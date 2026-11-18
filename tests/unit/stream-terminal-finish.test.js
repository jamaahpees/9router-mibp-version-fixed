// A stream that ends without a terminal chunk is indistinguishable from a dropped
// connection for strict OpenAI clients: OpenCode aborts the turn with
// "OpenAI Chat stream ended without finish_reason". The transform must synthesize
// the missing terminal, and an abort after HTTP 200 must carry one too.
//
// The translator registry is mocked: open-sse/translator/index.js participates in a
// circular import that vitest's SSR transform evaluates in a different order than
// Node, so importing the real registry fails at load. The contract under test here
// is the transform's terminal bookkeeping, not any provider translator.
import { describe, it, expect, vi } from "vitest";

vi.mock("../../open-sse/translator/index.js", () => ({
  initState: () => ({}),
  translateResponse: (targetFormat, sourceFormat, parsed, state) => {
    if (!parsed || !Array.isArray(parsed.candidates)) return [];
    const text = parsed.candidates[0]?.content?.parts?.[0]?.text;
    if (typeof text === "string" && text.length > 0) {
      return [{
        id: "chatcmpl-mock",
        object: "chat.completion.chunk",
        created: 1,
        choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
      }];
    }
    if (parsed.candidates[0]?.finishReason) {
      if (state) state.finishReason = "stop";
      return [{
        id: "chatcmpl-mock",
        object: "chat.completion.chunk",
        created: 1,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      }];
    }
    return [];
  },
}));

import { createSSEStream, createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";
import { buildStreamErrorBytes } from "../../open-sse/utils/streamHelpers.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

async function drain(stream, sse) {
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const readPromise = (async () => {
    let out = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
    }
    return out;
  })();
  if (sse) await writer.write(enc.encode(sse));
  await writer.close();
  return readPromise;
}

function terminalChunks(out) {
  return out
    .split("\n\n")
    .filter((frame) => frame.startsWith("data: {"))
    .map((frame) => JSON.parse(frame.slice(6)))
    .filter((chunk) => chunk && Array.isArray(chunk.choices) && chunk.choices[0] && chunk.choices[0].finish_reason);
}

const frame = (payload) => `data: ${JSON.stringify(payload)}\n\n`;
const textFrame = (text) => frame({ candidates: [{ content: { parts: [{ text }], role: "model" }, index: 0 }] });
const finishFrame = () => frame({ candidates: [{ content: { parts: [] }, finishReason: "STOP", index: 0 }] });

const openAIChunk = (finishReason) => frame({
  id: "chatcmpl-abc12345",
  object: "chat.completion.chunk",
  created: 1700000000,
  model: "m",
  choices: [{ index: 0, delta: { content: "hi" }, finish_reason: finishReason }],
});

const translate = () => createSSETransformStreamWithLogger(
  FORMATS.GEMINI,
  FORMATS.OPENAI,
  "antigravity",
  null,
  null,
  "gemini-test",
  "conn-test",
  { messages: [{ role: "user", content: "hi" }] },
);

describe("synthesized stream terminal for OpenAI clients", () => {
  it("adds finish_reason stop + [DONE] when the provider ends after content", async () => {
    const out = await drain(translate(), textFrame("hello"));

    const terminals = terminalChunks(out);
    expect(terminals).toHaveLength(1);
    expect(terminals[0].choices[0].finish_reason).toBe("stop");
    expect(out.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("does not duplicate a terminal the provider already sent", async () => {
    const out = await drain(translate(), textFrame("hello") + finishFrame());

    const terminals = terminalChunks(out);
    expect(terminals).toHaveLength(1);
    expect(terminals[0].choices[0].finish_reason).toBe("stop");
    expect(out.split("data: [DONE]").length - 1).toBe(1);
  });

  it("marks a content-less stream terminal with finish_reason error", async () => {
    const out = await drain(translate(), "");

    const terminals = terminalChunks(out);
    expect(terminals).toHaveLength(1);
    expect(terminals[0].choices[0].finish_reason).toBe("error");
    expect(out.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("synthesizes the terminal in passthrough for OpenAI-shaped frames", async () => {
    const stream = createSSEStream({ mode: "passthrough", provider: "openai", model: "m" });
    const out = await drain(stream, openAIChunk(null));

    expect(terminalChunks(out).map((c) => c.choices[0].finish_reason)).toEqual(["stop"]);
    expect(out.split("data: [DONE]").length - 1).toBe(1);
  });

  it("leaves Gemini-family passthrough untouched (no [DONE], no OpenAI chunk)", async () => {
    const stream = createSSEStream({ mode: "passthrough", provider: "antigravity", model: "m" });
    const out = await drain(stream, openAIChunk(null));

    expect(terminalChunks(out)).toHaveLength(0);
    expect(out).not.toContain("data: [DONE]");
  });
});

describe("abort terminal frames", () => {
  it("sends a terminal finish_reason error chunk before the OpenAI error frame", () => {
    const text = dec.decode(buildStreamErrorBytes(504, "upstream stalled", FORMATS.OPENAI));

    const terminals = terminalChunks(text);
    expect(terminals).toHaveLength(1);
    expect(terminals[0].choices[0].finish_reason).toBe("error");
    expect(text).toContain('"error"');
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("keeps the Claude error event free of OpenAI chunk frames", () => {
    const text = dec.decode(buildStreamErrorBytes(504, "upstream stalled", FORMATS.CLAUDE));

    expect(text).toContain("event: error");
    expect(text).not.toContain("chat.completion.chunk");
  });
});
