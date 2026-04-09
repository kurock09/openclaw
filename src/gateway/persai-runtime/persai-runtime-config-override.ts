import type { OpenClawConfig } from "../../config/config.js";
import {
  type ManagedRuntimeProvider,
  type PersaiAvailableModelsByProvider,
} from "./persai-runtime-provider-profile.js";

export type PersaiRuntimeOptimizationPolicy = {
  heartbeat: {
    every: string;
    target: "none" | "last";
    lightContext: boolean;
    isolatedSession: boolean;
  };
  contextPruning: {
    mode: "off" | "cache-ttl";
    ttl: string;
    keepLastAssistants: number;
    softTrimRatio: number;
    hardClearRatio: number;
    minPrunableToolChars: number;
    softTrim: {
      maxChars: number;
      headChars: number;
      tailChars: number;
    };
    hardClear: {
      enabled: boolean;
      placeholder: string;
    };
  };
  compaction: {
    mode: "default" | "safeguard";
    reserveTokens: number;
    keepRecentTokens: number;
    recentTurnsPreserve: number;
    identifierPolicy: "strict" | "off" | "custom";
    postIndexSync: "off" | "async" | "await";
    truncateAfterCompaction: boolean;
    suggestCompactionByMessageCount: boolean;
  };
  openai: {
    fastMode: boolean;
    serviceTier: "auto" | "default" | "flex" | "priority";
    responsesServerCompaction: boolean;
    openaiWsWarmup: boolean;
  };
};

export type PersaiRuntimeSettingsResponse = {
  mode?: unknown;
  primary?: {
    provider?: unknown;
    model?: unknown;
  } | null;
  availableModelsByProvider?: unknown;
  optimizationPolicy?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && allowed.includes(value as T) ? (value as T) : fallback;
}

function normalizeModelName(value: unknown): string | null {
  return asString(value);
}

export function parsePersaiAvailableModelsByProvider(
  payload: unknown,
): PersaiAvailableModelsByProvider {
  const row = asRecord(payload);
  const parseList = (provider: ManagedRuntimeProvider) => {
    const raw = row?.[provider];
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw
      .map((entry) => normalizeModelName(entry))
      .filter((entry): entry is string => entry !== null);
  };
  return {
    openai: parseList("openai"),
    anthropic: parseList("anthropic"),
  };
}

export function parsePersaiRuntimeOptimizationPolicy(
  payload: unknown,
): PersaiRuntimeOptimizationPolicy | null {
  const row = asRecord(payload);
  if (row === null) {
    return null;
  }
  const heartbeat = asRecord(row.heartbeat);
  const contextPruning = asRecord(row.contextPruning);
  const softTrim = asRecord(contextPruning?.softTrim);
  const hardClear = asRecord(contextPruning?.hardClear);
  const compaction = asRecord(row.compaction);
  const openai = asRecord(row.openai);
  return {
    heartbeat: {
      every: asString(heartbeat?.every) ?? "0m",
      target: asEnum(heartbeat?.target, ["none", "last"], "none"),
      lightContext: asBoolean(heartbeat?.lightContext, true),
      isolatedSession: asBoolean(heartbeat?.isolatedSession, true),
    },
    contextPruning: {
      mode: asEnum(contextPruning?.mode, ["off", "cache-ttl"], "off"),
      ttl: asString(contextPruning?.ttl) ?? "5m",
      keepLastAssistants: asInteger(contextPruning?.keepLastAssistants, 3),
      softTrimRatio: asNumber(contextPruning?.softTrimRatio, 0.3),
      hardClearRatio: asNumber(contextPruning?.hardClearRatio, 0.5),
      minPrunableToolChars: asInteger(contextPruning?.minPrunableToolChars, 12000),
      softTrim: {
        maxChars: asInteger(softTrim?.maxChars, 3000),
        headChars: asInteger(softTrim?.headChars, 1000),
        tailChars: asInteger(softTrim?.tailChars, 1000),
      },
      hardClear: {
        enabled: asBoolean(hardClear?.enabled, true),
        placeholder: asString(hardClear?.placeholder) ?? "[Old tool result content cleared]",
      },
    },
    compaction: {
      mode: asEnum(compaction?.mode, ["default", "safeguard"], "default"),
      reserveTokens: asInteger(compaction?.reserveTokens, 24000),
      keepRecentTokens: asInteger(compaction?.keepRecentTokens, 16000),
      recentTurnsPreserve: asInteger(compaction?.recentTurnsPreserve, 4),
      identifierPolicy: asEnum(compaction?.identifierPolicy, ["strict", "off", "custom"], "strict"),
      postIndexSync: asEnum(compaction?.postIndexSync, ["off", "async", "await"], "async"),
      truncateAfterCompaction: asBoolean(compaction?.truncateAfterCompaction, true),
      suggestCompactionByMessageCount: asBoolean(compaction?.suggestCompactionByMessageCount, false),
    },
    openai: {
      fastMode: asBoolean(openai?.fastMode, false),
      serviceTier: asEnum(openai?.serviceTier, ["auto", "default", "flex", "priority"], "auto"),
      responsesServerCompaction: asBoolean(openai?.responsesServerCompaction, false),
      openaiWsWarmup: asBoolean(openai?.openaiWsWarmup, false),
    },
  };
}

export function extractPersaiRuntimeOptimizationPolicy(
  bootstrap: unknown,
): PersaiRuntimeOptimizationPolicy | null {
  const bootstrapRow = asRecord(bootstrap);
  const governance = asRecord(bootstrapRow?.governance);
  return parsePersaiRuntimeOptimizationPolicy(governance?.optimizationPolicy);
}

export function parsePersaiRuntimeSettingsResponse(payload: unknown): {
  mode: "legacy_openclaw_default" | "global_settings";
  primary: { provider: ManagedRuntimeProvider; model: string } | null;
  availableModelsByProvider: PersaiAvailableModelsByProvider;
  optimizationPolicy: PersaiRuntimeOptimizationPolicy | null;
} | null {
  const row = asRecord(payload) as PersaiRuntimeSettingsResponse | null;
  if (row === null) {
    return null;
  }
  const mode =
    row.mode === "legacy_openclaw_default" || row.mode === "global_settings" ? row.mode : null;
  if (mode === null) {
    return null;
  }
  const provider =
    row.primary?.provider === "openai" || row.primary?.provider === "anthropic"
      ? row.primary.provider
      : null;
  const model = asString(row.primary?.model);
  return {
    mode,
    primary: provider && model ? { provider, model } : null,
    availableModelsByProvider: parsePersaiAvailableModelsByProvider(row.availableModelsByProvider),
    optimizationPolicy: parsePersaiRuntimeOptimizationPolicy(row.optimizationPolicy),
  };
}

function collectAllowedModelKeys(params: {
  availableModelsByProvider: PersaiAvailableModelsByProvider;
}): Set<string> {
  const keys = new Set<string>();
  const addModels = (provider: ManagedRuntimeProvider, models: string[]) => {
    for (const model of models) {
      const trimmed = model.trim();
      if (trimmed) {
        keys.add(`${provider}/${trimmed}`);
      }
    }
  };
  addModels("openai", params.availableModelsByProvider.openai);
  addModels("anthropic", params.availableModelsByProvider.anthropic);
  return keys;
}

export function applyPersaiRuntimeOverridesToConfig(
  baseConfig: OpenClawConfig,
  params: {
    availableModelsByProvider?: PersaiAvailableModelsByProvider | null;
    optimizationPolicy?: PersaiRuntimeOptimizationPolicy | null;
  },
): OpenClawConfig {
  const next = structuredClone(baseConfig);
  next.agents ??= {};
  next.agents.defaults ??= {};
  if (params.optimizationPolicy) {
    next.agents.defaults.heartbeat = {
      ...next.agents.defaults.heartbeat,
      ...params.optimizationPolicy.heartbeat,
    };
    next.agents.defaults.contextPruning = {
      ...next.agents.defaults.contextPruning,
      ...params.optimizationPolicy.contextPruning,
      softTrim: {
        ...next.agents.defaults.contextPruning?.softTrim,
        ...params.optimizationPolicy.contextPruning.softTrim,
      },
      hardClear: {
        ...next.agents.defaults.contextPruning?.hardClear,
        ...params.optimizationPolicy.contextPruning.hardClear,
      },
    };
    next.agents.defaults.compaction = {
      ...next.agents.defaults.compaction,
      ...params.optimizationPolicy.compaction,
    };
  }

  const mergedAvailableModels = collectAllowedModelKeys({
    availableModelsByProvider: params.availableModelsByProvider ?? { openai: [], anthropic: [] },
  });

  const nextModels = { ...next.agents.defaults.models };
  for (const key of mergedAvailableModels) {
    const currentEntry =
      nextModels[key] && typeof nextModels[key] === "object" ? nextModels[key] : {};
    nextModels[key] = { ...currentEntry };
  }
  if (params.optimizationPolicy) {
    const openaiModels =
      params.availableModelsByProvider?.openai && params.availableModelsByProvider.openai.length > 0
        ? params.availableModelsByProvider.openai
        : Object.keys(nextModels)
            .filter((key) => key.startsWith("openai/"))
            .map((key) => key.slice("openai/".length))
            .filter((model) => model.trim().length > 0);
    for (const model of openaiModels) {
      const key = `openai/${model}`;
      const currentEntry =
        nextModels[key] && typeof nextModels[key] === "object" ? nextModels[key] : {};
      const currentParams =
        currentEntry.params && typeof currentEntry.params === "object" ? currentEntry.params : {};
      nextModels[key] = {
        ...currentEntry,
        params: {
          ...currentParams,
          fastMode: params.optimizationPolicy.openai.fastMode,
          serviceTier: params.optimizationPolicy.openai.serviceTier,
          responsesServerCompaction: params.optimizationPolicy.openai.responsesServerCompaction,
          openaiWsWarmup: params.optimizationPolicy.openai.openaiWsWarmup,
        },
      };
    }
  }
  next.agents.defaults.models = nextModels;
  return next;
}
