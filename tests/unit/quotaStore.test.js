import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setQuotaSnapshot, getQuotaStore, isConnectionQuotaBlocked } from "../../src/sse/services/quotaStore.js";
const ag = vi.hoisted(() => new Map());
vi.mock("../../src/sse/services/antigravityQuota.js", () => ({ getAntigravityQuotaCache: () => ag }));

describe("passive quota snapshots", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-14T00:00:00Z")); getQuotaStore().clear(); ag.clear(); });
  afterEach(() => vi.useRealTimers());
  const future = "2026-10-14T02:00:00Z";
  it("uses authoritative AG cache including newly created and cleared strike blocks", () => {
    ag.set("a", { model: { remainingPercentage: 0, resetAt: future } });
    expect(isConnectionQuotaBlocked("antigravity", "model", { id: "a" }).isBlocked).toBe(true);
    ag.delete("a");
    expect(isConnectionQuotaBlocked("antigravity", "model", { id: "a" }).isBlocked).toBe(false);
  });
  it("keeps spark quota separate from normal Codex", () => {
    setQuotaSnapshot("a", "codex", { spark_session: { remaining: 0, resetAt: future } });
    expect(isConnectionQuotaBlocked("codex", "gpt-5-codex", { id: "a" }).isBlocked).toBe(false);
    expect(isConnectionQuotaBlocked("codex", "gpt-5.3-codex-spark", { id: "a" }).isBlocked).toBe(true);
  });
  it("uses latest reset among exhausted windows", () => {
    setQuotaSnapshot("a", "codex", { session: { remaining: 0, resetAt: future }, weekly: { remaining: 0, resetAt: "2026-10-15T00:00:00Z" } });
    expect(isConnectionQuotaBlocked("codex", "gpt-5", { id: "a" }).resetUntilMs).toBe(Date.parse("2026-10-15T00:00:00Z"));
  });
  it("never guesses GitHub premium scope from model names", () => {
    setQuotaSnapshot("a", "github", { premium_interactions: { remaining: 0, resetAt: future } });
    expect(isConnectionQuotaBlocked("github", "claude", { id: "a" }).isBlocked).toBe(false);
    expect(isConnectionQuotaBlocked("github", "claude", { id: "a", providerSpecificData: { modelQuotaScopes: { claude: "premium_interactions" } } }).isBlocked).toBe(true);
  });
  it("ignores stale, invalid, unknown and provider-mismatched readings", () => {
    setQuotaSnapshot("a", "codex", { session: { remaining: 0, resetAt: future } });
    expect(isConnectionQuotaBlocked("github", "model", { id: "a" }).isBlocked).toBe(false);
    vi.advanceTimersByTime(300001);
    expect(isConnectionQuotaBlocked("codex", "model", { id: "a" }).isBlocked).toBe(false);
  });
  it("does not overwrite newer observations", () => {
    setQuotaSnapshot("a", "codex", { session: { remaining: 80, resetAt: future } });
    setQuotaSnapshot("a", "codex", { session: { remaining: 0, resetAt: future } }, Date.now() - 1);
    expect(isConnectionQuotaBlocked("codex", "model", { id: "a" }).isBlocked).toBe(false);
  });
});
