import path from "node:path";
import { loadConfig } from "../../config/config.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import {
  archiveRemovedSessionTranscripts,
  loadSessionStore,
  normalizeStoreSessionKey,
  updateSessionStore,
} from "../../config/sessions/store.js";

const PERSAI_RUNTIME_AGENT_ID = "persai";

export async function cleanupPersaiAssistantSessions(assistantId: string): Promise<{
  storePath: string;
  removedCount: number;
}> {
  const cfg = loadConfig();
  const storePath = resolveStorePath(cfg.session?.store, { agentId: PERSAI_RUNTIME_AGENT_ID });
  const normalizedPrefix = normalizeStoreSessionKey(`agent:${PERSAI_RUNTIME_AGENT_ID}:${assistantId}:`);
  const removedSessionFiles = new Map<string, string | undefined>();

  const removedCount = await updateSessionStore(storePath, async (store) => {
    let removed = 0;
    for (const [key, entry] of Object.entries(store)) {
      if (!normalizeStoreSessionKey(key).startsWith(normalizedPrefix)) {
        continue;
      }
      if (entry?.sessionId) {
        removedSessionFiles.set(entry.sessionId, entry.sessionFile);
      }
      delete store[key];
      removed += 1;
    }
    return removed;
  });

  if (removedSessionFiles.size > 0) {
    const remainingStore = loadSessionStore(storePath);
    const referencedSessionIds = new Set(
      Object.values(remainingStore)
        .map((entry) => entry?.sessionId)
        .filter((sessionId): sessionId is string => typeof sessionId === "string" && sessionId.length > 0),
    );
    archiveRemovedSessionTranscripts({
      removedSessionFiles,
      referencedSessionIds,
      storePath,
      reason: "reset",
      restrictToStoreDir: true,
    });
  }

  return {
    storePath: path.resolve(storePath),
    removedCount,
  };
}
