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
    // Free tier on /inference/v1/chat/completions (live list: 2026-10-21).
    // Keep in sync with the -free ids from /inference/v1/models; passthroughModels
    // still accepts new ids before the next catalog refresh.
    { id: "big-pickle", name: "Big Pickle Free" },
    { id: "beam-free", name: "Beam Free" },
    { id: "deepseek-v4.1-flash-free", name: "DeepSeek V4.1 Flash Free" },
    { id: "glm-5.3-flash-free", name: "GLM 5.3 Flash Free" },
    { id: "longcat-2.5-preview-free", name: "LongCat 2.5 Preview Free" },
    { id: "mimo-v2.6-flash-free", name: "MiMo V2.6 Flash Free" },
    { id: "minimax-m3.1-flash-free", name: "MiniMax M3.1 Flash Free" },
    { id: "nemotron-3.5-lightning-free", name: "Nemotron 3.5 Lightning Free" },
    { id: "nemotron-3.5-super-vl-free", name: "Nemotron 3.5 Super VL Free" },
  ],
  modelsFetcher: { url: "https://opencode.ai/inference/v1/models", type: "opencode-free" },
  passthroughModels: true,
};