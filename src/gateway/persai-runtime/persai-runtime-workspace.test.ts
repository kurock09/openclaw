import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  consumePersaiAssistantBootstrapFile,
  resolvePersaiAssistantWorkspaceDir,
  writeBootstrapFilesToWorkspace,
} from "./persai-runtime-workspace.js";

async function makeTempEnv(): Promise<NodeJS.ProcessEnv> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-persai-workspace-"));
  return {
    ...process.env,
    PERSAI_WORKSPACE_ROOT: root,
  };
}

async function cleanupTempEnv(env: NodeJS.ProcessEnv): Promise<void> {
  const root = env.PERSAI_WORKSPACE_ROOT;
  if (typeof root === "string" && root.trim()) {
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe("persai runtime workspace bootstrap hygiene", () => {
  let env: NodeJS.ProcessEnv | null = null;
  const originalWorkspaceRoot = process.env.PERSAI_WORKSPACE_ROOT;

  afterEach(async () => {
    process.env.PERSAI_WORKSPACE_ROOT = originalWorkspaceRoot;
    if (env) {
      await cleanupTempEnv(env);
      env = null;
    }
  });

  it("does not recreate BOOTSTRAP.md after it was consumed", async () => {
    env = await makeTempEnv();
    const assistantId = "assistant-1";
    const workspaceDir = resolvePersaiAssistantWorkspaceDir(assistantId, env);
    process.env.PERSAI_WORKSPACE_ROOT = env.PERSAI_WORKSPACE_ROOT;

    await writeBootstrapFilesToWorkspace({
      assistantId,
      workspace: {
        bootstrapDocuments: {
          bootstrapDocument: "# BOOTSTRAP\n",
          soulDocument: "# SOUL\n",
        },
      },
      reapply: false,
    });

    await expect(fs.access(path.join(workspaceDir, "BOOTSTRAP.md"))).resolves.toBeUndefined();

    await consumePersaiAssistantBootstrapFile(assistantId, env);

    await expect(fs.access(path.join(workspaceDir, "BOOTSTRAP.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    await writeBootstrapFilesToWorkspace({
      assistantId,
      workspace: {
        bootstrapDocuments: {
          bootstrapDocument: "# BOOTSTRAP AGAIN\n",
          soulDocument: "# SOUL AGAIN\n",
        },
      },
      reapply: false,
    });

    await expect(fs.access(path.join(workspaceDir, "BOOTSTRAP.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
