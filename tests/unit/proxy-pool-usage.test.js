// Relay usage counter + per-gateway meter readout.
//
// The two halves are tested together on purpose: the counter decides which
// numbers exist and the meter decides which of them a given relay type is
// actually judged by (Cloudflare = requests/day, Vercel = GB/month, ...).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-usage-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

const POOL = "pool-1";

describe("proxy pool usage counter", () => {
  it("counts requests and bytes on the same daily row", async () => {
    const { recordProxyPoolRequest, recordProxyPoolBytes, getProxyPoolUsage } =
      await import("@/lib/db/repos/proxyPoolUsageRepo.js");
    const date = new Date("2026-11-19T10:00:00Z");

    await recordProxyPoolRequest(POOL, date);
    await recordProxyPoolRequest(POOL, date);
    await recordProxyPoolBytes(POOL, 1500, date);
    await recordProxyPoolBytes(POOL, 500, date);

    const row = await getProxyPoolUsage(POOL, "2026-11-19");
    expect(row.requests).toBe(2);
    expect(row.bytes).toBe(2000);
  });

  it("sums the month from the daily rows", async () => {
    const { recordProxyPoolRequest, recordProxyPoolBytes, getProxyPoolUsageMonthMap } =
      await import("@/lib/db/repos/proxyPoolUsageRepo.js");

    await recordProxyPoolRequest(POOL, new Date("2026-11-01T01:00:00Z"));
    await recordProxyPoolRequest(POOL, new Date("2026-11-02T01:00:00Z"));
    await recordProxyPoolBytes(POOL, 4000, new Date("2026-11-02T01:00:00Z"));
    await recordProxyPoolRequest("other", new Date("2026-11-02T01:00:00Z"));
    // Previous month must not leak into the current one.
    await recordProxyPoolRequest(POOL, new Date("2026-10-31T01:00:00Z"));

    const month = await getProxyPoolUsageMonthMap("2026-11");
    expect(month.get(POOL).requests).toBe(2);
    expect(month.get(POOL).bytes).toBe(4000);
    expect(month.get("other").requests).toBe(1);
  });

  it("ignores non-positive byte amounts", async () => {
    const { recordProxyPoolBytes, getProxyPoolUsage } = await import("@/lib/db/repos/proxyPoolUsageRepo.js");
    const date = new Date("2026-11-19T10:00:00Z");
    expect(await recordProxyPoolBytes(POOL, 0, date)).toBe(null);
    expect(await recordProxyPoolBytes(POOL, -5, date)).toBe(null);
    expect(await recordProxyPoolBytes(POOL, Number.NaN, date)).toBe(null);
    const row = await getProxyPoolUsage(POOL, "2026-11-19");
    expect(row.bytes).toBe(0);
  });
});

describe("per-gateway quota meters", () => {
  const now = new Date("2026-11-19T05:00:00Z");
  const usage = {
    day: { requests: 250, bytes: 111 },
    month: { requests: 9000, bytes: 2_500_000_000 },
  };

  const build = async (pool, buckets = usage) => {
    const { buildProxyPoolQuota } = await import("@/shared/utils/proxyPoolQuota.js");
    return buildProxyPoolQuota(pool, buckets, now);
  };

  it("cloudflare is a daily request meter", async () => {
    const q = await build({ id: "cf", type: "cloudflare" });
    expect(q.period).toBe("day");
    expect(q.unit).toBe("requests");
    expect(q.used).toBe(250);
    expect(q.limit).toBe(100000);
    expect(q.remaining).toBe(99750);
    expect(q.periodKey).toBe("2026-11-19");
  });

  it("vercel is a monthly GB meter with the 10 GB estimate", async () => {
    const q = await build({ id: "v", type: "vercel" });
    expect(q.period).toBe("month");
    expect(q.unit).toBe("bytes");
    expect(q.used).toBe(2_500_000_000);
    expect(q.limit).toBe(10_000_000_000);
    expect(q.estimated).toBe(true);
    expect(q.summary).toContain("10.0 GB (estimated)");
    expect(q.periodKey).toBe("2026-11");
  });

  it("vercel honours an explicit byte limit and drops the estimate label", async () => {
    const q = await build({ id: "v", type: "vercel", monthlyByteLimit: 5_000_000_000 });
    expect(q.limit).toBe(5_000_000_000);
    expect(q.estimated).toBe(false);
  });

  it("deno counts monthly egress in GiB", async () => {
    const q = await build({ id: "d", type: "deno" });
    expect(q.unit).toBe("bytes");
    expect(q.limit).toBe(20 * 1024 ** 3);
    expect(q.summary).toContain("GiB");
  });

  it("netlify reports a count with no claimed cap", async () => {
    const q = await build({ id: "n", type: "netlify" });
    expect(q.limit).toBe(null);
    expect(q.remaining).toBe(null);
    expect(q.used).toBe(9000);
  });

  it("plain http pools have no meter", async () => {
    const q = await build({ id: "h", type: "http" });
    expect(q.period).toBe(null);
    expect(q.summary).toBe(null);
  });

  it("a parked pool still shows its measured usage, flagged as reached", async () => {
    const q = await build({ id: "v", type: "vercel", lastError: "quota_exhausted: upstream returned HTTP 429" });
    expect(q.exhausted).toBe(true);
    expect(q.used).toBe(2_500_000_000);
    expect(q.summary).toContain("limit reached upstream");
  });
});
