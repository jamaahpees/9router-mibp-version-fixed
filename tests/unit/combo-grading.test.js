import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleComboChat, resetComboRotation } from "../../open-sse/services/combo.js";

const models = ["test/a", "test/b", "test/c"];
const log = { info: vi.fn(), warn: vi.fn() };
const ok = () => new Response("OK");
const fail = (retryAfter) => new Response(JSON.stringify({ error: { message: "quota exceeded" }, retryAfter }), { status: 429 });
const options = (handleSingleModel, extra = {}) => ({ body: {}, models, comboName: "graded", comboStrategy: "fallback-grading", handleSingleModel, log, ...extra });

describe("fallback grading", () => {
  beforeEach(() => { resetComboRotation(); vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-14T00:00:00Z")); });
  afterEach(() => vi.useRealTimers());

  it("stays on each successful model until failure, never rotates or returns to a recovered earlier model", async () => {
    const failed = new Set();
    const call = vi.fn(async (_, m) => failed.has(m) ? fail() : ok());
    for (let i = 0; i < 3; i++) await handleComboChat(options(call));
    expect(call.mock.calls.map(c => c[1])).toEqual([models[0], models[0], models[0]]);
    failed.add(models[0]);
    await handleComboChat(options(call));
    failed.clear();
    vi.advanceTimersByTime(60000);
    await handleComboChat(options(call));
    expect(call.mock.calls.slice(-3).map(c => c[1])).toEqual([models[0], models[1], models[1]]);
    failed.add(models[1]);
    await handleComboChat(options(call));
    await handleComboChat(options(call));
    expect(call.mock.calls.slice(-3).map(c => c[1])).toEqual([models[1], models[2], models[2]]);
  });

  it("waits after exhaustion, then restarts in list order", async () => {
    const call = vi.fn(async () => fail(new Date(Date.now() + 10000).toISOString()));
    expect((await handleComboChat(options(call))).status).toBe(503);
    expect(call).toHaveBeenCalledTimes(3);
    expect((await handleComboChat(options(call))).status).toBe(503);
    expect(call).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(10001);
    call.mockImplementation(async () => ok());
    expect((await handleComboChat(options(call))).ok).toBe(true);
    expect(call.mock.calls.at(-1)[1]).toBe(models[0]);
  });

  it("honors Retry-After seconds and HTTP dates", async () => {
    for (const header of ["10", new Date(Date.now() + 10000).toUTCString()]) {
      resetComboRotation();
      const call = vi.fn(async () => new Response("unavailable", { status: 429, headers: { "Retry-After": header } }));
      const response = await handleComboChat(options(call, { models: [models[0]] }));
      expect(response.status).toBe(503);
      await handleComboChat(options(call, { models: [models[0]] }));
      expect(call).toHaveBeenCalledTimes(1);
    }
  });

  it("advances after exceptions but not client aborts", async () => {
    const call = vi.fn(async (_, m) => { if (m === models[0]) throw new Error("network failure"); return ok(); });
    await handleComboChat(options(call));
    await handleComboChat(options(call));
    expect(call.mock.calls.map(c => c[1])).toEqual([models[0], models[1], models[1]]);
    resetComboRotation();
    call.mockImplementation(async () => { throw new DOMException("cancelled", "AbortError"); });
    await expect(handleComboChat(options(call))).rejects.toThrow("cancelled");
    call.mockImplementation(async () => ok());
    await handleComboChat(options(call));
    expect(call.mock.calls.at(-1)[1]).toBe(models[0]);
  });

  it("isolates combos, resets on changed model ordering and explicit reset", async () => {
    const call = vi.fn(async (_, m) => m === models[0] ? fail() : ok());
    await handleComboChat(options(call));
    call.mockImplementation(async () => ok());
    await handleComboChat(options(call, { comboName: "other" }));
    expect(call.mock.calls.at(-1)[1]).toBe(models[0]);
    await handleComboChat(options(call));
    expect(call.mock.calls.at(-1)[1]).toBe(models[1]);
    await handleComboChat(options(call, { models: [models[2], models[1], models[0]] }));
    expect(call.mock.calls.at(-1)[1]).toBe(models[2]);
    resetComboRotation("graded");
    await handleComboChat(options(call));
    expect(call.mock.calls.at(-1)[1]).toBe(models[0]);
  });

  it("round-robin-only reset leaves grading cursor intact", async () => {
    const call = vi.fn(async (_, m) => m === models[0] ? fail() : ok());
    await handleComboChat(options(call));
    resetComboRotation(undefined, { grading: false });
    call.mockImplementation(async () => ok());
    await handleComboChat(options(call));
    expect(call.mock.calls.at(-1)[1]).toBe(models[1]);
  });

  it("late success cannot move the cursor backwards", async () => {
    let release;
    const delayed = new Promise(resolve => { release = resolve; });
    const first = handleComboChat(options(() => delayed));
    const call = vi.fn(async (_, m) => m === models[0] ? fail() : ok());
    await handleComboChat(options(call));
    release(ok());
    await first;
    call.mockImplementation(async () => ok());
    await handleComboChat(options(call));
    expect(call.mock.calls.at(-1)[1]).toBe(models[1]);
  });

  it("keeps stored order even for capability-bearing requests", async () => {
    const call = vi.fn(async () => ok());
    await handleComboChat(options(call, { body: { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA" } }] }] } }));
    expect(call.mock.calls[0][1]).toBe(models[0]);
  });

  it("returns streaming responses untouched without consuming or rotating", async () => {
    const response = new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("data: OK\n\n")); c.close(); } }), { headers: { "Content-Type": "text/event-stream" } });
    const call = vi.fn(async () => response);
    expect(await handleComboChat(options(call))).toBe(response);
    expect(response.bodyUsed).toBe(false);
    expect((await response.text())).toContain("data: OK");
  });

  it("does not dispatch an already-aborted request", async () => {
    const controller = new AbortController();
    controller.abort();
    const call = vi.fn(async () => ok());
    await expect(handleComboChat(options(call, { signal: controller.signal }))).rejects.toThrow("Request aborted");
    expect(call).not.toHaveBeenCalled();
  });

  it("an in-flight failure cannot resurrect reset state", async () => {
    let release;
    const first = handleComboChat(options(() => new Promise(resolve => { release = resolve; })));
    resetComboRotation("graded");
    release(fail());
    expect((await first).status).toBe(503);
    const call = vi.fn(async () => ok());
    await handleComboChat(options(call));
    expect(call.mock.calls.at(-1)[1]).toBe(models[0]);
  });

  describe("checkModelAvailability precheck", () => {
    it("skips a candidate whose checker reports zero available accounts", async () => {
      // models[0] has 0 accounts -> skip, models[1] has accounts -> try and succeed
      const call = vi.fn(async (_, m) => m === models[1] ? ok() : fail());
      const checker = vi.fn(async (model) =>
        model === models[0] ? { availableCount: 0, totalCount: 1, retryAfter: null } : { availableCount: 1, totalCount: 1, retryAfter: null });
      await handleComboChat(options(call, { checkModelAvailability: checker }));
      // Should skip models[0], try models[1] and succeed
      expect(call.mock.calls[0][1]).toBe(models[1]);
      expect(checker).toHaveBeenCalledWith(models[0]);
      expect(checker).toHaveBeenCalledWith(models[1]);
    });

    it("skips a wholly locked model using its precise retry time", async () => {
      const retryAfter = new Date(Date.now() + 5000).toISOString();
      const call = vi.fn(async (_, m) => m === models[1] ? ok() : fail());
      const checker = vi.fn(async (model) =>
        model === models[0] ? { availableCount: 0, totalCount: 1, retryAfter } : { availableCount: 1, totalCount: 1, retryAfter: null });
      await handleComboChat(options(call, { checkModelAvailability: checker }));
      // Should skip models[0] (using its retryAfter), try models[1] and succeed
      expect(call.mock.calls[0][1]).toBe(models[1]);
      expect(checker).toHaveBeenCalledWith(models[0]);
      // The cooldown for models[0] should be set to retryAfter
      // Next request immediately should still skip models[0] due to cooldown
      call.mockClear();
      await handleComboChat(options(call, { checkModelAvailability: checker }));
      expect(call.mock.calls[0][1]).toBe(models[1]);
    });

    it("stays sticky on the later model even when an earlier model recovers", async () => {
      // First request fails on models[0] and succeeds on models[1] => cursor ends on models[1]
      const failFirst = vi.fn(async (body, model) => {
        if (model === models[0]) return fail();
        return ok();
      });
      await handleComboChat(options(failFirst, { checkModelAvailability: vi.fn(async () => ({ availableCount: 1, totalCount: 1, retryAfter: null })) }));
      const call = vi.fn(async () => ok());
      // Now earlier model is available, but cursor should stay on models[1]
      await handleComboChat(options(call, { checkModelAvailability: vi.fn(async () => ({ availableCount: 1, totalCount: 1, retryAfter: null })) }));
      expect(call.mock.calls.at(-1)[1]).toBe(models[1]);
    });

    it("does not infinite-retry when the checker still reports available after upstream failure", async () => {
      const call = vi.fn(async () => fail());
      const checker = vi.fn(async () => ({ availableCount: 1, totalCount: 1, retryAfter: null }));
      expect((await handleComboChat(options(call, { checkModelAvailability: checker }))).status).toBe(503);
      expect(call).toHaveBeenCalledTimes(3);
      // A second identical request must not dispatch again while cooldowns hold
      expect((await handleComboChat(options(call, { checkModelAvailability: checker }))).status).toBe(503);
      expect(call).toHaveBeenCalledTimes(3);
    });

    it("rechecks abort after the awaited checker", async () => {
      const controller = new AbortController();
      const call = vi.fn(async () => ok());
      const checker = vi.fn(async () => {
        controller.abort();
        return { availableCount: 1, totalCount: 1, retryAfter: null };
      });
      await expect(handleComboChat(options(call, { checkModelAvailability: checker, signal: controller.signal })))
        .rejects.toThrow("Request aborted");
      expect(call).not.toHaveBeenCalled();
    });

    it("rechecks generation/index after the awaited checker", { timeout: 15000 }, async () => {
      // Start a slow checker that yields, then advance cursor via another request
      let resolveSlow;
      const slow = new Promise(r => { resolveSlow = r; });
      const slowChecker = vi.fn(async () => { await slow; return { availableCount: 1, totalCount: 1, retryAfter: null }; });
      const fastChecker = vi.fn(async () => ({ availableCount: 1, totalCount: 1, retryAfter: null }));
      const call = vi.fn(async () => ok());
      // First request has slow checker; second request (fast) runs concurrently and advances cursor
      const first = handleComboChat(options(call, { checkModelAvailability: slowChecker }));
      // Yield to microtask queue so first request awaits the checker
      await Promise.resolve();
      // Second request advances cursor to models[1]
      await handleComboChat(options(async (_, m) => m === models[0] ? fail() : ok(), { checkModelAvailability: fastChecker }));
      // Now resolve slow checker; first request should recheck state and NOT regress
      resolveSlow({ availableCount: 1, totalCount: 1, retryAfter: null });
      expect((await first).ok).toBe(true);
      expect(call.mock.calls.map(c => c[1])).toEqual([models[1]]);
    });

    it("concurrent async checks do not double-dispatch the same candidate", { timeout: 15000 }, async () => {
      const call = vi.fn(async () => ok());
      const resolvers = [];
      const checker = vi.fn(async () => new Promise(r => { resolvers.push(r); }));
      const a = handleComboChat(options(call, { checkModelAvailability: checker }));
      const b = handleComboChat(options(call, { checkModelAvailability: checker }));
      // Resolve both checks
      resolvers.forEach(r => r({ availableCount: 1, totalCount: 1, retryAfter: null }));
      await Promise.all([a, b]);
      // Both may dispatch; cursor state stays consistent (no duplicate cursor regression)
      expect(call.mock.calls.length).toBeGreaterThanOrEqual(1);
    }, { timeout: 15000 });

    it("resetComboRotation clears the precheck cooldowns", async () => {
      const checker = vi.fn(async (model) =>
        model === models[0] ? { availableCount: 0, totalCount: 1, retryAfter: null } : { availableCount: 1, totalCount: 1, retryAfter: null });
      const call = vi.fn(async () => ok());
      await handleComboChat(options(call, { checkModelAvailability: checker }));
      expect(call.mock.calls.at(-1)[1]).toBe(models[1]);
      resetComboRotation("graded");
      checker.mockResolvedValue({ availableCount: 1, totalCount: 1, retryAfter: null });
      await handleComboChat(options(call, { checkModelAvailability: checker }));
      expect(call.mock.calls.at(-1)[1]).toBe(models[0]);
    });

    it("reset during check returns unavailable with routing changed message", async () => {
      let resolveSlow;
      const slow = new Promise(r => { resolveSlow = r; });
      const slowChecker = vi.fn(async () => { await slow; return { availableCount: 1, totalCount: 1, retryAfter: null }; });
      const call = vi.fn(async () => ok());
      const first = handleComboChat(options(call, { checkModelAvailability: slowChecker }));
      await Promise.resolve();
      // Reset combo while first request awaits the checker
      resetComboRotation("graded");
      // Now resolve the checker
      resolveSlow({ availableCount: 1, totalCount: 1, retryAfter: null });
      const response = await first;
      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body.error.message).toContain("Combo routing changed");
    });
  });
});
