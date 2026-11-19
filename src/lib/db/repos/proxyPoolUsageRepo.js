import { getAdapter } from "../driver.js";
import { utcDayKey, utcMonthKey } from "@/shared/utils/proxyPoolQuota.js";

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

/**
 * Add measured transfer to today's tally for a pool.
 *
 * Same row as the request counter, so a month total stays one `SUM` over the
 * daily rows. Negative or non-finite input is dropped rather than allowed to
 * shrink a counter; the caller passes what it measured, it never subtracts.
 */
export async function recordProxyPoolBytes(poolId, bytes, date = new Date()) {
  if (!poolId) return null;
  const amount = Math.floor(Number(bytes));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const db = await getAdapter();
  const day = utcDayKey(date);
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO proxyPoolUsage(poolId, day, requests, bytes, lastUsedAt)
     VALUES(?, ?, 0, ?, ?)
     ON CONFLICT(poolId, day) DO UPDATE SET
       bytes = bytes + excluded.bytes,
       lastUsedAt = excluded.lastUsedAt`,
    [poolId, day, amount, now]
  );
  return { poolId, day, bytes: amount };
}

/** Map of poolId -> { requests, bytes, lastUsedAt } for one UTC day. */
export async function getProxyPoolUsageMap(day = utcDayKey()) {
  const db = await getAdapter();
  const rows = db.all(
    `SELECT poolId, requests, bytes, lastUsedAt FROM proxyPoolUsage WHERE day = ?`,
    [day]
  );
  const map = new Map();
  for (const row of rows) {
    map.set(row.poolId, {
      requests: Number(row.requests) || 0,
      bytes: Number(row.bytes) || 0,
      lastUsedAt: row.lastUsedAt || null,
    });
  }
  return map;
}

/**
 * Month-to-date tally, summed from the daily rows so the table stays one row
 * per pool per day and no second counter can drift from it.
 */
export async function getProxyPoolUsageMonthMap(month = utcMonthKey()) {
  const db = await getAdapter();
  const rows = db.all(
    `SELECT poolId, SUM(requests) AS requests, SUM(bytes) AS bytes, MAX(lastUsedAt) AS lastUsedAt
       FROM proxyPoolUsage
      WHERE day LIKE ?
      GROUP BY poolId`,
    [`${month}-%`]
  );
  const map = new Map();
  for (const row of rows) {
    map.set(row.poolId, {
      requests: Number(row.requests) || 0,
      bytes: Number(row.bytes) || 0,
      lastUsedAt: row.lastUsedAt || null,
    });
  }
  return map;
}

export async function getProxyPoolUsage(poolId, day = utcDayKey()) {
  if (!poolId) return null;
  const db = await getAdapter();
  const row = db.get(
    `SELECT poolId, requests, bytes, lastUsedAt FROM proxyPoolUsage WHERE poolId = ? AND day = ?`,
    [poolId, day]
  );
  if (!row) return { poolId, day, requests: 0, bytes: 0, lastUsedAt: null };
  return {
    poolId,
    day,
    requests: Number(row.requests) || 0,
    bytes: Number(row.bytes) || 0,
    lastUsedAt: row.lastUsedAt || null,
  };
}
