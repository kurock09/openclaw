import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPersaiWebRuntimePreviewTurn } from "./persai-runtime-preview.js";

describe("runPersaiWebRuntimePreviewTurn", () => {
  let previewRootBefore: Set<string>;

  beforeEach(async () => {
    previewRootBefore = new Set(
      (await fs.readdir(os.tmpdir())).filter((name) =>
        name.startsWith("openclaw-persai-setup-preview-"),
      ),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs in an ephemeral workspace and cleans it afterward", async () => {
    let observedWorkspaceDir: string | null = null;
    let cleanedSessionKey: string | null = null;

    const result = await runPersaiWebRuntimePreviewTurn(
      {
        assistantId: "assistant-1",
        userMessage: "Introduce yourself",
        currentTimeIso: "2026-04-03T12:00:00.000Z",
        userTimezone: "UTC",
        spec: {
          bootstrap: {
            governance: {
              runtimeProviderProfile: {
                schema: "persai.runtimeProviderProfile.v1",
                mode: "legacy_openclaw_default",
              },
              toolQuotaPolicy: [],
            },
          },
          workspace: {
            persona: {
              instructions: "Be warm.",
              assistantGender: "female",
            },
            bootstrapDocuments: {
              soulDocument: "# SOUL\n",
              identityDocument: "# IDENTITY\n",
            },
          },
        },
      },
      {
        runAgentTurn: vi.fn(async (input) => {
          observedWorkspaceDir = input.workspaceDir ?? null;
          const files = await fs.readdir(input.workspaceDir!);
          expect(files.sort()).toEqual(["IDENTITY.md", "SOUL.md"]);
          return {
            ok: true,
            assistantMessage: "Hello from preview.",
            media: [],
          };
        }),
        cleanupSessionKey: vi.fn(async (sessionKey) => {
          cleanedSessionKey = sessionKey;
          return { removedCount: 1 };
        }),
        resolveCredentials: vi.fn(async () => new Map()),
      },
    );

    expect(result).toEqual({
      ok: true,
      assistantMessage: "Hello from preview.",
      media: [],
    });
    expect(observedWorkspaceDir).toBeTruthy();
    expect(cleanedSessionKey).toMatch(/^agent:persai:assistant-1:setup-preview:/);
    await expect(fs.access(observedWorkspaceDir!)).rejects.toMatchObject({
      code: "ENOENT",
    });

    const previewRootAfter = new Set(
      (await fs.readdir(os.tmpdir())).filter((name) =>
        name.startsWith("openclaw-persai-setup-preview-"),
      ),
    );
    expect(previewRootAfter).toEqual(previewRootBefore);
  });

  it("returns validation failure for invalid preview bootstrap", async () => {
    const result = await runPersaiWebRuntimePreviewTurn(
      {
        assistantId: "assistant-1",
        userMessage: "Introduce yourself",
        spec: {
          bootstrap: { governance: { runtimeProviderProfile: { mode: "admin_managed" } } },
          workspace: { bootstrapDocuments: {} },
        },
      },
      {
        runAgentTurn: vi.fn(),
        cleanupSessionKey: vi.fn(async () => ({ removedCount: 0 })),
        resolveCredentials: vi.fn(async () => new Map()),
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.status).toBe(400);
    }
  });
});
