// Integration tests for the paired pending-request counters and their lifecycle
// bridge. The historical defect: parallel requests shared one timer/counter, so
// one request finishing wiped its siblings, counters went negative, and a 60s
// timer could reset a whole model bucket (including other accounts).
//
// These tests drive the real `trackPendingRequest` pairing contract and assert
// through the shared in-memory state (`globalThis._pendingRequests`) plus the
// lifecycle snapshot returned additively by `getActiveRequests`.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// usageRepo only touches RAM for pending tracking; the adapter is needed only by
// getActiveRequests' ring/connection loading, so a minimal stub keeps the test
// hermetic (no sqlite driver, no `uuid` dependency).
vi.mock("../../src/lib/db/driver.js", () => ({
  getAdapter: async () => ({
    all: () => [],
    get: () => null,
    run: () => {},
    exec: () => {},
    transaction: (fn) => fn(),
  }),
}));
vi.mock("../../src/lib/db/repos/connectionsRepo.js", () => ({
  getProviderConnections: async () => [],
}));

import { trackPendingRequest, getActiveRequests } from "../../src/lib/db/repos/usageRepo.js";
import { createRequestLifecycle, getRequestLifecycleSnapshot } from "../../src/lib/requestLifecycle.js";

const MODEL_KEY = "gpt-4 (openai)";

function resetSharedState() {
  const g = globalThis;
  if (!g._pendingRequests) g._pendingRequests = { byModel: {}, byAccount: {} };
  g._pendingRequests.byModel = {};
  g._pendingRequests.byAccount = {};
  if (g._pendingEntries) g._pendingEntries.clear();
  if (g._lastErrorProvider) {
    g._lastErrorProvider.provider = "";
    g._lastErrorProvider.ts = 0;
  }
  const state = g.__requestLifecycleState;
  if (state) {
    state.active.clear();
    state.recent.length = 0;
    state.activeCount = 0;
    state.overflowActive = 0;
    state.droppedDetails = 0;
    state.droppedAttempts = 0;
  }
}

beforeEach(resetSharedState);
afterEach(() => vi.useRealTimers());

describe("pending counters — parallel isolation", () => {
  it.each([1, 2, 4, 8])(
    "%i parallel requests on one account+model keep isolated siblings and return to zero",
    (n) => {
      const ids = Array.from({ length: n }, (_, i) => `p-${i}`);
      for (const id of ids) trackPendingRequest("gpt-4", "openai", "acct-1", true, false, id);

      expect(globalThis._pendingRequests.byModel[MODEL_KEY]).toBe(n);
      expect(globalThis._pendingRequests.byAccount["acct-1"][MODEL_KEY]).toBe(n);

      ids.forEach((id, index) => {
        trackPendingRequest("gpt-4", "openai", "acct-1", false, false, id);
        const remaining = n - index - 1;
        if (remaining > 0) {
          // A sibling finishing must never wipe the others.
          expect(globalThis._pendingRequests.byModel[MODEL_KEY]).toBe(remaining);
          expect(globalThis._pendingRequests.byAccount["acct-1"][MODEL_KEY]).toBe(remaining);
          expect(remaining).toBeGreaterThanOrEqual(0);
        } else {
          expect(globalThis._pendingRequests.byModel[MODEL_KEY]).toBeUndefined();
          expect(globalThis._pendingRequests.byAccount["acct-1"]).toBeUndefined();
        }
      });

      expect(Object.keys(globalThis._pendingRequests.byModel)).toHaveLength(0);
      expect(Object.keys(globalThis._pendingRequests.byAccount)).toHaveLength(0);
    }
  );

  it("keeps different accounts independent", () => {
    trackPendingRequest("gpt-4", "openai", "acct-1", true, false, "a1");
    trackPendingRequest("gpt-4", "openai", "acct-2", true, false, "a2");
    expect(globalThis._pendingRequests.byModel[MODEL_KEY]).toBe(2);
    expect(globalThis._pendingRequests.byAccount["acct-1"][MODEL_KEY]).toBe(1);
    expect(globalThis._pendingRequests.byAccount["acct-2"][MODEL_KEY]).toBe(1);

    trackPendingRequest("gpt-4", "openai", "acct-1", false, false, "a1");
    expect(globalThis._pendingRequests.byModel[MODEL_KEY]).toBe(1);
    expect(globalThis._pendingRequests.byAccount["acct-1"]).toBeUndefined();
    expect(globalThis._pendingRequests.byAccount["acct-2"][MODEL_KEY]).toBe(1);
  });

  it("does not double-count a repeated start for the same pending id", () => {
    trackPendingRequest("gpt-4", "openai", "acct-1", true, false, "dup");
    trackPendingRequest("gpt-4", "openai", "acct-1", true, false, "dup");
    expect(globalThis._pendingRequests.byModel[MODEL_KEY]).toBe(1);
  });
});

describe("pending counters — idempotent finish", () => {
  it("treats repeated / unknown finishes as no-ops without going negative", () => {
    trackPendingRequest("gpt-4", "openai", "acct-1", true, false, "x");
    trackPendingRequest("gpt-4", "openai", "acct-1", false, false, "x");
    expect(globalThis._pendingRequests.byModel[MODEL_KEY]).toBeUndefined();

    trackPendingRequest("gpt-4", "openai", "acct-1", false, false, "x"); // already finished
    trackPendingRequest("gpt-4", "openai", "acct-1", false, false, "never-started");
    expect(globalThis._pendingRequests.byModel[MODEL_KEY]).toBeUndefined();
    expect(Object.keys(globalThis._pendingRequests.byModel)).toHaveLength(0);
    expect(Object.keys(globalThis._pendingRequests.byAccount)).toHaveLength(0);
  });

  it("preserves the legacy id-less balanced contract and clamps underflow", () => {
    trackPendingRequest("m", "p", "c", true);
    expect(globalThis._pendingRequests.byModel["m (p)"]).toBe(1);
    trackPendingRequest("m", "p", "c", false);
    expect(globalThis._pendingRequests.byModel["m (p)"]).toBeUndefined();
    trackPendingRequest("m", "p", "c", false); // extra finish must clamp at zero
    expect(globalThis._pendingRequests.byModel["m (p)"]).toBeUndefined();
  });
});

describe("pending counters — long reasoning is never expired by a shared timer", () => {
  it("keeps a request active past 60s of inactivity", () => {
    vi.useFakeTimers();
    trackPendingRequest("gpt-4", "openai", "acct-1", true, false, "long");
    expect(globalThis._pendingRequests.byModel[MODEL_KEY]).toBe(1);

    vi.advanceTimersByTime(10 * 60 * 1000); // 10 minutes, well past the old 60s timer
    expect(globalThis._pendingRequests.byModel[MODEL_KEY]).toBe(1);
    expect(globalThis._pendingRequests.byAccount["acct-1"][MODEL_KEY]).toBe(1);

    trackPendingRequest("gpt-4", "openai", "acct-1", false, false, "long");
    expect(globalThis._pendingRequests.byModel[MODEL_KEY]).toBeUndefined();
  });
});

describe("getActiveRequests — backward-compatible aggregate with additive lifecycle", () => {
  it("keeps legacy keys while adding lifecycle metadata", async () => {
    trackPendingRequest("gpt-4", "openai", "acct-1", true, false, "r1");
    trackPendingRequest("gpt-4", "openai", "acct-1", true, false, "r2");

    const result = await getActiveRequests();

    // Legacy contract.
    expect(Array.isArray(result.activeRequests)).toBe(true);
    expect(result.activeRequests).toHaveLength(1);
    expect(result.activeRequests[0].model).toBe("gpt-4");
    expect(result.activeRequests[0].provider).toBe("openai");
    expect(result.activeRequests[0].count).toBe(2);
    expect(typeof result.activeRequests[0].account).toBe("string");
    expect(Array.isArray(result.recentRequests)).toBe(true);
    expect(result.errorProvider).toBe("");
    expect(result.pending.byModel[MODEL_KEY]).toBe(2);

    // Additive lifecycle metadata.
    expect(Array.isArray(result.lifecycleRequests)).toBe(true);
    expect(Array.isArray(result.recentLifecycleRequests)).toBe(true);
    expect(result.trackingOverflow).toEqual(
      expect.objectContaining({
        activeCount: expect.any(Number),
        retainedActive: expect.any(Number),
        overflowActive: expect.any(Number),
      })
    );

    trackPendingRequest("gpt-4", "openai", "acct-1", false, false, "r1");
    trackPendingRequest("gpt-4", "openai", "acct-1", false, false, "r2");
    expect(globalThis._pendingRequests.byModel[MODEL_KEY]).toBeUndefined();
  });
});

describe("pending counters — lifecycle bridge mirrors chat.js/chatCore", () => {
  it("keeps the logical request active across a fallback account switch", () => {
    // A logical request whose first account attempt fails, then a second succeeds.
    const lc = createRequestLifecycle({});
    lc.onPhase("received", { model: "gpt-4" });

    const a1 = lc.beginAttempt({ provider: "openai", model: "gpt-4", connectionId: "acct-1" });
    trackPendingRequest("gpt-4", "openai", "acct-1", true, false, a1.id);
    a1.onPhase("preparing_request");
    a1.onMilestone("first_raw_byte");
    a1.finishAttempt("error");
    trackPendingRequest("gpt-4", "openai", "acct-1", false, true, a1.id);

    // Fallback must NOT finish the logical request, and the sibling counter is clean.
    expect(lc.snapshot().terminal).toBeNull();
    expect(getRequestLifecycleSnapshot().trackingOverflow.activeCount).toBe(1);
    expect(globalThis._pendingRequests.byModel[MODEL_KEY]).toBeUndefined();

    const a2 = lc.beginAttempt({ provider: "openai", model: "gpt-4", connectionId: "acct-2" });
    trackPendingRequest("gpt-4", "openai", "acct-2", true, false, a2.id);
    expect(globalThis._pendingRequests.byModel[MODEL_KEY]).toBe(1);

    a1.onPhase("streaming"); // ended attempt: strictly inert
    a2.onPhase("streaming");
    a2.onMilestone("first_event");
    a2.finishAttempt("completed");
    trackPendingRequest("gpt-4", "openai", "acct-2", false, false, a2.id);

    // Still logical-active until handleChat's stream teardown finishes it.
    expect(lc.snapshot().terminal).toBeNull();
    lc.finish("completed");

    const snap = lc.snapshot();
    expect(snap.terminal).toBe("completed");
    expect(snap.attemptCount).toBe(2);
    expect(snap.attempts.find((a) => a.id === a1.id).terminal).toBe("error");
    expect(snap.attempts.find((a) => a.id === a2.id).terminal).toBe("completed");
    expect(globalThis._pendingRequests.byModel[MODEL_KEY]).toBeUndefined();
    expect(getRequestLifecycleSnapshot().trackingOverflow.activeCount).toBe(0);
  });
});
