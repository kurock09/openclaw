import { loadConfig, type OpenClawConfig } from "../../config/config.js";

type CachedHeartbeatModel = {
  expiresAtMs: number;
  value: string | null;
};

type ProviderSettingsResponse = {
  mode?: unknown;
  primary?: {
    provider?: unknown;
    model?: unknown;
  } | null;
};

const CACHE_TTL_MS = 30_000;
let cachedHeartbeatModel: CachedHeartbeatModel | null = null;

function resolvePersaiInternalApiBaseUrl(cfg?: OpenClawConfig): string | null {
  const resolvedCfg = cfg ?? loadConfig();
  const provider = resolvedCfg.secrets?.providers?.["persai-runtime"];
  return provider?.source === "persai" && typeof provider.baseUrl === "string"
    ? provider.baseUrl.replace(/\/+$/, "")
    : null;
}

function parseHeartbeatModelOverride(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const row = payload as ProviderSettingsResponse;
  if (row.mode !== "global_settings") {
    return null;
  }
  const provider = row.primary?.provider;
  const model = row.primary?.model;
  if (
    (provider !== "openai" && provider !== "anthropic") ||
    typeof model !== "string" ||
    model.trim().length === 0
  ) {
    return null;
  }
  return `${provider}/${model.trim()}`;
}

export async function resolvePersaiHeartbeatModelOverride(
  cfg?: OpenClawConfig,
  nowMs: () => number = Date.now,
): Promise<string | null> {
  const now = nowMs();
  if (cachedHeartbeatModel && cachedHeartbeatModel.expiresAtMs > now) {
    return cachedHeartbeatModel.value;
  }

  const baseUrl = resolvePersaiInternalApiBaseUrl(cfg);
  const token = (process.env.PERSAI_INTERNAL_API_TOKEN ?? "").trim();
  if (!baseUrl || !token) {
    cachedHeartbeatModel = {
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
      cachedHeartbeatModel = {
        expiresAtMs: now + CACHE_TTL_MS,
        value: null,
      };
      return null;
    }
    const payload = parseHeartbeatModelOverride(await response.json());
    cachedHeartbeatModel = {
      expiresAtMs: now + CACHE_TTL_MS,
      value: payload,
    };
    return payload;
  } catch {
    cachedHeartbeatModel = {
      expiresAtMs: now + CACHE_TTL_MS,
      value: null,
    };
    return null;
  }
}

export function clearPersaiHeartbeatModelOverrideCache(): void {
  cachedHeartbeatModel = null;
}
