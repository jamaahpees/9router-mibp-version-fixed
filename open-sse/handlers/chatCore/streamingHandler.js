import { FORMATS } from "../../translator/formats.js";
import { needsTranslation } from "../../translator/index.js";
import { createSSETransformStreamWithLogger, createPassthroughStreamWithLogger } from "../../utils/stream.js";
import { pipeWithDisconnect } from "../../utils/streamHandler.js";
import { waitForStreamReadiness } from "../../utils/streamReadiness.js";
import { PROVIDERS } from "../../config/providers.js";
import { STREAM_STALL_TIMEOUT_MS } from "../../config/runtimeConfig.js";
import { buildAbortedResponsesTerminalBytes } from "../../utils/responsesStreamHelpers.js";
import { buildRequestDetail, extractRequestConfig, saveUsageStats, formatDoneLine } from "./requestDetail.js";
import { saveRequestDetail } from "@/lib/usageDb.js";
import { SSE_HEADERS_CORS as SSE_HEADERS } from "../../utils/sseConstants.js";

// Codex returns Responses API SSE → which client format to translate INTO, by request sourceFormat.
// Gemini-family all map to ANTIGRAVITY decoder; unknown sources fall back to OPENAI.
const CODEX_SOURCE_TO_TARGET = {
  [FORMATS.OPENAI_RESPONSES]: FORMATS.OPENAI_RESPONSES,
  [FORMATS.CLAUDE]: FORMATS.CLAUDE,
  [FORMATS.ANTIGRAVITY]: FORMATS.ANTIGRAVITY,
  [FORMATS.GEMINI]: FORMATS.ANTIGRAVITY,
  [FORMATS.GEMINI_CLI]: FORMATS.ANTIGRAVITY,
};

/**
 * Determine which SSE transform stream to use based on provider/format.
 */
function buildTransformStream({ provider, sourceFormat, targetFormat, userAgent, reqLogger, toolNameMap, customToolNames, model, connectionId, body, onStreamComplete, apiKey, requestContext }) {
  const isDroidCLI = userAgent?.toLowerCase().includes("droid") || userAgent?.toLowerCase().includes("codex-cli");
  // Responses-API providers (e.g. codex) emit Responses SSE → translate into client format
  const isResponsesProvider = PROVIDERS[provider]?.format === FORMATS.OPENAI_RESPONSES;
  const needsCodexTranslation = isResponsesProvider && targetFormat === FORMATS.OPENAI_RESPONSES && !isDroidCLI;

  if (needsCodexTranslation) {
    const codexTarget = CODEX_SOURCE_TO_TARGET[sourceFormat] || FORMATS.OPENAI;
    return createSSETransformStreamWithLogger(FORMATS.OPENAI_RESPONSES, codexTarget, provider, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey, customToolNames, requestContext);
  }

  if (needsTranslation(targetFormat, sourceFormat)) {
    return createSSETransformStreamWithLogger(targetFormat, sourceFormat, provider, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey, customToolNames, requestContext);
  }

  return createPassthroughStreamWithLogger(provider, reqLogger, model, connectionId, body, onStreamComplete, apiKey, requestContext);
}

/**
 * Handle streaming response — pipe provider SSE through transform stream to client.
 */
export async function handleStreamingResponse({ providerResponse, provider, model, sourceFormat, targetFormat, userAgent, body, stream, translatedBody, finalBody, requestStartTime, connectionId, apiKey, clientRawRequest, onRequestSuccess, reqLogger, toolNameMap, customToolNames, streamController, onStreamComplete, streamDetailId, pxpipe, reqTag, log, requestContext }) {
  let finished = false;
  const finishAttempt = (status) => {
    if (finished) return;
    finished = true;
    requestContext?.finishAttempt?.(status);
  };
  const failureResponse = (error, status = error.status || 502, alreadyStopped = false) => {
    if (!alreadyStopped) {
      streamController?.handleError?.(error);
      streamController?.abort?.();
    }
    finishAttempt(status === 499 ? "aborted" : status === 504 && error.localTermination ? "timeout" : "error");
    return {
      success: false, status, error: error.message,
      ...(error.localTermination ? { localTermination: true } : {}),
      response: new Response(JSON.stringify({ error: { message: error.message } }), {
        status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      }),
    };
  };
  // When upstream returns HTML/text or empty body instead of SSE (e.g. Cloudflare 5xx error
  // page, or immediate EOF), piping it through the SSE transform stream causes Next.js
  // "failed to pipe response" or StreamIdleTimeoutError (HTTP 200 with 0 bytes).
  if (!providerResponse?.body) {
    const status = providerResponse?.status >= 400 ? providerResponse.status : 502;
    const msg = `Upstream returned empty body [${status}]`;
    return failureResponse(new Error(msg), status);
  }

  const upstreamContentType = (providerResponse.headers.get('content-type') || '').toLowerCase();
  if (upstreamContentType && !upstreamContentType.includes('text/event-stream') && !upstreamContentType.includes('application/json')) {
    // Do not drain arbitrary HTML/text bodies: they can hang indefinitely.
    try { Promise.resolve(providerResponse.body.cancel()).catch(() => {}); } catch { /* locked */ }
    const shortMsg = `Upstream returned non-SSE response (${upstreamContentType})`;
    const status = providerResponse.status >= 400 ? providerResponse.status : 502;
    if (log?.errorLine) log.errorLine(reqTag, "✗", `BLOCKED ${status} · ${provider}/${model} · non-SSE (${upstreamContentType})\n    ${shortMsg}`);
    else console.warn(`[STREAM] ${provider} | ${model} | blocked pipe: ${shortMsg} [${status}]`);
    return failureResponse(new Error(`[${status}]: ${shortMsg || `Upstream returned non-SSE response (${upstreamContentType})`}`), status);
  }

  const transformStream = buildTransformStream({ provider, sourceFormat, targetFormat, userAgent, reqLogger, toolNameMap, customToolNames, model, connectionId, body, onStreamComplete, apiKey, requestContext });

  // Responses passthrough: synthesize response.failed + [DONE] if the stream aborts/stalls before a terminal event
  const isResponsesPassthrough = sourceFormat === FORMATS.OPENAI_RESPONSES && targetFormat === FORMATS.OPENAI_RESPONSES;
  const onAbortTerminal = isResponsesPassthrough ? buildAbortedResponsesTerminalBytes : null;
  const stallTimeoutMs = PROVIDERS[provider]?.stallTimeoutMs || STREAM_STALL_TIMEOUT_MS;
  const transformedBody = pipeWithDisconnect(providerResponse, transformStream, streamController, onAbortTerminal, stallTimeoutMs);
  const reader = transformedBody.getReader();
  let consumed;
  try {
    consumed = await waitForStreamReadiness(reader, {
      ...requestContext, streamController, format: sourceFormat,
    });
  } catch (error) {
    return failureResponse(error, error.status || 502, true);
  }
  if (onRequestSuccess) {
    Promise.resolve().then(() => {
      if (!requestContext?.signal?.aborted && !streamController?.isDisconnected?.()) return onRequestSuccess();
    }).catch(err => {
      console.error("[ChatCore] onRequestSuccess failed:", err?.message || err);
    });
  }
  // Replay the consumed chunk exactly once; no upstream request is replayed.
  const guardedBody = new ReadableStream({
    start(controller) { for (const chunk of consumed) controller.enqueue(chunk); },
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          finishAttempt(requestContext?.signal?.aborted || streamController?.isDisconnected?.() ? "aborted" : "completed");
          controller.close();
        } else controller.enqueue(next.value);
      } catch (error) {
        finishAttempt(error.name === "AbortError" ? "aborted" : "error");
        streamController?.handleError?.(error);
        controller.error(error);
      }
    },
    cancel(reason) {
      finishAttempt("aborted");
      streamController?.abort?.();
      try { Promise.resolve(reader.cancel(reason)).catch(() => {}); } catch { /* already closed */ }
    },
  });

  saveRequestDetail(buildRequestDetail({
    provider, model, connectionId,
    latency: { ttft: 0, total: Date.now() - requestStartTime },
    tokens: { prompt_tokens: 0, completion_tokens: 0 },
    request: extractRequestConfig(body, stream),
    providerRequest: finalBody || translatedBody || null,
    providerResponse: "[Streaming - raw response not captured]",
    response: { content: "[Streaming in progress...]", thinking: null, type: "streaming" },
    pxpipe,
    status: "success"
  }, { id: streamDetailId })).catch(err => {
    console.error("[RequestDetail] Failed to save streaming request:", err.message);
  });

  return {
    success: true,
    response: new Response(guardedBody, { headers: SSE_HEADERS })
  };
}

/**
 * Build onStreamComplete callback for streaming usage tracking.
 */
export function buildOnStreamComplete({ provider, model, connectionId, apiKey, requestStartTime, body, stream, finalBody, translatedBody, clientRawRequest, pxpipe, reqTag, log }) {
  const streamDetailId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

  const onStreamComplete = (contentObj, usage, ttftAt) => {
    const latency = {
      ttft: ttftAt ? ttftAt - requestStartTime : Date.now() - requestStartTime,
      total: Date.now() - requestStartTime
    };
    const safeContent = contentObj?.content || "[Empty streaming response]";
    const safeThinking = contentObj?.thinking || null;

    saveRequestDetail(buildRequestDetail({
      provider, model, connectionId,
      latency,
      tokens: usage || { prompt_tokens: 0, completion_tokens: 0 },
      request: extractRequestConfig(body, stream),
      providerRequest: finalBody || translatedBody || null,
      providerResponse: safeContent,
      response: { content: safeContent, thinking: safeThinking, type: "streaming" },
      pxpipe,
      status: "success"
    }, { id: streamDetailId })).catch(err => {
      console.error("[RequestDetail] Failed to update streaming content:", err.message);
    });

    // Persist stream usage to DB (no console line; the "📊 done" line below is authoritative)
    saveUsageStats({ provider, model, tokens: usage, connectionId, apiKey, endpoint: clientRawRequest?.endpoint, label: "STREAM USAGE", silent: true });
    if (log?.line) log.line(reqTag, "📊", formatDoneLine({ usage, latency }));
  };

  return { onStreamComplete, streamDetailId };
}
