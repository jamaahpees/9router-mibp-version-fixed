import { randomUUID } from "node:crypto";

const ACTIVE_CAP = 1000;
const ATTEMPT_CAP = 20;
const HISTORY_CAP = 50;
const state = globalThis.__requestLifecycleState ||= {
  active: new Map(), recent: [], activeCount: 0, overflowActive: 0,
  droppedDetails: 0, droppedAttempts: 0, notifier: null,
};
const now = () => performance.now();
const label = (value, fallback = "") => typeof value === "string" ? value.slice(0, 160) : fallback;
const account = (value) => typeof value === "string" && value ? `${value.slice(0, 8)}...` : "";
const notify = () => { try { state.notifier?.(); } catch { /* Observability must not break routing. */ } };

// The repository configures this without a reverse import or any database work.
export function configureRequestLifecycleNotifier(notifier) {
  state.notifier = typeof notifier === "function" ? notifier : null;
}

function makeRecord(provider, model, connectionId) {
  const started = now();
  return { id: randomUUID(), provider: label(provider), model: label(model), account: account(connectionId),
    phase: "created", started, phaseStarted: started, ended: null, terminal: null,
    phaseDurations: Object.create(null), milestones: Object.create(null) };
}
function snapshotRecord(record, time) {
  const end = record.ended ?? time;
  const phaseDurations = { ...record.phaseDurations };
  if (record.ended === null) phaseDurations[record.phase] = (phaseDurations[record.phase] || 0) + Math.max(0, end - record.phaseStarted);
  return { id: record.id, provider: record.provider, model: record.model, account: record.account,
    phase: record.phase, terminal: record.terminal, elapsedMs: Math.max(0, end - record.started),
    phaseElapsedMs: Math.max(0, end - record.phaseStarted), phaseDurations,
    milestones: { ...record.milestones } };
}
function phase(record, value, metadata = {}) {
  if (record.ended !== null) return;
  const next = label(value, "unknown");
  if (next !== record.phase) {
    const time = now();
    // Bound even malformed/invented phase names.
    if (Object.keys(record.phaseDurations).length < 32 || Object.hasOwn(record.phaseDurations, record.phase)) {
      record.phaseDurations[record.phase] = (record.phaseDurations[record.phase] || 0) + Math.max(0, time - record.phaseStarted);
    }
    record.phase = next;
    record.phaseStarted = time;
  }
  if (typeof metadata.provider === "string") record.provider = label(metadata.provider);
  if (typeof metadata.model === "string") record.model = label(metadata.model);
  if (typeof metadata.connectionId === "string") record.account = account(metadata.connectionId);
  notify();
}
function milestone(record, name) {
  if (record.ended !== null) return;
  const key = label(name);
  if (key && !Object.hasOwn(record.milestones, key) && Object.keys(record.milestones).length < 32) {
    record.milestones[key] = Math.max(0, now() - record.started);
    notify();
  }
}
function finishRecord(record, status, time = now()) {
  if (record.ended !== null) return false;
  if (Object.keys(record.phaseDurations).length < 32 || Object.hasOwn(record.phaseDurations, record.phase)) {
    record.phaseDurations[record.phase] = (record.phaseDurations[record.phase] || 0) + Math.max(0, time - record.phaseStarted);
  }
  record.ended = time;
  record.terminal = label(status, "success");
  return true;
}

export function createRequestLifecycle({ model, provider } = {}) {
  const record = makeRecord(provider, model);
  const attempts = [];
  let attemptCount = 0;
  const snapshot = () => {
    const time = now();
    return { ...snapshotRecord(record, time), attemptCount, droppedAttempts: Math.max(0, attemptCount - attempts.length),
      attempts: attempts.map((attempt) => snapshotRecord(attempt, time)) };
  };
  const entry = { snapshot, evicted: false };
  if (state.active.size >= ACTIVE_CAP) {
    const oldest = state.active.keys().next().value;
    state.active.get(oldest).evicted = true;
    state.active.delete(oldest);
    state.overflowActive++;
    state.droppedDetails++;
  }
  state.active.set(record.id, entry);
  state.activeCount++;
  notify();
  return {
    id: record.id,
    onPhase: (value, metadata = {}) => phase(record, value, metadata),
    onMilestone: (name) => milestone(record, name),
    beginAttempt({ provider: nextProvider, model: nextModel, connectionId } = {}) {
      const attempt = makeRecord(nextProvider ?? record.provider, nextModel ?? record.model, connectionId);
      if (record.ended !== null) {
        finishRecord(attempt, record.terminal);
      } else {
        attemptCount++;
        attempts.push(attempt);
        if (attempts.length > ATTEMPT_CAP) { attempts.shift(); state.droppedAttempts++; }
        phase(record, "attempt", { provider: attempt.provider, model: attempt.model, connectionId });
      }
      return { id: attempt.id,
        onPhase(value, metadata = {}) { if (record.ended !== null || attempt.ended !== null) return; phase(attempt, value, metadata); phase(record, value, metadata); },
        onMilestone(name) { if (record.ended !== null || attempt.ended !== null) return; milestone(attempt, name); milestone(record, name); },
        finishAttempt(status) { if (finishRecord(attempt, status)) notify(); },
      };
    },
    finish(status) {
      const time = now();
      if (!finishRecord(record, status, time)) return;
      for (const attempt of attempts) finishRecord(attempt, status, time);
      state.active.delete(record.id);
      state.activeCount--;
      if (entry.evicted) state.overflowActive--;
      state.recent.unshift(snapshot());
      if (state.recent.length > HISTORY_CAP) state.recent.pop();
      notify();
    },
    snapshot,
  };
}

export function getRequestLifecycleSnapshot() {
  return {
    lifecycleRequests: Array.from(state.active.values(), (entry) => entry.snapshot()),
    recentLifecycleRequests: state.recent.map((entry) => structuredClone(entry)),
    trackingOverflow: { activeCount: state.activeCount, retainedActive: state.active.size,
      overflowActive: state.overflowActive, droppedDetails: state.droppedDetails, droppedAttempts: state.droppedAttempts },
  };
}
