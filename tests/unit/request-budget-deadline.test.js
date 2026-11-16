import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { createRequestBudget } from "../../open-sse/utils/requestBudget.js";

describe("request budget deadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("aborts with a 504 TimeoutError once the deadline passes", () => {
    const budget = createRequestBudget({ deadlineAt: performance.now() + 60000 });

    vi.advanceTimersByTime(59000);
    expect(budget.signal.aborted).toBe(false);

    vi.advanceTimersByTime(2000);
    expect(budget.signal.aborted).toBe(true);
    expect(budget.signal.reason?.name).toBe("TimeoutError");
    expect(budget.signal.reason?.status).toBe(504);
  });

  it("setDeadline re-arms a shorter bound than the one in force", () => {
    const budget = createRequestBudget({ deadlineAt: performance.now() + 200000 });

    budget.setDeadline(performance.now() + 60000);
    vi.advanceTimersByTime(61000);

    expect(budget.signal.aborted).toBe(true);
  });

  it("setDeadline revives a budget disabled for a non-streaming call", () => {
    const budget = createRequestBudget({ deadlineAt: performance.now() + 60000 });

    budget.disableDeadline();
    expect(budget.deadlineAt).toBe(Infinity);
    vi.advanceTimersByTime(120000);
    expect(budget.signal.aborted).toBe(false);

    budget.setDeadline(performance.now() + 30000);
    vi.advanceTimersByTime(31000);
    expect(budget.signal.aborted).toBe(true);
  });

  it("setDeadline cannot resurrect a committed request", () => {
    const budget = createRequestBudget({ deadlineAt: Infinity });

    budget.commit();
    budget.setDeadline(performance.now() + 1000);
    vi.advanceTimersByTime(5000);

    expect(budget.signal.aborted).toBe(false);
  });

  it("stops the client's own abort from being lost", () => {
    const controller = new AbortController();
    const budget = createRequestBudget({ signal: controller.signal });

    controller.abort();
    expect(budget.signal.aborted).toBe(true);
  });
});
