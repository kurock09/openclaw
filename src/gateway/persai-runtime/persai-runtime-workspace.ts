import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
const MEMORY_FILE_NAME = "MEMORY.md";
const LEGACY_MEMORY_FILE_NAME = "memory.md";
const MEMORY_DIR_NAME = "memory";
const BOOTSTRAP_FILE_NAME = "BOOTSTRAP.md";
const BOOTSTRAP_CONSUMED_MARKER = ".persai-bootstrap-consumed";
const EMPTY_MEMORY_FILE_CONTENT = "# MEMORY.md\n";

export function resolvePersaiWorkspaceRoot(env: NodeJS.ProcessEnv = process.env): string {
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

export function extractBootstrapDocuments(workspace: unknown): Record<string, string> | null {
  if (!isRecord(workspace)) {
    return null;
  }
  const docs = workspace.bootstrapDocuments;
  if (!isRecord(docs)) {
    return null;
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(docs)) {
    if (typeof value === "string" && value.trim()) {
      result[key] = value;
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

async function clearDirectoryContents(dir: string): Promise<boolean> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    const code =
      err instanceof Error && "code" in err ? (err as NodeJS.ErrnoException).code : undefined;
    if (code === "ENOENT") {
      return false;
    }
    throw err;
  }

  let deleted = false;
  for (const entry of entries) {
    await fs.rm(path.join(dir, entry), { recursive: true, force: true });
    deleted = true;
  }
  return deleted;
}

export async function cleanupPersaiAssistantWorkspace(
  assistantId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ workspaceDir: string; deleted: boolean }> {
  const dir = resolvePersaiAssistantWorkspaceDir(assistantId, env);

  try {
    await fs.mkdir(dir, { recursive: true });
    const deleted = await clearDirectoryContents(dir);
    log.debug("assistant workspace directory cleaned (root preserved)", {
      assistantId,
      dir,
      deleted,
    });
    return { workspaceDir: dir, deleted };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.debug("workspace cleanup skipped (may not exist)", { assistantId, dir, error: message });
    return { workspaceDir: dir, deleted: false };
  }
}

export async function consumePersaiAssistantBootstrapFile(
  assistantId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{
  workspaceDir: string;
  bootstrapPath: string;
  markerPath: string;
  deleted: boolean;
}> {
  const workspaceDir = resolvePersaiAssistantWorkspaceDir(assistantId, env);
  const bootstrapPath = path.join(workspaceDir, BOOTSTRAP_FILE_NAME);
  const markerPath = path.join(workspaceDir, BOOTSTRAP_CONSUMED_MARKER);

  try {
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.rm(bootstrapPath, { force: true });
    await fs.writeFile(markerPath, "consumed\n", "utf-8");
    log.debug("assistant bootstrap file consumed", { assistantId, workspaceDir, bootstrapPath });
    return { workspaceDir, bootstrapPath, markerPath, deleted: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.debug("assistant bootstrap consume skipped", {
      assistantId,
      workspaceDir,
      bootstrapPath,
      markerPath,
      error: message,
    });
    return { workspaceDir, bootstrapPath, markerPath, deleted: false };
  }
}

export async function resetPersaiAssistantMemoryWorkspace(
  assistantId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{
  workspaceDir: string;
  memoryFilePath: string;
  memoryDirPath: string;
}> {
  const workspaceDir = resolvePersaiAssistantWorkspaceDir(assistantId, env);
  const memoryFilePath = path.join(workspaceDir, MEMORY_FILE_NAME);
  const legacyMemoryFilePath = path.join(workspaceDir, LEGACY_MEMORY_FILE_NAME);
  const memoryDirPath = path.join(workspaceDir, MEMORY_DIR_NAME);

  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.rm(memoryDirPath, { recursive: true, force: true });
  await fs.rm(legacyMemoryFilePath, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(memoryDirPath, { recursive: true });
  await fs.writeFile(memoryFilePath, EMPTY_MEMORY_FILE_CONTENT, "utf-8");

  log.debug("assistant memory workspace reset", {
    assistantId,
    workspaceDir,
    memoryFilePath,
    memoryDirPath,
  });

  return { workspaceDir, memoryFilePath, memoryDirPath };
}

export async function writeBootstrapFilesToWorkspace(params: {
  assistantId: string;
  workspace: unknown;
  reapply: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<{ workspaceDir: string; written: string[]; skipped: string[] }> {
  const { assistantId, workspace, reapply, env } = params;
  const dir = resolvePersaiAssistantWorkspaceDir(assistantId, env);
  const docs = extractBootstrapDocuments(workspace);
  const written: string[] = [];
  const skipped: string[] = [];

  if (!docs) {
    log.debug("no bootstrapDocuments in workspace spec", { assistantId });
    return { workspaceDir: dir, written, skipped };
  }

  await fs.mkdir(dir, { recursive: true });
  const bootstrapConsumedMarkerPath = path.join(dir, BOOTSTRAP_CONSUMED_MARKER);
  const bootstrapAlreadyConsumed = await fs
    .access(bootstrapConsumedMarkerPath)
    .then(() => true)
    .catch(() => false);

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

    if (filename === BOOTSTRAP_FILE_NAME && bootstrapAlreadyConsumed) {
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
