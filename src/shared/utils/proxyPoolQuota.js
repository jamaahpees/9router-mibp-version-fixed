/**
 * What each relay provider actually meters.
 *
 * These are not interchangeable: Cloudflare Workers gives a daily request
 * allowance, Vercel's binding meter is monthly gigabytes of transfer, Deno
 * counts monthly egress plus requests, and Netlify bills a shared credit pool.
 * Showing "requests left today" for Vercel would be fiction, so every entry
 * carries the unit it really uses, the period it resets on, and whether the
 * figure is published or an estimate.
 *
 * Figures read from the providers' own plan pages (Nov 2026):
 *   Cloudflare Workers Free: 100,000 requests/day, resets 00:00 UTC.
 *   Vercel Hobby: 100 GB fast data transfer + 1M edge requests per month.
 *   Deno Deploy Free: 1M requests + 20 GiB egress per month.
 *   Netlify Free: 300 credits/month, 2 credits per 10k requests.
 *
 * Vercel's real allowance is 100 GB, but a third-party relay spends its main
 * project's budget as well, so the operator's working figure is 10 GB. That is
 * an estimate and is labelled as one wherever it is shown.
 */

export const FREE_RELAY_DAILY_REQUESTS = 100000;

/** The operator's working Vercel figure, not the published 100 GB. */
export const VERCEL_ESTIMATED_MONTHLY_BYTES = 10 * 1000 ** 3;

const GIB = 1024 ** 3;

export const RELAY_METERS = {
  cloudflare: {
    unit: "requests",
    period: "day",
    requestLimit: FREE_RELAY_DAILY_REQUESTS,
    label: "requests today",
    note: "Workers Free: 100k requests/day, resets 00:00 UTC",
  },
  vercel: {
    unit: "bytes",
    period: "month",
    byteLimit: VERCEL_ESTIMATED_MONTHLY_BYTES,
    byteUnit: "GB",
    byteLimitEstimated: true,
    label: "GB this month",
    note: "Hobby allows 100 GB transfer/month; 10 GB assumed here (estimate), measured at the relay hop",
  },
  deno: {
    unit: "bytes",
    period: "month",
    byteLimit: 20 * GIB,
    byteUnit: "GiB",
    label: "GiB this month",
    note: "Free: 20 GiB egress + 1M requests/month; egress is measured here",
  },
  netlify: {
    unit: "requests",
    period: "month",
    // Credit-based plans have no per-request allowance at all, so no limit is
    // claimed; only the observed count is shown.
    requestLimit: null,
    label: "requests this month",
    note: "Free: 300 credits/month; requests cost 2 credits per 10k, no per-request cap",
  },
};

/** UTC day key (`YYYY-MM-DD`) — the boundary Cloudflare resets on. */
export function utcDayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

/** UTC month key (`YYYY-MM`) — the boundary the monthly plans reset on. */
export function utcMonthKey(date = new Date()) {
  return date.toISOString().slice(0, 7);
}

export function relayMeter(pool) {
  return RELAY_METERS[pool?.type] || null;
}

function formatBytes(bytes, unit = "GB") {
  const base = unit === "GiB" ? GIB : 1000 ** 3;
  const value = Math.max(0, Number(bytes) || 0) / base;
  if (value >= 100) return `${Math.round(value)} ${unit}`;
  if (value >= 10) return `${(Math.round(value * 10) / 10).toFixed(1)} ${unit}`;
  if (value >= 0.01) return `${(Math.round(value * 100) / 100).toFixed(2)} ${unit}`;
  if (value > 0) return `${Math.max(1, Math.round(value * base / 1000 ** 2))} MB`;
  return `0 ${unit}`;
}

function formatCount(value) {
  return Math.max(0, Math.round(Number(value) || 0)).toLocaleString("en-US");
}

function emptyQuota() {
  return {
    period: null, periodKey: null, unit: null, used: null, limit: null,
    remaining: null, percent: null, label: null, note: null,
    usedLabel: null, limitLabel: null, remainingLabel: null, summary: null,
    estimated: false, exhausted: false, exhaustedReason: null, lastUsedAt: null,
  };
}

/**
 * Build the meter readout for one pool.
 *
 * `usage.day` and `usage.month` come from the local counter; only the bucket
 * matching the meter's period is read, so a daily meter never sums a month's
 * worth of rows. `pool.lastError` set to `quota_exhausted*` by the relay
 * dispatch means the upstream refused traffic regardless of our own tally —
 * that is reported as `exhausted` rather than folded into the percentage,
 * because the two can disagree (a cold counter on a dead pool).
 */
export function buildProxyPoolQuota(pool, usage = {}, date = new Date()) {
  const meter = relayMeter(pool);
  if (!meter) return emptyQuota();

  const isDaily = meter.period === "day";
  const periodKey = isDaily ? utcDayKey(date) : utcMonthKey(date);
  const bucket = isDaily ? usage.day : usage.month;
  const lastUsedAt = bucket?.lastUsedAt || null;
  const exhaustedReason = typeof pool?.lastError === "string" && pool.lastError.startsWith("quota_exhausted")
    ? pool.lastError
    : null;

  const base = {
    period: meter.period,
    periodKey,
    unit: meter.unit,
    label: meter.label,
    note: meter.note,
    lastUsedAt,
    estimated: false,
    exhausted: Boolean(exhaustedReason),
    exhaustedReason,
  };

  if (meter.unit === "bytes") {
    const used = Math.max(0, Math.floor(Number(bucket?.bytes) || 0));
    const override = Number(isDaily ? pool?.dailyByteLimit : pool?.monthlyByteLimit);
    const hasOverride = Number.isFinite(override) && override > 0;
    const limit = hasOverride ? Math.floor(override) : meter.byteLimit;
    const unit = meter.byteUnit || "GB";
    const estimated = hasOverride ? false : meter.byteLimitEstimated === true;
    const usedLabel = formatBytes(used, unit);
    const tail = `${isDaily ? "today" : "this month"} (UTC ${periodKey})`;

    if (!limit) {
      return {
        ...base,
        estimated,
        used, limit: null, remaining: null, percent: null,
        usedLabel, limitLabel: null, remainingLabel: null,
        summary: `${usedLabel} ${tail}`,
      };
    }

    const remaining = Math.max(0, limit - used);
    const percent = Math.min(100, Math.round((used / limit) * 1000) / 10);
    const limitLabel = `${formatBytes(limit, unit)}${estimated ? " (estimated)" : ""}`;
    const remainingLabel = formatBytes(remaining, unit);
    const summary = exhaustedReason
      ? `limit reached upstream · ${usedLabel} ${tail}`
      : `${usedLabel} / ${limitLabel} · ${remainingLabel} left (UTC ${periodKey})`;

    return {
      ...base,
      estimated,
      used, limit, remaining, percent,
      usedLabel, limitLabel, remainingLabel, summary,
    };
  }

  const used = Math.max(0, Math.floor(Number(bucket?.requests) || 0));
  const override = Number(isDaily ? pool?.dailyRequestLimit : pool?.monthlyRequestLimit);
  const limit = Number.isFinite(override) && override > 0 ? Math.floor(override) : meter.requestLimit;
  const usedLabel = formatCount(used);

  if (!limit) {
    return {
      ...base,
      used, limit: null, remaining: null, percent: null,
      usedLabel, limitLabel: null, remainingLabel: null,
      summary: `${usedLabel} ${meter.label} (UTC ${periodKey})`,
    };
  }

  const remaining = Math.max(0, limit - used);
  const percent = Math.min(100, Math.round((used / limit) * 1000) / 10);
  const limitLabel = formatCount(limit);
  const remainingLabel = formatCount(remaining);

  return {
    ...base,
    used, limit, remaining, percent,
    usedLabel, limitLabel, remainingLabel,
    summary: exhaustedReason
      ? `limit reached upstream · ${usedLabel} ${meter.label} (UTC ${periodKey})`
      : `${usedLabel} / ${limitLabel} ${meter.label} · ${remainingLabel} left (UTC ${periodKey})`,
  };
}
