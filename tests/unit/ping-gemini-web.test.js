import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/localDb", () => ({
  getApiKeys: vi.fn(async () => []),
  getProviderNodes: vi.fn(async () => []),
}));
vi.mock("@/shared/constants/config", () => ({ UPDATER_CONFIG: { appPort: 20127 } }));
vi.mock("@/shared/utils/machineId", () => ({ getConsistentMachineId: vi.fn(async () => "cli-token") }));

const { getProviderNodes } = await import("@/lib/localDb");
const { pingModelByKind } = await import("../../src/app/api/models/test/ping.js");

describe("pingModelByKind GeminiWeb", () => {
  let fetchMock;
  let timeoutSpy;

  beforeEach(() => {
    getProviderNodes.mockReset().mockResolvedValue([]);
    fetchMock = vi.fn().mockResolvedValue(response("Hello!"));
    vi.stubGlobal("fetch", fetchMock);
    timeoutSpy = vi.spyOn(AbortSignal, "timeout");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function response(content, extra = {}) {
    return { ok: true, status: 200, text: async () => JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content }, ...extra }],
    }) };
  }

  it.each(["gweb/gemini-3-pro", "gweb-secondary/gemini-3-pro"])("allows 180 seconds for %s", async (model) => {
    expect((await pingModelByKind(model, "llm")).ok).toBe(true);
    expect(timeoutSpy).toHaveBeenCalledWith(180000);
  });

  it.each([
    { id: "openai-compatible-deployed-id", prefix: "gweb" },
    { id: "openai-compatible-deployed-id", name: "Gemini Web" },
    { id: "openai-compatible-deployed-id", baseUrl: "http://gemini-web:8083/v1" },
  ])("resolves the exact raw node ID using metadata %j", async (node) => {
    getProviderNodes.mockResolvedValue([node]);
    await pingModelByKind(`${node.id}/gemini-3-pro`, "llm");
    expect(timeoutSpy).toHaveBeenCalledWith(180000);
  });

  it("resolves a configured prefix by exact node match", async () => {
    getProviderNodes.mockResolvedValue([{ id: "node-id", prefix: "browser", baseUrl: "http://gemini-web:8083/v1" }]);
    await pingModelByKind("browser/gemini-3-pro", "llm");
    expect(timeoutSpy).toHaveBeenCalledWith(180000);
  });

  it.each(["openai/gpt-4o", "gwebish/model", "other-node/model", "gemini-3-pro"])("keeps the default timeout for %s", async (model) => {
    getProviderNodes.mockResolvedValue([{ id: "different-node", prefix: "gweb" }]);
    await pingModelByKind(model, "llm");
    expect(timeoutSpy).toHaveBeenCalledWith(15000);
  });

  it("keeps the default timeout when the node lookup fails", async () => {
    getProviderNodes.mockRejectedValue(new Error("database unavailable"));
    expect((await pingModelByKind("other/model", "llm")).ok).toBe(true);
    expect(timeoutSpy).toHaveBeenCalledWith(15000);
  });

  it.each(["TimeoutError", "AbortError"])("returns a test failure rather than throwing %s", async (name) => {
    fetchMock.mockRejectedValue(new DOMException("signal aborted", name));
    const result = await pingModelByKind("gweb/gemini-3-pro", "llm");
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/timeout/i), latencyMs: expect.any(Number) });
  });

  it("handles timeouts while reading the response", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => { throw new DOMException("expired", "TimeoutError"); } });
    expect(await pingModelByKind("gweb/gemini-3-pro", "llm")).toMatchObject({ ok: false, error: expect.stringMatching(/timeout/i) });
  });

  it.each(["", "   ", null])("rejects an empty completion %j", async (content) => {
    fetchMock.mockResolvedValue(response(content));
    expect(await pingModelByKind("gweb/gemini-3-pro", "llm")).toMatchObject({ ok: false, error: expect.stringMatching(/no completion content/i) });
  });

  it.each(["Service error", "Service error. Please try again later."])("rejects the exact upstream service-error reply %s", async (content) => {
    fetchMock.mockResolvedValue(response(content));
    expect(await pingModelByKind("gweb/gemini-3-pro", "llm")).toMatchObject({ ok: false, error: expect.stringMatching(/service error/i) });
  });

  it.each([
    "I'm having a hard time fulfilling your request. Can I help you with something else instead?",
    "I seem to be encountering an error. Can I try something else for you?",
    "  I’M having a hard time fulfilling your request.\n Can I help you with something else instead?  ",
    " I seem to be encountering an error.   Can I try something else for you? ",
  ])("rejects the normalized whole-response Google service error %s", async (content) => {
    fetchMock.mockResolvedValue(response(content));
    expect(await pingModelByKind("gweb/gemini-3-pro", "llm")).toMatchObject({ ok: false, error: expect.stringMatching(/service error/i) });
  });

  it.each([
    '\"I\'m having a hard time fulfilling your request. Can I help you with something else instead?\"',
    '\"I seem to be encountering an error. Can I try something else for you?\"',
    "The service replied: I'm having a hard time fulfilling your request. Can I help you with something else instead?",
    "I seem to be encountering an error. Can I try something else for you? This is an example.",
  ])("allows quoted or embedded Google service-error text %s", async (content) => {
    fetchMock.mockResolvedValue(response(content));
    expect((await pingModelByKind("gweb/gemini-3-pro", "llm")).ok).toBe(true);
  });

  it("does not mistake discussion of a service error for an upstream failure", async () => {
    fetchMock.mockResolvedValue(response("A service error can happen when a server is unavailable."));
    expect((await pingModelByKind("gweb/gemini-3-pro", "llm")).ok).toBe(true);
  });

  it("preserves the reasoning-only length-limited soft pass", async () => {
    fetchMock.mockResolvedValue(response("", { finish_reason: "length", message: { content: "", reasoning_content: "Thinking..." } }));
    expect(await pingModelByKind("gweb/gemini-3-pro", "llm")).toMatchObject({ ok: true, note: expect.stringMatching(/reasoning-only/) });
  });
});
