// Integration tests for pre-commit deadline/abort propagation through
// handleChatCore (open-sse/handlers/chatCore.js).
//
// The request signal must gate dispatch: an elapsed budget aborts BEFORE any
// upstream call, a client abort during dispatch cancels the owned upstream and
// is reported as local termination (so the caller stops fallback and does not
// quota-lock the account), and a non-streaming response stays pending-tracked
// until its body is fully consumed — finishing exactly once.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ noAuth: true, execute: executeMock }),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock("../../open-sse/utils/stream.js", () => ({
  COLORS: { red: "", reset: "" },
  createPassthroughStreamWithLogger: vi.fn(() => new TransformStream()),
  createSSETransformStreamWithLogger: vi.fn(() => new TransformStream()),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

vi.mock("undici", () => ({ Agent: class { constructor() {} } }));
vi.mock("uuid", () => ({ v4: () => "00000000-0000-0000-0000-000000000000" }));
vi.mock("node-machine-id", () => ({ machineIdSync: () => "mock-machine-id" }));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { createRequestBudget } = await import("../../open-sse/utils/requestBudget.js");

const FAKE = ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"];

const log = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  line: vi.fn(),
  errorLine: vi.fn(),
  tagForSession: vi.fn(() => ""),
  nextTag: vi.fn(() => ""),
};

function flush(ms = 20) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("handleChatCore — dispatch gating", () => {
  it("an elapsed pre-commit budget aborts before any upstream dispatch", async () => {
    vi.useFakeTimers({ toFake: FAKE });
    const budget = createRequestBudget({ deadlineAt: performance.now() - 1 });
    const finishAttempt = vi.fn();

    await expect(handleChatCore({
      body: { model: "gpt-4o", stream: true, messages: [{ role: "user", content: "hi" }] },
      modelInfo: { provider: "openai", model: "gpt-4o" },
      credentials: { apiKey: "k", providerSpecificData: {} },
      log,
      connectionId: "c1",
      requestContext: {
        signal: budget.signal,
        deadlineAt: budget.deadlineAt,
        check: () => budget.check(),
        wait: (work) => budget.wait(work),
        finishAttempt,
      },
    })).rejects.toMatchObject({ name: "TimeoutError", status: 504 });

    expect(executeMock).not.toHaveBeenCalled();
    budget.dispose();
  });

  it("a client abort during dispatch cancels the owned upstream and reports local termination", async () => {
    const ac = new AbortController();
    executeMock.mockImplementation(({ signal }) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }));
    const finishAttempt = vi.fn();

    const pending = handleChatCore({
      body: { model: "gpt-4o", stream: true, messages: [{ role: "user", content: "hi" }] },
      modelInfo: { provider: "openai", model: "gpt-4o" },
      credentials: { apiKey: "k", providerSpecificData: {} },
      log,
      connectionId: "c2",
      requestContext: {
        signal: ac.signal,
        check: () => {},
        wait: (work) => Promise.resolve(work),
        finishAttempt,
      },
    });

    await flush();
    expect(executeMock).toHaveBeenCalledTimes(1);

    ac.abort(Object.assign(new Error("client gone"), { name: "AbortError" }));

    const result = await pending;
    expect(result.success).toBe(false);
    expect(result.localTermination).toBe(true);
    expect(result.status).toBe(499);
    expect(finishAttempt).toHaveBeenCalledTimes(1);
  });
});

describe("handleChatCore — non-stream tracking to body end", () => {
  it("stays pending-tracked until the body is fully consumed, then finishes exactly once", async () => {
    const payload = JSON.stringify({
      id: "x",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    });
    let bodyController;
    const bodyStream = new ReadableStream({
      start(controller) {
        bodyController = controller;
        controller.enqueue(new TextEncoder().encode(payload));
      },
    });

    executeMock.mockResolvedValue({
      response: new Response(bodyStream, { status: 200, headers: { "content-type": "application/json" } }),
      url: "https://api.openai.com/v1/chat/completions",
      headers: {},
      transformedBody: null,
    });

    const finishAttempt = vi.fn();
    const pending = handleChatCore({
      body: { model: "gpt-4o", stream: false, messages: [{ role: "user", content: "hi" }] },
      modelInfo: { provider: "azure", model: "gpt-4o" },
      credentials: { apiKey: "k", providerSpecificData: {} },
      log,
      connectionId: "c3",
      requestContext: {
        signal: new AbortController().signal,
        check: () => {},
        wait: (work) => Promise.resolve(work),
        finishAttempt,
      },
    });

    await flush();
    expect(finishAttempt).not.toHaveBeenCalled();

    bodyController.close();
    await pending;

    expect(finishAttempt).toHaveBeenCalledTimes(1);
    expect(finishAttempt).toHaveBeenCalledWith("completed");
    expect(finishAttempt).toHaveBeenCalledWith("completed");
  });
});
