// Unit tests for the RAM-only request/attempt lifecycle helper.
//
// Covers: unique request + attempt identity, execution index milestones,
// monotonic non-negative durations, phase/milestone tracking, idempotent
// finishAttempt / finish, fallback isolation (an attempt finishing must NOT
// finish the logical request), bounded attempt + terminal history, and a
// bounded active set with a truthful overflow counter that never throws.
import { describe, it, expect, beforeEach } from "vitest";
import { createRequestLifecycle, getRequestLifecycleSnapshot } from "../../src/lib/requestLifecycle.js";

const PHASES = [
  "received",
  "selection_wait",
  "selecting_account",
  "preparing_credentials",
  "preparing_request",
  "upstream_headers_wait",
  "first_event_wait",
  "streaming",
];

// The helper keeps its state on globalThis so Next.js dev reloads share it.
// Reset in place (a fresh module import would keep pointing at the same object).
function resetLifecycleState() {
  const state = globalThis.__requestLifecycleState;
  if (!state) return;
  state.active.clear();
  state.recent.length = 0;
  state.activeCount = 0;
  state.overflowActive = 0;
  state.droppedDetails = 0;
  state.droppedAttempts = 0;
}

beforeEach(resetLifecycleState);

describe("request lifecycle — identity & attempts", () => {
  it("allocates a unique request id per logical request", () => {
    const a = createRequestLifecycle({ provider: "openai", model: "gpt-4" });
    const b = createRequestLifecycle({ provider: "openai", model: "gpt-4" });
    expect(typeof a.id).toBe("string");
    expect(a.id.length).toBeGreaterThan(0);
    expect(a.id).not.toBe(b.id);
  });

  it("allocates a distinct attempt id per account try", () => {
    const lc = createRequestLifecycle({});
    const a1 = lc.beginAttempt({ provider: "openai", model: "gpt-4", connectionId: "acct-1" });
    const a2 = lc.beginAttempt({ provider: "openai", model: "gpt-4", connectionId: "acct-2" });
    expect(typeof a1.id).toBe("string");
    expect(a1.id).not.toBe(a2.id);
    expect(a1.id).not.toBe(lc.id);
    const snap = lc.snapshot();
    expect(snap.attemptCount).toBe(2);
    expect(snap.attempts.map((a) => a.id)).toEqual([a1.id, a2.id]);
  });

  it("records execution index milestones for proxy / refresh dispatches", () => {
    const lc = createRequestLifecycle({});
    const attempt = lc.beginAttempt({ provider: "openai", model: "gpt-4", connectionId: "acct-1" });
    attempt.onMilestone("upstream_dispatch_1");
    attempt.onMilestone("upstream_headers");
    attempt.onMilestone("upstream_dispatch_2");
    const keys = Object.keys(lc.snapshot().milestones);
    expect(keys).toEqual(
      expect.arrayContaining(["upstream_dispatch_1", "upstream_headers", "upstream_dispatch_2"])
    );
  });
});

describe("request lifecycle — phases & milestones", () => {
  it("tracks every named phase with non-negative durations", () => {
    const lc = createRequestLifecycle({});
    for (const phase of PHASES) lc.onPhase(phase);
    lc.finish("completed");
    const snap = lc.snapshot();
    expect(snap.phase).toBe("streaming");
    expect(snap.terminal).toBe("completed");
    expect(Object.keys(snap.phaseDurations)).toEqual(expect.arrayContaining(PHASES));
    for (const duration of Object.values(snap.phaseDurations)) {
      expect(duration).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(duration)).toBe(true);
    }
  });

  it("records first_raw_byte / first_event / stream milestones separately and only once", () => {
    const lc = createRequestLifecycle({});
    lc.onMilestone("first_raw_byte");
    lc.onMilestone("first_event");
    lc.onMilestone("first_raw_byte"); // idempotent: first write wins
    const milestones = lc.snapshot().milestones;
    expect(Object.keys(milestones)).toEqual(expect.arrayContaining(["first_raw_byte", "first_event"]));
    expect(Object.keys(milestones).length).toBe(2);
    for (const at of Object.values(milestones)) expect(at).toBeGreaterThanOrEqual(0);
  });

  it("stores only safe metadata and ignores prompt / credential payloads", () => {
    const lc = createRequestLifecycle({});
    lc.onPhase("streaming", {
      provider: "openai",
      model: "gpt-4",
      connectionId: "conn-1234567890",
      prompt: "TOPSECRET-PROMPT",
      apiKey: "sk-super-secret",
      tokens: { completion_tokens: 9999 },
      toolPayload: { name: "danger" },
      rawError: { stack: "boom" },
    });
    const snap = lc.snapshot();
    const serialized = JSON.stringify(snap);
    expect(serialized).not.toContain("TOPSECRET-PROMPT");
    expect(serialized).not.toContain("sk-super-secret");
    expect(serialized).not.toContain("danger");
    expect(serialized).not.toContain("boom");
    // account is a truncated id prefix, never a full credential string
    expect(snap.account).toBe("conn-123...");
    expect(serialized).not.toContain("conn-1234567890");
  });

  it("bounds adversarial label lengths", () => {
    const lc = createRequestLifecycle({});
    lc.onPhase("streaming", { provider: "P".repeat(5000) });
    expect(lc.snapshot().provider.length).toBe(160);
  });

  it("exposes only the documented snapshot keys", () => {
    const lc = createRequestLifecycle({});
    lc.beginAttempt({ provider: "openai", model: "gpt-4", connectionId: "acct-1" });
    const keys = Object.keys(lc.snapshot()).sort();
    expect(keys).toEqual(
      [
        "account",
        "attemptCount",
        "attempts",
        "droppedAttempts",
        "elapsedMs",
        "id",
        "milestones",
        "model",
        "phase",
        "phaseDurations",
        "phaseElapsedMs",
        "provider",
        "terminal",
      ].sort()
    );
  });
});

describe("request lifecycle — finish semantics", () => {
  it("finish is idempotent (first status wins, one history entry)", () => {
    const lc = createRequestLifecycle({});
    lc.finish("completed");
    lc.finish("error");
    expect(lc.snapshot().terminal).toBe("completed");
    const history = getRequestLifecycleSnapshot().recentLifecycleRequests.filter((r) => r.id === lc.id);
    expect(history).toHaveLength(1);
    expect(history[0].terminal).toBe("completed");
  });

  it("finishAttempt is idempotent", () => {
    const lc = createRequestLifecycle({});
    const attempt = lc.beginAttempt({ provider: "openai", model: "gpt-4", connectionId: "acct-1" });
    attempt.finishAttempt("error");
    attempt.finishAttempt("completed");
    const recorded = lc.snapshot().attempts.find((a) => a.id === attempt.id);
    expect(recorded.terminal).toBe("error");
  });

  it("finishing one attempt does NOT finish the logical request (fallback isolation)", () => {
    const lc = createRequestLifecycle({});
    const attempt = lc.beginAttempt({ provider: "openai", model: "gpt-4", connectionId: "acct-1" });
    attempt.finishAttempt("error");
    expect(lc.snapshot().terminal).toBeNull();
    expect(getRequestLifecycleSnapshot().trackingOverflow.activeCount).toBe(1);
    lc.finish("completed");
    expect(lc.snapshot().terminal).toBe("completed");
  });

  it("finishing the logical request closes any open child attempts", () => {
    const lc = createRequestLifecycle({});
    const a1 = lc.beginAttempt({ provider: "openai", model: "gpt-4", connectionId: "acct-1" });
    const a2 = lc.beginAttempt({ provider: "openai", model: "gpt-4", connectionId: "acct-2" });
    lc.finish("completed");
    const snap = lc.snapshot();
    expect(snap.attempts.find((a) => a.id === a1.id).terminal).toBe("completed");
    expect(snap.attempts.find((a) => a.id === a2.id).terminal).toBe("completed");
  });

  it("ignores attempts begun after the request has finished", () => {
    const lc = createRequestLifecycle({});
    lc.finish("completed");
    const late = lc.beginAttempt({ provider: "openai", model: "gpt-4", connectionId: "acct-1" });
    late.onPhase("streaming");
    late.onMilestone("first_event");
    late.finishAttempt("error");
    const snap = lc.snapshot();
    expect(snap.attemptCount).toBe(0);
    expect(snap.attempts).toHaveLength(0);
    expect(snap.terminal).toBe("completed");
  });
});

describe("request lifecycle — bounded history", () => {
  it("bounds the terminal history to 50 entries", () => {
    for (let i = 0; i < 55; i++) createRequestLifecycle({ model: `m${i}` }).finish("completed");
    expect(getRequestLifecycleSnapshot().recentLifecycleRequests.length).toBe(50);
  });

  it("bounds per-request attempt history to 20 with truthful droppedAttempts", () => {
    const lc = createRequestLifecycle({});
    for (let i = 0; i < 25; i++) {
      lc.beginAttempt({ provider: "openai", model: "gpt-4", connectionId: `acct-${i}` });
    }
    const snap = lc.snapshot();
    expect(snap.attemptCount).toBe(25);
    expect(snap.attempts).toHaveLength(20);
    expect(snap.droppedAttempts).toBe(5);
  });
});

describe("request lifecycle — active cap & overflow", () => {
  it("caps detailed active tracking at 1000 with a truthful overflow counter", () => {
    const lifecycles = [];
    for (let i = 0; i < 1001; i++) lifecycles.push(createRequestLifecycle({ model: `m${i}` }));
    const snap = getRequestLifecycleSnapshot();
    expect(snap.lifecycleRequests.length).toBe(1000);
    expect(snap.trackingOverflow.activeCount).toBe(1001);
    expect(snap.trackingOverflow.retainedActive).toBe(1000);
    expect(snap.trackingOverflow.overflowActive).toBe(1);
    expect(snap.trackingOverflow.droppedDetails).toBeGreaterThanOrEqual(1);

    for (const lc of lifecycles) lc.finish("completed");
    const after = getRequestLifecycleSnapshot();
    expect(after.trackingOverflow.activeCount).toBe(0);
    expect(after.trackingOverflow.overflowActive).toBe(0);
    expect(after.trackingOverflow.retainedActive).toBe(0);
  });

  it("never rejects or throws when the active set overflows", () => {
    expect(() => {
      for (let i = 0; i < 1100; i++) createRequestLifecycle({ model: `m${i}` });
    }).not.toThrow();
    expect(getRequestLifecycleSnapshot().trackingOverflow.overflowActive).toBe(100);
  });
});

describe("request lifecycle — monotonic durations", () => {
  it("reports non-negative, non-decreasing durations", async () => {
    const lc = createRequestLifecycle({});
    lc.onPhase("received");
    const first = lc.snapshot();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = lc.snapshot();
    expect(second.elapsedMs).toBeGreaterThanOrEqual(first.elapsedMs);
    expect(second.phaseElapsedMs).toBeGreaterThanOrEqual(0);
    expect(first.elapsedMs).toBeGreaterThanOrEqual(0);
    for (const value of [...Object.values(first.phaseDurations), ...Object.values(second.phaseDurations)]) {
      expect(value).toBeGreaterThanOrEqual(0);
    }
  });
});
