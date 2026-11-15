import { NextResponse } from "next/server";
import { getCombos, createCombo, getComboByName } from "@/lib/localDb";
import { cleanComboModels, comboMapFromRows } from "@/shared/utils/comboGraph.js";

export const dynamic = "force-dynamic";

// Validate combo name: only a-z, A-Z, 0-9, -, _
const VALID_NAME_REGEX = /^[a-zA-Z0-9_.\-]+$/;

// A combo that reaches itself expands forever at request time, so reject it
// before it reaches the DB instead of trusting the picker to be careful.
function cycleError(name, removed) {
  const blocked = removed.filter((r) => r.reason === "self-reference" || r.reason === "cycle");
  if (blocked.length === 0) return null;
  const message = blocked.some((r) => r.reason === "self-reference")
    ? `Combo "${name}" cannot list itself as a model`
    : `Combo "${name}" would form a cycle through "${blocked[0].model}"`;
  return NextResponse.json({ error: message, blocked }, { status: 400 });
}

// GET /api/combos - Get all combos
export async function GET() {
  try {
    const combos = await getCombos();
    return NextResponse.json({ combos });
  } catch (error) {
    console.log("Error fetching combos:", error);
    return NextResponse.json({ error: "Failed to fetch combos" }, { status: 500 });
  }
}

// POST /api/combos - Create new combo
export async function POST(request) {
  try {
    const body = await request.json();
    const { name, models, kind } = body;

    if (!name) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    // Validate name format
    if (!VALID_NAME_REGEX.test(name)) {
      return NextResponse.json({ error: "Name can only contain letters, numbers, -, _ and ." }, { status: 400 });
    }

    // Check if name already exists
    const existing = await getComboByName(name);
    if (existing) {
      return NextResponse.json({ error: "Combo name already exists" }, { status: 400 });
    }

    const { models: cleanedModels, removed } = cleanComboModels(name, models, comboMapFromRows(await getCombos()));
    const blocked = cycleError(name, removed);
    if (blocked) return blocked;

    const combo = await createCombo({ name, models: cleanedModels, kind: kind || null });

    return NextResponse.json(combo, { status: 201 });
  } catch (error) {
    console.log("Error creating combo:", error);
    return NextResponse.json({ error: "Failed to create combo" }, { status: 500 });
  }
}
