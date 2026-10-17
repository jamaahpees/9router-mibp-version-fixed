import { describe, expect, it, vi } from "vitest";

vi.mock("undici", () => ({ Agent: class { constructor() {} } }));
vi.mock("uuid", () => ({ v4: () => "00000000-0000-0000-0000-000000000000" }));
vi.mock("node-machine-id", () => ({ machineIdSync: () => "mock-machine-id" }));

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {})
}));

const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { translateNonStreamingResponse } = await import("../../open-sse/handlers/chatCore/nonStreamingHandler.js");
const { handleForcedSSEToJson } = await import("../../open-sse/handlers/chatCore/sseToJsonHandler.js");

// A chat.completion body as returned by a chat-native upstream (e.g. op-ericding)
const CHAT_TOOL_BODY = {
  id: "chatcmpl-abc123",
  object: "chat.completion",
  created: 1700000000,
  model: "cl/claude-haiku-4-5",
  choices: [{
    index: 0,
    message: {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "shell", arguments: "{\"cmd\":\"ls\"}" } }]
    },
    finish_reason: "tool_calls"
  }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
};

describe("non-stream Chat upstream for a Responses-API client (op-ericding bug)", () => {
  it("translates chat.completion tool_calls into Responses function_call output", () => {
    // translateNonStreamingResponse(body, targetFormat=PROVIDER format, sourceFormat=CLIENT format)
    const out = translateNonStreamingResponse(CHAT_TOOL_BODY, FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES);
    expect(out.object).toBe("response");
    expect(out).not.toHaveProperty("choices");
    const fc = (out.output || []).find((o) => o.type === "function_call");
    expect(fc).toBeTruthy();
    expect(fc.call_id).toBe("call_1");
    expect(fc.name).toBe("shell");
    expect(fc.arguments).toBe("{\"cmd\":\"ls\"}");
  });

  it("translates marked Chat tools into Responses custom_tool_call output", () => {
    const customBody = structuredClone(CHAT_TOOL_BODY);
    customBody.choices[0].message.tool_calls[0] = {
      id: "call_exec",
      type: "function",
      function: {
        name: "exec",
        arguments: "{\"input\":\"return await tools.shell({command: 'pwd'});\"}"
      }
    };
    const out = translateNonStreamingResponse(
      customBody,
      FORMATS.OPENAI,
      FORMATS.OPENAI_RESPONSES,
      new Set(["exec"])
    );
    const call = (out.output || []).find((item) => item.type === "custom_tool_call");
    expect(call).toMatchObject({
      call_id: "call_exec",
      name: "exec",
      input: "return await tools.shell({command: 'pwd'});"
    });
    expect(out.output.some((item) => item.type === "function_call")).toBe(false);
  });

  it("keeps chat.completion text content as a Responses message item", () => {
    const body = {
      ...CHAT_TOOL_BODY,
      choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }]
    };
    const out = translateNonStreamingResponse(body, FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES);
    const msg = (out.output || []).find((o) => o.type === "message");
    expect(msg).toBeTruthy();
    expect(msg.content[0].type).toBe("output_text");
    expect(msg.content[0].text).toBe("hello");
  });

  it("leaves chat->chat untouched", () => {
    const out = translateNonStreamingResponse(CHAT_TOOL_BODY, FORMATS.OPENAI, FORMATS.OPENAI);
    expect(out.object).toBe("chat.completion");
    expect(out.choices[0].message.tool_calls[0].function.name).toBe("shell");
  });
});

describe("forced-SSE JSON path for a Responses-API client behind a chat upstream", () => {
  const sseCtx = (sourceFormat, targetFormat) => {
    const encoder = new TextEncoder();
    const raw = [
      'data: {"id":"chatcmpl-sse","object":"chat.completion.chunk","created":1700000000,"model":"gpt-x","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","type":"function","function":{"name":"shell","arguments":""}}]},"finish_reason":null}]}',
      'data: {"id":"chatcmpl-sse","object":"chat.completion.chunk","created":1700000000,"model":"gpt-x","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"cmd\\":\\"pwd\\"}"}}]},"finish_reason":null}]}',
      'data: {"id":"chatcmpl-sse","object":"chat.completion.chunk","created":1700000000,"model":"gpt-x","choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      "data: [DONE]",
      ""
    ].join("\n\n");
    return {
      providerResponse: new Response(new ReadableStream({
        start(controller) { controller.enqueue(encoder.encode(raw)); controller.close(); }
      }), { headers: { "content-type": "text/event-stream" } }),
      sourceFormat,
      targetFormat,
      provider: "op-test-chat",
      model: "gpt-x",
      body: { model: "gpt-x", messages: [] },
      stream: false,
      requestStartTime: Date.now(),
      connectionId: "test-connection",
      clientRawRequest: { endpoint: "/v1/responses" },
      trackDone: vi.fn(),
      appendLog: vi.fn()
    };
  };

  it("parses chat SSE chunks and returns a Responses function_call body", async () => {
    const result = await handleForcedSSEToJson(sseCtx(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI));
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.object).toBe("response");
    const fc = (json.output || []).find((o) => o.type === "function_call");
    expect(fc).toBeTruthy();
    expect(fc.name).toBe("shell");
    expect(fc.arguments).toBe("{\"cmd\":\"pwd\"}");
  });

  it("returns a custom_tool_call for a marked tool", async () => {
    const ctx = sseCtx(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI);
    ctx.customToolNames = new Set(["shell"]);
    const result = await handleForcedSSEToJson(ctx);
    expect(result.success).toBe(true);
    const json = await result.response.json();
    const call = (json.output || []).find((item) => item.type === "custom_tool_call");
    expect(call).toMatchObject({
      call_id: "call_9",
      name: "shell",
      input: "{\"cmd\":\"pwd\"}"
    });
  });

  it("still returns chat.completion for a plain chat client", async () => {
    const result = await handleForcedSSEToJson(sseCtx(FORMATS.OPENAI, FORMATS.OPENAI));
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.object).toBe("chat.completion");
    expect(json.choices[0].message.tool_calls[0].function.name).toBe("shell");
  });
});


describe("forced-SSE JSON path for a Claude client behind Responses/Codex upstream", () => {
  const responsesSseCtx = (sourceFormat, targetFormat, provider = "codex") => {
    const encoder = new TextEncoder();
    const raw = [
      'event: response.created',
      'data: {"response":{"id":"resp_test_123","created_at":1700000000}}',
      '',
      'event: response.output_item.done',
      'data: {"output_index":0,"item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Hello from Codex"}]}}',
      '',
      'event: response.output_item.done',
      'data: {"output_index":1,"item":{"type":"function_call","call_id":"call_tool_1","name":"bash","arguments":"{\\"command\\":\\"ls -la\\"}"}}',
      '',
      'event: response.completed',
      'data: {"response":{"status":"completed","usage":{"input_tokens":100,"output_tokens":25,"total_tokens":125,"cache_read_input_tokens":50,"cache_creation_input_tokens":10}}}',
      '',
      'data: [DONE]',
      ''
    ].join("\n");

    return {
      providerResponse: new Response(new ReadableStream({
        start(controller) { controller.enqueue(encoder.encode(raw)); controller.close(); }
      }), { headers: { "content-type": "text/event-stream" } }),
      sourceFormat,
      targetFormat,
      provider,
      model: "gpt-6-luna",
      body: { model: "claude9-opus-5", messages: [] },
      stream: false,
      requestStartTime: Date.now(),
      connectionId: "test-connection-claude",
      clientRawRequest: { endpoint: "/v1/messages" },
      trackDone: vi.fn(),
      appendLog: vi.fn()
    };
  };

  it.each([FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES])("keeps Codex output unchanged for %s clients", async (format) => {
    const result = await handleForcedSSEToJson(responsesSseCtx(format, FORMATS.OPENAI_RESPONSES));
    const json = await result.response.json();
    expect(json.object).toBe(format === FORMATS.OPENAI ? "chat.completion" : "response");
    expect(json.type).toBeUndefined();
    if (format === FORMATS.OPENAI) {
      expect(json.choices[0].message.content).toBe("Hello from Codex");
      expect(JSON.parse(json.choices[0].message.tool_calls[0].function.arguments)).toEqual({ command: "ls -la" });
      expect(json.usage).toEqual({ prompt_tokens: 100, completion_tokens: 25, total_tokens: 125 });
    } else {
      expect(json.output[1].call_id).toBe("call_tool_1");
      expect(json.usage).toEqual({ input_tokens: 100, output_tokens: 25, total_tokens: 125 });
    }
  });

  it("converts Codex forced Responses SSE into Anthropic message format for CLAUDE client with tool_use stop_reason", async () => {
    const ctx = responsesSseCtx(FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES, "codex");
    const result = await handleForcedSSEToJson(ctx);
    expect(result.success).toBe(true);
    const json = await result.response.json();

    expect(json.type).toBe("message");
    expect(json.role).toBe("assistant");
    expect(json.model).toBe("gpt-6-luna");
    expect(json.id).toBe("resp_test_123");
    expect(Array.isArray(json.content)).toBe(true);

    const textPart = json.content.find((c) => c.type === "text");
    expect(textPart).toBeDefined();
    expect(textPart.text).toBe("Hello from Codex");

    const toolPart = json.content.find((c) => c.type === "tool_use");
    expect(toolPart).toBeDefined();
    expect(toolPart.id).toBe("call_tool_1");
    expect(toolPart.name).toBe("bash");
    expect(toolPart.input).toEqual({ command: "ls -la" });

    expect(json.stop_reason).toBe("tool_use");
    expect(json.usage).toEqual({
      input_tokens: 100,
      output_tokens: 25,
    });
  });

  it("converts Codex forced Responses SSE into Anthropic message with end_turn when no tools used", async () => {
    const encoder = new TextEncoder();
    const raw = [
      'event: response.created',
      'data: {"response":{"id":"resp_text_only","created_at":1700000000}}',
      '',
      'event: response.output_item.done',
      'data: {"output_index":0,"item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Simple text"}]}}',
      '',
      'event: response.completed',
      'data: {"response":{"status":"completed","usage":{"input_tokens":40,"output_tokens":10,"total_tokens":50}}}',
      '',
      'data: [DONE]',
      ''
    ].join("\n");

    const ctx = {
      providerResponse: new Response(new ReadableStream({
        start(controller) { controller.enqueue(encoder.encode(raw)); controller.close(); }
      }), { headers: { "content-type": "text/event-stream" } }),
      sourceFormat: FORMATS.CLAUDE,
      targetFormat: FORMATS.OPENAI_RESPONSES,
      provider: "codex",
      model: "gpt-6-luna",
      body: { model: "claude9-opus-5", messages: [] },
      stream: false,
      requestStartTime: Date.now(),
      connectionId: "test-connection-claude-text",
      clientRawRequest: { endpoint: "/v1/messages" },
      trackDone: vi.fn(),
      appendLog: vi.fn()
    };

    const result = await handleForcedSSEToJson(ctx);
    expect(result.success).toBe(true);
    const json = await result.response.json();

    expect(json.type).toBe("message");
    expect(json.role).toBe("assistant");
    expect(json.stop_reason).toBe("end_turn");
    expect(json.content).toEqual([{ type: "text", text: "Simple text" }]);
    expect(json.usage).toEqual({
      input_tokens: 40,
      output_tokens: 10,
    });
  });

  it("converts standard Chat forced SSE into Anthropic message for CLAUDE client", async () => {
    const encoder = new TextEncoder();
    const raw = [
      'data: {"id":"chatcmpl-claude-test","object":"chat.completion.chunk","created":1700000000,"model":"gpt-4o","choices":[{"delta":{"content":"Hello from Chat SSE"},"finish_reason":null}]}',
      'data: {"id":"chatcmpl-claude-test","object":"chat.completion.chunk","created":1700000000,"model":"gpt-4o","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":15,"completion_tokens":5,"total_tokens":20}}',
      'data: [DONE]',
      ''
    ].join("\n\n");

    const ctx = {
      providerResponse: new Response(new ReadableStream({
        start(controller) { controller.enqueue(encoder.encode(raw)); controller.close(); }
      }), { headers: { "content-type": "text/event-stream" } }),
      sourceFormat: FORMATS.CLAUDE,
      targetFormat: FORMATS.OPENAI,
      provider: "op-test-chat",
      model: "gpt-4o",
      body: { model: "gpt-4o", messages: [] },
      stream: false,
      requestStartTime: Date.now(),
      connectionId: "test-connection-claude-chat",
      clientRawRequest: { endpoint: "/v1/messages" },
      trackDone: vi.fn(),
      appendLog: vi.fn()
    };

    const result = await handleForcedSSEToJson(ctx);
    expect(result.success).toBe(true);
    const json = await result.response.json();

    expect(json.type).toBe("message");
    expect(json.role).toBe("assistant");
    expect(json.stop_reason).toBe("end_turn");
    expect(json.content).toEqual([{ type: "text", text: "Hello from Chat SSE" }]);
    expect(json.usage).toEqual({
      input_tokens: 15,
      output_tokens: 5,
    });
  });
});
