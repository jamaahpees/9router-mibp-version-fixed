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
