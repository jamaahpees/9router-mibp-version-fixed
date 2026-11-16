import { describe, it, expect } from "vitest";

import {
  applyComboLimits,
  coerceComboLimit,
  comboLimitOverride,
  parseComboLimit,
  COMBO_LIMIT_BOUNDS,
} from "../../src/shared/utils/comboGraph.js";

const baseCaps = { contextWindow: 272000, maxOutput: 384000 };

describe("combo limit override", () => {
  it("keeps derived caps when nothing is pinned", () => {
    expect(comboLimitOverride({ name: "a" })).toEqual({
      contextWindow: undefined,
      maxOutput: undefined,
    });
    expect(applyComboLimits(baseCaps, comboLimitOverride({}))).toEqual(baseCaps);
  });

  it("lets the operator replace the derived window", () => {
    const caps = applyComboLimits(baseCaps, comboLimitOverride({ contextWindow: 1000000 }));

    expect(caps).toEqual({ contextWindow: 1000000, maxOutput: 384000 });
    // The aggregate is shared, so an overlay must never mutate it in place.
    expect(baseCaps.contextWindow).toBe(272000);
  });

  it("pins context and output independently", () => {
    const caps = applyComboLimits(
      baseCaps,
      comboLimitOverride({ contextWindow: 1000000, maxOutput: 64000 }),
    );

    expect(caps).toEqual({ contextWindow: 1000000, maxOutput: 64000 });
  });

  it("survives a caps object of null", () => {
    expect(applyComboLimits(null, { contextWindow: 1000 })).toBe(null);
  });

  it("reads a stored value leniently and rejects nonsense as NULL", () => {
    expect(coerceComboLimit("1000000", "contextWindow")).toBe(1000000);
    expect(coerceComboLimit(0, "contextWindow")).toBe(null);
    expect(coerceComboLimit(999, "contextWindow")).toBe(null);
    expect(coerceComboLimit(1.5, "maxOutput")).toBe(null);
    expect(coerceComboLimit("abc", "maxOutput")).toBe(null);
    expect(coerceComboLimit(null, "maxOutput")).toBe(null);
  });

  it("accepts an empty string as 'clear the override'", () => {
    expect(parseComboLimit("", "contextWindow")).toEqual({ value: null });
    expect(parseComboLimit(null, "maxOutput")).toEqual({ value: null });
    expect(parseComboLimit(undefined, "maxOutput")).toEqual({ value: null });
  });

  it("rejects out-of-bounds and non-integer writes with a readable message", () => {
    const low = parseComboLimit(COMBO_LIMIT_BOUNDS.contextWindow.min - 1, "contextWindow");
    const high = parseComboLimit(COMBO_LIMIT_BOUNDS.contextWindow.max + 1, "contextWindow");
    const fractional = parseComboLimit(1234.5, "maxOutput");

    expect(low.error).toMatch(/Context window must be between/);
    expect(high.error).toMatch(/Context window must be between/);
    expect(fractional.error).toMatch(/Max output must be a whole number/);
    expect(parseComboLimit(1000000, "contextWindow")).toEqual({ value: 1000000 });
  });

  it("bounds the attempt timeout separately from the published limits", () => {
    expect(parseComboLimit(60000, "timeoutMs")).toEqual({ value: 60000 });
    expect(parseComboLimit("", "timeoutMs")).toEqual({ value: null });
    expect(parseComboLimit(1000, "timeoutMs").error).toMatch(/Attempt timeout must be between/);
    expect(parseComboLimit(300001, "timeoutMs").error).toMatch(/Attempt timeout must be between/);
    expect(coerceComboLimit(60000, "timeoutMs")).toBe(60000);
    expect(coerceComboLimit(0, "timeoutMs")).toBe(null);
  });

  it("keeps the attempt timeout out of the published capability overlay", () => {
    const override = comboLimitOverride({ contextWindow: 1000000, timeoutMs: 60000 });

    expect(override).toEqual({ contextWindow: 1000000, maxOutput: undefined });
  });
});
