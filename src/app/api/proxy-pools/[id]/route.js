import { NextResponse } from "next/server";
import {
  countBoundConnections,
  connectionProxyPoolIds,
  detachProxyPoolFromProviderData,
  detachProxyPoolFromStrategies,
} from "@/shared/utils/proxyPoolBinding.js";
import { getSettings, updateSettings } from "@/lib/localDb";
import { forgetPoolGeo } from "open-sse/services/poolGeo.js";
import { forgetPoolFitness } from "open-sse/services/proxyPoolFitness.js";
import {
  deleteProxyPool,
  getProviderConnections,
  getProxyPoolById,
  updateProviderConnection,
  updateProxyPool,
} from "@/models";

function normalizeProxyPoolUpdate(body = {}) {
  const updates = {};

  if (Object.prototype.hasOwnProperty.call(body, "name")) {
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name) {
      return { error: "Name is required" };
    }
    updates.name = name;
  }

  if (Object.prototype.hasOwnProperty.call(body, "proxyUrl")) {
    const proxyUrl = typeof body?.proxyUrl === "string" ? body.proxyUrl.trim() : "";
    if (!proxyUrl) {
      return { error: "Proxy URL is required" };
    }
    updates.proxyUrl = proxyUrl;
  }

  if (Object.prototype.hasOwnProperty.call(body, "noProxy")) {
    updates.noProxy = typeof body?.noProxy === "string" ? body.noProxy.trim() : "";
  }

  if (Object.prototype.hasOwnProperty.call(body, "isActive")) {
    updates.isActive = body?.isActive === true;
  }

  if (Object.prototype.hasOwnProperty.call(body, "strictProxy")) {
    updates.strictProxy = body?.strictProxy === true;
  }

  if (Object.prototype.hasOwnProperty.call(body, "type")) {
    const validTypes = ["http", "vercel", "cloudflare", "deno", "netlify"];
    updates.type = validTypes.includes(body?.type) ? body.type : "http";
  }

  return { updates };
}

// GET /api/proxy-pools/[id] - Get proxy pool
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const proxyPool = await getProxyPoolById(id);

    if (!proxyPool) {
      return NextResponse.json({ error: "Proxy pool not found" }, { status: 404 });
    }

    return NextResponse.json({ proxyPool });
  } catch (error) {
    console.log("Error fetching proxy pool:", error);
    return NextResponse.json({ error: "Failed to fetch proxy pool" }, { status: 500 });
  }
}

// PUT /api/proxy-pools/[id] - Update proxy pool
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const existing = await getProxyPoolById(id);

    if (!existing) {
      return NextResponse.json({ error: "Proxy pool not found" }, { status: 404 });
    }

    const body = await request.json();
    const normalized = normalizeProxyPoolUpdate(body);

    if (normalized.error) {
      return NextResponse.json({ error: normalized.error }, { status: 400 });
    }

    const updated = await updateProxyPool(id, normalized.updates);
    return NextResponse.json({ proxyPool: updated });
  } catch (error) {
    console.log("Error updating proxy pool:", error);
    return NextResponse.json({ error: "Failed to update proxy pool" }, { status: 500 });
  }
}

// Force flag: "delete anyway" detaches the pool from every account that still
// points at it. Requests fall back to the legacy single proxy or direct egress.
async function readForceFlag(request) {
  try {
    const url = new URL(request.url);
    const query = url.searchParams.get("force");
    if (query === "true" || query === "1") return true;
  } catch {
    // Non-standard request URL (tests): fall through to the body check.
  }
  try {
    const body = await request.json();
    return body?.force === true;
  } catch {
    return false;
  }
}

// DELETE /api/proxy-pools/[id] - Delete proxy pool
// Without force this refuses while the pool is bound (upstream behaviour).
// With force=true it detaches the pool from connections and settings first.
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const existing = await getProxyPoolById(id);

    if (!existing) {
      return NextResponse.json({ error: "Proxy pool not found" }, { status: 404 });
    }

    const connections = await getProviderConnections();
    const bound = connections.filter((connection) => connectionProxyPoolIds(connection).includes(id));

    if (bound.length > 0) {
      const force = await readForceFlag(request);
      if (!force) {
        return NextResponse.json(
          {
            error: "Proxy pool is currently in use",
            boundConnectionCount: bound.length,
            canForceDelete: true,
          },
          { status: 409 }
        );
      }

      for (const connection of bound) {
        const providerSpecificData = detachProxyPoolFromProviderData(connection.providerSpecificData, id);
        await updateProviderConnection(connection.id, { providerSpecificData });
      }

      // Free/no-auth providers pick their pool from settings, not a connection.
      try {
        const settings = await getSettings();
        const nextStrategies = detachProxyPoolFromStrategies(settings?.providerStrategies, id);
        if (nextStrategies) await updateSettings({ providerStrategies: nextStrategies });
      } catch (error) {
        console.log("Error detaching proxy pool from settings:", error);
      }
    }

    await deleteProxyPool(id);
    forgetPoolGeo(id);
    forgetPoolFitness(id);

    return NextResponse.json({ success: true, detachedConnections: bound.length });
  } catch (error) {
    console.log("Error deleting proxy pool:", error);
    return NextResponse.json({ error: "Failed to delete proxy pool" }, { status: 500 });
  }
}
