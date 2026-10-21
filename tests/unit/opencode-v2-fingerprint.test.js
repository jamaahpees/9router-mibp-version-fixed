import { describe, expect, it } from "vitest";
import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";
import {
  OPENCODE_FINGERPRINT_TOOLS,
  applyFingerprintTools,
  takeRenamedToolNames,
  restoreToolNames,
} from "../../open-sse/utils/opencodeFingerprint.js";

const CHAT_MODEL = "deepseek-v4.1-flash-free";
const RESPONSES_MODEL = "muse-spark-1.3-contributor-free";
// Upstream decodes this prefix and rejects a non-small counter with 403
// FreeTierError (live probes: counter 0-16 pass, >=100 fail).
const SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const V2_UA_RE = /^opencode\/[a-z0-9-]+\/\d+\.\d+\.\d+\/[a-z0-9-]+$/i;

function counterOf(session) {
  const prefix = BigInt(`0x${session.slice(4, 16)}`);
  return Number((~prefix & ((1n << 48n) - 1n)) & 0xfffn);
}

describe("OpenCode 2.0 free-tier fingerprint", () => {
  it("routes both formats through /inference/v1", () => {
    const executor = new OpenCodeExecutor();
    expect(executor.buildUrl(CHAT_MODEL)).toBe("https://opencode.ai/inference/v1/chat/completions");
    expect(executor.buildUrl(RESPONSES_MODEL)).toBe("https://opencode.ai/inference/v1/responses");
  });

  it("sends the v2 User-Agent, session headers, and no v1 request id", () => {
    const executor = new OpenCodeExecutor();
    executor.transformRequest(CHAT_MODEL, { messages: [] }, true, {});
    const headers = executor.buildHeaders({});

    expect(headers["User-Agent"]).toMatch(V2_UA_RE);
    expect(headers["x-opencode-client"]).toBe("cli");
    expect(headers["x-opencode-session"]).toMatch(SESSION_RE);
    expect(headers["x-opencode-session-id"]).toBe(headers["x-opencode-session"]);
    expect(headers["x-session-affinity"]).toBe(headers["x-opencode-session"]);
    expect(headers["x-session-id"]).toBe(headers["x-opencode-session"]);
    expect(headers["x-opencode-request"]).toBeUndefined();
  });

  it("encodes a real small counter in the session prefix", () => {
    const executor = new OpenCodeExecutor();
    executor.transformRequest(CHAT_MODEL, { messages: [] }, true, {});

    for (let i = 0; i < 3; i++) {
      const session = executor.buildHeaders({})["x-opencode-session"];
      const counter = counterOf(session);
      expect(counter).toBeGreaterThan(0);
      expect(counter).toBeLessThan(17);
    }
  });

  it("translates a downstream session into the canonical shape", () => {
    const executor = new OpenCodeExecutor();
    executor.transformRequest(CHAT_MODEL, { messages: [] }, true, {
      rawHeaders: { "x-opencode-session": "ses_0123456789abcdefXYZ" },
    });
    const session = executor.buildHeaders({})["x-opencode-session"];
    expect(session).toMatch(SESSION_RE);
    expect(counterOf(session)).toBe(1);
  });

  it("appends the exact read/shell definitions and defaults Responses tool_choice to auto", () => {
    const body = { input: [], tools: [] };
    applyFingerprintTools(body, true);

    const names = body.tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(OPENCODE_FINGERPRINT_TOOLS));
    expect(body.tool_choice).toBe("auto");
    expect(body.instructions).toContain("placeholders");

    const shell = body.tools.find((tool) => tool.name === "shell");
    expect(shell.parameters.required).toEqual(["command"]);
    expect(shell.parameters.additionalProperties).toBe(false);
    expect(shell.parameters.properties.background.type).toBe("boolean");

    const read = body.tools.find((tool) => tool.name === "read");
    expect(read.parameters.required).toEqual(["path"]);
    expect(read.parameters.additionalProperties).toBe(false);
  });

  it("keeps caller tools and aliases only exact-name conflicts", () => {
    const customRead = {
      type: "function",
      function: {
        name: "read",
        description: "Read a file with the caller's own schema",
        parameters: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] },
      },
    };
    const body = {
      messages: [{ role: "user", content: "hi" }],
      tools: [customRead, { type: "function", function: { name: "grep", description: "Search", parameters: { type: "object", properties: {} } } }],
    };

    applyFingerprintTools(body, false);

    const names = body.tools.map((tool) => tool.function.name);
    expect(names).toContain("grep");
    expect(names).toContain("read");
    expect(names).toContain("shell");
    // The caller's conflicting tool travels under an alias instead of being dropped.
    expect(names.filter((name) => name.startsWith("read"))).toHaveLength(2);

    const map = takeRenamedToolNames(body);
    expect(map?.size).toBe(1);
    const [alias, original] = [...map.entries()][0];
    expect(original).toBe("read");
    expect(alias).not.toBe("read");

    const restored = restoreToolNames(
      { choices: [{ message: { tool_calls: [{ function: { name: alias } }] } }] },
      map
    );
    expect(restored.choices[0].message.tool_calls[0].function.name).toBe("read");
  });

  it("forces streaming with usage for chat and store=false for Responses", () => {
    const executor = new OpenCodeExecutor();

    const chat = executor.transformRequest(CHAT_MODEL, { messages: [], stream: false }, false, {});
    expect(chat.stream).toBe(true);
    expect(chat.stream_options.include_usage).toBe(true);

    const responses = executor.transformRequest(RESPONSES_MODEL, { input: [] }, false, {});
    expect(responses.stream).toBe(true);
    expect(responses.store).toBe(false);
    expect(responses.tool_choice).toBe("auto");
  });
});
