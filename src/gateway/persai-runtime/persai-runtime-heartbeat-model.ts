import { loadConfig, type OpenClawConfig } from "../../config/config.js";
import {
  applyPersaiRuntimeOverridesToConfig,
  extractPersaiRuntimeOptimizationPolicy,
  parsePersaiRuntimeSettingsResponse,
  type PersaiRuntimeSettingsResponse,
} from "./persai-runtime-config-override.js";
import { resolvePersaiRuntimeProviderProfile } from "./persai-runtime-provider-profile.js";

type CachedProviderSettings = {
  expiresAtMs: number;
  value: PersaiRuntimeSettingsResponse | null;
};

const CACHE_TTL_MS = 30_000;
let cachedProviderSettings: CachedProviderSettings | null = null;

function resolvePersaiInternalApiBaseUrl(cfg?: OpenClawConfig): string | null {
  const resolvedCfg = cfg ?? loadConfig();
  const provider = resolvedCfg.secrets?.providers?.["persai-runtime"];
  return provider?.source === "persai" && typeof provider.baseUrl === "string"
    ? provider.baseUrl.replace(/\/+$/, "")
    : null;
}

function parseHeartbeatModelOverride(payload: PersaiRuntimeSettingsResponse | null): string | null {
  if (!payload) {
    return null;
  }
  const row = parsePersaiRuntimeSettingsResponse(payload);
  if (row === null) {
    return null;
  }
  if (row.mode !== "global_settings") {
    return null;
  }
  if (!row.primary) {
    return null;
  }
  return `${row.primary.provider}/${row.primary.model}`;
}

async function fetchPersaiRuntimeSettings(
  cfg?: OpenClawConfig,
  nowMs: () => number = Date.now,
): Promise<PersaiRuntimeSettingsResponse | null> {
  const now = nowMs();
  if (cachedProviderSettings && cachedProviderSettings.expiresAtMs > now) {
    return cachedProviderSettings.value;
  }
  const baseUrl = resolvePersaiInternalApiBaseUrl(cfg);
  const token = (process.env.PERSAI_INTERNAL_API_TOKEN ?? "").trim();
  if (!baseUrl || !token) {
    cachedProviderSettings = {
      expiresAtMs: now + CACHE_TTL_MS,
      value: null,
    };
    return null;
  }
  try {
    const response = await fetch(`${baseUrl}/api/v1/internal/runtime/provider-settings/default`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    if (!response.ok) {
      cachedProviderSettings = {
        expiresAtMs: now + CACHE_TTL_MS,
        value: null,
      };
      return null;
    }
    const payload = (await response.json()) as PersaiRuntimeSettingsResponse;
    cachedProviderSettings = {
      expiresAtMs: now + CACHE_TTL_MS,
      value: payload,
    };
    return payload;
  } catch {
    cachedProviderSettings = {
      expiresAtMs: now + CACHE_TTL_MS,
      value: null,
    };
    return null;
  }
}

export async function resolvePersaiHeartbeatModelOverride(
  cfg?: OpenClawConfig,
  nowMs: () => number = Date.now,
): Promise<string | null> {
  return parseHeartbeatModelOverride(await fetchPersaiRuntimeSettings(cfg, nowMs));
}

export async function resolvePersaiRuntimeConfigOverride(
  cfg?: OpenClawConfig,
  nowMs: () => number = Date.now,
): Promise<OpenClawConfig | null> {
  const settings = parsePersaiRuntimeSettingsResponse(await fetchPersaiRuntimeSettings(cfg, nowMs));
  if (settings === null) {
    return null;
  }
  return applyPersaiRuntimeOverridesToConfig(cfg ?? loadConfig(), {
    availableModelsByProvider: settings.availableModelsByProvider,
    optimizationPolicy: settings.optimizationPolicy,
  });
}

export async function resolvePersaiLayeredRuntimeConfig(params: {
  cfg?: OpenClawConfig;
  bootstrap?: unknown;
  nowMs?: () => number;
}): Promise<OpenClawConfig> {
  const baseCfg = params.cfg ?? loadConfig();
  const runtimeCfg =
    (await resolvePersaiRuntimeConfigOverride(baseCfg, params.nowMs ?? Date.now)) ?? baseCfg;
  if (params.bootstrap === undefined) {
    return runtimeCfg;
  }
  const providerProfile = resolvePersaiRuntimeProviderProfile(params.bootstrap);
  const optimizationPolicy = extractPersaiRuntimeOptimizationPolicy(params.bootstrap);
  if (!providerProfile && !optimizationPolicy) {
    return runtimeCfg;
  }
  return applyPersaiRuntimeOverridesToConfig(runtimeCfg, {
    availableModelsByProvider: providerProfile?.availableModelsByProvider ?? null,
    optimizationPolicy,
  });
}

export function clearPersaiHeartbeatModelOverrideCache(): void {
  cachedProviderSettings = null;
}
