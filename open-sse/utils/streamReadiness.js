import { STREAM_FIRST_CHUNK_TIMEOUT_MS } from "../config/runtimeConfig.js";
import { FORMATS } from "../translator/formats.js";
import { parseSSELine, hasValuableContent } from "./streamHelpers.js";

// Limit retained pre-readiness data as well as unfinished frame parsing.
const MAX_READINESS_BYTES = 1024 * 1024;

export function streamReadinessError(message, status = 502, localTermination = false) {
  return Object.assign(new Error(message), { status, localTermination,
    ...(status === 499 ? { name: "AbortError" } : status === 504 ? { name: "TimeoutError" } : {}) });
}

function eligibleEvent(data, event, format) {
  if (!data || typeof data !== "object") return false;
  const type = data.type || event;
  if (data.error || data.response?.error || type === "error" || type === "response.failed" ||
      type === "response.incomplete" || data.response?.status === "failed" || data.response?.status === "incomplete") {
    throw streamReadinessError(data.error?.message || data.response?.error?.message || "Upstream stream reported failure");
  }
  if (data.done && Object.keys(data).length === 1) return false;
  if (data.choices?.some(choice => hasValuableContent({ choices: [choice] }, FORMATS.OPENAI))) return true;
  if (type === "message_start" || type === "message_stop") return true;
  if (type === "content_block_start") return !!data.content_block && ["text", "thinking", "tool_use"].includes(data.content_block.type);
  if (type === "content_block_delta") return !!(data.delta?.text || data.delta?.thinking || data.delta?.partial_json);
  if (type === "message_delta") return !!data.delta?.stop_reason;
  if (type?.startsWith("response.")) {
    if (type === "response.completed") return data.response?.status === "completed";
    if (type === "response.created" || type === "response.in_progress") return false;
    return !!(data.delta || data.text || data.item?.role || data.item?.type === "function_call" || data.part?.text);
  }
  if (data.candidates?.some(candidate => candidate.content?.parts?.length || candidate.finishReason)) return true;
  if (format === FORMATS.OLLAMA) return !!(data.message?.role || data.message?.content || data.message?.thinking || data.message?.tool_calls?.length || data.response || data.done === true);
  return false;
}

/** Wait for a real protocol event, retaining the original bytes for exact replay. */
export async function waitForStreamReadiness(reader, {
  signal, deadlineAt, timeoutMs = STREAM_FIRST_CHUNK_TIMEOUT_MS, format,
  streamController, onPhase, onMilestone,
} = {}) {
  onPhase?.("first_event_wait");
  const deadline = Math.min(deadlineAt ?? Infinity, performance.now() + timeoutMs);
  const chunks = [];
  const decoder = new TextDecoder();
  let buffer = "";
  let totalBytes = 0;
  let timer;
  let abortListener;
  let stopped = false;
  const stop = (error) => {
    if (stopped) return;
    stopped = true;
    for (const current of signals) current.removeEventListener("abort", abortListener);
    streamController?.handleError?.(error);
    streamController?.abort?.();
    // Cancellation can wait forever on a pending upstream pull; never await it.
    try { Promise.resolve(reader.cancel(error)).catch(() => {}); } catch { /* already closed */ }
  };
  const signals = [...new Set([signal, streamController?.signal].filter(Boolean))];
  const abortError = () => signals.some(current => current.aborted && current.reason?.name === "TimeoutError")
    ? streamReadinessError("Stream request deadline exceeded", 504, true)
    : streamReadinessError("Stream readiness aborted", 499, true);
  const interrupted = new Promise((_, reject) => {
    abortListener = () => reject(abortError());
    for (const current of signals) current.addEventListener("abort", abortListener, { once: true });
    timer = setTimeout(() => reject(streamReadinessError("Stream first event timeout", 504, true)), Math.max(0, deadline - performance.now()));
  });
  interrupted.catch(() => {});
  const checkActive = () => {
    if (signals.some(current => current.aborted)) throw abortError();
    if (performance.now() >= deadline) throw streamReadinessError("Stream first event timeout", 504, true);
    if (streamController?.isDisconnected?.() || streamController?.signal?.aborted) {
      throw streamReadinessError("Stream disconnected before readiness", 499, true);
    }
  };
  const inspect = (frame) => {
    let event = "";
    const lines = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) lines.push(line.slice(5).trimStart());
    }
    if (!lines.length) return false;
    const parsed = parseSSELine(`data: ${lines.join("\n")}`);
    if (!parsed) throw streamReadinessError("Upstream returned invalid stream event");
    return eligibleEvent(parsed, event, format);
  };
  try {
    while (true) {
      checkActive();
      const next = await Promise.race([reader.read(), interrupted]);
      checkActive();
      if (next.done) throw streamReadinessError("Upstream ended before an eligible stream event");
      if (!next.value?.byteLength) continue;
      chunks.push(next.value);
      totalBytes += next.value.byteLength;
      if (totalBytes > MAX_READINESS_BYTES) throw streamReadinessError("Stream readiness buffer exceeded limit");
      buffer += decoder.decode(next.value, { stream: true });
      let ready = false;
      if (format === FORMATS.OLLAMA) {
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const parsed = parseSSELine(line, format);
          if (!parsed) throw streamReadinessError("Upstream returned invalid stream event");
          if (eligibleEvent(parsed, "", format)) { ready = true; break; }
        }
      } else {
        let separator;
        while ((separator = /\r?\n\r?\n/.exec(buffer))) {
          const frame = buffer.slice(0, separator.index);
          buffer = buffer.slice(separator.index + separator[0].length);
          if (inspect(frame)) { ready = true; break; }
        }
      }
      if (ready) {
        // isConnected may become false on normal EOF, so use the explicit disconnect
        // predicate when supplied; synthetic terminals themselves are never eligible.
        checkActive();
        onMilestone?.("first_event");
        onPhase?.("streaming");
        return chunks;
      }
    }
  } catch (error) {
    const failure = error.status ? error : streamReadinessError(error.message || "Stream readiness failed");
    stop(failure);
    throw failure;
  } finally {
    clearTimeout(timer);
    for (const current of signals) current.removeEventListener("abort", abortListener);
  }
}
