import { afterEach, describe, expect, it, vi } from "vitest";

const workspaceQuotaGuardMocks = vi.hoisted(() => ({
  enforceWorkspaceQuota: vi.fn(),
  getWorkspaceQuotaFromContext: vi.fn(),
  invalidateWorkspaceCache: vi.fn(),
}));

const runExecProcessMock = vi.hoisted(() => vi.fn());

vi.mock("./workspace-quota-guard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./workspace-quota-guard.js")>();
  return {
    ...actual,
    enforceWorkspaceQuota: workspaceQuotaGuardMocks.enforceWorkspaceQuota,
    getWorkspaceQuotaFromContext: workspaceQuotaGuardMocks.getWorkspaceQuotaFromContext,
    invalidateWorkspaceCache: workspaceQuotaGuardMocks.invalidateWorkspaceCache,
  };
});

vi.mock("./bash-tools.exec-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./bash-tools.exec-runtime.js")>();
  return {
    ...actual,
    runExecProcess: runExecProcessMock,
  };
});

import { createExecTool } from "./bash-tools.exec.js";

const TEST_EXEC_DEFAULTS = {
  host: "gateway" as const,
  security: "full" as const,
  ask: "off" as const,
};

const createTestExecTool = (
  defaults?: Parameters<typeof createExecTool>[0],
): ReturnType<typeof createExecTool> => createExecTool({ ...TEST_EXEC_DEFAULTS, ...defaults });

describe("exec workspace quota watch", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("kills a running command when periodic quota checks detect workspace growth past the limit", async () => {
    vi.useRealTimers();
    workspaceQuotaGuardMocks.getWorkspaceQuotaFromContext.mockReturnValue({
      workspaceDir: "/workspace",
      quotaBytes: 100,
    });
    workspaceQuotaGuardMocks.enforceWorkspaceQuota
      .mockReturnValueOnce({
        allowed: true,
        usedBytes: 10,
        quotaBytes: 100,
      })
      .mockReturnValueOnce({
        allowed: false,
        usedBytes: 150,
        quotaBytes: 100,
      });

    let resolveRun:
      | ((value: {
          status: "completed" | "failed";
          exitCode: number | null;
          exitSignal: NodeJS.Signals | number | null;
          durationMs: number;
          aggregated: string;
          timedOut: boolean;
          reason?: string;
        }) => void)
      | null = null;

    const kill = vi.fn(() => {
      resolveRun?.({
        status: "failed",
        exitCode: null,
        exitSignal: "SIGKILL",
        durationMs: 50,
        aggregated: "",
        timedOut: false,
        reason: "Command aborted by signal SIGKILL",
      });
    });

    runExecProcessMock.mockImplementation(async () => ({
      session: { id: "sess-1", backgrounded: false, pid: 123, cwd: "/workspace", tail: "" },
      startedAt: 0,
      pid: 123,
      promise: new Promise((resolve) => {
        resolveRun = resolve;
      }),
      kill,
    }));

    const tool = createTestExecTool();
    const execution = tool.execute("call-1", {
      command: "python big-write.py",
      workdir: "/workspace",
    });

    await expect(execution).rejects.toThrow(
      "Workspace storage quota exceeded during command: 150 B / 100 B. Process was terminated to stop further workspace growth.",
    );
    expect(kill).toHaveBeenCalledTimes(1);
    expect(workspaceQuotaGuardMocks.invalidateWorkspaceCache).toHaveBeenCalledWith("/workspace");
  }, 10_000);

  it("does not start the quota watch for direct cleanup commands", async () => {
    vi.useFakeTimers();
    workspaceQuotaGuardMocks.getWorkspaceQuotaFromContext.mockReturnValue({
      workspaceDir: "/workspace",
      quotaBytes: 100,
    });
    workspaceQuotaGuardMocks.enforceWorkspaceQuota.mockReturnValue({
      allowed: false,
      usedBytes: 150,
      quotaBytes: 100,
    });

    runExecProcessMock.mockResolvedValue({
      session: { id: "sess-2", backgrounded: false, pid: 123, cwd: "/workspace", tail: "" },
      startedAt: 0,
      pid: 123,
      promise: Promise.resolve({
        status: "completed",
        exitCode: 0,
        exitSignal: null,
        durationMs: 10,
        aggregated: "",
        timedOut: false,
      }),
      kill: vi.fn(),
    });

    const tool = createTestExecTool();
    const result = await tool.execute("call-2", {
      command: "rm -rf build",
      workdir: "/workspace",
    });

    await vi.advanceTimersByTimeAsync(5_000);

    const text = result.content.find((part) => part.type === "text")?.text ?? "";
    expect(text).toContain("Allowing cleanup command.");
    expect(workspaceQuotaGuardMocks.enforceWorkspaceQuota).toHaveBeenCalledTimes(2);
  });
});
