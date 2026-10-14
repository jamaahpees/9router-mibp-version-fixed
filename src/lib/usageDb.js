// RAM-only lifecycle helpers are independent of the SQLite implementation.
export { createRequestLifecycle, getRequestLifecycleSnapshot } from "./requestLifecycle.js";

// Shim → re-export from new SQLite-based DB layer (src/lib/db/)
export {
  statsEmitter, trackPendingRequest, getActiveRequests,
  saveRequestUsage, getUsageHistory, getUsageStats, getChartData,
  appendRequestLog, getRecentLogs,
  saveRequestDetail, getRequestDetails, getRequestDetailById,
} from "@/lib/db/index.js";
