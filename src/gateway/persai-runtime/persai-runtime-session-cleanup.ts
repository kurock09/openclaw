import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../../config/config.js";
import { resolveSessionFilePath, resolveStorePath } from "../../config/sessions/paths.js";
import {
  loadSessionStore,
  normalizeStoreSessionKey,
  updateSessionStore,
} from "../../config/sessions/store.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { derivePersaiWebRuntimeSessionKey } from "./persai-runtime-session.js";

const PERSAI_RUNTIME_AGENT_ID = "persai";
const DEFAULT_RUNTIME_AGENT_ID = "main";

function collectReferencedSessionIds(storePath: string): Set<string> {
  return new Set(
    Object.values(loadSessionStore(storePath))
      .map((entry) => entry?.sessionId)
      .filter(
        (sessionId): sessionId is string => typeof sessionId === "string" && sessionId.length > 0,
      ),
  );
}

async function deleteTranscriptFile(storePath: string, entry: SessionEntry): Promise<boolean> {
  const transcriptPath = resolveSessionFilePath(entry.sessionId, entry, {
    sessionsDir: path.dirname(storePath),
  });
  try {
    await fs.rm(transcriptPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

async function deleteRemovedSessionTranscripts(params: {
  storePath: string;
  removedSessionFiles: ReadonlyMap<string, SessionEntry>;
  referencedSessionIds: ReadonlySet<string>;
}): Promise<number> {
  let deletedCount = 0;
  for (const [sessionId, entry] of params.removedSessionFiles) {
    if (params.referencedSessionIds.has(sessionId)) {
      continue;
    }
    if (await deleteTranscriptFile(params.storePath, entry)) {
      deletedCount += 1;
    }
  }
  return deletedCount;
}

async function purgeArchivedAssistantSessionFiles(
  assistantId: string,
  storePath: string,
): Promise<number> {
  const sessionsDir = path.dirname(storePath);
  let entries: Array<{ name: string; isFile(): boolean }>;
  try {
    entries = (await fs.readdir(sessionsDir, { withFileTypes: true })) as Array<{
      name: string;
      isFile(): boolean;
    }>;
  } catch {
    return 0;
  }

  let removedCount = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.includes(".jsonl.reset.")) {
      continue;
    }
    const archivedPath = path.join(sessionsDir, entry.name);
    try {
      const content = await fs.readFile(archivedPath, "utf-8");
      if (!content.includes(assistantId)) {
        continue;
      }
      await fs.rm(archivedPath, { force: true });
      removedCount += 1;
    } catch {
      // Best-effort: stale or unreadable files should not block resets.
    }
  }

  return removedCount;
}

async function removeMatchingSessionsFromStore(params: {
  storePath: string;
  matches: (normalizedKey: string) => boolean;
}): Promise<number> {
  const removedSessionFiles = new Map<string, SessionEntry>();
  const removedCount = await updateSessionStore(params.storePath, async (store) => {
    let removed = 0;
    for (const [key, entry] of Object.entries(store)) {
      if (!entry || !params.matches(normalizeStoreSessionKey(key))) {
        continue;
      }
      removedSessionFiles.set(entry.sessionId, entry);
      delete store[key];
      removed += 1;
    }
    return removed;
  });

  if (removedSessionFiles.size > 0) {
    await deleteRemovedSessionTranscripts({
      storePath: params.storePath,
      removedSessionFiles,
      referencedSessionIds: collectReferencedSessionIds(params.storePath),
    });
  }

  return removedCount;
}

function resolveAssistantStorePaths(): string[] {
  const cfg = loadConfig();
  return Array.from(
    new Set(
      [PERSAI_RUNTIME_AGENT_ID, DEFAULT_RUNTIME_AGENT_ID].map((agentId) =>
        path.resolve(resolveStorePath(cfg.session?.store, { agentId })),
      ),
    ),
  );
}

export async function cleanupPersaiAssistantSessions(assistantId: string): Promise<{
  storePath: string;
  removedCount: number;
}> {
  const normalizedCurrentPrefix = normalizeStoreSessionKey(
    `agent:${PERSAI_RUNTIME_AGENT_ID}:${assistantId}:`,
  );
  let removedCount = 0;
  const storePaths = resolveAssistantStorePaths();

  for (const storePath of storePaths) {
    removedCount += await removeMatchingSessionsFromStore({
      storePath,
      matches: (normalizedKey) =>
        normalizedKey.startsWith(normalizedCurrentPrefix) ||
        normalizedKey.includes(`:${assistantId}:`),
    });
    await purgeArchivedAssistantSessionFiles(assistantId, storePath);
  }

  return {
    storePath: path.resolve(
      resolveStorePath(loadConfig().session?.store, { agentId: PERSAI_RUNTIME_AGENT_ID }),
    ),
    removedCount,
  };
}

export async function cleanupPersaiWebChatSession(params: {
  assistantId: string;
  chatId: string;
  surfaceThreadKey: string;
}): Promise<{ removedCount: number }> {
  const { assistantId, chatId, surfaceThreadKey } = params;
  const normalizedCurrentKey = normalizeStoreSessionKey(
    derivePersaiWebRuntimeSessionKey({
      assistantId,
      chatId,
      surfaceThreadKey,
    }),
  );
  const legacySuffix = `:${chatId}:${surfaceThreadKey}`;
  let removedCount = 0;

  for (const storePath of resolveAssistantStorePaths()) {
    removedCount += await removeMatchingSessionsFromStore({
      storePath,
      matches: (normalizedKey) =>
        normalizedKey === normalizedCurrentKey ||
        (normalizedKey.includes(`${assistantId}:`) &&
          normalizedKey.includes(":web:") &&
          normalizedKey.endsWith(legacySuffix)),
    });
  }

  return { removedCount };
}

export async function cleanupPersaiSessionKey(sessionKey: string): Promise<{
  removedCount: number;
}> {
  const normalizedSessionKey = normalizeStoreSessionKey(sessionKey);
  let removedCount = 0;

  for (const storePath of resolveAssistantStorePaths()) {
    removedCount += await removeMatchingSessionsFromStore({
      storePath,
      matches: (normalizedKey) => normalizedKey === normalizedSessionKey,
    });
  }

  return { removedCount };
}
