// fallback-grading must not commit a 2xx stream that carries no content. Gemini
// aborts a generation (MALFORMED_FUNCTION_CALL) with HTTP 200 and an empty stream;
// handing that to the client ended the turn, which strict OpenAI clients report as
// "stream ended without finish_reason". The grading seat must fall through instead.
import { describe, it, expect, vi } from "vitest";

// The combo module reaches the translator registry through its provider imports;
// that registry has a circular import vitest's SSR transform evaluates differently
// from Node. The grading path under test never translates anything.
vi.mock("../../open-sse/translator/index.js", () => ({
  translateRequest: (source, target, model, body) => body,
  translateResponse: () => [],
  initState: () => ({}),
  needsTranslation: () => false,
}));

vi.mock("@/lib/usageDb.js", () => ({
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
  appendRequestLog: vi.fn(async () => {}),
  trackPendingRequest: vi.fn(),
}));

import { handleComboChat, resetComboRotation } from "../../open-sse/services/combo.js";

const enc = new TextEncoder();

const ROLE = `data: {"id":"x","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n`;
const EMPTY_STOP = `data: {"id":"x","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`;
const CONTENT = `data: {"id":"x","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}\n\n`;
const FINISH = `data: {"id":"x","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`;

function sseResponse(frames) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(enc.encode(frame));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };

describe("fallback-grading empty-stream failover", () => {
  it("falls through to the next seat when a 2xx stream has no content", async () => {
    const comboName = `grading-empty-${Date.now()}`;
    resetComboRotation(comboName);
    const calls = [];

    const response = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }], stream: true },
      models: ["p/one", "p/two"],
      comboName,
      comboStrategy: "fallback-grading",
      log,
      checkModelAvailability: async () => ({ availableCount: 1 }),
      handleSingleModel: async (_body, model) => {
        calls.push(model);
        return model === "p/one"
          ? sseResponse([ROLE, EMPTY_STOP])
          : sseResponse([ROLE, CONTENT, FINISH]);
      },
    });

    expect(calls).toEqual(["p/one", "p/two"]);
    const text = await response.text();
    expect(text).toContain("OK");
    expect(log.warn).toHaveBeenCalledWith(
      "COMBO",
      expect.stringContaining("returned empty (stop)"),
    );
  });

  it("returns the empty response as-is when the last seat is also empty", async () => {
    const comboName = `grading-all-empty-${Date.now()}`;
    resetComboRotation(comboName);
    const calls = [];

    const response = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }], stream: true },
      models: ["p/one"],
      comboName,
      comboStrategy: "fallback-grading",
      log,
      checkModelAvailability: async () => ({ availableCount: 1 }),
      handleSingleModel: async (_body, model) => {
        calls.push(model);
        return sseResponse([ROLE, EMPTY_STOP]);
      },
    });

    expect(calls).toEqual(["p/one"]);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"finish_reason":"stop"');
  });
});
