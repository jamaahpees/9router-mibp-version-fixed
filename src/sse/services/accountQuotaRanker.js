/**
 * Quota-aware account ranking.
 *
 * Rotation for quota-metered providers should prefer the account with the most
 * remaining quota for the requested model instead of spreading requests across
 * accounts (round-robin). Spread patterns look like account farming upstream and
 * burn quota faster than they earn speed.
 *
 * Rules, in order:
 *   1. drop inactive / TOS-banned connections;
 *   2. drop accounts whose quota for this model is exhausted, remembering the
 *      earliest reset for retryAfter;
 *   3. rank by remaining quota (unknown last), then paid-plan preference, then
 *      the caller's priority, then least recently used;
 *   4. hysteresis: keep the account already in use while it is above
 *      switchBelowPct, so callers do not flap between accounts.
 *
 * Selection stays cache-only. Misses schedule a background refresh for later
 * requests instead of blocking the current one.
 */

import {
  getAntigravityQuotaCache,
  getAntigravityModelQuota,
  ensureAntigravityQuotaFresh,
} from "./antigravityQuota.js";

const inflightBackgroundRefresh = new Set();

/** A paid plan exposes a 5h session bucket next to the weekly one. */
export function hasSessionWindow(quotas) {
  if (!quotas || typeof quotas !== "object") return false;
  return Object.keys(quotas).some((key) => key.endsWith("_session"));
}

function isTosBanned(connection) {
  const lastError = connection?.lastError || connection?.providerSpecificData?.lastError;
  return typeof lastError === "string" && /TOS_VIOLATION|violation of Terms of Service/i.test(lastError);
}

function readQuota(connection, model) {
  const quotas = getAntigravityQuotaCache().get(connection.id);
  if (!quotas) return { known: false, remaining: null, resetAt: null, has5h: false };
  const quota = (model ? getAntigravityModelQuota(quotas, model) : null) || (model ? quotas[model] : null) || null;
  return {
    known: Boolean(quota) && typeof quota.remainingPercentage === "number",
    remaining: typeof quota?.remainingPercentage === "number" ? quota.remainingPercentage : null,
    resetAt: quota?.resetAt || null,
    has5h: hasSessionWindow(quotas),
  };
}

function scheduleBackgroundRefresh(connection, budget) {
  if (budget.left <= 0) return;
  if (inflightBackgroundRefresh.has(connection.id)) return;
  if (!connection.accessToken) return;
  budget.left -= 1;
  inflightBackgroundRefresh.add(connection.id);
  Promise.resolve()
    .then(() => ensureAntigravityQuotaFresh(connection.id, connection.accessToken, connection.providerSpecificData))
    .catch(() => {})
    .finally(() => inflightBackgroundRefresh.delete(connection.id));
}

/**
 * @returns {{ ranked: object[], retryAfter: string|null, suppressed: object[] }}
 */
export async function rankAntigravityConnections({
  connections = [],
  model = null,
  preferredConnectionId = null,
  switchBelowPct = 15,
  preferPaid = true,
  refreshBudget = 2,
  log = null,
} = {}) {
  const now = Date.now();
  const budget = { left: refreshBudget };
  const candidates = [];
  const suppressed = [];
  let retryAfterMs = 0;

  for (const connection of connections) {
    if (!connection?.id) continue;
    if (connection.isActive === false) { suppressed.push({ connection, reason: "inactive" }); continue; }
    if (isTosBanned(connection)) { suppressed.push({ connection, reason: "tos" }); continue; }

    const quota = readQuota(connection, model);
    if (!quota.known) scheduleBackgroundRefresh(connection, budget);

    if (quota.known && quota.remaining <= 0 && quota.resetAt) {
      const resetMs = new Date(quota.resetAt).getTime();
      if (resetMs > now) {
        suppressed.push({ connection, reason: "exhausted", resetAt: quota.resetAt });
        if (!retryAfterMs || resetMs < retryAfterMs) retryAfterMs = resetMs;
        continue;
      }
    }

    candidates.push({ connection, quota });
  }

  const preferred = candidates.find((entry) => entry.connection.id === preferredConnectionId);

  const sortEntries = (entries) => entries.sort((a, b) => {
    const aRem = a.quota.known ? a.quota.remaining : -1;
    const bRem = b.quota.known ? b.quota.remaining : -1;
    if (aRem !== bRem) return bRem - aRem;
    if (preferPaid && a.quota.has5h !== b.quota.has5h) return a.quota.has5h ? -1 : 1;
    const prio = (a.connection.priority || 999) - (b.connection.priority || 999);
    if (prio !== 0) return prio;
    const aUsed = a.connection.lastUsedAt ? new Date(a.connection.lastUsedAt).getTime() : 0;
    const bUsed = b.connection.lastUsedAt ? new Date(b.connection.lastUsedAt).getTime() : 0;
    return aUsed - bUsed;
  });

  // Hysteresis: the account already serving this conversation keeps the slot
  // while it still has meaningful quota left.
  if (preferred && (!preferred.quota.known || preferred.quota.remaining >= switchBelowPct)) {
    const rest = sortEntries(candidates.filter((entry) => entry !== preferred));
    const ranked = [preferred, ...rest].map((entry) => entry.connection);
    log?.debug?.("AG_QUOTA", "hysteresis keeps " + (preferred.connection.email || preferred.connection.id.slice(0, 8)) + " (rem=" + (preferred.quota.remaining ?? "?") + "%)");
    return { ranked, retryAfter: retryAfterMs ? new Date(retryAfterMs).toISOString() : null, suppressed };
  }

  const ordered = sortEntries(candidates);
  const ranked = ordered.map((entry) => entry.connection);
  if (log && ranked.length) {
    const top = ordered[0];
    log.debug?.("AG_QUOTA", "ranked " + ranked.length + " accounts for " + (model || "*") + " -> " + (top.connection.email || top.connection.id.slice(0, 8)) + " (rem=" + (top.quota.remaining ?? "?") + "%)");
  }
  return { ranked, retryAfter: retryAfterMs ? new Date(retryAfterMs).toISOString() : null, suppressed };
}