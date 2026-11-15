/**
 * Combo graph guard.
 *
 * A combo may list another combo as a member (nested combos are a feature), but a
 * combo must never reach itself: `a -> a`, or `a -> b -> a`. The dashboard model
 * picker lists combos next to real models, so a combo can be added to its own
 * member list by accident. At runtime that recursed until the process ran out of
 * memory (observed 2026-11-15: `claude9-opus-5` re-entered itself for minutes,
 * 2.1 GB RSS, swap thrash, dashboard unreachable).
 *
 * Everything below is pure so both the DB repo and the runtime path can share it.
 */

const COMBO_REF_MAX_DEPTH = 8;

/** A bare name can reference a combo; `provider/model` never does. */
export function isComboRef(model) {
  return typeof model === "string" && model.length > 0 && !model.includes("/");
}

/**
 * Would expanding `start` eventually reach `target`?
 * Only bare names are followed; unknown names simply stop the branch.
 */
export function comboReaches(start, target, comboMap) {
  if (start === target) return true;
  const stack = [start];
  const visited = new Set();
  let depth = 0;
  while (stack.length > 0) {
    if (depth++ > COMBO_REF_MAX_DEPTH * 64) return false;
    const current = stack.pop();
    if (visited.has(current)) continue;
    visited.add(current);
    const combo = comboMap instanceof Map ? comboMap.get(current) : comboMap?.[current];
    const members = Array.isArray(combo?.models) ? combo.models : Array.isArray(combo) ? combo : [];
    for (const member of members) {
      if (!isComboRef(member)) continue;
      if (member === target) return true;
      stack.push(member);
    }
  }
  return false;
}

/**
 * Drop members that would make `name` cyclic, plus duplicates and empty entries.
 *
 * @param {string} name - combo being written
 * @param {string[]} models - proposed members
 * @param {Map<string,{models:string[]}>|Record<string,{models:string[]}>} comboMap - other combos (may include `name`)
 * @returns {{ models: string[], removed: Array<{ model: string, reason: string }> }}
 */
export function cleanComboModels(name, models, comboMap = new Map()) {
  const cleaned = [];
  const removed = [];
  const seen = new Set();
  const list = Array.isArray(models) ? models : [];

  for (const raw of list) {
    const model = typeof raw === "string" ? raw.trim() : "";
    if (!model) {
      removed.push({ model: String(raw), reason: "empty" });
      continue;
    }
    if (model === name) {
      removed.push({ model, reason: "self-reference" });
      continue;
    }
    if (seen.has(model)) {
      removed.push({ model, reason: "duplicate" });
      continue;
    }
    if (isComboRef(model) && comboReaches(model, name, comboMap)) {
      removed.push({ model, reason: "cycle" });
      continue;
    }
    seen.add(model);
    cleaned.push(model);
  }

  return { models: cleaned, removed };
}

/** Build the lookup `cleanComboModels` expects from rows produced by combosRepo. */
export function comboMapFromRows(rows, { excludeId = null, override = null } = {}) {
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row?.name) continue;
    if (excludeId && row.id === excludeId) continue;
    map.set(row.name, { models: Array.isArray(row.models) ? row.models : [] });
  }
  if (override?.name) {
    map.set(override.name, { models: Array.isArray(override.models) ? override.models : [] });
  }
  return map;
}

/**
 * Limits an operator can pin on a combo.
 *
 * Without an override a combo advertises the smallest window (and smallest
 * output) any of its seats can honour, because any seat may answer. That is
 * honest but pessimistic when every seat really does take 1M, and it is the
 * only number clients (Claude Code, Cursor, …) use to decide how much context
 * to send. NULL means "keep deriving it".
 */
export const COMBO_LIMIT_BOUNDS = {
  contextWindow: { min: 1000, max: 10000000, label: "Context window" },
  maxOutput: { min: 1, max: 2000000, label: "Max output" },
};

/** Lenient read path: anything that is not a positive integer becomes NULL. */
export function coerceComboLimit(value, key) {
  const bounds = COMBO_LIMIT_BOUNDS[key];
  if (!bounds || value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < bounds.min || n > bounds.max) return null;
  return n;
}

/** Strict write path: returns { value } or { error }. */
export function parseComboLimit(value, key) {
  const bounds = COMBO_LIMIT_BOUNDS[key];
  if (!bounds) return { value: null };
  if (value === null || value === undefined || value === "") return { value: null };
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return { error: `${bounds.label} must be a whole number of tokens` };
  }
  if (n < bounds.min || n > bounds.max) {
    return { error: `${bounds.label} must be between ${bounds.min} and ${bounds.max}` };
  }
  return { value: n };
}

/** Explicit limits stored on a combo row (undefined when not set). */
export function comboLimitOverride(combo) {
  return {
    contextWindow: coerceComboLimit(combo?.contextWindow, "contextWindow") ?? undefined,
    maxOutput: coerceComboLimit(combo?.maxOutput, "maxOutput") ?? undefined,
  };
}

/** Overlay a combo's pinned limits on caps derived from its seats. */
export function applyComboLimits(caps, override) {
  if (!caps) return caps;
  const next = { ...caps };
  if (Number.isFinite(override?.contextWindow)) next.contextWindow = override.contextWindow;
  if (Number.isFinite(override?.maxOutput)) next.maxOutput = override.maxOutput;
  return next;
}
