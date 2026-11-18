// Per-candidate deadline for combo seats.
//
// A seat that is still prefilling has produced nothing the client can use, so from the
// client's side it is indistinguishable from a dead seat. Without a cap, one slow seat can
// eat the client's whole per-attempt budget before the next seat is even tried (observed on
// 2026-11-18: 64 s of prefill, then a stream that closed with no candidates, and the failover
// finished past the client's limit).
//
// The deadline is armed ONLY when another candidate can take over. The last seat is never cut,
// so a genuinely slow but valid stream is still committed (fail-open). It aborts through the
// same AbortSignal the upstream fetch already listens on, so the abandoned prefill stops
// instead of running on in the background.
import { COMBO_CANDIDATE_DEADLINE_MS } from "../config/runtimeConfig.js";

/**
 * @param {{ hasNext?: boolean, deadlineMs?: number }} [options]
 * @returns {null | {
 *   ms: number, deadlineAt: number, signal: AbortSignal, aborted: boolean,
 *   remainingMs: () => number, disarm: () => void, stop: () => void,
 * }}
 */
export function startCandidateDeadline({ hasNext = false, deadlineMs = COMBO_CANDIDATE_DEADLINE_MS } = {}) {
  if (!hasNext) return null;
  // Clamp: 0 / NaN / negative would abort the seat instantly and turn every combo into a
  // single-seat race. There is no "disable" through this value; omit `hasNext` for that.
  const ms = Number.isFinite(deadlineMs) && deadlineMs > 0 ? deadlineMs : COMBO_CANDIDATE_DEADLINE_MS;
  const controller = new AbortController();
  const deadlineAt = performance.now() + ms;
  let timer = setTimeout(() => {
    timer = null;
    controller.abort(new DOMException(`Candidate deadline ${Math.round(ms / 1000)}s exceeded`, "TimeoutError"));
  }, ms);
  // Never hold the event loop open on a pending seat timer.
  timer.unref?.();

  const disarm = () => {
    if (timer) { clearTimeout(timer); timer = null; }
  };

  return {
    ms,
    deadlineAt,
    signal: controller.signal,
    get aborted() { return controller.signal.aborted; },
    // Time left for a follow-up step on the same seat (the empty-content peek). Floor at 1 s:
    // a seat whose headers arrived just under the deadline still gets a look at its stream
    // instead of being cut with zero observation.
    remainingMs() { return Math.max(1000, deadlineAt - performance.now()); },
    // Stop aborting once the upstream headers are in; from there the peek deadline governs.
    // Keeping the timer alive past that point could abort a stream that was just committed.
    disarm,
    stop: disarm,
  };
}
