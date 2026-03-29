import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { applyPersaiRuntimeSpecLocally } from "./persai-runtime-local-apply.js";
import { InMemoryPersaiRuntimeSpecStore } from "./persai-runtime-spec-store.js";

const {
  syncTelegramBotForAssistantMock,
  validatePersaiRuntimeProviderProfileForApplyMock,
  validateToolPolicyForApplyMock,
  writeBootstrapFilesToWorkspaceMock,
} = vi.hoisted(() => ({
  syncTelegramBotForAssistantMock: vi.fn(),
  validatePersaiRuntimeProviderProfileForApplyMock: vi.fn(),
  validateToolPolicyForApplyMock: vi.fn(),
  writeBootstrapFilesToWorkspaceMock: vi.fn(),
}));

vi.mock("./persai-runtime-telegram.js", () => ({
  syncTelegramBotForAssistant: syncTelegramBotForAssistantMock,
}));

vi.mock("./persai-runtime-provider-profile.js", () => ({
  PersaiRuntimeProviderProfileValidationError: class PersaiRuntimeProviderProfileValidationError extends Error {},
  validatePersaiRuntimeProviderProfileForApply: validatePersaiRuntimeProviderProfileForApplyMock,
}));

vi.mock("./persai-runtime-tool-policy.js", () => ({
  PersaiToolPolicyValidationError: class PersaiToolPolicyValidationError extends Error {},
  validateToolPolicyForApply: validateToolPolicyForApplyMock,
}));

vi.mock("./persai-runtime-workspace.js", () => ({
  writeBootstrapFilesToWorkspace: writeBootstrapFilesToWorkspaceMock,
}));

describe("applyPersaiRuntimeSpecLocally", () => {
  beforeEach(() => {
    syncTelegramBotForAssistantMock.mockReset().mockResolvedValue(undefined);
    validatePersaiRuntimeProviderProfileForApplyMock.mockReset().mockResolvedValue(undefined);
    validateToolPolicyForApplyMock.mockReset().mockResolvedValue(undefined);
    writeBootstrapFilesToWorkspaceMock.mockReset().mockResolvedValue({
      workspaceDir: "/tmp/persai/assistant-1",
      written: ["workspace.json"],
      skipped: [],
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test("replaces stale runtime specs for the same assistant", async () => {
    const store = new InMemoryPersaiRuntimeSpecStore();
    await store.put({
      assistantId: "assistant-1",
      publishedVersionId: "version-1",
      contentHash: "hash-1",
      reapply: false,
      bootstrap: { channels: { telegram: { enabled: true, botToken: "token-1" } } },
      workspace: { persona: { instructions: "Old persona" } },
      appliedAt: "2026-03-29T10:00:00.000Z",
    });

    await applyPersaiRuntimeSpecLocally({
      payload: {
        assistantId: "assistant-1",
        publishedVersionId: "version-2",
        contentHash: "hash-2",
        reapply: false,
        spec: {
          bootstrap: { channels: { telegram: { enabled: true, botToken: "token-1" } } },
          workspace: { persona: { instructions: "New persona" } },
        },
      },
      store,
    });

    await expect(store.get("assistant-1", "version-1")).resolves.toBeNull();
    await expect(store.get("assistant-1", "version-2")).resolves.toMatchObject({
      assistantId: "assistant-1",
      publishedVersionId: "version-2",
      contentHash: "hash-2",
      workspace: { persona: { instructions: "New persona" } },
    });
    expect(syncTelegramBotForAssistantMock).toHaveBeenCalledTimes(1);
  });
});
