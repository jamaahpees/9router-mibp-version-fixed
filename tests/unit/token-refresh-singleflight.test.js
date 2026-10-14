// Single-flight OAuth refresh: concurrent waiters must share ONE in-flight
// refresh, and a waiter that is cancelled (its own pre-commit deadline fires)
// must NEVER abort that shared refresh — other requests still depend on it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { withCredentialRefreshLock } from "../../open-sse/services/oauthCredentialManager.js";
import { dedupRefresh } from "../../open-sse/services/tokenRefresh/dedup.js";
import { createRequestBudget } from "../../open-sse/utils/requestBudget.js";

const FAKE = ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"];

afterEach(() => {
  vi.useRealTimers();
});

describe("shared OAuth single-flight", () => {
  it("withCredentialRefreshLock shares one in-flight refresh per connection", async () => {
    let release;
    const refreshFn = vi.fn(() => new Promise((resolve) => { release = () => resolve({ accessToken: "t" }); }));
    const creds = { connectionId: "c1" };

    const p1 = withCredentialRefreshLock("openai", creds, refreshFn);
    const p2 = withCredentialRefreshLock("openai", creds, refreshFn);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(refreshFn).toHaveBeenCalledTimes(1);
    release();
    await expect(Promise.all([p1, p2])).resolves.toEqual([
      { accessToken: "t" },
      { accessToken: "t" },
    ]);
    expect(refreshFn).toHaveBeenCalledTimes(1);
  });

  it("a waiter cancelled by its own deadline never aborts the shared refresh", async () => {
    vi.useFakeTimers({ toFake: FAKE });
    let release;
    const refreshFn = () => new Promise((resolve) => { release = () => resolve({ accessToken: "shared" }); });
    const lock = withCredentialRefreshLock("xai", { connectionId: "c2" }, refreshFn);

    const budget = createRequestBudget({ deadlineAt: performance.now() + 50 });
    const waiter = budget.wait(lock).then(() => "ok", (e) => e);
    await vi.advanceTimersByTimeAsync(51);

    expect((await waiter).name).toBe("TimeoutError");

    // The shared refresh keeps running and resolves for the other waiters.
    release();
    await expect(lock).resolves.toEqual({ accessToken: "shared" });
    budget.dispose();
  });

  it("dedupRefresh collapses concurrent identical refreshes and survives waiter cancel", async () => {
    vi.useFakeTimers({ toFake: FAKE });
    let fnCalls = 0;
    let release;
    const fn = () => {
      fnCalls++;
      return new Promise((resolve) => { release = () => resolve({ token: "x" }); });
    };

    const a = dedupRefresh("xai", "tok", fn);
    const b = dedupRefresh("xai", "tok", fn);
    expect(fnCalls).toBe(1);

    const budget = createRequestBudget({ deadlineAt: performance.now() + 10 });
    const waiter = budget.wait(a).catch((e) => e);
    await vi.advanceTimersByTimeAsync(11);
    expect((await waiter).name).toBe("TimeoutError");

    release();
    await expect(b).resolves.toEqual({ token: "x" });
    budget.dispose();
  });
});
