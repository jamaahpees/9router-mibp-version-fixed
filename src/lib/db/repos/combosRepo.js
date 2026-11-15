import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { cleanComboModels, comboMapFromRows, coerceComboLimit } from "../../../shared/utils/comboGraph.js";

function rowToCombo(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    models: parseJson(row.models, []),
    // NULL means "derive from the seats"; a number is the operator's choice.
    contextWindow: coerceComboLimit(row.contextWindow, "contextWindow"),
    maxOutput: coerceComboLimit(row.maxOutput, "maxOutput"),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getCombos() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM combos ORDER BY createdAt ASC`);
  return rows.map(rowToCombo);
}

export async function getComboById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM combos WHERE id = ?`, [id]);
  return rowToCombo(row);
}

export async function getComboByName(name) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM combos WHERE name = ?`, [name]);
  return rowToCombo(row);
}

export async function createCombo(data) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  // Strip self-references/cycles here too: the API validates, but imports and
  // presets write through the repo directly.
  const { models, removed } = cleanComboModels(data.name, data.models || [], comboMapFromRows(db.all(`SELECT * FROM combos`)));
  if (removed.length > 0) {
    console.warn(`[combosRepo] model(s) dropped from combo "${data.name}":`, removed.map((r) => `${r.model} (${r.reason})`).join(", "));
  }
  const combo = {
    id: uuidv4(),
    name: data.name,
    kind: data.kind || null,
    models,
    contextWindow: coerceComboLimit(data.contextWindow, "contextWindow"),
    maxOutput: coerceComboLimit(data.maxOutput, "maxOutput"),
    createdAt: now,
    updatedAt: now,
  };
  db.run(
    `INSERT INTO combos(id, name, kind, models, contextWindow, maxOutput, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
    [combo.id, combo.name, combo.kind, stringifyJson(combo.models), combo.contextWindow, combo.maxOutput, combo.createdAt, combo.updatedAt]
  );
  return combo;
}

export async function updateCombo(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM combos WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToCombo(row), ...data, updatedAt: new Date().toISOString() };
    if (Array.isArray(merged.models)) {
      const others = db.all(`SELECT * FROM combos WHERE id != ?`, [id]);
      const { models, removed } = cleanComboModels(merged.name, merged.models, comboMapFromRows(others));
      if (removed.length > 0) {
        console.warn(`[combosRepo] model(s) dropped from combo "${merged.name}":`, removed.map((r) => `${r.model} (${r.reason})`).join(", "));
      }
      merged.models = models;
    }
    merged.contextWindow = coerceComboLimit(merged.contextWindow, "contextWindow");
    merged.maxOutput = coerceComboLimit(merged.maxOutput, "maxOutput");
    db.run(
      `UPDATE combos SET name = ?, kind = ?, models = ?, contextWindow = ?, maxOutput = ?, updatedAt = ? WHERE id = ?`,
      [merged.name, merged.kind, stringifyJson(merged.models || []), merged.contextWindow, merged.maxOutput, merged.updatedAt, id]
    );
    result = merged;
  });
  return result;
}

export async function deleteCombo(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM combos WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}
