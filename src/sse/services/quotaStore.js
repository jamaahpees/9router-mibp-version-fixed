import { getAntigravityQuotaCache } from "./antigravityQuota.js";

// Passive snapshots from existing usage requests. No polling or refresh requests.
const quotaStore = new Map();
const MAX_SNAPSHOTS = 1000;
const SNAPSHOT_TTL_MS = 5 * 60_000;

export function getQuotaStore() {
  return quotaStore;
}

export function setQuotaSnapshot(connectionId, provider, quotas, observedAt = Date.now()) {
  if (!connectionId || !quotas || typeof quotas !== "object" || Array.isArray(quotas)) return;
  if (quotaStore.get(connectionId)?.updatedAt > observedAt) return;
  quotaStore.delete(connectionId);
  quotaStore.set(connectionId, {
    provider,
    quotas: Object.fromEntries(Object.entries(quotas).map(([key, quota]) => [key, { ...quota }])),
    updatedAt: observedAt,
  });
  while (quotaStore.size > MAX_SNAPSHOTS) quotaStore.delete(quotaStore.keys().next().value);
}

function blockingReset(quota, now) {
  if (!quota || quota.unlimited === true) return 0;
  let remaining = quota.remainingPercentage ?? quota.remaining;
  if (remaining == null && Number.isFinite(quota.total) && quota.total > 0 && Number.isFinite(quota.used)) {
    remaining = quota.total - quota.used;
  }
  const reset = Date.parse(quota.resetAt);
  return typeof remaining === "number" && Number.isFinite(remaining) && remaining <= 0 && reset > now ? reset : 0;
}

export function isConnectionQuotaBlocked(providerId, model, connection, now = Date.now()) {
  let resetUntilMs = 0;
  if (providerId === "antigravity") {
    // Keep the existing lazy cache and strike breaker authoritative. Duplicating
    // these entries would leave stale blocks after clearAntigravityStrikes.
    resetUntilMs = blockingReset(getAntigravityQuotaCache().get(connection?.id)?.[model], now);
  } else {
    const entry = quotaStore.get(connection?.id);
    if (entry?.provider === providerId && now - entry.updatedAt <= SNAPSHOT_TTL_MS) {
      const names = [model];
      if (providerId === "codex") {
        names.push("session", "weekly");
        if (model?.includes("spark")) names.push("spark_session", "spark_weekly");
        if (model?.includes("review")) names.push("review_session", "review_weekly");
      } else if (providerId === "github") {
        names.push("chat");
        // Unknown billing scope must not block free models. Only use explicit
        // model metadata, never infer premium billing from a model's name.
        if (connection.providerSpecificData?.modelQuotaScopes?.[model] === "premium_interactions") {
          names.push("premium_interactions");
        }
      }
      resetUntilMs = Math.max(0, ...names.map(name => blockingReset(entry.quotas[name], now)));
    }
  }
  return { isBlocked: resetUntilMs > now, resetUntilMs };
}
