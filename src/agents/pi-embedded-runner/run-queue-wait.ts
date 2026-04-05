import {
  resolveAgentMaxConcurrent,
  resolveSubagentMaxConcurrent,
} from "../../config/agent-limits.js";
import type { OpenClawConfig } from "../../config/config.js";
import { CommandLane } from "../../process/lanes.js";

export const EMBEDDED_RUN_GLOBAL_QUEUE_WAIT_WARN_AFTER_MS = 2_000;

function resolveGlobalLaneCapacityHint(lane: string, config?: OpenClawConfig): number {
  if (lane === "main") {
    return resolveAgentMaxConcurrent(config);
  }
  if (lane === "subagent") {
    return resolveSubagentMaxConcurrent(config);
  }
  return 1;
}

export function buildEmbeddedRunQueueWaitWarning(params: {
  runId: string;
  sessionId: string;
  sessionKey?: string;
  globalLane: string;
  waitedMs: number;
  queuedAhead: number;
  config?: OpenClawConfig;
}): string {
  const lane = params.globalLane.trim() || CommandLane.Main;
  const limit = resolveGlobalLaneCapacityHint(lane, params.config);
  const sessionKeyPart =
    typeof params.sessionKey === "string" && params.sessionKey.trim()
      ? ` sessionKey=${params.sessionKey.trim()}`
      : "";
  return (
    `[throughput-backpressure] active turn waited for global lane capacity: ` +
    `lane=${lane} waitedMs=${params.waitedMs} queuedAhead=${params.queuedAhead} ` +
    `maxConcurrent=${limit} run=${params.runId} session=${params.sessionId}${sessionKeyPart}`
  );
}
