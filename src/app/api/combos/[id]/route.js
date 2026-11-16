import { NextResponse } from "next/server";
import { getComboById, updateCombo, deleteCombo, getComboByName, getCombos, getSettings, updateSettings } from "@/lib/localDb";
import { resetComboRotation } from "open-sse/services/combo.js";
import { cleanComboModels, comboMapFromRows, parseComboLimit } from "@/shared/utils/comboGraph.js";

// Validate combo name: only a-z, A-Z, 0-9, -, _
const VALID_NAME_REGEX = /^[a-zA-Z0-9_.\-]+$/;

// GET /api/combos/[id] - Get combo by ID
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const combo = await getComboById(id);
    
    if (!combo) {
      return NextResponse.json({ error: "Combo not found" }, { status: 404 });
    }
    
    return NextResponse.json(combo);
  } catch (error) {
    console.log("Error fetching combo:", error);
    return NextResponse.json({ error: "Failed to fetch combo" }, { status: 500 });
  }
}

// PUT /api/combos/[id] - Update combo
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    
    // Validate name format if provided
    if (body.name) {
      if (!VALID_NAME_REGEX.test(body.name)) {
        return NextResponse.json({ error: "Name can only contain letters, numbers, -, _ and ." }, { status: 400 });
      }
      
      // Check if name already exists (exclude current combo)
      const existing = await getComboByName(body.name);
      if (existing && existing.id !== id) {
        return NextResponse.json({ error: "Combo name already exists" }, { status: 400 });
      }
    }
    
    // Capture previous name to invalidate rotation state on rename
    const prev = await getComboById(id);

    // Reject self-reference / cycles before writing; a cyclic combo expands
    // forever at request time and takes the process down with it.
    if (Array.isArray(body.models)) {
      const others = (await getCombos()).filter((c) => c.id !== id);
      const targetName = body.name || prev?.name;
      const { models: cleanedModels, removed } = cleanComboModels(targetName, body.models, comboMapFromRows(others));
      const blocked = removed.filter((r) => r.reason === "self-reference" || r.reason === "cycle");
      if (blocked.length > 0) {
        const message = blocked.some((r) => r.reason === "self-reference")
          ? `Combo "${targetName}" cannot list itself as a model`
          : `Combo "${targetName}" would form a cycle through "${blocked[0].model}"`;
        return NextResponse.json({ error: message, blocked }, { status: 400 });
      }
      body.models = cleanedModels;
    }

    // Manual limits: undefined leaves the stored value alone, null clears it.
    if ("contextWindow" in body) {
      const parsed = parseComboLimit(body.contextWindow, "contextWindow");
      if (parsed.error) return NextResponse.json({ error: parsed.error }, { status: 400 });
      body.contextWindow = parsed.value;
    }
    if ("maxOutput" in body) {
      const parsed = parseComboLimit(body.maxOutput, "maxOutput");
      if (parsed.error) return NextResponse.json({ error: parsed.error }, { status: 400 });
      body.maxOutput = parsed.value;
    }
    if ("timeoutMs" in body) {
      const parsed = parseComboLimit(body.timeoutMs, "timeoutMs");
      if (parsed.error) return NextResponse.json({ error: parsed.error }, { status: 400 });
      body.timeoutMs = parsed.value;
    }

    const combo = await updateCombo(id, body);
    
    if (!combo) {
      return NextResponse.json({ error: "Combo not found" }, { status: 404 });
    }

    if (prev?.name && combo.name !== prev.name) {
      const settings = await getSettings();
      const strategies = { ...(settings.comboStrategies || {}) };
      if (strategies[prev.name]) strategies[combo.name] = strategies[prev.name];
      else delete strategies[combo.name];
      delete strategies[prev.name];
      await updateSettings({ comboStrategies: strategies });
    }

    // Invalidate rotation state (models/strategy/name may have changed)
    if (prev?.name) resetComboRotation(prev.name);
    if (combo.name && combo.name !== prev?.name) resetComboRotation(combo.name);

    return NextResponse.json(combo);
  } catch (error) {
    console.log("Error updating combo:", error);
    return NextResponse.json({ error: "Failed to update combo" }, { status: 500 });
  }
}

// DELETE /api/combos/[id] - Delete combo
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const prev = await getComboById(id);
    const success = await deleteCombo(id);
    
    if (!success) {
      return NextResponse.json({ error: "Combo not found" }, { status: 404 });
    }

    if (prev?.name) {
      resetComboRotation(prev.name);
      const settings = await getSettings();
      const strategies = { ...(settings.comboStrategies || {}) };
      delete strategies[prev.name];
      await updateSettings({ comboStrategies: strategies });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error deleting combo:", error);
    return NextResponse.json({ error: "Failed to delete combo" }, { status: 500 });
  }
}
