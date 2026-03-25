/**
 * PersAI → OpenClaw HTTP runtime: persisted materialized spec from POST /api/v1/runtime/spec/apply.
 * @see ADR-048 (PersAI repo): multi-replica requires shared backend; memory is single-replica only.
 */

export type PersaiAppliedRuntimeSpec = {
  assistantId: string;
  publishedVersionId: string;
  contentHash: string;
  reapply: boolean;
  bootstrap: unknown;
  workspace: unknown;
  appliedAt: string;
};

export interface PersaiRuntimeSpecStore {
  put(record: PersaiAppliedRuntimeSpec): Promise<void>;
  get(assistantId: string, publishedVersionId: string): Promise<PersaiAppliedRuntimeSpec | null>;
}

function storeKey(assistantId: string, publishedVersionId: string): string {
  return `${assistantId}\u001f${publishedVersionId}`;
}

/** Process-local store. Safe only for a single gateway replica (dev / smoke). */
export class InMemoryPersaiRuntimeSpecStore implements PersaiRuntimeSpecStore {
  private readonly map = new Map<string, PersaiAppliedRuntimeSpec>();

  async put(record: PersaiAppliedRuntimeSpec): Promise<void> {
    this.map.set(storeKey(record.assistantId, record.publishedVersionId), record);
  }

  async get(assistantId: string, publishedVersionId: string): Promise<PersaiAppliedRuntimeSpec | null> {
    return this.map.get(storeKey(assistantId, publishedVersionId)) ?? null;
  }
}

/**
 * Factory from env. `PERSAI_RUNTIME_SPEC_STORE=memory` (default) or `redis` (explicit error until implemented).
 */
export function createPersaiRuntimeSpecStoreFromEnv(): PersaiRuntimeSpecStore {
  const raw = (process.env.PERSAI_RUNTIME_SPEC_STORE ?? "memory").trim().toLowerCase();
  if (raw === "" || raw === "memory") {
    return new InMemoryPersaiRuntimeSpecStore();
  }
  if (raw === "redis") {
    throw new Error(
      "PERSAI_RUNTIME_SPEC_STORE=redis is not implemented yet. Use memory for single-replica, or add a Redis-backed PersaiRuntimeSpecStore (ADR-048).",
    );
  }
  throw new Error(`Unknown PERSAI_RUNTIME_SPEC_STORE="${raw}" (expected memory or redis).`);
}
