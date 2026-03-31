import { AsyncLocalStorage } from "node:async_hooks";

export interface PersaiRuntimeRequestCtx {
  assistantId?: string;
  toolDenyList?: string[];
  toolQuotaPolicy?: Map<string, { toolCode: string; dailyCallLimit: number | null }>;
  toolLimitWebhookUrl?: string;
  cronWebhookUrl?: string;
  workspaceDir?: string;
  activeToolName?: string;
  /** Per-request resolved tool credentials (env var name → secret value). */
  toolCredentials?: Map<string, string>;
}

/**
 * Per-request context for PersAI runtime. Allows concurrent requests to carry
 * their own assistant context, toolDenyList, workspaceDir, and toolCredentials without sharing
 * process.env.
 *
 * Extracted to a dependency-free module so that low-level helpers (memory tools,
 * workspace resolution, extension credential resolvers) can read the store
 * without pulling in the full openclaw-tools graph.
 */
export const persaiRuntimeRequestContext = new AsyncLocalStorage<PersaiRuntimeRequestCtx>();

const TOOL_PROVIDER_ENV_FALLBACKS: Record<string, Record<string, string[]>> = {
  image_generate: {
    openai: ["OPENAI_IMAGE_GEN_API_KEY"],
  },
  tts: {
    openai: ["OPENAI_TTS_API_KEY"],
  },
  memory_search: {
    openai: ["OPENAI_EMBEDDINGS_API_KEY"],
  },
};

function normalizeLookupKey(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

/**
 * Read a per-request tool credential by its conventional env var name
 * (e.g. "TAVILY_API_KEY"). Returns `undefined` when called outside a PersAI
 * runtime request or when the credential was not injected.
 */
export function getPersaiToolCredential(envVar: string): string | undefined {
  return persaiRuntimeRequestContext.getStore()?.toolCredentials?.get(envVar);
}

export function getPersaiActiveToolName(): string | undefined {
  return persaiRuntimeRequestContext.getStore()?.activeToolName;
}

export function withPersaiActiveTool<T>(toolName: string, run: () => T): T {
  const store = persaiRuntimeRequestContext.getStore();
  if (!store) {
    return run();
  }
  return persaiRuntimeRequestContext.run(
    {
      ...store,
      activeToolName: toolName,
    },
    run,
  );
}

export function resolvePersaiToolCredentialForEnvVars(params: {
  envVars: readonly string[];
  provider?: string;
  toolName?: string;
}): { value: string; envVar: string } | null {
  const store = persaiRuntimeRequestContext.getStore();
  if (!store?.toolCredentials || params.envVars.length === 0) {
    return null;
  }

  for (const envVar of params.envVars) {
    const value = store.toolCredentials.get(envVar);
    if (typeof value === "string" && value.trim().length > 0) {
      return { value, envVar };
    }
  }

  const toolName = normalizeLookupKey(params.toolName ?? store.activeToolName);
  const provider = normalizeLookupKey(params.provider);
  if (!toolName || !provider) {
    return null;
  }

  const fallbackEnvVars = TOOL_PROVIDER_ENV_FALLBACKS[toolName]?.[provider] ?? [];
  for (const envVar of fallbackEnvVars) {
    const value = store.toolCredentials.get(envVar);
    if (typeof value === "string" && value.trim().length > 0) {
      return { value, envVar };
    }
  }

  return null;
}
