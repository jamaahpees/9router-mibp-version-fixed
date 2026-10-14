// Integration tests for the streaming pre-commit gate (open-sse/handlers/chatCore/streamingHandler.js).
//
// The handler must hold the HTTP 200 commitment until the first REAL protocol
// event, hold the upstream open only up to the deadline, and on timeout/abort
// return a structured HTTP failure (504 timeout / 499 abort / 502 invalid or
// empty upstream) — never an empty 200 and never a late success callback. Once
// committed, cancelling the response aborts the OWNED upstream exactly once and
// replays nothing.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  saveRequestDetail: vi.fn(async () => {}),
  appendRequestLog: vi.fn(async () => {}),
  trackPendingRequest: vi.fn(),
  saveRequestUsage: vi.fn(async () => {}),
}));

vi.mock("../../open-sse/handlers/chatCore/requestDetail.js", () => ({
  buildRequestDetail: (base) => ({ ...base }),
  extractRequestConfig: () => ({}),
  saveUsageStats: vi.fn(),
  formatDoneLine: () => "",
  extractUsageFromResponse: () => ({}),
}));

vi.mock("../../open-sse/utils/stream.js", () => ({
  COLORS: {},
  createPassthroughStreamWithLogger: () => new TransformStream(),
  createSSETransformStreamWithLogger: () => new TransformStream(),
}));

vi.mock("undici", () => ({ Agent: class { constructor() {} } }));
vi.mock("uuid", () => ({ v4: () => "00000000-0000-0000-0000-000000000000" }));
vi.mock("node-machine-id", () => ({ machineIdSync: () => "mock-machine-id" }));

const { handleStreamingResponse } = await import("../../open-sse/handlers/chatCore/streamingHandler.js");
const { FORMATS } = await import("../../open-sse/translator/formats.js");

const FAKE = ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"];
const enc = new TextEncoder();

function useFake() {
  vi.useFakeTimers({ toFake: FAKE });
}

afterEach(() => {
  vi.useRealTimers();
});

function frame(str) {
  return enc.encode(str);
}

function makeController() {
  const ac = new AbortController();
  return {
    signal: ac.signal,
    isConnected: () => true,
    isDisconnected: () => false,
    handleError: vi.fn(),
    handleComplete: vi.fn(),
    handleDisconnect: vi.fn(),
    abort: vi.fn(() => ac.abort()),
  };
}

function providerResponse(body, { status = 200, contentType = "text/event-stream" } = {}) {
  return {
    status,
    body,
    headers: { get: (h) => (h.toLowerCase() === "content-type" ? contentType : null) },
  };
}

function streamFrom(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

function stalledAfter(firstChunk) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(firstChunk);
    },
    pull() {
      return new Promise(() => {});
    },
  });
}

function baseArgs(overrides = {}) {
  const ac = new AbortController();
  return {
    provider: "openai",
    model: "gpt-4o",
    sourceFormat: FORMATS.CLAUDE,
    targetFormat: FORMATS.OPENAI,
    stream: true,
    body: { model: "gpt-4o" },
    requestContext: { signal: ac.signal, deadlineAt: performance.now() + 5000 },
    ...overrides,
  };
}

describe("handleStreamingResponse — pre-commit failure semantics", () => {
  it("rejects an empty upstream body with a structured 502 (never an empty 200)", async () => {
    const sc = makeController();
    const result = await handleStreamingResponse({
      ...baseArgs(),
      providerResponse: providerResponse(null, { status: 502 }),
      streamController: sc,
    });
    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(sc.abort).toHaveBeenCalled();
  });

  it("rejects a non-SSE upstream content-type without draining it", async () => {
    const sc = makeController();
    const body = streamFrom([frame("<html>oops</html>")]);
    const result = await handleStreamingResponse({
      ...baseArgs(),
      providerResponse: providerResponse(body, { contentType: "text/html" }),
      streamController: sc,
    });
    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(sc.abort).toHaveBeenCalled();
  });

  it("holds the 200 and returns a structured 504 when only keepalives arrive", async () => {
    useFake();
    const sc = makeController();
    const onRequestSuccess = vi.fn();
    const args = baseArgs({
      requestContext: { signal: new AbortController().signal, deadlineAt: performance.now() + 100 },
      streamController: sc,
      onRequestSuccess,
    });

    const pending = handleStreamingResponse({
      ...args,
      providerResponse: providerResponse(stalledAfter(frame(": keepalive\n\n"))),
    });
    await vi.advanceTimersByTimeAsync(150);
    const result = await pending;

    expect(result.success).toBe(false);
    expect(result.status).toBe(504);
    expect(result.localTermination).toBe(true);
    expect(sc.abort).toHaveBeenCalled();
    expect(onRequestSuccess).not.toHaveBeenCalled();
  });

  it("a client abort before commitment returns 499 and never fires success", async () => {
    useFake();
    const ac = new AbortController();
    const sc = makeController();
    const onRequestSuccess = vi.fn();
    const args = baseArgs({
      requestContext: { signal: ac.signal, deadlineAt: performance.now() + 5000 },
      streamController: sc,
      onRequestSuccess,
    });

    const pending = handleStreamingResponse({
      ...args,
      providerResponse: providerResponse(stalledAfter(frame(": keepalive\n\n"))),
    });
    await vi.advanceTimersByTimeAsync(2);
    ac.abort(Object.assign(new Error("client gone"), { name: "AbortError" }));
    await vi.advanceTimersByTimeAsync(2);
    const result = await pending;

    expect(result.success).toBe(false);
    expect(result.status).toBe(499);
    expect(result.localTermination).toBe(true);
    expect(sc.abort).toHaveBeenCalled();
    expect(onRequestSuccess).not.toHaveBeenCalled();
  });

  it("a stream disconnect before readiness fails without a success callback", async () => {
    useFake();
    const sc = makeController();
    sc.isDisconnected = () => true;
    sc.isConnected = () => false;
    const onRequestSuccess = vi.fn();

    const result = await handleStreamingResponse({
      ...baseArgs({ streamController: sc, onRequestSuccess }),
      providerResponse: providerResponse(stalledAfter(frame(": keepalive\n\n"))),
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(499);
    expect(onRequestSuccess).not.toHaveBeenCalled();
  });
});

describe("handleStreamingResponse — commitment", () => {
  it("commits 200, replays the consumed bytes exactly once, and fires success once", async () => {
    useFake();
    const sc = makeController();
    const onRequestSuccess = vi.fn();
    const onStreamComplete = vi.fn();
    const body = streamFrom([
      frame("event: message_st"),
      frame('art\ndata: {"type":"message_start","message":{"role":"assistant"}}\n\n'),
      frame("data: [DONE]\n\n"),
    ]);

    const result = await handleStreamingResponse({
      ...baseArgs({ streamController: sc, onRequestSuccess, onStreamComplete }),
      providerResponse: providerResponse(body),
    });

    expect(result.success).toBe(true);
    expect(result.response.status).toBe(200);

    const text = await result.response.text();
    expect(text.match(/"type":"message_start"/g)).toHaveLength(1);
    expect(text).toContain("data: [DONE]");

    await vi.advanceTimersByTimeAsync(0);
    expect(onRequestSuccess).toHaveBeenCalledTimes(1);
  });

  it("cancelling the committed response aborts the owned upstream exactly once", async () => {
    useFake();
    const sc = makeController();
    const body = streamFrom([
      frame('data: {"type":"message_start","message":{"role":"assistant"}}\n\n'),
      frame('data: {"type":"content_block_delta","delta":{"text":"x"}}\n\n'),
    ]);

    const result = await handleStreamingResponse({
      ...baseArgs({ streamController: sc }),
      providerResponse: providerResponse(body),
    });
    expect(result.success).toBe(true);

    await result.response.body.cancel("client closed");
    expect(sc.abort).toHaveBeenCalledTimes(1);
  });
});
