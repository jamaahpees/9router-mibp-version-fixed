// Unit tests for the per-provider selection queue.
//
// Historical defect: one global selectionMutex serialized account selection
// across ALL providers. The replacement keys a FIFO queue by the canonical
// provider ID so unrelated providers select independently while one provider's
// rotation state stays ordered.
//
// These tests drive the queue directly (no DB, no network) and pin the
// contracts the auth layer relies on:
//   - FIFO per provider; unrelated providers proceed concurrently
//   - identity-checked release (an older holder never frees a newer tail)
//   - a cancellation / rejection never poisons the chain
//   - a request cancelled while queued stops after the wait and never dispatches
//   - a cancelled waiter never lets its successor bypass the active holder
import { describe, it, expect, vi, afterEach } from "vitest";
import { acquireProviderSelection } from "../../src/sse/services/selectionQueue.js";

// Microtask barrier: lets a synchronous burst of acquire() calls settle.
const tick = () => new Promise((resolve) => setImmediate(resolve));

afterEach(() => vi.useRealTimers());

describe("selectionQueue — per-provider FIFO", () => {
  it("grants slots for one provider in arrival order", async () => {
    const order = [];
    const release1 = await acquireProviderSelection("codex");
    order.push("first");

    const second = acquireProviderSelection("codex").then((r) => { order.push("second"); return r; });
    const third = acquireProviderSelection("codex").then((r) => { order.push("third"); return r; });

    await tick();
    expect(order).toEqual(["first"]); // second/third still queued behind first

    release1();
    const release2 = await second;
    expect(order).toEqual(["first", "second"]);

    release2();
    const release3 = await third;
    expect(order).toEqual(["first", "second", "third"]);
    release3();
  });

  it("does not serialize unrelated providers", async () => {
    const releaseA = await acquireProviderSelection("codex"); // held
    // Provider B acquires immediately even while A is still held.
    const releaseB = await acquireProviderSelection("openai");
    expect(typeof releaseB).toBe("function");
    releaseB();
    releaseA();
  });
});

describe("selectionQueue — identity-checked release", () => {
  it("an older holder never frees a newer waiter's slot", async () => {
    const releaseA = await acquireProviderSelection("codex");
    const second = acquireProviderSelection("codex");
    releaseA(); // A releases; B becomes the holder
    const releaseB = await second;

    // Stale, double release from A must not free B.
    releaseA();

    let thirdGranted = false;
    const third = acquireProviderSelection("codex").then((r) => { thirdGranted = true; return r; });
    await tick();
    expect(thirdGranted).toBe(false); // still blocked behind B

    releaseB();
    const releaseC = await third;
    expect(thirdGranted).toBe(true);
    releaseC();
  });

  it("release is idempotent", async () => {
    const release = await acquireProviderSelection("codex");
    release();
    release();
    const next = await acquireProviderSelection("codex");
    expect(typeof next).toBe("function");
    next();
  });
});

describe("selectionQueue — cancellation safety", () => {
  it("rejects an already-aborted signal without touching the queue", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(acquireProviderSelection("codex", { signal: ac.signal })).rejects.toThrow(/abort/i);
    // The queue is still usable afterwards.
    const release = await acquireProviderSelection("codex");
    expect(typeof release).toBe("function");
    release();
  });

  it("a queued waiter cancelled before dispatch rejects and never runs", async () => {
    const releaseA = await acquireProviderSelection("codex"); // holder
    const ac = new AbortController();
    let dispatched = false;
    const queued = acquireProviderSelection("codex", { signal: ac.signal })
      .then((r) => { dispatched = true; return r; });

    await tick();
    ac.abort();
    await expect(queued).rejects.toThrow(/abort/i);
    expect(dispatched).toBe(false); // no release => never dispatched
    releaseA();
  });

  it("a cancellation never poisons the chain (successor still waits for the holder)", async () => {
    const releaseA = await acquireProviderSelection("codex"); // holder
    const ac = new AbortController();
    const cancelled = acquireProviderSelection("codex", { signal: ac.signal });
    const successor = acquireProviderSelection("codex"); // queues behind the cancelled one

    ac.abort();
    await expect(cancelled).rejects.toThrow(/abort/i);

    // The successor must NOT bypass the still-held A.
    let successorGranted = false;
    successor.then((r) => { successorGranted = true; return r; });
    await tick();
    expect(successorGranted).toBe(false);

    releaseA();
    const releaseSuccessor = await successor;
    expect(successorGranted).toBe(true);
    releaseSuccessor();
  });

  it("has no intrinsic timeout — a queued waiter survives hours of fake clock", async () => {
    vi.useFakeTimers();
    const releaseA = await acquireProviderSelection("codex"); // holder
    const ac = new AbortController();
    let granted = false;
    const queued = acquireProviderSelection("codex", { signal: ac.signal })
      .then((r) => { granted = true; return r; });

    // The queue must not time out or auto-release a waiter.
    vi.advanceTimersByTime(6 * 60 * 60 * 1000);
    expect(granted).toBe(false);

    // Cancelling still works promptly, and the chain stays live.
    ac.abort();
    await expect(queued).rejects.toThrow(/abort/i);
    releaseA();

    const next = await acquireProviderSelection("codex");
    expect(typeof next).toBe("function");
    next();
  });
});

describe("selectionQueue — phase hooks", () => {
  it("fires selecting_account when uncontended and both phases when queued", async () => {
    const phases1 = [];
    const release1 = await acquireProviderSelection("codex", { onPhase: (p) => phases1.push(p) });
    expect(phases1).toEqual(["selecting_account"]);

    const phases2 = [];
    const queued = acquireProviderSelection("codex", { onPhase: (p) => phases2.push(p) });
    await tick();
    expect(phases2).toEqual(["selection_wait"]); // waiting, not yet selecting

    release1();
    const release2 = await queued;
    expect(phases2).toEqual(["selection_wait", "selecting_account"]);
    release2();
  });
});
