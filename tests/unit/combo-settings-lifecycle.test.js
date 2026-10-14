import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ getSettings: vi.fn(), updateSettings: vi.fn(), reset: vi.fn(), getComboById: vi.fn(), updateCombo: vi.fn(), deleteCombo: vi.fn(), getComboByName: vi.fn() }));
vi.mock("@/lib/localDb", () => ({ ...mock }));
vi.mock("open-sse/services/combo.js", () => ({ resetComboRotation: mock.reset }));
vi.mock("@/lib/network/outboundProxy", () => ({ applyOutboundProxyEnv: vi.fn() }));
import { PATCH } from "../../src/app/api/settings/route.js";
import { PUT, DELETE } from "../../src/app/api/combos/[id]/route.js";

const request = body => new Request("http://localhost/api/settings", { method: "PATCH", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
const context = { params: Promise.resolve({ id: "id-1" }) };

describe("combo strategy lifecycle", () => {
  beforeEach(() => { vi.resetAllMocks(); mock.getSettings.mockResolvedValue({ comboStrategies: { a: { fallbackStrategy: "fallback-grading" } } }); mock.updateSettings.mockImplementation(async update => ({ comboStrategies: { a: { fallbackStrategy: "fallback-grading" } }, ...update })); });

  it("saving another combo does not reset grading", async () => {
    const res = await PATCH(request({ comboStrategies: { a: { fallbackStrategy: "fallback-grading" }, b: { fallbackStrategy: "round-robin" } } }));
    expect(res.status).toBe(200);
    expect(mock.reset.mock.calls).toEqual([["b"]]);
  });

  it("changing round-robin sticky limit excludes grading from reset", async () => {
    await PATCH(request({ comboStickyRoundRobinLimit: 3 }));
    expect(mock.reset).toHaveBeenCalledWith(undefined, { grading: false });
  });

  it("renaming preserves the combo strategy", async () => {
    mock.getComboById.mockResolvedValue({ id: "id-1", name: "a", models: ["p/m"] });
    mock.updateCombo.mockResolvedValue({ id: "id-1", name: "renamed", models: ["p/m"] });
    mock.getComboByName.mockResolvedValue(null);
    expect((await PUT(request({ name: "renamed" }), context)).status).toBe(200);
    expect(mock.updateSettings).toHaveBeenCalledWith({ comboStrategies: { renamed: { fallbackStrategy: "fallback-grading" } } });
  });

  it("deleting removes name-keyed strategy", async () => {
    mock.getComboById.mockResolvedValue({ id: "id-1", name: "a" });
    mock.deleteCombo.mockResolvedValue(true);
    expect((await DELETE(request({}), context)).status).toBe(200);
    expect(mock.updateSettings).toHaveBeenCalledWith({ comboStrategies: {} });
    expect(mock.reset).toHaveBeenCalledWith("a");
  });
});
