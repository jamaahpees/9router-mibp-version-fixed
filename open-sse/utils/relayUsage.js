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

/**
 * Add measured body bytes to the same pool row.
 *
 * Called with the request-body size before the hop and, later, with the
 * response size (headers or stream completion). Both are best-effort: a
 * dropped write under-counts transfer, which is the safe direction for a
 * remaining-allowance readout.
 */
export function countRelayBytes(poolId, bytes) {
  const id = typeof poolId === "string" ? poolId.trim() : "";
  const amount = Number(bytes);
  if (!id || !Number.isFinite(amount) || amount <= 0) return;
  import("@/lib/db/repos/proxyPoolUsageRepo.js")
    .then(({ recordProxyPoolBytes }) => recordProxyPoolBytes(id, amount))
    .catch(() => {});
}
