import { describe, expect, it, vi } from "vitest";
import type { ChannelId } from "../../channels/plugins/index.js";
import type { ChannelAccountSnapshot } from "../../channels/plugins/types.js";
import type { ChannelManager, ChannelRuntimeSnapshot } from "../server-channels.js";
import {
  assertSupportedPersaiRuntimeStartupContract,
  createReadinessChecker,
} from "./readiness.js";

function snapshotWith(
  accounts: Record<string, Partial<ChannelAccountSnapshot>>,
): ChannelRuntimeSnapshot {
  const channels: ChannelRuntimeSnapshot["channels"] = {};
  const channelAccounts: ChannelRuntimeSnapshot["channelAccounts"] = {};

  for (const [channelId, accountSnapshot] of Object.entries(accounts)) {
    const resolved = { accountId: "default", ...accountSnapshot } as ChannelAccountSnapshot;
    channels[channelId as ChannelId] = resolved;
    channelAccounts[channelId as ChannelId] = { default: resolved };
  }

  return { channels, channelAccounts };
}

function createManager(snapshot: ChannelRuntimeSnapshot): ChannelManager {
  return {
    getRuntimeSnapshot: vi.fn(() => snapshot),
    startChannels: vi.fn(),
    startChannel: vi.fn(),
    stopChannel: vi.fn(),
    markChannelLoggedOut: vi.fn(),
    isHealthMonitorEnabled: vi.fn(() => true),
    isManuallyStopped: vi.fn(() => false),
    resetRestartAttempts: vi.fn(),
  };
}

function createHealthyDiscordManager(startedAt: number, lastEventAt: number): ChannelManager {
  return createManager(
    snapshotWith({
      discord: {
        running: true,
        connected: true,
        enabled: true,
        configured: true,
        lastStartAt: startedAt,
        lastEventAt,
      },
    }),
  );
}

function withReadinessClock(run: () => void) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-06T12:00:00Z"));
  try {
    run();
  } finally {
    vi.useRealTimers();
  }
}

function withReadinessEnv(env: NodeJS.ProcessEnv, run: () => void) {
  const originalEnv = process.env;
  process.env = {
    ...originalEnv,
    ...env,
  };
  try {
    run();
  } finally {
    process.env = originalEnv;
  }
}

function createReadinessHarness(params: {
  startedAgoMs: number;
  accounts: Record<string, Partial<ChannelAccountSnapshot>>;
  cacheTtlMs?: number;
}) {
  const startedAt = Date.now() - params.startedAgoMs;
  const manager = createManager(snapshotWith(params.accounts));
  return {
    manager,
    readiness: createReadinessChecker({
      channelManager: manager,
      startedAt,
      cacheTtlMs: params.cacheTtlMs,
    }),
  };
}

describe("createReadinessChecker", () => {
  it("reports ready when all managed channels are healthy", () => {
    withReadinessClock(() => {
      const startedAt = Date.now() - 5 * 60_000;
      const manager = createHealthyDiscordManager(startedAt, Date.now() - 1_000);

      const readiness = createReadinessChecker({ channelManager: manager, startedAt });
      expect(readiness()).toEqual({ ready: true, failing: [], uptimeMs: 300_000 });
    });
  });

  it("ignores disabled and unconfigured channels", () => {
    withReadinessClock(() => {
      const { readiness } = createReadinessHarness({
        startedAgoMs: 5 * 60_000,
        accounts: {
          discord: {
            running: false,
            enabled: false,
            configured: true,
            lastStartAt: Date.now() - 5 * 60_000,
          },
          telegram: {
            running: false,
            enabled: true,
            configured: false,
            lastStartAt: Date.now() - 5 * 60_000,
          },
        },
      });
      expect(readiness()).toEqual({ ready: true, failing: [], uptimeMs: 300_000 });
    });
  });

  it("uses startup grace before marking disconnected channels not ready", () => {
    withReadinessClock(() => {
      const { readiness } = createReadinessHarness({
        startedAgoMs: 30_000,
        accounts: {
          discord: {
            running: true,
            connected: false,
            enabled: true,
            configured: true,
            lastStartAt: Date.now() - 30_000,
          },
        },
      });
      expect(readiness()).toEqual({ ready: true, failing: [], uptimeMs: 30_000 });
    });
  });

  it("reports disconnected managed channels after startup grace", () => {
    withReadinessClock(() => {
      const { readiness } = createReadinessHarness({
        startedAgoMs: 5 * 60_000,
        accounts: {
          discord: {
            running: true,
            connected: false,
            enabled: true,
            configured: true,
            lastStartAt: Date.now() - 5 * 60_000,
          },
        },
      });
      expect(readiness()).toEqual({ ready: false, failing: ["discord"], uptimeMs: 300_000 });
    });
  });

  it("keeps restart-pending channels ready during reconnect backoff", () => {
    withReadinessClock(() => {
      const startedAt = Date.now() - 5 * 60_000;
      const { readiness } = createReadinessHarness({
        startedAgoMs: 5 * 60_000,
        accounts: {
          discord: {
            running: false,
            restartPending: true,
            reconnectAttempts: 3,
            enabled: true,
            configured: true,
            lastStartAt: startedAt - 30_000,
            lastStopAt: Date.now() - 5_000,
          },
        },
      });
      expect(readiness()).toEqual({ ready: true, failing: [], uptimeMs: 300_000 });
    });
  });

  it("treats stale-socket channels as ready to avoid pulling healthy idle pods", () => {
    withReadinessClock(() => {
      const startedAt = Date.now() - 31 * 60_000;
      const { readiness } = createReadinessHarness({
        startedAgoMs: 31 * 60_000,
        accounts: {
          discord: {
            running: true,
            connected: true,
            enabled: true,
            configured: true,
            lastStartAt: startedAt,
            lastEventAt: Date.now() - 31 * 60_000,
          },
        },
      });
      expect(readiness()).toEqual({ ready: true, failing: [], uptimeMs: 1_860_000 });
    });
  });

  it("keeps telegram long-polling channels ready without stale-socket classification", () => {
    withReadinessClock(() => {
      const startedAt = Date.now() - 31 * 60_000;
      const { readiness } = createReadinessHarness({
        startedAgoMs: 31 * 60_000,
        accounts: {
          telegram: {
            running: true,
            connected: true,
            enabled: true,
            configured: true,
            lastStartAt: startedAt,
            lastEventAt: null,
          },
        },
      });
      expect(readiness()).toEqual({ ready: true, failing: [], uptimeMs: 1_860_000 });
    });
  });

  it("caches readiness snapshots briefly to keep repeated probes cheap", () => {
    withReadinessClock(() => {
      const { manager, readiness } = createReadinessHarness({
        startedAgoMs: 5 * 60_000,
        accounts: {
          discord: {
            running: true,
            connected: true,
            enabled: true,
            configured: true,
            lastStartAt: Date.now() - 5 * 60_000,
            lastEventAt: Date.now() - 1_000,
          },
        },
        cacheTtlMs: 1_000,
      });
      expect(readiness()).toEqual({ ready: true, failing: [], uptimeMs: 300_000 });
      vi.advanceTimersByTime(500);
      expect(readiness()).toEqual({ ready: true, failing: [], uptimeMs: 300_500 });
      expect(manager.getRuntimeSnapshot).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(600);
      expect(readiness()).toEqual({ ready: true, failing: [], uptimeMs: 301_100 });
      expect(manager.getRuntimeSnapshot).toHaveBeenCalledTimes(2);
    });
  });

  it("keeps single-replica PersAI runtime mode ready without extra cluster requirements", () => {
    withReadinessClock(() => {
      withReadinessEnv(
        {
          PERSAI_RUNTIME_READINESS_MODE: "single_replica",
          PERSAI_RUNTIME_SPEC_STORE: "memory",
        },
        () => {
          const startedAt = Date.now() - 5 * 60_000;
          const manager = createHealthyDiscordManager(startedAt, Date.now() - 1_000);
          const readiness = createReadinessChecker({ channelManager: manager, startedAt });
          expect(readiness()).toEqual({ ready: true, failing: [], uptimeMs: 300_000 });
        },
      );
    });
  });

  it("reports PersAI runtime multi-replica blockers when cluster seams are not shared", () => {
    withReadinessClock(() => {
      withReadinessEnv(
        {
          PERSAI_RUNTIME_READINESS_MODE: "multi_replica",
          PERSAI_RUNTIME_SPEC_STORE: "memory",
        },
        () => {
          const startedAt = Date.now() - 5 * 60_000;
          const manager = createHealthyDiscordManager(startedAt, Date.now() - 1_000);
          const readiness = createReadinessChecker({ channelManager: manager, startedAt });
          expect(readiness()).toEqual({
            ready: false,
            failing: [
              "persai_runtime_spec_store_not_shared",
              "persai_runtime_session_store_not_cluster_proven",
              "persai_runtime_workspace_continuity_not_cluster_proven",
              "persai_runtime_session_ordering_process_local",
              "persai_runtime_multi_replica_session_not_supported",
            ],
            uptimeMs: 300_000,
          });
        },
      );
    });
  });

  it("keeps PersAI runtime multi-replica mode not ready even with redis spec storage", () => {
    withReadinessClock(() => {
      withReadinessEnv(
        {
          PERSAI_RUNTIME_READINESS_MODE: "multi_replica",
          PERSAI_RUNTIME_SPEC_STORE: "redis",
        },
        () => {
          const startedAt = Date.now() - 5 * 60_000;
          const manager = createHealthyDiscordManager(startedAt, Date.now() - 1_000);
          const readiness = createReadinessChecker({ channelManager: manager, startedAt });
          expect(readiness()).toEqual({
            ready: false,
            failing: [
              "persai_runtime_session_store_not_cluster_proven",
              "persai_runtime_workspace_continuity_not_cluster_proven",
              "persai_runtime_session_ordering_process_local",
              "persai_runtime_multi_replica_session_not_supported",
            ],
            uptimeMs: 300_000,
          });
        },
      );
    });
  });

  it("rejects PersAI runtime multi-replica mode at startup", () => {
    withReadinessEnv(
      {
        PERSAI_RUNTIME_READINESS_MODE: "multi_replica",
      },
      () => {
        expect(() => assertSupportedPersaiRuntimeStartupContract()).toThrow(
          /does not support `PERSAI_RUNTIME_READINESS_MODE=multi_replica`/i,
        );
      },
    );
  });

  it("rejects unknown PersAI runtime startup modes", () => {
    withReadinessEnv(
      {
        PERSAI_RUNTIME_READINESS_MODE: "maybe_cluster",
      },
      () => {
        expect(() => assertSupportedPersaiRuntimeStartupContract()).toThrow(
          /does not support `PERSAI_RUNTIME_READINESS_MODE=maybe_cluster`/i,
        );
      },
    );
  });
});
