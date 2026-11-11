/**
 * Proxy-pool binding helpers.
 *
 * A connection can point at a pool through the legacy single field
 * (`providerSpecificData.proxyPoolId`) or through the multi-pool rotation list
 * (`providerSpecificData.proxyPoolIds`). Every consumer that needs to know
 * "is this pool in use?" has to look at both, otherwise a pool selected only
 * through the multi-pool picker looks unused and can be deleted or reported as
 * 0 bound while requests still route through it.
 */

/** Pool ids a single connection is bound to, without duplicates. */
export function connectionProxyPoolIds(connection) {
  const psd = connection?.providerSpecificData || {};
  const ids = new Set();
  if (typeof psd.proxyPoolId === "string" && psd.proxyPoolId) ids.add(psd.proxyPoolId);
  if (Array.isArray(psd.proxyPoolIds)) {
    for (const id of psd.proxyPoolIds) {
      if (typeof id === "string" && id) ids.add(id);
    }
  }
  return [...ids];
}

/** Map of poolId -> number of connections bound to it. */
export function buildProxyPoolUsageMap(connections = []) {
  const usageMap = new Map();
  for (const connection of connections) {
    for (const poolId of connectionProxyPoolIds(connection)) {
      usageMap.set(poolId, (usageMap.get(poolId) || 0) + 1);
    }
  }
  return usageMap;
}

/** Number of connections bound to one pool (legacy id or rotation list). */
export function countBoundConnections(connections = [], proxyPoolId) {
  if (!proxyPoolId) return 0;
  return connections.filter((connection) => connectionProxyPoolIds(connection).includes(proxyPoolId)).length;
}

/**
 * Return provider data with one pool unbound.
 *
 * Used by "delete anyway" flows: the pool row disappears, so every reference to
 * it has to go too, otherwise the connection keeps retrying a dead pool id and
 * requests fail instead of falling back to the legacy proxy (or direct egress).
 */
export function detachProxyPoolFromProviderData(providerSpecificData, proxyPoolId) {
  const psd = { ...(providerSpecificData || {}) };
  if (!proxyPoolId) return psd;

  if (Array.isArray(psd.proxyPoolIds)) {
    const remaining = psd.proxyPoolIds.filter((id) => id !== proxyPoolId);
    psd.proxyPoolIds = remaining;
    if (remaining.length === 0) {
      psd.proxyRotationStrategy = "none";
    }
  }

  if (psd.proxyPoolId === proxyPoolId) psd.proxyPoolId = null;
  if (psd.connectionProxyPoolId === proxyPoolId) psd.connectionProxyPoolId = null;

  const stillBound =
    (typeof psd.proxyPoolId === "string" && psd.proxyPoolId) ||
    (Array.isArray(psd.proxyPoolIds) && psd.proxyPoolIds.length > 0) ||
    (typeof psd.connectionProxyPoolId === "string" && psd.connectionProxyPoolId);

  // Nothing left to route through and no legacy single proxy either: stop
  // advertising a proxy for this connection.
  if (!stillBound && !psd.connectionProxyUrl) {
    psd.connectionProxyEnabled = false;
  }

  return psd;
}

/** Remove one pool id from every providerStrategies entry in settings. */
export function detachProxyPoolFromStrategies(providerStrategies = {}, proxyPoolId) {
  if (!proxyPoolId || !providerStrategies || typeof providerStrategies !== "object") return null;
  let changed = false;
  const next = {};
  for (const [provider, strategy] of Object.entries(providerStrategies)) {
    if (strategy && typeof strategy === "object" && strategy.proxyPoolId === proxyPoolId) {
      next[provider] = { ...strategy, proxyPoolId: null };
      changed = true;
    } else {
      next[provider] = strategy;
    }
  }
  return changed ? next : null;
}
