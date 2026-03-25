import { afterEach, describe, expect, test } from "vitest";
import {
  createPersaiRuntimeSpecStoreFromEnv,
  InMemoryPersaiRuntimeSpecStore,
  RedisPersaiRuntimeSpecStore,
  type PersaiAppliedRuntimeSpec,
} from "./persai-runtime-spec-store.js";

const ORIGINAL_ENV = { ...process.env };

function sampleRecord(): PersaiAppliedRuntimeSpec {
  return {
    assistantId: "assistant-1",
    publishedVersionId: "version-2",
    contentHash: "hash-3",
    reapply: false,
    bootstrap: { schema: "openclaw.bootstrap.v1" },
    workspace: { schema: "openclaw.workspace.v1", persona: { instructions: "Be helpful." } },
    appliedAt: "2026-03-25T00:00:00.000Z",
  };
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("InMemoryPersaiRuntimeSpecStore", () => {
  test("returns previously stored records", async () => {
    const store = new InMemoryPersaiRuntimeSpecStore();
    const record = sampleRecord();

    await store.put(record);

    await expect(store.get(record.assistantId, record.publishedVersionId)).resolves.toEqual(record);
  });
});

describe("RedisPersaiRuntimeSpecStore", () => {
  test("connects lazily and reads/writes records with prefix and ttl", async () => {
    const state = new Map<string, string>();
    const calls = {
      connect: 0,
      expire: [] as Array<{ key: string; ttl: number }>,
    };
    const client = {
      isOpen: false,
      async connect() {
        calls.connect += 1;
        client.isOpen = true;
      },
      async get(key: string) {
        return state.get(key) ?? null;
      },
      async set(key: string, value: string) {
        state.set(key, value);
      },
      async expire(key: string, ttl: number) {
        calls.expire.push({ key, ttl });
        return 1;
      },
    };
    const store = new RedisPersaiRuntimeSpecStore(client, {
      keyPrefix: "persai:test",
      ttlSeconds: 120,
    });
    const record = sampleRecord();

    await store.put(record);
    await expect(store.get(record.assistantId, record.publishedVersionId)).resolves.toEqual(record);

    expect(calls.connect).toBe(1);
    expect(calls.expire).toEqual([
      {
        key: "persai:test:assistant-1\u001fversion-2",
        ttl: 120,
      },
    ]);
  });
});

describe("createPersaiRuntimeSpecStoreFromEnv", () => {
  test("defaults to memory store", () => {
    delete process.env.PERSAI_RUNTIME_SPEC_STORE;

    const store = createPersaiRuntimeSpecStoreFromEnv();

    expect(store).toBeInstanceOf(InMemoryPersaiRuntimeSpecStore);
  });

  test("builds redis store when url is configured", () => {
    process.env.PERSAI_RUNTIME_SPEC_STORE = "redis";
    process.env.PERSAI_RUNTIME_SPEC_STORE_REDIS_URL = "redis://runtime-store:6379/0";
    process.env.PERSAI_RUNTIME_SPEC_STORE_KEY_PREFIX = "persai:prod";
    process.env.PERSAI_RUNTIME_SPEC_STORE_TTL_SECONDS = "600";

    const store = createPersaiRuntimeSpecStoreFromEnv({
      createRedisClient: () => ({
        isOpen: false,
        async connect() {},
        async get() {
          return null;
        },
        async set() {},
        async expire() {
          return 1;
        },
      }),
    });

    expect(store).toBeInstanceOf(RedisPersaiRuntimeSpecStore);
  });

  test("rejects redis mode without url", () => {
    process.env.PERSAI_RUNTIME_SPEC_STORE = "redis";
    delete process.env.PERSAI_RUNTIME_SPEC_STORE_REDIS_URL;

    expect(() => createPersaiRuntimeSpecStoreFromEnv()).toThrow(
      "PERSAI_RUNTIME_SPEC_STORE=redis requires PERSAI_RUNTIME_SPEC_STORE_REDIS_URL.",
    );
  });

  test("rejects invalid ttl", () => {
    process.env.PERSAI_RUNTIME_SPEC_STORE = "redis";
    process.env.PERSAI_RUNTIME_SPEC_STORE_REDIS_URL = "redis://runtime-store:6379/0";
    process.env.PERSAI_RUNTIME_SPEC_STORE_TTL_SECONDS = "-1";

    expect(() => createPersaiRuntimeSpecStoreFromEnv()).toThrow(
      "PERSAI_RUNTIME_SPEC_STORE_TTL_SECONDS must be a non-negative integer when set.",
    );
  });
});
