import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("persai-runtime-workspace");

const BOOTSTRAP_FILE_MAP: Record<string, string> = {
  soulDocument: "SOUL.md",
  userDocument: "USER.md",
  identityDocument: "IDENTITY.md",
  toolsDocument: "TOOLS.md",
  agentsDocument: "AGENTS.md",
  heartbeatDocument: "HEARTBEAT.md",
  bootstrapDocument: "BOOTSTRAP.md",
};

const WRITE_ONCE_FILES = new Set(["BOOTSTRAP.md"]);
const NEVER_OVERWRITE_FILES = new Set(["MEMORY.md"]);

export function resolvePersaiWorkspaceRoot(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = env.PERSAI_WORKSPACE_ROOT?.trim();
  if (explicit) {
    return explicit;
  }
  return path.join(os.homedir(), ".openclaw", "workspaces", "persai");
}

export function resolvePersaiAssistantWorkspaceDir(
  assistantId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const root = resolvePersaiWorkspaceRoot(env);
  const sanitized = assistantId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(root, sanitized);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function extractBootstrapDocuments(
  workspace: unknown,
): Record<string, string> | null {
  if (!isRecord(workspace)) return null;
  const docs = workspace.bootstrapDocuments;
  if (!isRecord(docs)) return null;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(docs)) {
    if (typeof value === "string" && value.trim()) {
      result[key] = value;
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

export async function writeBootstrapFilesToWorkspace(params: {
  assistantId: string;
  workspace: unknown;
  reapply: boolean;
}): Promise<{ workspaceDir: string; written: string[]; skipped: string[] }> {
  const { assistantId, workspace, reapply } = params;
  const dir = resolvePersaiAssistantWorkspaceDir(assistantId);
  const docs = extractBootstrapDocuments(workspace);
  const written: string[] = [];
  const skipped: string[] = [];

  if (!docs) {
    log.debug("no bootstrapDocuments in workspace spec", { assistantId });
    return { workspaceDir: dir, written, skipped };
  }

  await fs.mkdir(dir, { recursive: true });

  for (const [docKey, content] of Object.entries(docs)) {
    const filename = BOOTSTRAP_FILE_MAP[docKey];
    if (!filename) {
      log.debug("unknown bootstrap document key, skipping", { docKey, assistantId });
      skipped.push(docKey);
      continue;
    }

    const filePath = path.join(dir, filename);

    if (NEVER_OVERWRITE_FILES.has(filename)) {
      skipped.push(filename);
      continue;
    }

    if (WRITE_ONCE_FILES.has(filename) && !reapply) {
      try {
        await fs.access(filePath);
        skipped.push(filename);
        continue;
      } catch {
        // File doesn't exist — write it
      }
    }

    await fs.writeFile(filePath, content, "utf-8");
    written.push(filename);
  }

  log.debug("bootstrap files written to workspace", {
    assistantId,
    dir,
    written,
    skipped,
  });

  return { workspaceDir: dir, written, skipped };
}
