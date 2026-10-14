// Unit tests for the first-event readiness gate (open-sse/utils/streamReadiness.js).
//
// The gate holds the HTTP 200 commitment until the upstream stream produces a
// REAL protocol event, with an absolute first-event deadline (nearest of the
// ingress budget and STREAM_FIRST_CHUNK_TIMEOUT_MS). It must:
//   - treat parser evidence (role / message-start / reasoning / text / tool /
//     authentic terminal success) as ready,
//   - treat comments/keepalive, DONE-only, terminal errors and synthesized
//     aborts as NOT ready,
//   - bound split SSE framing, replay every consumed byte exactly once, and
//     never drop reasoning/tool events.
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForStreamReadiness } from "../../open-sse/utils/streamReadiness.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const FAKE = ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"];
const enc = new TextEncoder();

function useFake() {
  vi.useFakeTimers({ toFake: FAKE });
}

afterEach(() => {
  vi.useRealTimers();
});

function frame(str) {
  return enc.encode(str);
}

function concat(chunks) {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

// A scripted reader: each step yields a string chunk after `delay` fake ms.
// Once steps are exhausted it stays open (pending read) — modelling an upstream
// that keeps the socket alive but sends nothing more.
function scriptedReader(steps) {
  const delivered = [];
  let i = 0;
  return {
    delivered,
    read() {
      if (i >= steps.length) return new Promise(() => {});
      const step = steps[i++];
      return new Promise((resolve) => {
        setTimeout(() => {
          if (step.done) {
            resolve({ done: true, value: undefined });
            return;
          }
          const bytes = frame(step.chunk);
          delivered.push(bytes);
          resolve({ done: false, value: bytes });
        }, step.delay ?? 1);
      });
    },
    cancel() {
      return Promise.resolve();
    },
  };
}

// An upstream that emits an eligible-frame-free keepalive forever.
function pingReader(intervalMs = 10) {
  return {
    read() {
      return new Promise((resolve) => {
        setTimeout(() => resolve({ done: false, value: frame(": keepalive\n\n") }), intervalMs);
      });
    },
    cancel() {
      return Promise.resolve();
    },
  };
}

function makeController() {
  const ac = new AbortController();
  return {
    signal: ac.signal,
    isConnected: () => true,
    isDisconnected: () => false,
    handleError: vi.fn(),
    abort: vi.fn(() => ac.abort()),
  };
}

describe("streamReadiness — deadline on ping-only upstreams", () => {
  it("times out with a structured 504 when only keepalives arrive (no translated output)", async () => {
    useFake();
    const sc = makeController();
    const reader = pingReader(10);

    const pending = waitForStreamReadiness(reader, {
      timeoutMs: 1000,
      format: FORMATS.CLAUDE,
      streamController: sc,
    });
    const assertion = expect(pending).rejects.toMatchObject({ status: 504, localTermination: true });

    await vi.advanceTimersByTimeAsync(1200);

    await assertion;
    expect(sc.handleError).toHaveBeenCalledTimes(1);
    expect(sc.abort).toHaveBeenCalledTimes(1);
  });

  it("times out when the upstream opens then stays silent", async () => {
    useFake();
    const sc = makeController();
    const reader = scriptedReader([{ chunk: ": keepalive\n\n", delay: 1 }]);

    const pending = waitForStreamReadiness(reader, {
      timeoutMs: 500,
      format: FORMATS.CLAUDE,
      streamController: sc,
    });
    const assertion = expect(pending).rejects.toMatchObject({ status: 504 });

    await vi.advanceTimersByTimeAsync(600);

    await assertion;
  });
});

describe("streamReadiness — bounded framing & exact-once replay", () => {
  it("reassembles an SSE event split across reads and returns the exact bytes once", async () => {
    useFake();
    const sc = makeController();
    const reader = scriptedReader([
      { chunk: "event: message_st", delay: 1 },
      { chunk: 'art\ndata: {"type":"message_start","message":{"role":"assistant"}}\n\n', delay: 1 },
    ]);

    const pending = waitForStreamReadiness(reader, {
      timeoutMs: 5000,
      format: FORMATS.CLAUDE,
      streamController: sc,
    });
    await vi.advanceTimersByTimeAsync(5);

    const chunks = await pending;
    const expected = "event: message_st" +
      'art\ndata: {"type":"message_start","message":{"role":"assistant"}}\n\n';

    expect(chunks.length).toBe(2);
    expect(new TextDecoder().decode(concat(chunks))).toBe(expected);
    // Replay must be the same buffers, delivered exactly once (identity, no dup).
    expect(chunks).toEqual(reader.delivered);
  });

  it("ignores a leading comment/keepalive frame and starts at the real event", async () => {
    useFake();
    const sc = makeController();
    const reader = scriptedReader([
      { chunk: ": keepalive\n\n", delay: 1 },
      { chunk: 'data: {"type":"content_block_delta","delta":{"text":"hi"}}\n\n', delay: 1 },
    ]);

    const pending = waitForStreamReadiness(reader, {
      timeoutMs: 5000,
      format: FORMATS.CLAUDE,
      streamController: sc,
    });
    await vi.advanceTimersByTimeAsync(5);

    const chunks = await pending;
    // Both frames retained (comment included) so the byte stream is untouched.
    expect(new TextDecoder().decode(concat(chunks))).toContain(": keepalive");
    expect(new TextDecoder().decode(concat(chunks))).toContain('"text":"hi"');
  });
});

describe("streamReadiness — parser evidence eligibility", () => {
  it("a delayed reasoning delta satisfies the gate", async () => {
    useFake();
    const sc = makeController();
    const reader = scriptedReader([
      { chunk: ": keepalive\n\n", delay: 1 },
      { chunk: 'data: {"type":"content_block_delta","delta":{"thinking":"..."}}\n\n', delay: 40 },
    ]);

    const pending = waitForStreamReadiness(reader, {
      timeoutMs: 5000,
      format: FORMATS.CLAUDE,
      streamController: sc,
    });
    await vi.advanceTimersByTimeAsync(60);
    await expect(pending).resolves.toBeInstanceOf(Array);
  });

  it("a tool_use content-block start satisfies the gate", async () => {
    useFake();
    const sc = makeController();
    const reader = scriptedReader([
      { chunk: 'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"f"}}\n\n', delay: 1 },
    ]);

    const pending = waitForStreamReadiness(reader, {
      timeoutMs: 5000,
      format: FORMATS.CLAUDE,
      streamController: sc,
    });
    await vi.advanceTimersByTimeAsync(5);
    await expect(pending).resolves.toBeInstanceOf(Array);
  });

  it("an OpenAI tool_calls delta satisfies the gate", async () => {
    useFake();
    const sc = makeController();
    const reader = scriptedReader([
      { chunk: 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"f","arguments":""}}]}}]}\n\n', delay: 1 },
    ]);

    const pending = waitForStreamReadiness(reader, {
      timeoutMs: 5000,
      format: FORMATS.OPENAI,
      streamController: sc,
    });
    await vi.advanceTimersByTimeAsync(5);
    await expect(pending).resolves.toBeInstanceOf(Array);
  });

  it("a Gemini candidate with parts satisfies the gate", async () => {
    useFake();
    const sc = makeController();
    const reader = scriptedReader([
      { chunk: 'data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}\n\n', delay: 1 },
    ]);

    const pending = waitForStreamReadiness(reader, {
      timeoutMs: 5000,
      format: FORMATS.GEMINI,
      streamController: sc,
    });
    await vi.advanceTimersByTimeAsync(5);
    await expect(pending).resolves.toBeInstanceOf(Array);
  });

  it("an Ollama role line satisfies the gate", async () => {
    useFake();
    const sc = makeController();
    const reader = scriptedReader([
      { chunk: '{"message":{"role":"assistant","content":""}}\n', delay: 1 },
    ]);

    const pending = waitForStreamReadiness(reader, {
      timeoutMs: 5000,
      format: FORMATS.OLLAMA,
      streamController: sc,
    });
    await vi.advanceTimersByTimeAsync(5);
    await expect(pending).resolves.toBeInstanceOf(Array);
  });
});

describe("streamReadiness — authentic success vs synthetic failure", () => {
  it("an authentic terminal success (message_stop) is eligible", async () => {
    useFake();
    const sc = makeController();
    const reader = scriptedReader([
      { chunk: 'data: {"type":"message_stop"}\n\n', delay: 1 },
    ]);

    const pending = waitForStreamReadiness(reader, {
      timeoutMs: 5000,
      format: FORMATS.CLAUDE,
      streamController: sc,
    });
    await vi.advanceTimersByTimeAsync(5);
    await expect(pending).resolves.toBeInstanceOf(Array);
  });

  it("a synthetic response.failed terminal is NOT eligible and rejects 502", async () => {
    useFake();
    const sc = makeController();
    const reader = scriptedReader([
      { chunk: 'data: {"type":"response.failed","response":{"status":"failed"}}\n\n', delay: 1 },
    ]);

    const pending = waitForStreamReadiness(reader, {
      timeoutMs: 5000,
      format: FORMATS.OPENAI_RESPONSES,
      streamController: sc,
    });
    const assertion = expect(pending).rejects.toMatchObject({ status: 502 });
    await vi.advanceTimersByTimeAsync(5);
    await assertion;
  });

  it("a DONE-only upstream with no valid event rejects 502 at EOF", async () => {
    useFake();
    const sc = makeController();
    const reader = scriptedReader([
      { chunk: "data: [DONE]\n\n", delay: 1 },
      { done: true, delay: 1 },
    ]);

    const pending = waitForStreamReadiness(reader, {
      timeoutMs: 5000,
      format: FORMATS.OPENAI,
      streamController: sc,
    });
    const assertion = expect(pending).rejects.toMatchObject({ status: 502 });
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
  });

  it("an immediate EOF with no event rejects 502 (no empty 200)", async () => {
    useFake();
    const sc = makeController();
    const reader = scriptedReader([{ done: true, delay: 1 }]);

    const pending = waitForStreamReadiness(reader, {
      timeoutMs: 5000,
      format: FORMATS.OPENAI,
      streamController: sc,
    });
    const assertion = expect(pending).rejects.toMatchObject({ status: 502 });
    await vi.advanceTimersByTimeAsync(5);
    await assertion;
  });

  it("an invalid/malformed frame rejects 502", async () => {
    useFake();
    const sc = makeController();
    const reader = scriptedReader([{ chunk: "data: {not json\n\n", delay: 1 }]);

    const pending = waitForStreamReadiness(reader, {
      timeoutMs: 5000,
      format: FORMATS.OPENAI,
      streamController: sc,
    });
    const assertion = expect(pending).rejects.toMatchObject({ status: 502 });
    await vi.advanceTimersByTimeAsync(5);
    await assertion;
  });
});

describe("streamReadiness — deadline/output race & abort", () => {
  it("an event before the deadline resolves", async () => {
    useFake();
    const sc = makeController();
    const reader = scriptedReader([
      { chunk: 'data: {"type":"content_block_delta","delta":{"text":"x"}}\n\n', delay: 50 },
    ]);

    const pending = waitForStreamReadiness(reader, {
      timeoutMs: 100,
      format: FORMATS.CLAUDE,
      streamController: sc,
    });
    await vi.advanceTimersByTimeAsync(60);
    await expect(pending).resolves.toBeInstanceOf(Array);
  });

  it("an event after the deadline loses the race and rejects 504", async () => {
    useFake();
    const sc = makeController();
    const reader = scriptedReader([
      { chunk: 'data: {"type":"content_block_delta","delta":{"text":"late"}}\n\n', delay: 500 },
    ]);

    const pending = waitForStreamReadiness(reader, {
      timeoutMs: 100,
      format: FORMATS.CLAUDE,
      streamController: sc,
    });
    const assertion = expect(pending).rejects.toMatchObject({ status: 504 });
    await vi.advanceTimersByTimeAsync(600);
    await assertion;
  });

  it("a caller abort before readiness rejects 499 and never commits", async () => {
    useFake();
    const ac = new AbortController();
    const sc = makeController();
    const reader = pingReader(10);

    const pending = waitForStreamReadiness(reader, {
      signal: ac.signal,
      timeoutMs: 5000,
      format: FORMATS.CLAUDE,
      streamController: sc,
    });
    const assertion = expect(pending).rejects.toMatchObject({ status: 499, localTermination: true });

    await vi.advanceTimersByTimeAsync(20);
    ac.abort(Object.assign(new Error("client gone"), { name: "AbortError" }));
    await vi.advanceTimersByTimeAsync(1);

    await assertion;
  });

  it("a TimeoutError signal reason maps to 504", async () => {
    useFake();
    const ac = new AbortController();
    const sc = makeController();
    const reader = pingReader(10);

    const pending = waitForStreamReadiness(reader, {
      signal: ac.signal,
      timeoutMs: 5000,
      format: FORMATS.CLAUDE,
      streamController: sc,
    });
    const assertion = expect(pending).rejects.toMatchObject({ status: 504 });

    await vi.advanceTimersByTimeAsync(20);
    ac.abort(Object.assign(new Error("deadline"), { name: "TimeoutError", status: 504 }));
    await vi.advanceTimersByTimeAsync(1);

    await assertion;
  });
});
