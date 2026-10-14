// Integration tests for the per-provider selection lock at the auth boundary.
//
// Verifies that getProviderCredentials() serializes account selection PER
// canonical provider (not globally, not per model):
//   - a slow provider-A selection does not hold provider-B
//   - canonical aliases resolve to one provider BEFORE locking, so they share
//     exactly one lock
//   - round-robin updates stay consistent under parallel contention
//   - a request cancelled while queued never enters the critical section
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getSettings: vi.fn(),
  getProxyPools: vi.fn(),
  updateProviderConnection: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  pickProxyPoolId: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getSettings: mocks.getSettings,
  getProxyPools: mocks.getProxyPools,
  updateProviderConnection: mocks.updateProviderConnection,
  validateApiKey: vi.fn(),
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
  pickProxyPoolId: mocks.pickProxyPoolId,
}));
// Keep the module graph hermetic: antigravityQuota imports the real usage client.
vi.mock("open-sse/services/usage/google.js", () => ({ getAntigravityUsage: vi.fn() }));

const { getProviderCredentials } = await import("@/sse/services/auth.js");

const TIMEOUT_MS = 1000;
const withTimeout = (promise) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error("selection timed out")), TIMEOUT_MS)),
]);
const settle = () => new Promise((resolve) => setTimeout(resolve, 15));

const store = new Map();
const gates = new Map();

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

function seed(provider, accounts) {
  for (const account of accounts) {
    store.set(account.id, { isActive: true, providerSpecificData: {}, ...account, provider });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
  gates.clear();
  mocks.getSettings.mockResolvedValue({});
  mocks.getProxyPools.mockResolvedValue([]);
  mocks.pickProxyPoolId.mockReturnValue(null);
  mocks.resolveConnectionProxyConfig.mockResolvedValue({});
  mocks.updateProviderConnection.mockResolvedValue(undefined);
  mocks.getProviderConnections.mockImplementation(async ({ provider, isActive } = {}) => {
    const gate = gates.get(provider);
    if (gate) await gate.promise;
    return [...store.values()]
      .filter((c) => c.provider === provider && (isActive === undefined || c.isActive === isActive))
      .map((c) => ({ ...c }));
  });
});

afterEach(() => vi.useRealTimers());

describe("per-provider selection lock — isolation", () => {
  it("a slow provider-A selection does not hold provider-B", async () => {
    seed("codex", [{ id: "codex-1", email: "c@example.com" }]);
    seed("openai", [{ id: "openai-1", email: "o@example.com" }]);

    const gate = deferred();
    gates.set("codex", gate); // provider A parks inside the critical section

    let aDone = false;
    const a = getProviderCredentials("codex", null, "gpt-5")
      .then((r) => { aDone = true; return r; }, (e) => { aDone = true; throw e; });
    const b = getProviderCredentials("openai", null, "gpt-4");

    // B must resolve while A is still parked.
    const bResult = await withTimeout(b);
    expect(bResult.connectionId).toBe("openai-1");
    expect(aDone).toBe(false);

    gate.resolve();
    const aResult = await withTimeout(a);
    expect(aResult.connectionId).toBe("codex-1");
    expect(aDone).toBe(true);
  });

  it("a request cancelled while queued never dispatches (no DB read, no selection)", async () => {
    seed("codex", [{ id: "codex-1", email: "c@example.com" }]);
    const gate = deferred();
    gates.set("codex", gate);

    let codexCalls = 0;
    const base = mocks.getProviderConnections.getMockImplementation();
    mocks.getProviderConnections.mockImplementation((args = {}) => {
      if (args.provider === "codex") codexCalls++;
      return base(args);
    });

    const holder = getProviderCredentials("codex", null, "gpt-5"); // holds the lock, parked
    await settle();
    expect(codexCalls).toBe(1);

    const ac = new AbortController();
    const queued = getProviderCredentials("codex", null, "gpt-5", { signal: ac.signal });
    ac.abort();
    await expect(queued).rejects.toThrow(/abort/i);
    expect(codexCalls).toBe(1); // cancelled request never entered the critical section

    gate.resolve();
    await withTimeout(holder);
    expect(codexCalls).toBe(1); // only the original holder dispatched
  });
});

describe("per-provider selection lock — canonical aliases", () => {
  it("aliases resolve to the canonical provider BEFORE locking (shared lock)", async () => {
    seed("codex", [{ id: "codex-1", email: "c@example.com" }]);
    const gate = deferred();
    gates.set("codex", gate);

    let codexCalls = 0;
    const base = mocks.getProviderConnections.getMockImplementation();
    mocks.getProviderConnections.mockImplementation((args = {}) => {
      if (args.provider === "codex") codexCalls++;
      return base(args);
    });

    // "cx" is codex's UI alias; "codex" is the canonical id.
    const aliasReq = getProviderCredentials("cx", null, "gpt-5");
    const canonicalReq = getProviderCredentials("codex", null, "gpt-5");

    await settle();
    // Only ONE critical-section entry: the canonical request is queued behind
    // the alias request, proving they share a single lock.
    expect(codexCalls).toBe(1);

    gate.resolve();
    const [aliasResult, canonicalResult] = await Promise.all([
      withTimeout(aliasReq),
      withTimeout(canonicalReq),
    ]);
    expect(codexCalls).toBe(2);
    expect(aliasResult.connectionId).toBe("codex-1");
    expect(canonicalResult.connectionId).toBe("codex-1");
  });
});

describe("per-provider selection lock — round-robin contention", () => {
  it("stays consistent under parallel contention (no lost updates)", async () => {
    vi.useFakeTimers();
    let clock = Date.parse("2026-10-14T00:00:00.000Z");
    vi.setSystemTime(new Date(clock));

    seed("codex", [
      { id: "codex-a", email: "a@example.com", priority: 1 },
      { id: "codex-b", email: "b@example.com", priority: 2 },
    ]);
    mocks.getSettings.mockResolvedValue({ fallbackStrategy: "round-robin", stickyRoundRobinLimit: 1 });

    const applied = [];
    mocks.updateProviderConnection.mockImplementation(async (id, patch) => {
      const connection = store.get(id);
      if (connection) Object.assign(connection, patch);
      applied.push({ id, ...patch });
      // Serialized selection => a well-ordered clock, so each lastUsedAt is distinct.
      clock += 1000;
      vi.setSystemTime(new Date(clock));
    });

    const N = 6;
    const results = await Promise.all(
      Array.from({ length: N }, () => getProviderCredentials("codex", null, "gpt-5"))
    );
    const picked = results.map((r) => r.connectionId);

    // stickyRoundRobinLimit=1 => strict alternation, in dispatch order.
    expect(picked).toEqual(["codex-a", "codex-b", "codex-a", "codex-b", "codex-a", "codex-b"]);

    // Every selection persisted exactly one update, and no two share a timestamp
    // (a concurrent read-modify-write would have duplicated or torn the value).
    expect(applied).toHaveLength(N);
    const stamps = applied.map((p) => p.lastUsedAt);
    expect([...stamps].sort()).toEqual(stamps);
    expect(new Set(stamps).size).toBe(N);
  });
});
