import type { ChannelAccountSnapshot } from "../../channels/plugins/types.js";
import {
  DEFAULT_CHANNEL_CONNECT_GRACE_MS,
  DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS,
  evaluateChannelHealth,
  type ChannelHealthPolicy,
  type ChannelHealthEvaluation,
} from "../channel-health-policy.js";
import type { ChannelManager } from "../server-channels.js";

export type ReadinessResult = {
  ready: boolean;
  failing: string[];
  uptimeMs: number;
};

export type ReadinessChecker = () => ReadinessResult;

const DEFAULT_READINESS_CACHE_TTL_MS = 1_000;
const PERSAI_RUNTIME_READINESS_MODE_ENV = "PERSAI_RUNTIME_READINESS_MODE";
const PERSAI_RUNTIME_SINGLE_REPLICA_MODE = "single_replica";
const PERSAI_RUNTIME_MULTI_REPLICA_MODE = "multi_replica";

function resolvePersaiRuntimeReadinessMode(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[PERSAI_RUNTIME_READINESS_MODE_ENV];
  return (raw ?? PERSAI_RUNTIME_SINGLE_REPLICA_MODE).trim().toLowerCase();
}

export function assertSupportedPersaiRuntimeStartupContract(
  env: NodeJS.ProcessEnv = process.env,
): void {
  const mode = resolvePersaiRuntimeReadinessMode(env);
  if (mode === PERSAI_RUNTIME_SINGLE_REPLICA_MODE) {
    return;
  }

  throw new Error(
    `PersAI OpenClaw runtime does not support \`PERSAI_RUNTIME_READINESS_MODE=${mode}\`. ` +
      "Supported runtime contract remains `single_replica` with one pod per runtime pool " +
      "until distributed session ownership exists.",
  );
}

function resolvePersaiRuntimeReadinessFailures(): string[] {
  const mode = resolvePersaiRuntimeReadinessMode();
  if (mode !== PERSAI_RUNTIME_MULTI_REPLICA_MODE) {
    return [];
  }

  const failures: string[] = [];
  const specStoreMode = (process.env.PERSAI_RUNTIME_SPEC_STORE ?? "memory").trim().toLowerCase();
  if (specStoreMode !== "redis") {
    failures.push("persai_runtime_spec_store_not_shared");
  }
  // Redis-backed apply metadata is only one seam. Session transcripts, workspace
  // continuity, and execution ordering are still owned by the gateway process
  // rather than a cluster-wide runtime contract.
  failures.push(
    "persai_runtime_session_store_not_cluster_proven",
    "persai_runtime_workspace_continuity_not_cluster_proven",
    "persai_runtime_session_ordering_process_local",
    "persai_runtime_multi_replica_session_not_supported",
  );
  return failures;
}

function shouldIgnoreReadinessFailure(
  accountSnapshot: ChannelAccountSnapshot,
  health: ChannelHealthEvaluation,
): boolean {
  if (health.reason === "unmanaged" || health.reason === "stale-socket") {
    return true;
  }
  // Channel restarts spend time in backoff with running=false before the next
  // lifecycle re-enters startup grace. Keep readiness green during that handoff
  // window, but still surface hard failures once restart attempts are exhausted.
  return health.reason === "not-running" && accountSnapshot.restartPending === true;
}

export function createReadinessChecker(deps: {
  channelManager: ChannelManager;
  startedAt: number;
  cacheTtlMs?: number;
}): ReadinessChecker {
  const { channelManager, startedAt } = deps;
  const cacheTtlMs = Math.max(0, deps.cacheTtlMs ?? DEFAULT_READINESS_CACHE_TTL_MS);
  let cachedAt = 0;
  let cachedState: Omit<ReadinessResult, "uptimeMs"> | null = null;

  return (): ReadinessResult => {
    const now = Date.now();
    const uptimeMs = now - startedAt;
    if (cachedState && now - cachedAt < cacheTtlMs) {
      return { ...cachedState, uptimeMs };
    }

    const snapshot = channelManager.getRuntimeSnapshot();
    const failing: string[] = [];

    for (const [channelId, accounts] of Object.entries(snapshot.channelAccounts)) {
      if (!accounts) {
        continue;
      }
      for (const accountSnapshot of Object.values(accounts)) {
        if (!accountSnapshot) {
          continue;
        }
        const policy: ChannelHealthPolicy = {
          now,
          staleEventThresholdMs: DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS,
          channelConnectGraceMs: DEFAULT_CHANNEL_CONNECT_GRACE_MS,
          channelId,
        };
        const health = evaluateChannelHealth(accountSnapshot, policy);
        if (!health.healthy && !shouldIgnoreReadinessFailure(accountSnapshot, health)) {
          failing.push(channelId);
          break;
        }
      }
    }

    failing.push(...resolvePersaiRuntimeReadinessFailures());

    cachedAt = now;
    cachedState = { ready: failing.length === 0, failing };
    return { ...cachedState, uptimeMs };
  };
}
