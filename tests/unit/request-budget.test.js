// Unit tests for the pre-commit request budget (open-sse/utils/requestBudget.js).
//
// The budget enforces an INGRESS-relative ABSOLUTE deadline for one logical
// request. It must NOT be reset by retries, fallback attempts, proxy
// re-resolution or reactive (401) token refresh, and it must propagate the
// caller AbortSignal to the owned request ONLY — a cancelled waiter must never
// abort shared credential-refresh work that other requests still need.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequestBudget, localTerminationResult } from "../../open-sse/utils/requestBudget.js";

// performance must be faked so the module's monotonic clock advances with the
// fake timers (vitest does not fake `performance` unless asked to).
const FAKE = ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"];

function useFake() {
  vi.useFakeTimers({ toFake: FAKE });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("requestBudget — ingress-relative deadline", () => {
  it("aborts at the absolute deadline with a 504 TimeoutError", async () => {
    useFake();
    const budget = createRequestBudget({ deadlineAt: performance.now() + 1000 });
    expect(budget.signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1001);

    expect(budget.signal.aborted).toBe(true);
    expect(budget.signal.reason.name).toBe("TimeoutError");
    expect(budget.signal.reason.status).toBe(504);
    budget.dispose();
  });

  it("check() throws the stored reason once the deadline elapses", () => {
    useFake();
    const budget = createRequestBudget({ deadlineAt: performance.now() + 100 });
    expect(() => budget.check()).not.toThrow();

    vi.advanceTimersByTime(101);

    expect(() => budget.check()).toThrowError(/deadline/i);
    budget.dispose();
  });

  it("does NOT reset the deadline across retries/fallback waits", async () => {
    useFake();
    const budget = createRequestBudget({ deadlineAt: performance.now() + 1000 });
    const step = () => new Promise((resolve) => setTimeout(() => resolve("attempt"), 400));

    const p1 = budget.wait(step()); // t = 400
    await vi.advanceTimersByTimeAsync(400);
    await expect(p1).resolves.toBe("attempt");

    const p2 = budget.wait(step()); // t = 800
    await vi.advanceTimersByTimeAsync(400);
    await expect(p2).resolves.toBe("attempt");

    // t would reach 1200 → past the original 1000ms deadline. A budget that
    // reset on each wait would still be alive; this one must abort.
    // Attach the rejection assertion BEFORE advancing so the rejection is
    // observed at the moment the fake clock crosses the deadline.
    const p3 = budget.wait(step());
    const assertion = expect(p3).rejects.toMatchObject({ name: "TimeoutError", status: 504 });
    await vi.advanceTimersByTimeAsync(400);
    await assertion;
    expect(budget.signal.aborted).toBe(true);
    budget.dispose();
  });

  it("commit() disarms the deadline and lets check() pass", async () => {
    useFake();
    const budget = createRequestBudget({ deadlineAt: performance.now() + 100 });
    budget.commit();

    await vi.advanceTimersByTimeAsync(10_000);

    expect(budget.signal.aborted).toBe(false);
    expect(() => budget.check()).not.toThrow();
    budget.dispose();
  });

  it("disableDeadline() disarms the deadline (non-stream bodies)", async () => {
    useFake();
    const budget = createRequestBudget({ deadlineAt: performance.now() + 50 });
    budget.disableDeadline();

    expect(budget.deadlineAt).toBe(Infinity);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(budget.signal.aborted).toBe(false);
    budget.dispose();
  });
});

describe("requestBudget — abort propagation", () => {
  it("propagates the caller signal and rejects wait() with the caller reason", async () => {
    const external = new AbortController();
    const budget = createRequestBudget({ signal: external.signal });
    const pending = budget.wait(new Promise(() => {}));

    external.abort(new DOMException("client gone", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(budget.signal.aborted).toBe(true);
    budget.dispose();
  });

  it("dispose() detaches the caller signal and clears the timer", async () => {
    useFake();
    const external = new AbortController();
    const budget = createRequestBudget({ signal: external.signal, deadlineAt: performance.now() + 100 });
    budget.dispose();

    await vi.advanceTimersByTimeAsync(1000);
    external.abort();

    expect(budget.signal.aborted).toBe(false);
  });

  it("observes an eagerly-started work promise (no unhandled rejection)", async () => {
    const budget = createRequestBudget({});
    const rejected = Promise.reject(new Error("upstream exploded"));
    await expect(budget.wait(rejected)).rejects.toThrow("upstream exploded");
    budget.dispose();
  });
});

describe("requestBudget — waiter cancel must not abort shared work", () => {
  it("a deadline-aborted waiter leaves the shared refresh promise alive", async () => {
    useFake();
    let resolveRefresh;
    const sharedRefresh = new Promise((resolve) => { resolveRefresh = resolve; });
    const budget = createRequestBudget({ deadlineAt: performance.now() + 50 });

    const waiter = budget.wait(sharedRefresh).then(() => "resolved", (e) => e);
    await vi.advanceTimersByTimeAsync(51);

    const outcome = await waiter;
    expect(outcome.name).toBe("TimeoutError");

    // The shared refresh was never aborted — it still resolves normally.
    resolveRefresh({ accessToken: "fresh" });
    await expect(sharedRefresh).resolves.toEqual({ accessToken: "fresh" });
    budget.dispose();
  });
});

describe("localTerminationResult", () => {
  it("maps timeouts to a structured 504", async () => {
    const r = localTerminationResult(Object.assign(new Error("x"), { name: "TimeoutError", status: 504 }));
    expect(r).toMatchObject({ success: false, status: 504, localTermination: true });
    expect(await r.response.clone().json()).toEqual({
      error: { message: expect.stringMatching(/timed out/i) },
    });
  });

  it("maps client aborts to 499", () => {
    const r = localTerminationResult(Object.assign(new Error("x"), { name: "AbortError" }));
    expect(r.status).toBe(499);
    expect(r.localTermination).toBe(true);
  });
});
