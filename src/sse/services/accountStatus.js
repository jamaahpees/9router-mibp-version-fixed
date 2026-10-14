import { getProviderConnections, getSettings } from "@/lib/localDb";
import { resolveProviderId, FREE_PROVIDERS } from "@/shared/constants/providers.js";
import { isModelLockActive, getModelLockKey, MODEL_LOCK_ALL } from "open-sse/services/accountFallback.js";
import { filterConnectionsForModel } from "./auth.js";
import { isConnectionQuotaBlocked } from "./quotaStore.js";
import { getModelInfo } from "./model.js";

/** Read-only snapshot; never selects credentials, refreshes quota, or updates usage. */
export async function checkModelAvailability(modelStr, excludeConnectionIds = new Set()) {
  const { provider, model } = await getModelInfo(modelStr);
  const providerId = resolveProviderId(provider);
  const excluded = excludeConnectionIds instanceof Set ? excludeConnectionIds : new Set(excludeConnectionIds || []);
  if (FREE_PROVIDERS[providerId]?.noAuth) {
    return { availableCount: excluded.has("noauth") ? 0 : 1, totalCount: 1, retryAfter: null };
  }
  const settings = await getSettings();
  const connections = filterConnectionsForModel(providerId,
    (await getProviderConnections({ provider: providerId, isActive: true })).filter(c => c.isActive !== false),
    model, settings);
  const now = Date.now();
  let availableCount = 0;
  const retryTimes = [];
  for (const connection of connections) {
    if (excluded.has(connection.id)) continue;
    const locked = isModelLockActive(connection, model);
    // Match the predicate's model-specific OR account-level lock precedence exactly.
    const lockUntil = locked ? Date.parse(connection[getModelLockKey(model)] || connection[MODEL_LOCK_ALL]) : 0;

    // Check multi-provider unified quota store (Codex, GitHub, Antigravity)
    const { isBlocked: quotaBlocked, resetUntilMs } = isConnectionQuotaBlocked(providerId, model, connection, now);

    if (!locked && !quotaBlocked) {
      availableCount++;
    } else {
      retryTimes.push(Math.max(lockUntil || 0, quotaBlocked ? resetUntilMs : 0));
    }
  }
  return {
    availableCount,
    totalCount: connections.length,
    retryAfter: retryTimes.length ? new Date(Math.min(...retryTimes)).toISOString() : null,
  };
}
