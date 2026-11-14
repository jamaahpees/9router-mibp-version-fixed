import { describe, it, expect } from "vitest";
import antigravity from "../../open-sse/providers/registry/antigravity.js";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";

const DEAD_PREFIXES = [
  "gemini-4-argon",
  "gemini-4-carbon",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.1-pro",
  "gemini-pro-agent",
  "claude-sonnet-5-5",
  "claude-opus-5-5",
  "gemini-4-hydrogen",
];

describe("antigravity catalog reflects what the backend serves", () => {
  it("does not advertise models that answer 404 on every account", () => {
    const ids = antigravity.models.map((m) => m.id);
    for (const prefix of DEAD_PREFIXES) {
      expect(ids.filter((id) => id.startsWith(prefix))).toEqual([]);
    }
  });

  it("keeps the models that actually answer 200", () => {
    const ids = antigravity.models.map((m) => m.id);
    for (const id of ["gemini-3.8-flash", "gemini-3.8-flash-high", "claude-sonnet-4-6", "gpt-oss-120b-medium", "gemini-3.1-flash-image"]) {
      expect(ids).toContain(id);
    }
  });

  it("advertises the extra models the backend answered 200 for", () => {
    const ids = antigravity.models.map((m) => m.id);
    for (const id of ["gemini-3-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-flash-thinking"]) {
      expect(ids).toContain(id);
    }
    // listed upstream but answered 503 "No capacity available"
    expect(ids).not.toContain("gemini-2.5-pro");
  });
});

describe("model-not-found is request scoped", () => {
  it("does not fall back across accounts on a 404 model mismatch", () => {
    const result = checkFallbackError(404, '{"error":{"code":404,"message":"Requested entity was not found."}}', 0, "antigravity");
    expect(result.shouldFallback).toBe(false);
    expect(result.requestScoped).toBe(true);
  });

  it("still falls back for other 404 responses", () => {
    const result = checkFallbackError(404, '{"error":{"message":"page not found"}}', 0, "antigravity");
    expect(result.shouldFallback).toBe(true);
  });
});