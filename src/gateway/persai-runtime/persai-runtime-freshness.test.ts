import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  InMemoryPersaiRuntimeSpecStore,
  type PersaiAppliedRuntimeSpec,
} from "./persai-runtime-spec-store.js";

const { applyPersaiRuntimeSpecLocallyMock } = vi.hoisted(() => ({
  applyPersaiRuntimeSpecLocallyMock: vi.fn(),
}));

vi.mock("./persai-runtime-local-apply.js", () => ({
  applyPersaiRuntimeSpecLocally: applyPersaiRuntimeSpecLocallyMock,
  parseFreshSpecResponse: (body: unknown) => body,
}));

import { ensureSpecFreshness, resetFreshnessCache } from "./persai-runtime-freshness.js";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

function sampleApplied(bootstrapGeneration = 1): PersaiAppliedRuntimeSpec {
  return {
    assistantId: "assistant-1",
    publishedVersionId: "version-1",
    contentHash: "hash-1",
    reapply: false,
    bootstrap: {
      governance: {
        configGeneration: bootstrapGeneration,
      },
    },
    workspace: {
      persona: {
        instructions: "Be helpful.",
      },
    },
    appliedAt: "2026-03-29T00:00:00.000Z",
  };
}

beforeEach(() => {
  process.env = {
    ...ORIGINAL_ENV,
    PERSAI_API_BASE_URL: "https://persai.internal",
    PERSAI_INTERNAL_API_TOKEN: "test-token",
    PERSAI_CONFIG_GENERATION_CACHE_TTL_MS: "1",
  };
  applyPersaiRuntimeSpecLocallyMock.mockReset();
  resetFreshnessCache();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
  vi.clearAllMocks();
  resetFreshnessCache();
});

describe("ensureSpecFreshness", () => {
  test("does not locally apply when PersAI answers 204 fresh", async () => {
    const store = new InMemoryPersaiRuntimeSpecStore();
    const applied = sampleApplied(1);
    await store.put(applied);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ generation: 2 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 204,
        json: async () => ({}),
      });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      ensureSpecFreshness({
        assistantId: applied.assistantId,
        applied,
        store,
      }),
    ).resolves.toEqual({
      fresh: true,
      rematerialized: false,
    });

    expect(applyPersaiRuntimeSpecLocallyMock).not.toHaveBeenCalled();
  });

  test("applies fresh spec payload locally for assistant-scoped refresh", async () => {
    const store = new InMemoryPersaiRuntimeSpecStore();
    const applied = sampleApplied(1);
    await store.put(applied);

    const refreshedPayload = {
      generation: 3,
      assistantId: "assistant-1",
      publishedVersionId: "version-1",
      contentHash: "hash-2",
      spec: {
        bootstrap: {
          governance: {
            configGeneration: 3,
          },
        },
        workspace: {
          persona: {
            instructions: "Updated instructions.",
          },
        },
      },
    };

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ generation: 3 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => refreshedPayload,
      });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      ensureSpecFreshness({
        assistantId: applied.assistantId,
        applied,
        store,
      }),
    ).resolves.toEqual({
      fresh: true,
      rematerialized: true,
    });

    expect(applyPersaiRuntimeSpecLocallyMock).toHaveBeenCalledTimes(1);
    expect(applyPersaiRuntimeSpecLocallyMock).toHaveBeenCalledWith({
      payload: {
        assistantId: "assistant-1",
        publishedVersionId: "version-1",
        contentHash: "hash-2",
        reapply: false,
        spec: refreshedPayload.spec,
      },
      store,
    });
  });
});
