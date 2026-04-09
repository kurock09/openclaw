/**
 * Two-tier freshness check for H3.1 lazy invalidation.
 *
 * Tier 1: In-memory cached configGeneration (fast, local).
 * Tier 2: PersAI ensure-fresh-spec endpoint (single-assistant refresh, remote).
 */

import {
  applyPersaiRuntimeSpecLocally,
  parseFreshSpecResponse,
  type PersaiRuntimeFreshSpecResponse,
} from "./persai-runtime-local-apply.js";
import type {
  PersaiAppliedRuntimeSpec,
  PersaiRuntimeSpecStore,
} from "./persai-runtime-spec-store.js";

const DEFAULT_GENERATION_CACHE_TTL_MS = 3_600_000; // 1 hour
const DEFAULT_FRESHNESS_TIMEOUT_MS = 5_000;

let cachedGeneration: number | null = null;
let cachedAt = 0;

const rematerializeMutex = new Map<string, Promise<boolean>>();

function getGenerationCacheTtlMs(): number {
  const env = process.env.PERSAI_CONFIG_GENERATION_CACHE_TTL_MS?.trim();
  if (env) {
    const parsed = parseInt(env, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_GENERATION_CACHE_TTL_MS;
}

function getPersaiInternalBaseUrl(): string | null {
  return process.env.PERSAI_API_BASE_URL?.trim() || null;
}

function getGatewayToken(): string | null {
  return process.env.PERSAI_INTERNAL_API_TOKEN?.trim() || null;
}

function extractConfigGenerationFromBootstrap(bootstrap: unknown): number {
  if (typeof bootstrap === "object" && bootstrap !== null && !Array.isArray(bootstrap)) {
    const gov = (bootstrap as Record<string, unknown>).governance;
    if (typeof gov === "object" && gov !== null && !Array.isArray(gov)) {
      const gen = (gov as Record<string, unknown>).configGeneration;
      if (typeof gen === "number" && Number.isFinite(gen)) {
        return gen;
      }
    }
  }
  return 0;
}

async function fetchRemoteConfigGeneration(): Promise<number | null> {
  const baseUrl = getPersaiInternalBaseUrl();
  const token = getGatewayToken();
  if (!baseUrl || !token) {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_FRESHNESS_TIMEOUT_MS);
  try {
    const url = new URL("/api/v1/internal/runtime/config-generation", baseUrl);
    const resp = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!resp.ok) {
      return null;
    }
    const body = (await resp.json()) as { generation?: number };
    if (typeof body.generation === "number") {
      return body.generation;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function requestEnsureFreshSpec(
  assistantId: string,
  currentConfigGeneration: number,
): Promise<
  { status: "fresh" } | { status: "updated"; payload: PersaiRuntimeFreshSpecResponse } | null
> {
  const baseUrl = getPersaiInternalBaseUrl();
  const token = getGatewayToken();
  if (!baseUrl || !token) {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_FRESHNESS_TIMEOUT_MS);
  try {
    const url = new URL("/api/v1/internal/runtime/ensure-fresh-spec", baseUrl);
    const resp = await fetch(url.toString(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ assistantId, currentConfigGeneration }),
      signal: controller.signal,
    });
    if (resp.status === 204) {
      return { status: "fresh" };
    }
    if (!resp.ok) {
      return null;
    }
    const parsed = parseFreshSpecResponse(await resp.json());
    return parsed ? { status: "updated", payload: parsed } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Checks whether the applied spec is still fresh against the global configGeneration.
 * Returns `{ fresh: true, rematerialized: false }` when up-to-date,
 * `{ fresh: true, rematerialized: true }` when stale and OpenClaw locally applied a fresh spec,
 * or `{ fresh: true, rematerialized: false }` on fail-open (PersAI unreachable).
 */
export async function ensureSpecFreshness(params: {
  assistantId: string;
  applied: PersaiAppliedRuntimeSpec;
  store: PersaiRuntimeSpecStore;
}): Promise<{ fresh: boolean; rematerialized: boolean }> {
  const specGeneration = extractConfigGenerationFromBootstrap(params.applied.bootstrap);
  const now = Date.now();
  const ttl = getGenerationCacheTtlMs();

  if (cachedGeneration !== null && now - cachedAt < ttl) {
    if (specGeneration >= cachedGeneration) {
      return { fresh: true, rematerialized: false };
    }
  }

  const remoteGeneration = await fetchRemoteConfigGeneration();
  if (remoteGeneration !== null) {
    cachedGeneration = remoteGeneration;
    cachedAt = Date.now();

    if (specGeneration >= remoteGeneration) {
      return { fresh: true, rematerialized: false };
    }
  } else {
    return { fresh: true, rematerialized: false };
  }

  const existing = rematerializeMutex.get(params.assistantId);
  if (existing) {
    const rematerialized = await existing;
    return { fresh: true, rematerialized };
  }

  const promise = (async () => {
    try {
      const result = await requestEnsureFreshSpec(params.assistantId, specGeneration);
      if (result === null || result.status === "fresh") {
        return false;
      }
      cachedGeneration = result.payload.generation;
      cachedAt = Date.now();
      await applyPersaiRuntimeSpecLocally({
        payload: {
          assistantId: result.payload.assistantId,
          publishedVersionId: result.payload.publishedVersionId,
          contentHash: result.payload.contentHash,
          reapply: false,
          spec: result.payload.spec,
        },
        store: params.store,
      });
      return true;
    } finally {
      rematerializeMutex.delete(params.assistantId);
    }
  })();
  rematerializeMutex.set(params.assistantId, promise);
  const rematerialized = await promise;

  return { fresh: true, rematerialized };
}

/** Reset cache — useful for testing. */
export function resetFreshnessCache(): void {
  cachedGeneration = null;
  cachedAt = 0;
  rematerializeMutex.clear();
}
