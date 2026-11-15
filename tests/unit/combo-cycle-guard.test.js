import { describe, it, expect } from "vitest";

import {
  cleanComboModels,
  comboMapFromRows,
  comboReaches,
  isComboRef,
} from "../../src/shared/utils/comboGraph.js";

describe("combo graph guard", () => {
  it("drops a combo's own name from its members", () => {
    const { models, removed } = cleanComboModels(
      "claude9-opus-5",
      ["cx/gpt-6.1-sol", "claude9-opus-5"],
      new Map(),
    );

    expect(models).toEqual(["cx/gpt-6.1-sol"]);
    expect(removed).toEqual([{ model: "claude9-opus-5", reason: "self-reference" }]);
  });

  it("keeps nested combos that do not loop back", () => {
    const map = comboMapFromRows(
      [
        { name: "smart-agent9", models: ["ag/gemini-3.8-flash-high"] },
        { name: "openclaw9", models: ["smart-agent9"] },
      ],
      { override: { name: "hermes-aftershock", models: [] } },
    );

    const { models, removed } = cleanComboModels("hermes-aftershock", ["openclaw9", "smart-agent9"], map);

    expect(models).toEqual(["openclaw9", "smart-agent9"]);
    expect(removed).toEqual([]);
  });

  it("drops the member that would close a cycle", () => {
    const map = comboMapFromRows([
      { name: "a", models: ["b"] },
      { name: "b", models: ["a"] },
    ]);

    const { models, removed } = cleanComboModels("a", ["b"], map);

    expect(models).toEqual([]);
    expect(removed).toEqual([{ model: "b", reason: "cycle" }]);
  });

  it("dedupes members and drops empty entries", () => {
    const { models, removed } = cleanComboModels(
      "dup",
      ["ag/gemini-3-flash", "ag/gemini-3-flash", "", "  "],
      new Map(),
    );

    expect(models).toEqual(["ag/gemini-3-flash"]);
    expect(removed.map((r) => r.reason)).toEqual(["duplicate", "empty", "empty"]);
  });

  it("treats provider/model ids as leaves, not combo references", () => {
    expect(isComboRef("ag/gemini-3-flash")).toBe(false);
    expect(isComboRef("free")).toBe(true);
    expect(comboReaches("ag/whatever", "free", new Map())).toBe(false);
  });

  it("finds a cycle across three levels", () => {
    const map = comboMapFromRows([
      { name: "a", models: ["b"] },
      { name: "b", models: ["c"] },
      { name: "c", models: ["a"] },
    ]);

    expect(comboReaches("b", "a", map)).toBe(true);
    expect(comboReaches("c", "c", map)).toBe(true);
  });

  it("does not report a cycle for a linear chain", () => {
    const map = comboMapFromRows([
      { name: "a", models: ["b"] },
      { name: "b", models: ["c"] },
      { name: "c", models: ["ag/gemini-3-flash"] },
    ]);

    expect(comboReaches("b", "a", map)).toBe(false);
    expect(cleanComboModels("top", ["a"], map)).toEqual({ models: ["a"], removed: [] });
  });
});
