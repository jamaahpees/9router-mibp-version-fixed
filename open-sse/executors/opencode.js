import crypto from "crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { getThinkingLevels } from "../providers/thinkingLevels.js";
import { injectReasoningContent } from "../utils/reasoningContentInjector.js";
import { resolveSessionId } from "../utils/sessionManager.js";
import { isMuseSparkModel } from "../providers/models/helpers.js";
import { applyFingerprintTools } from "../utils/opencodeFingerprint.js";

// Upstream validates requests against the real OpenCode CLI fingerprint.
//
// Since 2026-10-14 the v1 `opencode/1.18.x` User-Agent is answered with 403
// FreeTierError; the v2 CLI sends `opencode/<channel>/<semver>/<client>`.
// Free-tier traffic also moved from /zen/v1 to /inference/v1.
const OPENCODE_UA = "opencode/latest/2.1.1/cli";
const OPENCODE_CLIENT = "cli";
const SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const BASE62_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

let lastTimestamp = 0;
let counter = 0;

function unstableRandom() {
  const bytes = crypto.randomBytes(14);
  let out = "";
  for (let i = 0; i < 14; i++) out += BASE62_CHARS[bytes[i] % 62];
  return out;
}

// Session prefix = 12 hex of ~(timeMs * 0x1000 + counter), low 48 bits, like
// the CLI. Upstream decodes it and rejects a non-small counter with 403
// FreeTierError (live probes: counter 0-16 pass, >=100 fail), so the counter
// must stay real instead of being random.
const SESSION_PREFIX_MASK = (1n << 48n) - 1n;
const SESSION_TIME_MASK = (1n << 36n) - 1n;

function descendingTimeHex(time, counterValue) {
  return (~(BigInt(time) * 0x1000n + BigInt(counterValue)) & SESSION_PREFIX_MASK)
    .toString(16)
    .padStart(12, "0");
}

function generateSessionId(timestamp = Date.now()) {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp;
    counter = 0;
  }
  counter++;
  return `ses_${descendingTimeHex(timestamp, counter)}${unstableRandom()}`;
}

// Deterministically map any downstream session id into the canonical shape.
// The counter is pinned to 1 (what the CLI sends) and the time field derives
// from the digest, so retries keep the same id.
function translateSessionId(sessionId, clientTool = "") {
  if (typeof sessionId === "string" && SESSION_RE.test(sessionId.trim())) {
    return sessionId.trim();
  }
  const digest = crypto
    .createHash("sha256")
    .update(`opencode\0${clientTool || "generic"}\0${sessionId || ""}`)
    .digest();
  const time = BigInt(`0x${digest.subarray(0, 5).toString("hex")}`) & SESSION_TIME_MASK;
  const timeHex = descendingTimeHex(time, 1);
  let randomPart = "";
  for (let i = 6; i < 20; i++) randomPart += BASE62_CHARS[digest[i] % 62];
  return `ses_${timeHex}${randomPart}`;
}

function hasValidOpencodeVersion(ua) {
  const m = String(ua || "").match(/^opencode\/[a-z0-9-]+\/(\d+)\.\d+\.\d+\/[a-z0-9-]+$/i);
  return !!m && parseInt(m[1], 10) >= 2;
}

// Strip the thinking suffix "model(level)" so registry lookups hit the base id.
function baseModelId(model) {
  return String(model || "").replace(/\([^()]+\)\s*$/, "").trim();
}

function isResponsesModel(model) {
  // Muse Spark ids (paid, or the retired contributor-free ones) speak the
  // Responses API; every other model stays on chat/completions.
  return isMuseSparkModel(baseModelId(model));
}

function resolveOpencodeSession(body, credentials) {
  const headers = credentials?.rawHeaders || {};
  const resolved = resolveSessionId({
    headers,
    body,
    connectionId: credentials?.connectionId,
    scope: "opencode",
  });
  if (!resolved) return generateSessionId();
  // A client-supplied session in any other format would trip the upstream
  // fingerprint gate, so translate it into the canonical shape.
  return SESSION_RE.test(String(resolved)) ? resolved : translateSessionId(resolved);
}

function normalizeOpencodeReasoning(model, body) {
  const current = body.reasoning;
  const currentReasoning = current && typeof current === "object" && !Array.isArray(current)
    ? current
    : null;
  const requestedEffort = typeof body.reasoning_effort === "string"
    ? body.reasoning_effort
    : currentReasoning?.effort;
  if (typeof requestedEffort !== "string") return;

  const cleanModel = baseModelId(model || body.model);
  const supportedLevels = getThinkingLevels("opencode", cleanModel);
  let effort = requestedEffort.toLowerCase().trim();
  if ((effort === "max" || effort === "ultra") && supportedLevels?.length && !supportedLevels.includes(effort)) {
    if (effort === "ultra" && supportedLevels.includes("max")) effort = "max";
    else if (supportedLevels.includes("xhigh")) effort = "xhigh";
  }

  body.reasoning = { ...currentReasoning, effort };
  if (!body.reasoning.summary) body.reasoning.summary = "auto";
  delete body.reasoning_effort;
}

// OpenCode free tier is limited per egress IP — a 429/403 with a limit-ish
// body means the POOL's IP is exhausted, not the account. Declare it
// pool-scoped so chatCore marks the pool unfit, retries via another pool, and
// it shows up (clearable) on the Proxy Fitness page.
const IP_LIMIT_BODY = /limit|rate|quota|exhausted|capacity|too many|retry/i;

export class OpenCodeExecutor extends BaseExecutor {
  constructor() {
    super("opencode", PROVIDERS.opencode);
    this._currentSessionId = null;
  }

  transformRequest(model, body, stream, credentials) {
    this._currentSessionId = resolveOpencodeSession(body, credentials);

    if (isResponsesModel(model)) {
      // Responses API names the output cap max_output_tokens and takes thinking
      // as reasoning:{effort,summary} — normalize the Chat fields at this boundary.
      if (body.max_output_tokens === undefined) {
        if (body.max_completion_tokens !== undefined) body.max_output_tokens = body.max_completion_tokens;
        else if (body.max_tokens !== undefined) body.max_output_tokens = body.max_tokens;
      }
      delete body.max_tokens;
      delete body.max_completion_tokens;
      normalizeOpencodeReasoning(model, body);
      body.stream = true;
      body.store = false;
      // Free-tier fingerprint: upstream compares the read/shell definitions
      // verbatim and defaults tool_choice to "auto" (never "none").
      applyFingerprintTools(body, true);
    } else {
      // /inference/v1/chat/completions fingerprint: streaming + usage in the
      // stream + OpenCode's own read/shell tools.
      body.stream = true;
      applyFingerprintTools(body, false);
      if (body.stream_options && typeof body.stream_options === "object" && !Array.isArray(body.stream_options)) {
        body.stream_options.include_usage = true;
      } else {
        body.stream_options = { include_usage: true };
      }
    }
    return injectReasoningContent({ provider: this.provider, model, body });
  }

  buildUrl(model) {
    const base = this.config.baseUrl;
    return isResponsesModel(model)
      ? `${base}/inference/v1/responses`
      : `${base}/inference/v1/chat/completions`;
  }

  buildHeaders(credentials) {
    const raw = credentials?.rawHeaders || {};
    const lower = {};
    for (const [k, v] of Object.entries(raw)) lower[k.toLowerCase()] = v;

    const downstreamUa = lower["user-agent"] || "";
    // Only preserve a downstream UA that already carries the v2 shape;
    // v1/bare UAs are rejected upstream with 403 FreeTierError.
    const useDownstreamUa = hasValidOpencodeVersion(downstreamUa);

    const session = SESSION_RE.test(String(this._currentSessionId || ""))
      ? this._currentSessionId
      : generateSessionId();

    // Mirrors the v2 CLI: x-opencode-session-id travels next to
    // x-opencode-session, and v1's x-opencode-request is no longer sent.
    return {
      "Content-Type": "application/json",
      "Authorization": "Bearer public",
      "User-Agent": useDownstreamUa ? downstreamUa : OPENCODE_UA,
      "x-opencode-client": lower["x-opencode-client"] || OPENCODE_CLIENT,
      "x-opencode-session": session,
      "x-opencode-session-id": session,
      "x-session-affinity": session,
      "x-session-id": session,
      "x-opencode-project": lower["x-opencode-project"] || "global",
      "Accept": "text/event-stream",
    };
  }

  parseError(response, bodyText) {
    const status = response?.status || 0;
    const text = String(bodyText || "");
    if ((status === 429 || status === 403) && IP_LIMIT_BODY.test(text)) {
      return {
        status,
        message: text.slice(0, 300) || `OpenCode free limit (${status})`,
        poolScoped: { reason: "ip-limit" },
      };
    }
    return null; // fall through to default parsing
  }
}
