/**
 * Daily request allowance per relay pool.
 *
 * The relay types below all run on a free serverless plan with a 100k
 * requests/day ceiling. A pool may override it with its own
 * `dailyRequestLimit`; plain http/https proxies have no known ceiling and
 * report `limit: null` instead of a made-up number.
 */
export const FREE_RELAY_DAILY_REQUESTS = 100000;

const RELAY_TYPES = new Set(["cloudflare", "vercel", "deno", "netlify"]);

/** UTC day key (`YYYY-MM-DD`) — the same boundary the relays reset on. */
export function utcDayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export function proxyPoolDailyLimit(pool) {
  if (!pool) return null;
  const override = Number(pool.dailyRequestLimit);
  if (Number.isFinite(override) && override > 0) return Math.floor(override);
  return RELAY_TYPES.has(pool.type) ? FREE_RELAY_DAILY_REQUESTS : null;
}

/**
 * Merge a pool definition with its usage row into the shape the dashboard
 * renders. `remaining` is clamped at 0 so an overrun never shows a negative.
 */
export function buildProxyPoolQuota(pool, usage, dayKey = utcDayKey()) {
  const used = Math.max(0, Number(usage?.requests) || 0);
  const limit = proxyPoolDailyLimit(pool);
  const base = { day: dayKey, used, lastUsedAt: usage?.lastUsedAt || null };
  if (!limit) return { ...base, limit: null, remaining: null, percent: null };
  return {
    ...base,
    limit,
    remaining: Math.max(0, limit - used),
    // One decimal is enough for a progress bar and avoids re-renders that
    // differ only in float noise.
    percent: Math.min(100, Math.round((used / limit) * 1000) / 10),
  };
}
