import { describe, it, expect, vi, beforeEach } from "vitest";

const cache = new Map();
const ensureFresh = vi.fn(async () => null);

vi.mock("../../src/sse/services/antigravityQuota.js", () => ({
  getAntigravityQuotaCache: () => cache,
  // Keep the real resolution out of scope: tests provide exact per-model quotas.
  getAntigravityModelQuota: (quotas, model) => (quotas && model ? quotas[model] || null : null),
  ensureAntigravityQuotaFresh: (...args) => ensureFresh(...args),
}));

const { rankAntigravityConnections, hasSessionWindow } = await import("../../src/sse/services/accountQuotaRanker.js");

const conn = (id, extra = {}) => ({ id, email: id + "@x", priority: extra.priority ?? 1, isActive: true, accessToken: "t", ...extra });

function setQuota(id, model, remaining, resetAt = null, session = false) {
  const quotas = { [model]: { remainingPercentage: remaining, resetAt } };
  if (session) quotas.gemini_session = { remainingPercentage: remaining, resetAt };
  cache.set(id, quotas);
}

describe("quota-aware antigravity rotation", () => {
  beforeEach(() => {
    cache.clear();
    ensureFresh.mockClear();
  });

  it("ranks by remaining quota, highest first", async () => {
    setQuota("a", "gemini-3.8-flash-high", 20);
    setQuota("b", "gemini-3.8-flash-high", 90);
    setQuota("c", "gemini-3.8-flash-high", 55);
    const { ranked } = await rankAntigravityConnections({
      connections: [conn("a"), conn("b"), conn("c")],
      model: "gemini-3.8-flash-high",
    });
    expect(ranked.map((c) => c.id)).toEqual(["b", "c", "a"]);
  });

  it("excludes exhausted accounts and reports the earliest reset", async () => {
    const soon = new Date(Date.now() + 60_000).toISOString();
    const later = new Date(Date.now() + 600_000).toISOString();
    setQuota("full", "m", 80);
    setQuota("out1", "m", 0, later);
    setQuota("out2", "m", 0, soon);
    const { ranked, retryAfter, suppressed } = await rankAntigravityConnections({
      connections: [conn("out1"), conn("full"), conn("out2")],
      model: "m",
    });
    expect(ranked.map((c) => c.id)).toEqual(["full"]);
    expect(retryAfter).toBe(soon);
    expect(suppressed.filter((s) => s.reason === "exhausted")).toHaveLength(2);
  });

  it("prefers a paid plan (5h session bucket) when quota ties", async () => {
    setQuota("free", "m", 90, null, false);
    setQuota("paid", "m", 90, null, true);
    const { ranked } = await rankAntigravityConnections({
      connections: [conn("free", { priority: 1 }), conn("paid", { priority: 5 })],
      model: "m",
    });
    expect(ranked[0].id).toBe("paid");
  });

  it("keeps the current account while it is above the switch threshold", async () => {
    setQuota("current", "m", 40, null, true);
    setQuota("better", "m", 95, null, true);
    const { ranked } = await rankAntigravityConnections({
      connections: [conn("current"), conn("better")],
      model: "m",
      preferredConnectionId: "current",
      switchBelowPct: 15,
    });
    expect(ranked[0].id).toBe("current");
  });

  it("switches away once the current account drops below the threshold", async () => {
    setQuota("current", "m", 5, null, true);
    setQuota("better", "m", 95, null, true);
    const { ranked } = await rankAntigravityConnections({
      connections: [conn("current"), conn("better")],
      model: "m",
      preferredConnectionId: "current",
      switchBelowPct: 15,
    });
    expect(ranked[0].id).toBe("better");
  });

  it("schedules a background refresh for unknown quota without blocking", async () => {
    const { ranked } = await rankAntigravityConnections({
      connections: [conn("unknown", { priority: 1 }), conn("known", { priority: 2 })],
      model: "m",
      refreshBudget: 2,
    });
    setQuota("known", "m", 50);
    expect(ranked).toHaveLength(2);
    expect(ensureFresh).toHaveBeenCalledWith("unknown", "t", undefined);
  });

  it("drops TOS-banned and inactive accounts", async () => {
    setQuota("ok", "m", 50);
    const { ranked, suppressed } = await rankAntigravityConnections({
      connections: [
        conn("banned", { lastError: "TOS_VIOLATION: service disabled by upstream" }),
        conn("off", { isActive: false }),
        conn("ok"),
      ],
      model: "m",
    });
    expect(ranked.map((c) => c.id)).toEqual(["ok"]);
    expect(suppressed.map((s) => s.reason).sort()).toEqual(["inactive", "tos"]);
  });

  it("detects paid plans from a session bucket", () => {
    expect(hasSessionWindow({ gemini_session: { remainingPercentage: 1 } })).toBe(true);
    expect(hasSessionWindow({ gemini_weekly: { remainingPercentage: 1 } })).toBe(false);
  });
});