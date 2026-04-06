import { afterEach, describe, expect, it, vi } from "vitest";

const workspaceQuotaGuardMocks = vi.hoisted(() => ({
  getWorkspaceQuotaFromContext: vi.fn(),
  invalidateWorkspaceCache: vi.fn(),
}));

vi.mock("../workspace-quota-guard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../workspace-quota-guard.js")>();
  return {
    ...actual,
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

  it("invalidates the workspace quota cache after remove", async () => {
    await withTempDir("openclaw-fs-bridge-quota-remove-", async (stateDir) => {
      const { bridge, workspaceDir } = await createSeededSandboxFsBridge(stateDir);
      workspaceQuotaGuardMocks.getWorkspaceQuotaFromContext.mockReturnValue({
        workspaceDir,
        quotaBytes: 1024,
      });

      await bridge.remove({ filePath: "nested/file.txt" });

      expect(workspaceQuotaGuardMocks.invalidateWorkspaceCache).toHaveBeenCalledWith(workspaceDir);
    });
  });

  it("invalidates the workspace quota cache after rename", async () => {
    await withTempDir("openclaw-fs-bridge-quota-rename-", async (stateDir) => {
      const { bridge, workspaceDir } = await createSeededSandboxFsBridge(stateDir);
      workspaceQuotaGuardMocks.getWorkspaceQuotaFromContext.mockReturnValue({
        workspaceDir,
        quotaBytes: 1024,
      });

      await bridge.rename({ from: "from.txt", to: "nested/to.txt" });

      expect(workspaceQuotaGuardMocks.invalidateWorkspaceCache).toHaveBeenCalledWith(workspaceDir);
    });
  });
});
