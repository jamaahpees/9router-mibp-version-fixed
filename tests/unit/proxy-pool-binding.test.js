import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import {
  connectionProxyPoolIds,
  buildProxyPoolUsageMap,
  countBoundConnections,
  detachProxyPoolFromProviderData,
  detachProxyPoolFromStrategies,
} from "../../src/shared/utils/proxyPoolBinding.js";

const conn = (proxyPoolId, proxyPoolIds) => ({ providerSpecificData: { proxyPoolId, proxyPoolIds } });

describe("proxy pool bindings", () => {
  it("reads the legacy single field", () => {
    expect(connectionProxyPoolIds(conn("pool-a"))).toEqual(["pool-a"]);
  });

  it("reads the multi-pool rotation list", () => {
    expect(connectionProxyPoolIds(conn(undefined, ["pool-a", "pool-b"]))).toEqual(["pool-a", "pool-b"]);
  });

  it("dedupes a pool present in both fields", () => {
    expect(connectionProxyPoolIds(conn("pool-a", ["pool-a", "pool-b"]))).toEqual(["pool-a", "pool-b"]);
  });

  it("tolerates missing or malformed provider data", () => {
    expect(connectionProxyPoolIds(null)).toEqual([]);
    expect(connectionProxyPoolIds({})).toEqual([]);
    expect(connectionProxyPoolIds(conn("", [null, "", 0]))).toEqual([]);
  });

  it("counts one connection per pool across both fields", () => {
    const connections = [
      conn("pool-a"),
      conn(undefined, ["pool-a", "pool-b"]),
      conn("pool-b", ["pool-b"]),
      conn(undefined, []),
    ];
    const usage = buildProxyPoolUsageMap(connections);
    expect(usage.get("pool-a")).toBe(2);
    expect(usage.get("pool-b")).toBe(2);
    expect(usage.get("pool-c")).toBeUndefined();
    expect(countBoundConnections(connections, "pool-a")).toBe(2);
    expect(countBoundConnections(connections, "pool-b")).toBe(2);
    expect(countBoundConnections(connections, "pool-c")).toBe(0);
  });

  it("keeps the delete guard from ignoring multi-pool bindings", () => {
    // Regression: DELETE /api/proxy-pools/[id] only compared the legacy
    // providerSpecificData.proxyPoolId, so a pool chosen through the multi-pool
    // picker looked unused and could be deleted while still in rotation.
    const source = fs.readFileSync("src/app/api/proxy-pools/[id]/route.js", "utf8");
    expect(source).toContain("countBoundConnections");
    expect(source).not.toMatch(/providerSpecificData\?\.proxyPoolId === proxyPoolId/);
  });
});

describe("detach helpers", () => {
  it("removes the pool from the rotation list and stops advertising a proxy", () => {
    const psd = detachProxyPoolFromProviderData(
      { proxyPoolIds: ["pool-a"], proxyRotationStrategy: "round-robin" },
      "pool-a"
    );
    expect(psd.proxyPoolIds).toEqual([]);
    expect(psd.proxyRotationStrategy).toBe("none");
    expect(psd.connectionProxyEnabled).toBe(false);
  });

  it("keeps other pools and the legacy direct proxy untouched", () => {
    const psd = detachProxyPoolFromProviderData(
      { proxyPoolIds: ["pool-a", "pool-b"], connectionProxyUrl: "http://direct:8888", connectionProxyEnabled: true },
      "pool-a"
    );
    expect(psd.proxyPoolIds).toEqual(["pool-b"]);
    expect(psd.connectionProxyEnabled).toBe(true);
    expect(psd.connectionProxyUrl).toBe("http://direct:8888");
  });

  it("clears legacy single-pool fields that match", () => {
    const psd = detachProxyPoolFromProviderData({ proxyPoolId: "pool-a", connectionProxyPoolId: "pool-a" }, "pool-a");
    expect(psd.proxyPoolId).toBeNull();
    expect(psd.connectionProxyPoolId).toBeNull();
  });

  it("drops the pool from provider strategies", () => {
    const next = detachProxyPoolFromStrategies(
      { freebuff: { proxyPoolId: "pool-a", rotateStrategy: "smart" }, gemini: { proxyPoolId: "pool-b" } },
      "pool-a"
    );
    expect(next.freebuff.proxyPoolId).toBeNull();
    expect(next.freebuff.rotateStrategy).toBe("smart");
    expect(next.gemini.proxyPoolId).toBe("pool-b");
  });
});

describe("DELETE /api/proxy-pools/[id]", () => {
  const deleteProxyPool = vi.fn(async () => true);
  const updateProviderConnection = vi.fn(async () => ({}));
  const getProxyPoolById = vi.fn(async () => ({ id: "pool-a", name: "Pool A" }));
  let connections = [];
  let settings = { providerStrategies: {} };
  const updateSettings = vi.fn(async () => ({}));

  beforeEach(() => {
    vi.resetModules();
    deleteProxyPool.mockClear();
    updateProviderConnection.mockClear();
    updateSettings.mockClear();
    connections = [];
    settings = { providerStrategies: {} };
  });

  async function loadDelete() {
    vi.doMock("@/models", () => ({
      deleteProxyPool,
      getProxyPoolById,
      getProviderConnections: async () => connections,
      updateProviderConnection,
      updateProxyPool: async () => ({}),
    }));
    vi.doMock("@/lib/localDb", () => ({
      getSettings: async () => settings,
      updateSettings,
    }));
    const mod = await import("../../src/app/api/proxy-pools/[id]/route.js");
    return mod.DELETE;
  }

  const call = (DELETE, query = "") => DELETE(new Request(`http://local/api/proxy-pools/pool-a${query}`, { method: "DELETE" }), { params: Promise.resolve({ id: "pool-a" }) });

  it("refuses to delete a pool bound through the multi-pool list", async () => {
    connections = [{ id: "conn-1", providerSpecificData: { proxyPoolIds: ["pool-a", "pool-b"] } }];
    const res = await call(await loadDelete());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.boundConnectionCount).toBe(1);
    expect(body.canForceDelete).toBe(true);
    expect(deleteProxyPool).not.toHaveBeenCalled();
    expect(updateProviderConnection).not.toHaveBeenCalled();
  });

  it("force deletes and detaches every bound connection", async () => {
    connections = [
      { id: "conn-1", providerSpecificData: { proxyPoolIds: ["pool-a", "pool-b"] } },
      { id: "conn-2", providerSpecificData: { proxyPoolId: "pool-a" } },
      { id: "conn-3", providerSpecificData: { proxyPoolIds: ["pool-b"] } },
    ];
    settings = { providerStrategies: { freebuff: { proxyPoolId: "pool-a" } } };
    const res = await call(await loadDelete(), "?force=1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, detachedConnections: 2 });
    expect(updateProviderConnection).toHaveBeenCalledTimes(2);
    expect(updateProviderConnection.mock.calls.map(([id]) => id).sort()).toEqual(["conn-1", "conn-2"]);
    expect(updateSettings).toHaveBeenCalledWith({ providerStrategies: { freebuff: { proxyPoolId: null } } });
    expect(deleteProxyPool).toHaveBeenCalledWith("pool-a");
  });

  it("refuses to delete a pool bound through the legacy single field", async () => {
    connections = [{ providerSpecificData: { proxyPoolId: "pool-a" } }];
    const res = await call(await loadDelete());
    expect(res.status).toBe(409);
    expect(deleteProxyPool).not.toHaveBeenCalled();
  });

  it("deletes a pool nothing points at", async () => {
    connections = [{ id: "conn-1", providerSpecificData: { proxyPoolIds: ["pool-b"] } }];
    const res = await call(await loadDelete());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, detachedConnections: 0 });
    expect(deleteProxyPool).toHaveBeenCalledWith("pool-a");
  });
});
