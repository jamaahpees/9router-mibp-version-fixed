// Per-provider account-selection queue.
//
// Only account selection is serialized; upstream work (OAuth/token refresh,
// proxy dialing, streaming) does NOT hold this queue. Slots are keyed by the
// canonical provider ID so aliases (e.g. "cx" -> "codex") share one lock while
// unrelated providers select concurrently.
//
// Scope: process-local, in-memory state. This serializes selection within a
// single worker and is NOT atomic across workers/processes — a multi-worker
// deployment still needs an external lock for cross-process selection.
const providerTails = new Map();

function abortReason(signal) {
  return signal.reason ?? new DOMException("Account selection aborted", "AbortError");
}

/** Acquire a FIFO slot keyed by the canonical provider ID. */
export async function acquireProviderSelection(providerId, { signal, onPhase } = {}) {
  if (signal?.aborted) throw abortReason(signal);

  const predecessor = providerTails.get(providerId);
  let resolveSlot;
  const slot = new Promise(resolve => { resolveSlot = resolve; });
  // Aborted waiters release their own slot, but never bypass their predecessor.
  const tail = (predecessor || Promise.resolve()).then(() => slot);
  providerTails.set(providerId, tail);

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    resolveSlot();
    // An older holder must not delete a newer waiter's tail.
    void tail.then(() => {
      if (providerTails.get(providerId) === tail) providerTails.delete(providerId);
    });
  };

  let onAbort;
  try {
    const aborted = signal && new Promise((_, reject) => {
      onAbort = () => reject(abortReason(signal));
      signal.addEventListener("abort", onAbort, { once: true });
    });
    if (predecessor) onPhase?.("selection_wait");
    await (aborted ? Promise.race([predecessor || Promise.resolve(), aborted]) : predecessor);
    if (signal?.aborted) throw abortReason(signal);
    onPhase?.("selecting_account");
    if (signal?.aborted) throw abortReason(signal);
    return release;
  } catch (error) {
    release();
    throw error;
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
