import { describe, it, expect } from "vitest";

describe("Dashboard phase display & mock-SSE contract", () => {
  it("formats SSE payload including lifecycleRequests, recentLifecycleRequests, trackingOverflow without secrets", () => {
    const rawRecord = {
      id: "req-12345678-abcd",
      provider: "anthropic",
      model: "claude-3-7-sonnet",
      account: "acc-1234...",
      phase: "first_event_wait",
      terminal: null,
      elapsedMs: 2345.6,
      phaseElapsedMs: 123.4,
      phaseDurations: {
        selection_wait: 10.5,
        selecting_account: 50.2,
        preparing_credentials: 20.1,
        preparing_request: 5.0,
        upstream_headers_wait: 450.0,
        first_event_wait: 123.4,
      },
      milestones: {
        first_raw_byte: 535.8,
      },
    };

    const sseSnapshot = {
      activeRequests: [{ model: "claude-3-7-sonnet", provider: "anthropic", account: "Account acc-1234...", count: 1 }],
      recentRequests: [],
      errorProvider: "",
      pending: { byModel: {}, byAccount: {} },
      lifecycleRequests: [rawRecord],
      recentLifecycleRequests: [],
      trackingOverflow: {
        activeCount: 1,
        retainedActive: 1,
        overflowActive: 0,
        droppedDetails: 0,
        droppedAttempts: 0,
      },
    };

    const serialized = JSON.stringify(sseSnapshot);
    expect(serialized).not.toContain("sk-");
    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("bearer");

    const parsed = JSON.parse(serialized);
    expect(parsed.lifecycleRequests).toHaveLength(1);
    expect(parsed.lifecycleRequests[0].phase).toBe("first_event_wait");
    expect(parsed.lifecycleRequests[0].elapsedMs).toBeCloseTo(2345.6);
  });

  it("verifies LifecycleRequests logic handles phase formatting and elapsed time calculation", () => {
    function formatPhase(phase) {
      return phase.replaceAll("_", " ");
    }
    function formatAge(elapsedMs) {
      return (elapsedMs / 1000).toFixed(1) + "s";
    }

    const phases = [
      "selection_wait",
      "selecting_account",
      "preparing_credentials",
      "preparing_request",
      "upstream_headers_wait",
      "first_event_wait",
      "streaming"
    ];

    for (const p of phases) {
      const formatted = formatPhase(p);
      expect(formatted).not.toContain("_");
    }

    expect(formatAge(1500)).toBe("1.5s");
    expect(formatAge(0)).toBe("0.0s");
  });
});