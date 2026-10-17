import { describe, expect, it } from "vitest";
import fs from "node:fs";
import vm from "node:vm";
import { AI_PROVIDERS, OAUTH_PROVIDERS, FREE_PROVIDERS, FREE_TIER_PROVIDERS, APIKEY_PROVIDERS, getProviderAlias, isOpenAICompatibleProvider, isAnthropicCompatibleProvider } from "../../src/shared/constants/providers.js";
import { getModelsByProviderId, getModelKind } from "../../src/shared/constants/models.js";

const source = fs.readFileSync("src/shared/components/ModelSelectModal.js", "utf8");
// Execute the actual grouping callback: no standalone pure helper exists, and
// importing the component would require JSX/React rendering infrastructure.
const startMarker = "const groupedModels = useMemo(() => {";
const start = source.indexOf(startMarker);
const end = source.indexOf("\n  }, [filteredActiveProviders", start);
if (start < 0 || end < 0) throw new Error("Model grouping callback not found");
const grouping = new vm.Script(`(() => {${source.slice(start + startMarker.length, end)}\n})()`);
const allProviders = { ...OAUTH_PROVIDERS, ...FREE_PROVIDERS, ...FREE_TIER_PROVIDERS, ...APIKEY_PROVIDERS };
function groupModels(overrides = {}) {
  return grouping.runInNewContext({
    AI_PROVIDERS, allProviders, getProviderAlias, getModelsByProviderId, getModelKind,
    isOpenAICompatibleProvider, isAnthropicCompatibleProvider,
    PROVIDER_ORDER: Object.keys(allProviders),
    NO_AUTH_PROVIDER_IDS: Object.keys(FREE_PROVIDERS).filter((id) => FREE_PROVIDERS[id].noAuth),
    filteredActiveProviders: [], activeProviders: [], modelAliases: {}, providerNodes: [],
    customModels: [], disabledModels: {}, kindFilter: null, cursorModels: [], ...overrides,
  });
}
const nodeIds = ["openai-compatible-chat-test", "anthropic-compatible-test"];
const registered = nodeIds.map((providerAlias) => ({ providerAlias, id: "chat-model" }));

describe("ModelSelectModal compatible node visibility (#4659)", () => {
  it.each(nodeIds)("shows registered models on disconnected %s in the default LLM picker", (providerId) => {
    const groups = groupModels({ customModels: registered, providerNodes: [{ id: providerId, name: "Local node", prefix: "local" }] });
    expect(groups[providerId].name).toBe("Local node");
    expect(groups[providerId].models).toEqual([expect.objectContaining({ id: "chat-model", value: "local/chat-model", isCustom: true })]);
  });
  it("does not expose disconnected standard providers or nodes without registered models", () => {
    const groups = groupModels({ customModels: [{ providerAlias: "openai", id: "custom-chat" }], providerNodes: [{ id: nodeIds[0] }] });
    expect(groups).not.toHaveProperty("openai");
    for (const id of nodeIds) expect(groups).not.toHaveProperty(id);
  });
  it.each(["image", "tts", "stt", "embedding", "imageToText", "webSearch", "webFetch"])("does not add disconnected compatible nodes to the %s picker", (kindFilter) => {
    const groups = groupModels({ customModels: registered, kindFilter });
    for (const id of nodeIds) expect(groups).not.toHaveProperty(id);
  });
  it("preserves multiple registered models for the same node", () => {
    const groups = groupModels({ customModels: [registered[0], { providerAlias: nodeIds[0], id: "second" }] });
    expect(groups[nodeIds[0]].models.map((m) => m.id)).toEqual(["chat-model", "second"]);
  });
  it("ignores null and incomplete entries without hiding compatible models", () => {
    const groups = groupModels({ customModels: [null, undefined, {}, ...registered] });
    for (const id of nodeIds) expect(groups[id].models[0].id).toBe("chat-model");
  });
  it("ignores null entries for connected standard providers too", () => {
    const connection = { id: "cursor-account", provider: "cursor" };
    const groups = groupModels({
      activeProviders: [connection], filteredActiveProviders: [connection],
      customModels: [null, { providerAlias: getProviderAlias("cursor"), id: "custom-chat" }],
      cursorModels: [{ id: "account-chat", name: "Account chat" }],
    });
    expect(groups.cursor.models.map((m) => m.id)).toEqual(["account-chat", "custom-chat"]);
  });
});
