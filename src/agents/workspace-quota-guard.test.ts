import { afterEach, describe, expect, it, vi } from "vitest";

const execSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execSync: execSyncMock,
}));

import { enforceWorkspaceQuota, invalidateWorkspaceCache } from "./workspace-quota-guard.js";

describe("workspace quota guard measurement reliability", () => {
  afterEach(() => {
    vi.clearAllMocks();
    invalidateWorkspaceCache("/workspace-a");
    invalidateWorkspaceCache("/workspace-b");
  });

  it("fails closed when workspace usage cannot be measured", () => {
    execSyncMock.mockImplementation(() => {
      throw new Error("du failed");
    });

    const result = enforceWorkspaceQuota({
      workspaceDir: "/workspace-a",
      quotaBytes: 100,
    });

    expect(result.allowed).toBe(false);
    expect(result.measurementFailed).toBe(true);
    expect(result.measurementFailureReason).toContain("du failed");
  });

  it("treats invalid du output as measurement failure instead of caching zero", () => {
    execSyncMock
      .mockReturnValueOnce("not-a-number\t/workspace-b")
      .mockReturnValueOnce("55\t/workspace-b");

    const failed = enforceWorkspaceQuota({
      workspaceDir: "/workspace-b",
      quotaBytes: 100,
    });
    const recovered = enforceWorkspaceQuota({
      workspaceDir: "/workspace-b",
      quotaBytes: 100,
    });

    expect(failed.allowed).toBe(false);
    expect(failed.measurementFailed).toBe(true);
    expect(recovered.allowed).toBe(true);
    expect(recovered.usedBytes).toBe(55);
    expect(execSyncMock).toHaveBeenCalledTimes(2);
  });
});
