import "open-sse/index.js";

import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
} from "../services/auth.js";
import { handleAntigravityQuotaError, clearAntigravityStrikes } from "../services/antigravityQuota.js";
import { getSettings } from "@/lib/localDb";
import { getModelInfo, getComboModels } from "../services/model.js";
import { checkModelAvailability } from "../services/accountStatus.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { DEFAULT_HEADROOM_URL } from "@/lib/headroom/detect";
import { getTransform as getPxpipeTransform } from "@/lib/pxpipe/loader.js";
import { appendPxpipeEvent } from "@/lib/pxpipe/events.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { handleComboChat, handleFusionChat, detectRequiredCapabilities } from "open-sse/services/combo.js";
import { augmentModelsWithCapacityAdapter, withCapacityAdapterStripping, getActiveAdapterStrategy } from "open-sse/services/capacityAdapter.js";
import { handleBypassRequest } from "open-sse/utils/bypassHandler.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { HTTP_STATUS, CLAUDE_PRECOMMIT_TIMEOUT_MS } from "open-sse/config/runtimeConfig.js";
import { createRequestBudget, localTerminationResult } from "open-sse/utils/requestBudget.js";
import { createRequestLifecycle } from "@/lib/requestLifecycle.js";
import { detectFormatByEndpoint } from "open-sse/translator/formats.js";
import * as log from "../utils/logger.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { getProjectIdForConnection } from "open-sse/services/projectId.js";
import { stripModelContextMarker } from "open-sse/utils/modelMarkers.js";

/**
 * Handle chat completion request
 * Supports: OpenAI, Claude, Gemini, OpenAI Responses API formats
 * Format detection and translation handled by translator
 */
const requestContexts = new WeakMap();

export async function handleChat(request, clientRawRequest = null) {
  const arrivedAt = performance.now();
  const lifecycle = createRequestLifecycle({});
  const isClaudeEndpoint = new URL(request.url).pathname.endsWith("/messages");
  const budget = createRequestBudget({ signal: request.signal, deadlineAt: isClaudeEndpoint ? arrivedAt + CLAUDE_PRECOMMIT_TIMEOUT_MS : Infinity });
  const context = { lifecycle, budget };
  requestContexts.set(request, context);
  const finish = (status) => { lifecycle.finish(status); budget.dispose(); };
  try {
    const response = await budget.wait(handleChatRequest(request, clientRawRequest));
    budget.commit();
    if (!response.body) { finish(response.ok ? "completed" : "error"); return response; }
    const reader = response.body.getReader();
    return new Response(new ReadableStream({
      async pull(controller) {
        try {
          const next = await budget.wait(reader.read());
          if (next.done) { finish(response.ok ? context.streamOutcome || "completed" : "error"); controller.close(); }
          else controller.enqueue(next.value);
        } catch (error) {
          reader.cancel(error).catch(() => {});
          finish(error?.name === "TimeoutError" ? "timeout" : "aborted");
          controller.error(error);
        }
      },
      cancel(reason) { finish("aborted"); return reader.cancel(reason); },
    }), { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch (error) {
    finish(error?.name === "TimeoutError" ? "timeout" : "aborted");
    if (budget.signal.aborted || error?.localTermination) return localTerminationResult(error).response;
    throw error;
  }
}

async function handleChatRequest(request, clientRawRequest = null) {
  const requestContext = requestContexts.get(request);
  let body;
  try {
    body = await request.json();
    requestContext?.budget.check();
  } catch {
    log.warn("CHAT", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  // Build clientRawRequest for logging (if not provided)
  if (!clientRawRequest) {
    const url = new URL(request.url);
    clientRawRequest = {
      endpoint: url.pathname,
      body,
      headers: Object.fromEntries(request.headers.entries())
    };
  }
  // Claude Code marks a 1M-context request as `<model>[1m]`; the marker matches
  // no combo, alias or provider/model pair, so it must not reach resolution.
  // The capability travels in the anthropic-beta header, forwarded as-is.
  if (body.stream === false) requestContext?.budget.disableDeadline();
  const { model: modelStr, contextMarker } = stripModelContextMarker(body.model);
  requestContext?.lifecycle.onPhase("received", { model: modelStr });
  if (contextMarker) body.model = modelStr;

  // Request summary is emitted as the unified "▶" line in chatCore (has fmt/thinking/account)

  // Log API key (masked)
  const authHeader = request.headers.get("Authorization");
  const apiKey = extractApiKey(request);
  if (authHeader && apiKey) {
    const masked = log.maskKey(apiKey);
    log.debug("AUTH", `API Key: ${masked}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  // Enforce API key if enabled in settings
  const settings = await getSettings();
  if (settings.requireApiKey) {
    if (!apiKey) {
      log.warn("AUTH", "Missing API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    }
    const authResult = await isValidApiKey(apiKey);
    if (authResult === false) {
      log.warn("AUTH", "Invalid API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
    }
    if (typeof authResult === "object" && authResult?.valid === false) {
      log.warn("AUTH", `API key usage limit exceeded: ${authResult.usage}/${authResult.limit}`);
      return new Response(JSON.stringify({
        error: {
          message: `Usage limit exceeded for this API key (${authResult.usage}/${authResult.limit} tokens).`,
          type: "insufficient_quota",
          code: "insufficient_quota"
        }
      }), { status: 429, headers: { "Content-Type": "application/json" } });
    }
  }

  if (!modelStr) {
    log.warn("CHAT", "Missing model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  }

  // Bypass naming/warmup requests before combo rotation to avoid wasting rotation slots
  const userAgent = request?.headers?.get("user-agent") || "";
  const bypassResponse = handleBypassRequest(body, modelStr, userAgent, !!settings.ccFilterNaming);
  if (bypassResponse) return bypassResponse.response || bypassResponse;

  const requiredCapabilities = detectRequiredCapabilities(body);

  // Check if model is a combo (has multiple models with fallback)
  const comboModels = await getComboModels(modelStr);
  requestContext?.budget.check();
  if (comboModels) {
    // Check for combo-specific strategy first, fallback to global
    const comboStrategies = settings.comboStrategies || {};
    const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
    const comboStrategy = comboSpecificStrategy || settings.comboStrategy || "fallback";
    const augmentedModels = augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, settings);
    const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));

    if (comboStrategy === "fusion") {
      log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
      return handleFusionChat({
        body,
        models: comboModels,
        handleSingleModel: (b, m, isPanel) => {
          let cleanRawReq = clientRawRequest;
          if (isPanel && clientRawRequest) {
            const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
            cleanRawReq = { ...clientRawRequest, body: cleanBody };
          }
          return handleSingleModelChat(b, m, cleanRawReq, request, apiKey);
        },
        log,
        comboName: modelStr,
        judgeModel: comboStrategies[modelStr]?.judgeModel,
        tuning: comboStrategies[modelStr]?.fusionTuning,
      });
    }

    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: augmentedModels,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey),
        adapterAdded
      ),
      log,
      comboName: modelStr,
      // Capability-adapter requests are request-local; never move the grading cursor.
      comboStrategy: comboStrategy === "fallback-grading" && adapterAdded.length ? "fallback" : comboStrategy,
      comboStickyLimit,
      signal: request?.signal,
      checkModelAvailability
    });
  }

  // Single model request — may still switch to a capacity-adapter model if the
  // target lacks a capability the request needs (e.g. no vision, request has an image).
  const soloAugmented = augmentModelsWithCapacityAdapter([modelStr], requiredCapabilities, settings);
  if (soloAugmented.length > 1) {
    const adapterAdded = soloAugmented.filter((m) => m !== modelStr);
    log.info("CHAT", `Capacity adapter for [${[...requiredCapabilities].join(",")}] on "${modelStr}" → trying ${soloAugmented.join(", ")}`);
    return handleComboChat({
      body,
      models: soloAugmented,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey),
        adapterAdded
      ),
      log,
      comboName: modelStr,
      comboStrategy: getActiveAdapterStrategy(requiredCapabilities, settings)
    });
  }

  return handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey);
}

/**
 * Handle single model chat request
 */
async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null) {
  const modelInfo = await getModelInfo(modelStr);
  if (request) requestContexts.get(request)?.budget.check();

  // If provider is null, this might be a combo name - check and handle
  if (!modelInfo.provider) {
    const comboModels = await getComboModels(modelStr);
    if (comboModels) {
      const chatSettings = await getSettings();
      // Check for combo-specific strategy first, fallback to global
      const comboStrategies = chatSettings.comboStrategies || {};
      const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
      const comboStrategy = comboSpecificStrategy || chatSettings.comboStrategy || "fallback";
      const requiredCapabilities = detectRequiredCapabilities(body);
      const augmentedModels = augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, chatSettings);
      const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));

      if (comboStrategy === "fusion") {
        log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
        return handleFusionChat({
          body,
          models: comboModels,
          handleSingleModel: (b, m, isPanel) => {
            let cleanRawReq = clientRawRequest;
            if (isPanel && clientRawRequest) {
              const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
              cleanRawReq = { ...clientRawRequest, body: cleanBody };
            }
            return handleSingleModelChat(b, m, cleanRawReq, request, apiKey);
          },
          log,
          comboName: modelStr,
          judgeModel: comboStrategies[modelStr]?.judgeModel,
          tuning: comboStrategies[modelStr]?.fusionTuning,
        });
      }

      const comboStickyLimit = chatSettings.comboStickyRoundRobinLimit;
      log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
      return handleComboChat({
        body,
        models: augmentedModels,
        handleSingleModel: withCapacityAdapterStripping(
          (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey),
          adapterAdded
        ),
        log,
        comboName: modelStr,
        // Capability-adapter requests must not change the grading cursor.
        comboStrategy: comboStrategy === "fallback-grading" && adapterAdded.length ? "fallback" : comboStrategy,
        comboStickyLimit,
        signal: request?.signal,
        checkModelAvailability
      });
    }
    log.warn("CHAT", "Invalid model format", { model: modelStr });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
  }

  const { provider, model } = modelInfo;

  // Routing shown in the unified "▶" line (client model → provider/model)

  // Extract userAgent from request
  const userAgent = request?.headers?.get("user-agent") || "";

  // Try with available accounts (fallback on errors)
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  const context = request && requestContexts.get(request);
  const budget = context?.budget;
  while (true) {
    budget?.check();
    const selection = getProviderCredentials(provider, excludeConnectionIds, model, {
      signal: budget?.signal || request?.signal,
      onPhase: (phase) => context?.lifecycle.onPhase(phase, { provider, model }),
    });
    const credentials = budget ? await budget.wait(selection) : await selection;

    // All accounts unavailable
    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("CHAT", `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`);
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) {
        log.warn("AUTH", `No active credentials for provider: ${provider}`);
        return errorResponse(HTTP_STATUS.NOT_FOUND, `No active credentials for provider: ${provider}`);
      }
      log.warn("CHAT", "No more accounts available", { provider });
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    // Account selection shown in the unified "▶" line (acc:...)
    const attempt = context?.lifecycle.beginAttempt({ provider, model, connectionId: credentials.connectionId });
    attempt?.onPhase("preparing_credentials");
    const refresh = checkAndRefreshToken(provider, credentials);
    const refreshedCredentials = budget ? await budget.wait(refresh) : await refresh;

    // Ensure real project ID is available for providers that need it (P0 fix: cold miss)
    if ((provider === "antigravity" || provider === "gemini-cli") && !refreshedCredentials.projectId) {
      budget?.check();
      const discovery = getProjectIdForConnection(credentials.connectionId, refreshedCredentials.accessToken, provider);
      const pid = budget ? await budget.wait(discovery) : await discovery;
      if (pid) {
        refreshedCredentials.projectId = pid;
        // Persist to DB in background so subsequent requests have it immediately
        updateProviderCredentials(credentials.connectionId, { projectId: pid }).catch(() => { });
      }
    }

    // Use shared chatCore
    const chatSettings = await getSettings();
    const providerThinking = (chatSettings.providerThinking || {})[provider] || null;
    budget?.check();
    attempt?.onPhase("preparing_request");
    const result = await handleChatCore({
      requestContext: { signal: budget?.signal || request?.signal, deadlineAt: budget?.deadlineAt, wait: budget ? (work) => budget.wait(work) : null,
        check: () => budget?.check(), onPhase: (phase) => attempt?.onPhase(phase),
        onMilestone: (name) => attempt?.onMilestone(name), finishAttempt: (status) => { attempt?.finishAttempt(status); if (context && (status === "completed" || status === "error" || status === "aborted" || status === "timeout")) context.streamOutcome = status; }, pendingId: attempt?.id },
      body: { ...body, model: `${provider}/${model}` },
      modelInfo: { provider, model },
      credentials: refreshedCredentials,
      log,
      clientRawRequest,
      connectionId: credentials.connectionId,
      userAgent,
      apiKey,
      ccFilterNaming: !!chatSettings.ccFilterNaming,
      rtkEnabled: !!chatSettings.rtkEnabled,
      headroomEnabled: !!chatSettings.headroomEnabled,
      headroomUrl: chatSettings.headroomUrl || DEFAULT_HEADROOM_URL,
      headroomCompressUserMessages: !!chatSettings.headroomCompressUserMessages,
      headroomTimeoutMs: chatSettings.headroomTimeoutMs,
      cavemanEnabled: !!chatSettings.cavemanEnabled,
      cavemanLevel: chatSettings.cavemanLevel || "full",
      ponytailEnabled: !!chatSettings.ponytailEnabled,
      ponytailLevel: chatSettings.ponytailLevel || "full",
      pxpipeEnabled: !!chatSettings.pxpipeEnabled,
      pxpipeMinChars: chatSettings.pxpipeMinChars,
      pxpipeTimeoutMs: chatSettings.pxpipeTimeoutMs,
      // Lazily warms the in-process module on first use; null when not installed (fail-open)
      pxpipeTransform: chatSettings.pxpipeEnabled ? await getPxpipeTransform() : null,
      onPxpipeEvent: appendPxpipeEvent,
      providerThinking,
      // Pool-scoped failure recovery: re-resolve proxy config excluding the
      // failed pool so the request retries via another pool, not a dead end.
      resolveProxyConfig: async (creds, excludePoolIds = []) => {
        const psd = { ...(creds?.providerSpecificData || {}) };
        if (psd.proxyPoolIds?.length) psd.proxyPoolScope = `${provider}::${model}`;
        const resolved = await resolveConnectionProxyConfig(psd, creds?.connectionId || creds?.id, excludePoolIds);
        if (!resolved?.proxyPoolId) return null;
        return {
          connectionProxyEnabled: resolved.connectionProxyEnabled,
          connectionProxyUrl: resolved.connectionProxyUrl,
          connectionNoProxy: resolved.connectionNoProxy,
          connectionProxyPoolId: resolved.proxyPoolId || null,
          vercelRelayUrl: resolved.vercelRelayUrl || "",
          proxyPoolId: resolved.proxyPoolId || null,
          strictProxy: resolved.strictProxy === true,
        };
      },
      // Detect source format by endpoint + body
      sourceFormatOverride: request?.url ? detectFormatByEndpoint(new URL(request.url).pathname, body) : null,
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          ...newCreds,
          existingProviderSpecificData: credentials.providerSpecificData,
          testStatus: "active"
        });
      },
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
        // "Consecutive" strikes: a success clears the breaker for this pair.
        clearAntigravityStrikes(credentials.connectionId, model);
      }
    });

    if (result.success) return result.response;
    attempt?.finishAttempt(result.localTermination ? (result.status === 504 ? "timeout" : "aborted") : "error");
    if (result.localTermination) {
      throw Object.assign(new Error(result.error), { name: result.status === 504 ? "TimeoutError" : "AbortError", status: result.status, localTermination: true });
    }
    if (budget?.signal.aborted) budget.check();
    budget?.check();

    // Antigravity 409/429: refresh live quota to get exact resetAt before locking
    let quotaResetMs = null;
    let resetsAtMs = result.resetsAtMs;
    if (provider === "antigravity" && (result.status === 409 || result.status === 429)) {
      quotaResetMs = await handleAntigravityQuotaError(
        credentials.connectionId, result.status, model,
        refreshedCredentials.accessToken, credentials.providerSpecificData
      );
      if (quotaResetMs) resetsAtMs = quotaResetMs;
    }

    // Exhausted Antigravity model is blocked only in RAM cache until upstream resetAt.
    // Do not persist a modelLock_* for this path.
    const shouldFallback = provider === "antigravity" && quotaResetMs
      ? true
      : (await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model, resetsAtMs)).shouldFallback;

    if (shouldFallback) {
      log.warn("FALLBACK", `⇄ ACC:${credentials.connectionName} UNAVAILABLE (${result.status}) → NEXT ACCOUNT`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }

    return result.response;
  }
}
