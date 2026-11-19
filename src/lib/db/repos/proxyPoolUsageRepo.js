import { getAdapter } from "../driver.js";
import { utcDayKey } from "@/shared/utils/proxyPoolQuota.js";

/**
 * Add one dispatch to today's tally for a pool.
 *
 * Called from the request hot path, so it stays a single upsert with no read
 * first. `requests + 1` is computed by SQLite itself, which keeps concurrent
 * requests from overwriting each other's count.
 */
export async function recordProxyPoolRequest(poolId, date = new Date()) {
  if (!poolId) return null;
  const db = await getAdapter();
  const day = utcDayKey(date);
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO proxyPoolUsage(poolId, day, requests, lastUsedAt)
     VALUES(?, ?, 1, ?)
     ON CONFLICT(poolId, day) DO UPDATE SET
       requests = requests + 1,
       lastUsedAt = excluded.lastUsedAt`,
    [poolId, day, now]
  );
  return { poolId, day };
}

/** Map of poolId -> { requests, lastUsedAt } for one UTC day. */
export async function getProxyPoolUsageMap(day = utcDayKey()) {
  const db = await getAdapter();
  const rows = db.all(
    `SELECT poolId, requests, lastUsedAt FROM proxyPoolUsage WHERE day = ?`,
    [day]
  );
  const map = new Map();
  for (const row of rows) {
    map.set(row.poolId, {
      requests: Number(row.requests) || 0,
      lastUsedAt: row.lastUsedAt || null,
    });
  }
  return map;
}

export async function getProxyPoolUsage(poolId, day = utcDayKey()) {
  if (!poolId) return null;
  const db = await getAdapter();
  const row = db.get(
    `SELECT poolId, requests, lastUsedAt FROM proxyPoolUsage WHERE poolId = ? AND day = ?`,
    [poolId, day]
  );
  if (!row) return { poolId, day, requests: 0, lastUsedAt: null };
  return {
    poolId,
    day,
    requests: Number(row.requests) || 0,
    lastUsedAt: row.lastUsedAt || null,
  };
}
