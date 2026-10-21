export default {
  id: "opencode",
  priority: 40,
  hasFree: true,
  alias: "oc",
  uiAlias: "oc",
  display: {
    name: "OpenCode Free",
    icon: "terminal",
    color: "#E87040",
    textIcon: "OC",
  },
  category: "free",
  noAuth: true,
  // forceStream: upstream free tier (2026-09) rejects non-streaming bodies
  // with 403 FreeTierError; chatCore aggregates SSE back to JSON for clients
  // that requested a plain response (see handleForcedSSEToJson).
  forceStream: true,
  transport: {
    baseUrl: "https://opencode.ai",
    headers: {
      "x-opencode-client": "cli",
    },
    noAuth: true,
  },
  models: [
    // Muse Spark models are served by /inference/v1/responses; the rest stay
    // on /inference/v1/chat/completions, so the format is declared per-model.
    { id: "muse-spark-1.2-contributor-free", name: "Muse Spark 1.2 Contributor Free", targetFormat: "openai-responses" },
    { id: "muse-spark-1.3-contributor-free", name: "Muse Spark 1.3 Contributor Free", targetFormat: "openai-responses" },
  ],
  modelsFetcher: { url: "https://opencode.ai/inference/v1/models", type: "opencode-free" },
  passthroughModels: true,
};