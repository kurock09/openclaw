import { createClient } from "redis";

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
  workspaceDir?: string;
};

export interface PersaiRuntimeSpecStore {
  put(record: PersaiAppliedRuntimeSpec): Promise<void>;
  get(assistantId: string, publishedVersionId: string): Promise<PersaiAppliedRuntimeSpec | null>;
  remove(assistantId: string): Promise<void>;
  getAll(): Promise<PersaiAppliedRuntimeSpec[]>;
}

function storeKey(assistantId: string, publishedVersionId: string): string {
  return `${assistantId}\u001f${publishedVersionId}`;
}

function redisStoreKey(prefix: string, assistantId: string, publishedVersionId: string): string {
  return `${prefix}:${storeKey(assistantId, publishedVersionId)}`;
}

function parseNonNegativeIntegerEnv(value: string | undefined, envName: string): number {
  const normalized = (value ?? "").trim();
  if (normalized === "") {
    return 0;
  }
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`${envName} must be a non-negative integer when set.`);
  }
  return Number.parseInt(normalized, 10);
}

type PersaiRuntimeRedisClient = {
  isOpen: boolean;
  connect(): Promise<unknown>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  expire(key: string, ttl: number): Promise<unknown>;
  del(key: string | string[]): Promise<unknown>;
  keys(pattern: string): Promise<string[]>;
};

/** Process-local store. Safe only for a single gateway replica (dev / smoke). */
export class InMemoryPersaiRuntimeSpecStore implements PersaiRuntimeSpecStore {
  private readonly map = new Map<string, PersaiAppliedRuntimeSpec>();

  async put(record: PersaiAppliedRuntimeSpec): Promise<void> {
    this.map.set(storeKey(record.assistantId, record.publishedVersionId), record);
  }

  async get(assistantId: string, publishedVersionId: string): Promise<PersaiAppliedRuntimeSpec | null> {
    return this.map.get(storeKey(assistantId, publishedVersionId)) ?? null;
  }

  async remove(assistantId: string): Promise<void> {
    const prefix = `${assistantId}\u001f`;
    for (const key of this.map.keys()) {
      if (key.startsWith(prefix)) {
        this.map.delete(key);
      }
    }
  }

  async getAll(): Promise<PersaiAppliedRuntimeSpec[]> {
    return [...this.map.values()];
  }
}

export class RedisPersaiRuntimeSpecStore implements PersaiRuntimeSpecStore {
  private connectPromise: Promise<void> | null = null;

  constructor(
    private readonly client: PersaiRuntimeRedisClient,
    private readonly options: {
      keyPrefix: string;
      ttlSeconds: number;
    },
  ) {}

  private async ensureConnected(): Promise<void> {
    if (this.client.isOpen) {
      return;
    }
    if (!this.connectPromise) {
      this.connectPromise = Promise.resolve(this.client.connect())
        .then(() => undefined)
        .catch((error) => {
          this.connectPromise = null;
          throw error;
        });
    }
    await this.connectPromise;
  }

  async put(record: PersaiAppliedRuntimeSpec): Promise<void> {
    await this.ensureConnected();
    const key = redisStoreKey(this.options.keyPrefix, record.assistantId, record.publishedVersionId);
    await this.client.set(key, JSON.stringify(record));
    if (this.options.ttlSeconds > 0) {
      await this.client.expire(key, this.options.ttlSeconds);
    }
  }

  async get(assistantId: string, publishedVersionId: string): Promise<PersaiAppliedRuntimeSpec | null> {
    await this.ensureConnected();
    const key = redisStoreKey(this.options.keyPrefix, assistantId, publishedVersionId);
    const payload = await this.client.get(key);
    if (payload === null) {
      return null;
    }
    const parsed = JSON.parse(payload) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error(`Invalid PersAI runtime spec payload stored at Redis key "${key}".`);
    }
    return parsed as PersaiAppliedRuntimeSpec;
  }

  async remove(assistantId: string): Promise<void> {
    await this.ensureConnected();
    const pattern = `${this.options.keyPrefix}:${assistantId}\u001f*`;
    const keys = await this.client.keys(pattern);
    if (keys.length > 0) {
      await this.client.del(keys);
    }
  }

  async getAll(): Promise<PersaiAppliedRuntimeSpec[]> {
    await this.ensureConnected();
    const pattern = `${this.options.keyPrefix}:*`;
    const keys = await this.client.keys(pattern);
    const results: PersaiAppliedRuntimeSpec[] = [];
    for (const key of keys) {
      const payload = await this.client.get(key);
      if (payload) {
        try {
          results.push(JSON.parse(payload) as PersaiAppliedRuntimeSpec);
        } catch {
          // Skip malformed entries
        }
      }
    }
    return results;
  }
}

/**
 * Factory from env.
 * - `PERSAI_RUNTIME_SPEC_STORE=memory` (default): process-local, single-replica only.
 * - `PERSAI_RUNTIME_SPEC_STORE=redis`: shared backend for multi-replica/runtime-restart safety.
 */
export function createPersaiRuntimeSpecStoreFromEnv(params?: {
  createRedisClient?: (url: string) => PersaiRuntimeRedisClient;
}): PersaiRuntimeSpecStore {
  const raw = (process.env.PERSAI_RUNTIME_SPEC_STORE ?? "memory").trim().toLowerCase();
  if (raw === "" || raw === "memory") {
    return new InMemoryPersaiRuntimeSpecStore();
  }
  if (raw === "redis") {
    const url = (process.env.PERSAI_RUNTIME_SPEC_STORE_REDIS_URL ?? "").trim();
    if (!url) {
      throw new Error(
        "PERSAI_RUNTIME_SPEC_STORE=redis requires PERSAI_RUNTIME_SPEC_STORE_REDIS_URL.",
      );
    }
    const keyPrefix =
      (process.env.PERSAI_RUNTIME_SPEC_STORE_KEY_PREFIX ?? "persai:runtime-spec").trim() ||
      "persai:runtime-spec";
    const ttlSeconds = parseNonNegativeIntegerEnv(
      process.env.PERSAI_RUNTIME_SPEC_STORE_TTL_SECONDS,
      "PERSAI_RUNTIME_SPEC_STORE_TTL_SECONDS",
    );
    const createRedisClient = params?.createRedisClient ?? ((redisUrl: string) => createClient({ url: redisUrl }));
    return new RedisPersaiRuntimeSpecStore(createRedisClient(url), {
      keyPrefix,
      ttlSeconds,
    });
  }
  throw new Error(`Unknown PERSAI_RUNTIME_SPEC_STORE="${raw}" (expected memory or redis).`);
}
