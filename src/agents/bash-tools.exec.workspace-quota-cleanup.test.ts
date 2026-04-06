import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const workspaceQuotaGuardMocks = vi.hoisted(() => ({
  enforceWorkspaceQuota: vi.fn(),
  getWorkspaceQuotaFromContext: vi.fn(),
  invalidateWorkspaceCache: vi.fn(),
}));

vi.mock("./workspace-quota-guard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./workspace-quota-guard.js")>();
  return {
    ...actual,
    enforceWorkspaceQuota: workspaceQuotaGuardMocks.enforceWorkspaceQuota,
    getWorkspaceQuotaFromContext: workspaceQuotaGuardMocks.getWorkspaceQuotaFromContext,
    invalidateWorkspaceCache: workspaceQuotaGuardMocks.invalidateWorkspaceCache,
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

afterEach(() => {
  vi.clearAllMocks();
});

describe("exec workspace quota cleanup bypass", () => {
  it("blocks non-cleanup commands when workspace quota cannot be verified", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-exec-cleanup-"));
    try {
      workspaceQuotaGuardMocks.getWorkspaceQuotaFromContext.mockReturnValue({
        workspaceDir,
        quotaBytes: 1,
      });
      workspaceQuotaGuardMocks.enforceWorkspaceQuota.mockReturnValue({
        allowed: false,
        usedBytes: 0,
        quotaBytes: 1,
        measurementFailed: true,
      });

      const tool = createTestExecTool();
      const result = await tool.execute("call-0", {
        command: "python main.py",
        workdir: workspaceDir,
      });
      const text = result.content.find((part) => part.type === "text")?.text ?? "";

      expect(text).toContain("Workspace storage quota could not be verified right now.");
      expect((result.details as { exitCode?: number }).exitCode).toBe(1);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("still allows direct cleanup commands when workspace quota is exceeded", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-exec-cleanup-"));
    try {
      await fs.writeFile(path.join(workspaceDir, "cleanup-target.txt"), "x", "utf-8");
      workspaceQuotaGuardMocks.getWorkspaceQuotaFromContext.mockReturnValue({
        workspaceDir,
        quotaBytes: 1,
      });
      workspaceQuotaGuardMocks.enforceWorkspaceQuota.mockReturnValue({
        allowed: false,
        usedBytes: 10,
        quotaBytes: 1,
      });

      const tool = createTestExecTool();
      const result = await tool.execute("call-1", {
        command: "rm cleanup-target.txt",
        workdir: workspaceDir,
      });
      const text = result.content.find((part) => part.type === "text")?.text ?? "";

      expect(text).toContain("Allowing cleanup command.");
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("does not bypass workspace quota for commands that only mention cleanup verbs", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-exec-cleanup-"));
    try {
      workspaceQuotaGuardMocks.getWorkspaceQuotaFromContext.mockReturnValue({
        workspaceDir,
        quotaBytes: 1,
      });
      workspaceQuotaGuardMocks.enforceWorkspaceQuota.mockReturnValue({
        allowed: false,
        usedBytes: 10,
        quotaBytes: 1,
      });

      const tool = createTestExecTool();
      const result = await tool.execute("call-2", {
        command: 'echo "do not run rm -rf later"',
        workdir: workspaceDir,
      });
      const text = result.content.find((part) => part.type === "text")?.text ?? "";

      expect(text).toContain("Workspace storage quota exceeded:");
      expect(text).not.toContain("Allowing cleanup command.");
      expect((result.details as { exitCode?: number }).exitCode).toBe(1);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
