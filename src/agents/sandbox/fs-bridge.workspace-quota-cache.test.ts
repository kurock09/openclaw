import { afterEach, describe, expect, it, vi } from "vitest";

const workspaceQuotaGuardMocks = vi.hoisted(() => ({
  adjustWorkspaceUsageCache: vi.fn(),
  enforceWorkspaceQuota: vi.fn(),
  getWorkspaceQuotaFromContext: vi.fn(),
  invalidateWorkspaceCache: vi.fn(),
}));

vi.mock("../workspace-quota-guard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../workspace-quota-guard.js")>();
  return {
    ...actual,
    adjustWorkspaceUsageCache: workspaceQuotaGuardMocks.adjustWorkspaceUsageCache,
    enforceWorkspaceQuota: workspaceQuotaGuardMocks.enforceWorkspaceQuota,
    getWorkspaceQuotaFromContext: workspaceQuotaGuardMocks.getWorkspaceQuotaFromContext,
    invalidateWorkspaceCache: workspaceQuotaGuardMocks.invalidateWorkspaceCache,
  };
});

import {
  createSeededSandboxFsBridge,
  installFsBridgeTestHarness,
  withTempDir,
} from "./fs-bridge.test-helpers.js";

describe("sandbox fs bridge workspace quota cache parity", () => {
  installFsBridgeTestHarness();

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("adjusts the workspace quota cache after file overwrite", async () => {
    await withTempDir("openclaw-fs-bridge-quota-write-", async (stateDir) => {
      const { bridge, workspaceDir } = await createSeededSandboxFsBridge(stateDir, {
        nestedContents: "bye",
      });
      workspaceQuotaGuardMocks.getWorkspaceQuotaFromContext.mockReturnValue({
        workspaceDir,
        quotaBytes: 1024,
      });
      workspaceQuotaGuardMocks.enforceWorkspaceQuota.mockReturnValue({
        allowed: true,
        usedBytes: 1,
        quotaBytes: 1024,
      });

      await bridge.writeFile({ filePath: "nested/file.txt", data: "updated" });

      expect(workspaceQuotaGuardMocks.adjustWorkspaceUsageCache).toHaveBeenCalledWith(
        workspaceDir,
        Buffer.byteLength("updated", "utf8") - 1,
      );
      expect(workspaceQuotaGuardMocks.invalidateWorkspaceCache).not.toHaveBeenCalled();
    });
  });

  it("invalidates the workspace quota cache after remove", async () => {
    await withTempDir("openclaw-fs-bridge-quota-remove-", async (stateDir) => {
      const { bridge, workspaceDir } = await createSeededSandboxFsBridge(stateDir);
      workspaceQuotaGuardMocks.getWorkspaceQuotaFromContext.mockReturnValue({
        workspaceDir,
        quotaBytes: 1024,
      });
      workspaceQuotaGuardMocks.enforceWorkspaceQuota.mockReturnValue({
        allowed: true,
        usedBytes: 1,
        quotaBytes: 1024,
      });

      await bridge.remove({ filePath: "nested/file.txt" });

      expect(workspaceQuotaGuardMocks.adjustWorkspaceUsageCache).toHaveBeenCalledWith(
        workspaceDir,
        -1,
      );
      expect(workspaceQuotaGuardMocks.invalidateWorkspaceCache).not.toHaveBeenCalled();
    });
  });

  it("adjusts the workspace quota cache after rename overwrite", async () => {
    await withTempDir("openclaw-fs-bridge-quota-rename-", async (stateDir) => {
      const { bridge, workspaceDir } = await createSeededSandboxFsBridge(stateDir);
      workspaceQuotaGuardMocks.getWorkspaceQuotaFromContext.mockReturnValue({
        workspaceDir,
        quotaBytes: 1024,
      });
      workspaceQuotaGuardMocks.enforceWorkspaceQuota.mockReturnValue({
        allowed: true,
        usedBytes: 1,
        quotaBytes: 1024,
      });
      await bridge.writeFile({ filePath: "nested/to.txt", data: "12345" });

      await bridge.rename({ from: "from.txt", to: "nested/to.txt" });

      expect(workspaceQuotaGuardMocks.adjustWorkspaceUsageCache).toHaveBeenCalledWith(
        workspaceDir,
        -1,
      );
      expect(workspaceQuotaGuardMocks.invalidateWorkspaceCache).not.toHaveBeenCalled();
    });
  });
});
