import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { keyAccessFromColumns, keyAccessToColumns } from "@/shared/utils/keyAccess.js";
import { KEY_ACCESS_UNRESTRICTED } from "@/shared/constants/keyAccess.js";

function rowToKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    machineId: row.machineId,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    usageLimit: row.usageLimit ?? null,
    usagePeriod: row.usagePeriod ?? "all",
    access: keyAccessFromColumns(row.accessRestricted, row.accessAllow),
  };
}

export async function getApiKeys() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM apiKeys ORDER BY createdAt ASC`);
  const keys = rows.map(rowToKey);

  // Attach token usage to each key
  for (const k of keys) {
    let query = `SELECT SUM(promptTokens + completionTokens) as total FROM usageHistory WHERE apiKey = ?`;
    const params = [k.key];
    if (k.usagePeriod === "daily") {
      query += ` AND date(timestamp) = date('now')`;
    }
    const usageRow = db.get(query, params);
    k.currentUsage = usageRow?.total || 0;
  }

  return keys;
}

export async function getApiKeyById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
  return rowToKey(row);
}

// Used by the /v1 handlers to read the presented key's access settings.
export async function getApiKeyByKey(key) {
  if (!key) return null;
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE key = ?`, [key]);
  return rowToKey(row);
}

export async function createApiKey(name, machineId, usageLimit = null, usagePeriod = "all") {
  if (!machineId) throw new Error("machineId is required");
  const db = await getAdapter();
  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  const result = generateApiKeyWithMachine(machineId);
  const apiKey = {
    id: uuidv4(),
    name,
    key: result.key,
    machineId,
    isActive: true,
    createdAt: new Date().toISOString(),
    usageLimit: usageLimit !== null && usageLimit !== undefined && usageLimit !== "" ? parseInt(usageLimit, 10) : null,
    usagePeriod: usagePeriod || "all",
    access: { restricted: false, allow: [] },
  };
  const cols = keyAccessToColumns(KEY_ACCESS_UNRESTRICTED);
  db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, usageLimit, usagePeriod, accessRestricted, accessAllow) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [apiKey.id, apiKey.key, apiKey.name, apiKey.machineId, 1, apiKey.createdAt, apiKey.usageLimit, apiKey.usagePeriod, cols.accessRestricted, cols.accessAllow]
  );
  return apiKey;
}

export async function updateApiKey(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToKey(row), ...data };
    if (merged.usageLimit !== null && merged.usageLimit !== undefined && merged.usageLimit !== "") {
      merged.usageLimit = parseInt(merged.usageLimit, 10);
    } else {
      merged.usageLimit = null;
    }
    const cols = keyAccessToColumns(merged.access);
    db.run(
      `UPDATE apiKeys SET key = ?, name = ?, machineId = ?, isActive = ?, usageLimit = ?, usagePeriod = ?, accessRestricted = ?, accessAllow = ? WHERE id = ?`,
      [merged.key, merged.name, merged.machineId, merged.isActive ? 1 : 0, merged.usageLimit, merged.usagePeriod || "all", cols.accessRestricted, cols.accessAllow, id]
    );
    result = rowToKey(db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]));
  });
  return result;
}

export async function deleteApiKey(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM apiKeys WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}

export async function validateApiKey(key) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE key = ?`, [key]);
  if (!row) return false;
  if (row.isActive !== 1 && row.isActive !== true) return false;

  // Check usage limit if configured
  if (row.usageLimit !== null && row.usageLimit !== undefined) {
    const limit = parseInt(row.usageLimit, 10);
    if (limit > 0) {
      let query = `SELECT SUM(promptTokens + completionTokens) as total FROM usageHistory WHERE apiKey = ?`;
      const params = [key];
      if (row.usagePeriod === "daily") {
        query += ` AND date(timestamp) = date('now')`;
      }
      const usageRow = db.get(query, params);
      const totalTokens = usageRow?.total || 0;
      if (totalTokens >= limit) {
        return { valid: false, reason: "limit_exceeded", usage: totalTokens, limit };
      }
    }
  }

  return true;
}
