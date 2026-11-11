import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import {
  connectionProxyPoolIds,
  buildProxyPoolUsageMap,
  countBoundConnections,
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

describe("DELETE /api/proxy-pools/[id]", () => {
  const deleteProxyPool = vi.fn(async () => true);
  const getProxyPoolById = vi.fn(async () => ({ id: "pool-a", name: "Pool A" }));
  let connections = [];

  beforeEach(() => {
    vi.resetModules();
    deleteProxyPool.mockClear();
    connections = [];
  });

  async function loadDelete() {
    vi.doMock("@/models", () => ({
      deleteProxyPool,
      getProxyPoolById,
      getProviderConnections: async () => connections,
      updateProxyPool: async () => ({}),
    }));
    const mod = await import("../../src/app/api/proxy-pools/[id]/route.js");
    return mod.DELETE;
  }

  const call = (DELETE) => DELETE(new Request("http://local/api/proxy-pools/pool-a", { method: "DELETE" }), { params: Promise.resolve({ id: "pool-a" }) });

  it("refuses to delete a pool bound through the multi-pool list", async () => {
    connections = [{ providerSpecificData: { proxyPoolIds: ["pool-a", "pool-b"] } }];
    const res = await call(await loadDelete());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.boundConnectionCount).toBe(1);
    expect(deleteProxyPool).not.toHaveBeenCalled();
  });

  it("refuses to delete a pool bound through the legacy single field", async () => {
    connections = [{ providerSpecificData: { proxyPoolId: "pool-a" } }];
    const res = await call(await loadDelete());
    expect(res.status).toBe(409);
    expect(deleteProxyPool).not.toHaveBeenCalled();
  });

  it("deletes a pool nothing points at", async () => {
    connections = [{ providerSpecificData: { proxyPoolIds: ["pool-b"] } }];
    const res = await call(await loadDelete());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(deleteProxyPool).toHaveBeenCalledWith("pool-a");
  });
});
