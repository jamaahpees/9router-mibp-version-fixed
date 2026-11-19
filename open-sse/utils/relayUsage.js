/**
 * Relay dispatch tally, fire-and-forget.
 *
 * The request path must never wait on bookkeeping or fail because of it, so
 * the DB write is a detached import promise whose rejection is swallowed. A
 * lost tick only makes the displayed remaining count slightly optimistic;
 * throwing here would break the actual request.
 */
export function countRelayDispatch(poolId) {
  const id = typeof poolId === "string" ? poolId.trim() : "";
  if (!id) return;
  import("@/lib/db/repos/proxyPoolUsageRepo.js")
    .then(({ recordProxyPoolRequest }) => recordProxyPoolRequest(id))
    .catch(() => {});
}
