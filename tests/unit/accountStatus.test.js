import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { checkModelAvailability } from "../../src/sse/services/accountStatus.js";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  getProviderConnections: vi.fn(),
  filterConnectionsForModel: vi.fn((providerId, connections, model, settings) => {
    const override = (settings.providerStrategies || {})[providerId] || {};
    if (override.strictModelAssignment !== true || !model) return connections;
    return connections.filter(c =>
      c.providerSpecificData?.assignedModel === model ||
      (providerId === "freebuff" ? c.providerSpecificData?.freebuffModel === model : false)
    );
  }),
  getModelInfo: vi.fn(),
  getAntigravityQuotaCache: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  getProviderConnections: mocks.getProviderConnections,
}));

vi.mock("@/shared/constants/providers.js", () => ({
  resolveProviderId: vi.fn((id) => id),
  FREE_PROVIDERS: { "noauth-provider": { noAuth: true }, antigravity: { noAuth: false } },
}));

vi.mock("@/sse/services/auth.js", () => ({
  filterConnectionsForModel: mocks.filterConnectionsForModel,
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(),
  pickProxyPoolId: vi.fn(),
}));

vi.mock("open-sse/services/usage/google.js", () => ({
  getAntigravityUsage: vi.fn(),
  getGeminiUsage: vi.fn(),
}));

vi.mock("@/sse/services/antigravityQuota.js", () => ({
  getAntigravityQuotaCache: mocks.getAntigravityQuotaCache,
  refreshAntigravityQuota: vi.fn(),
  handleAntigravityQuotaError: vi.fn(),
  clearAntigravityStrikes: vi.fn(),
}));

vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: mocks.getModelInfo,
}));

describe("checkModelAvailability read-only snapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAntigravityQuotaCache.mockReturnValue(new Map());
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T00:00:00Z"));
    mocks.getSettings.mockResolvedValue({ providerStrategies: {} });
    // Default model info for generic tests (openai/gpt-4)
    mocks.getModelInfo.mockResolvedValue({ provider: "openai", model: "gpt-4" });
  });
  afterEach(() => vi.useRealTimers());

  it("returns availableCount > 0 for free/no-auth provider", async () => {
    mocks.getModelInfo.mockResolvedValue({ provider: "noauth-provider", model: "model-x" });
    const res = await checkModelAvailability("noauth-provider/model-x");
    expect(res).toEqual({ availableCount: 1, totalCount: 1, retryAfter: null });
  });

  it("returns availableCount = 0 when no connections exist", async () => {
    mocks.getModelInfo.mockResolvedValue({ provider: "openai", model: "gpt-4" });
    mocks.getProviderConnections.mockResolvedValue([]);
    const res = await checkModelAvailability("openai/gpt-4");
    expect(res).toEqual({ availableCount: 0, totalCount: 0, retryAfter: null });
  });

  it("excludes connection IDs passed in excludeConnectionIds", async () => {
    mocks.getModelInfo.mockResolvedValue({ provider: "openai", model: "gpt-4" });
    const conns = [
      { id: "conn-1", isActive: true, providerSpecificData: {} },
      { id: "conn-2", isActive: true, providerSpecificData: {} },
    ];
    mocks.getProviderConnections.mockResolvedValue(conns);
    const res = await checkModelAvailability("openai/gpt-4", new Set(["conn-1"]));
    expect(res).toEqual({ availableCount: 1, totalCount: 2, retryAfter: null });
  });

  it("applies strict model assignment filter when provider strategy requires it", async () => {
    mocks.getModelInfo.mockResolvedValue({ provider: "freebuff", model: "mimo/mimo-v2.5" });
    const conns = [
      { id: "conn-1", isActive: true, providerSpecificData: { assignedModel: "mimo/mimo-v2.5" } },
      { id: "conn-2", isActive: true, providerSpecificData: { assignedModel: "other/model" } },
    ];
    mocks.getProviderConnections.mockResolvedValue(conns);
    mocks.getSettings.mockResolvedValue({
      providerStrategies: { freebuff: { strictModelAssignment: true } }
    });
    const res = await checkModelAvailability("freebuff/mimo/mimo-v2.5");
    expect(res.availableCount).toBe(1);
    expect(res.totalCount).toBe(1);
  });

  it("skips model-locked connections and reports retryAfter from earliest lock", async () => {
    mocks.getModelInfo.mockResolvedValue({ provider: "openai", model: "gpt-4" });
    const future = new Date("2026-10-14T00:05:00Z").toISOString();
    const conns = [
      { id: "conn-1", isActive: true, providerSpecificData: {}, "modelLock_gpt-4": future },
      { id: "conn-2", isActive: true, providerSpecificData: {} },
    ];
    mocks.getProviderConnections.mockResolvedValue(conns);
    const res = await checkModelAvailability("openai/gpt-4");
    expect(res.availableCount).toBe(1);
    expect(res.totalCount).toBe(2);
    expect(res.retryAfter).toBe(future);
  });

  it("skips Antigravity quota-exhausted connections with future resetAt", async () => {
    const { setQuotaSnapshot } = await import("../../src/sse/services/quotaStore.js");
    mocks.getModelInfo.mockResolvedValue({ provider: "antigravity", model: "gemini-2.5-pro" });
    const resetAt = new Date("2026-10-14T00:10:00Z").toISOString();
    mocks.getAntigravityQuotaCache.mockReturnValue(new Map([
      ["ag-1", { "gemini-2.5-pro": { remainingPercentage: 0, resetAt } }]
    ]));
    const conns = [
      { id: "ag-1", isActive: true, providerSpecificData: {} },
    ];
    mocks.getProviderConnections.mockResolvedValue(conns);
    const res = await checkModelAvailability("antigravity/gemini-2.5-pro");
    expect(res.availableCount).toBe(0);
    expect(res.totalCount).toBe(1);
    expect(res.retryAfter).toBe(resetAt);
  });

  it("does NOT skip Antigravity when quota remaining > 0", async () => {
    const { setQuotaSnapshot } = await import("../../src/sse/services/quotaStore.js");
    mocks.getModelInfo.mockResolvedValue({ provider: "antigravity", model: "gemini-2.5-pro" });
    mocks.getAntigravityQuotaCache.mockReturnValue(new Map([
      ["ag-1", { "gemini-2.5-pro": { remainingPercentage: 50, resetAt: new Date("2026-10-14T00:10:00Z").toISOString() } }]
    ]));
    const conns = [
      { id: "ag-1", isActive: true, providerSpecificData: {} },
    ];
    mocks.getProviderConnections.mockResolvedValue(conns);
    const res = await checkModelAvailability("antigravity/gemini-2.5-pro");
    expect(res.availableCount).toBe(1);
    expect(res.totalCount).toBe(1);
    expect(res.retryAfter).toBeNull();
  });

  it("does NOT skip Antigravity when resetAt is in the past", async () => {
    const { setQuotaSnapshot } = await import("../../src/sse/services/quotaStore.js");
    mocks.getModelInfo.mockResolvedValue({ provider: "antigravity", model: "gemini-2.5-pro" });
    const past = new Date("2026-10-13T23:00:00Z").toISOString();
    mocks.getAntigravityQuotaCache.mockReturnValue(new Map([
      ["ag-1", { "gemini-2.5-pro": { remainingPercentage: 0, resetAt: past } }]
    ]));
    const conns = [
      { id: "ag-1", isActive: true, providerSpecificData: {} },
    ];
    mocks.getProviderConnections.mockResolvedValue(conns);
    const res = await checkModelAvailability("antigravity/gemini-2.5-pro");
    expect(res.availableCount).toBe(1);
    expect(res.retryAfter).toBeNull();
  });

  it("does NOT skip Antigravity when quota not in cache (unknown)", async () => {
    mocks.getModelInfo.mockResolvedValue({ provider: "antigravity", model: "gemini-2.5-pro" });
    const conns = [
      { id: "ag-1", isActive: true, providerSpecificData: {} },
    ];
    mocks.getProviderConnections.mockResolvedValue(conns);
    mocks.getAntigravityQuotaCache.mockReturnValue(new Map()); // empty cache
    const res = await checkModelAvailability("antigravity/gemini-2.5-pro");
    expect(res.availableCount).toBe(1);
    expect(res.retryAfter).toBeNull();
  });

  it("uses getModelInfo for alias/slash resolution (not naive split)", async () => {
    mocks.getModelInfo.mockResolvedValue({ provider: "openrouter", model: "anthropic/claude-3-opus" });
    mocks.getProviderConnections.mockResolvedValue([
      { id: "conn-1", isActive: true, providerSpecificData: {} },
    ]);
    const res = await checkModelAvailability("openrouter/anthropic/claude-3-opus");
    expect(mocks.getModelInfo).toHaveBeenCalledWith("openrouter/anthropic/claude-3-opus");
    expect(res.totalCount).toBe(1);
  });

  it("skips Codex connection when relevant quota window is exhausted in quotaStore", async () => {
    const { setQuotaSnapshot } = await import("../../src/sse/services/quotaStore.js");
    mocks.getModelInfo.mockResolvedValue({ provider: "codex", model: "gpt-5.3-codex-spark" });
    const resetAt = new Date("2026-10-14T02:00:00Z").toISOString();
    setQuotaSnapshot("codex-1", "codex", {
      spark_session: { remaining: 0, total: 100, resetAt },
    });
    mocks.getProviderConnections.mockResolvedValue([
      { id: "codex-1", isActive: true, providerSpecificData: {} },
    ]);
    const res = await checkModelAvailability("codex/gpt-5.3-codex-spark");
    expect(res.availableCount).toBe(0);
    expect(res.totalCount).toBe(1);
    expect(res.retryAfter).toBe(resetAt);
  });

  it("accounts for account-level lock (modelLock___all)", async () => {
    mocks.getModelInfo.mockResolvedValue({ provider: "openai", model: "gpt-4" });
    const future = new Date("2026-10-14T00:05:00Z").toISOString();
    const conns = [
      { id: "conn-1", isActive: true, providerSpecificData: {}, modelLock___all: future },
    ];
    mocks.getProviderConnections.mockResolvedValue(conns);
    const res = await checkModelAvailability("openai/gpt-4");
    expect(res.availableCount).toBe(0);
    expect(res.retryAfter).toBe(future);
  });
});