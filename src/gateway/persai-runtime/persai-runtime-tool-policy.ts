import type { OpenClawConfig } from "../../config/config.js";
import type { SecretRef } from "../../config/types.secrets.js";
import { resolveSecretRefValues } from "../../secrets/resolve.js";
import { secretRefKey } from "../../secrets/ref-contract.js";

export type PersaiToolCredentialRef = {
  toolCode: string;
  secretRef: SecretRef;
  configured: boolean;
  providerId?: string;
};

export type PersaiToolQuotaEntry = {
  toolCode: string;
  activationStatus: "active" | "inactive";
  dailyCallLimit: number | null;
};

/**
 * Default env var when no providerId is specified.
 */
const TOOL_CREDENTIAL_ENV_MAP: Record<string, string> = {
  "tool/web_search/api-key": "TAVILY_API_KEY",
  "tool/web_fetch/api-key": "FIRECRAWL_API_KEY",
  "tool/image_generate/api-key": "OPENAI_IMAGE_GEN_API_KEY",
  "tool/tts/api-key": "OPENAI_TTS_API_KEY",
  "tool/memory_search/api-key": "OPENAI_EMBEDDINGS_API_KEY",
};

/**
 * Provider-specific env var overrides keyed by secretId → providerId → envVar.
 */
const PROVIDER_ENV_OVERRIDES: Record<string, Record<string, string>> = {
  "tool/web_search/api-key": {
    tavily: "TAVILY_API_KEY",
    brave: "BRAVE_API_KEY",
    perplexity: "PERPLEXITY_API_KEY",
    google: "GEMINI_API_KEY",
  },
  "tool/tts/api-key": {
    openai: "OPENAI_TTS_API_KEY",
    elevenlabs: "ELEVENLABS_API_KEY",
    yandex: "YANDEX_TTS_API_KEY",
  },
};

function resolveCredentialEnvVar(
  secretId: string,
  providerId?: string,
): string | undefined {
  if (providerId) {
    const overrides = PROVIDER_ENV_OVERRIDES[secretId];
    if (overrides?.[providerId]) {
      return overrides[providerId];
    }
  }
  return TOOL_CREDENTIAL_ENV_MAP[secretId];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

export class PersaiToolPolicyValidationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PersaiToolPolicyValidationError";
  }
}

function parseCredentialRefRow(
  toolCode: string,
  row: Record<string, unknown>,
): PersaiToolCredentialRef | null {
  const configured = row.configured === true;
  const secretRefObj = asRecord(row.secretRef);
  if (!secretRefObj) return null;

  const source = secretRefObj.source;
  const provider = asNonEmptyString(secretRefObj.provider);
  const id = asNonEmptyString(secretRefObj.id);
  if (
    (source !== "env" &&
      source !== "file" &&
      source !== "exec" &&
      source !== "persai") ||
    !provider ||
    !id
  ) {
    return null;
  }

  const providerId = asNonEmptyString(row.providerId) ?? undefined;
  return {
    toolCode,
    secretRef: { source, provider, id },
    configured,
    providerId,
  };
}

export function extractToolCredentialRefs(
  bootstrap: unknown,
): Map<string, PersaiToolCredentialRef> {
  const result = new Map<string, PersaiToolCredentialRef>();
  const governance = asRecord(asRecord(bootstrap)?.governance);
  if (!governance) {
    return result;
  }
  const refs = governance.toolCredentialRefs;

  if (Array.isArray(refs)) {
    for (const entry of refs) {
      const row = asRecord(entry);
      if (!row) continue;
      const toolCode = asNonEmptyString(row.toolCode);
      if (!toolCode) continue;
      const parsed = parseCredentialRefRow(toolCode, row);
      if (parsed) result.set(toolCode, parsed);
    }
  } else if (isRecord(refs)) {
    for (const [key, value] of Object.entries(refs)) {
      const toolCode = asNonEmptyString(key);
      if (!toolCode) continue;
      const row = asRecord(value);
      if (!row) continue;
      const parsed = parseCredentialRefRow(toolCode, row);
      if (parsed) result.set(toolCode, parsed);
    }
  }

  return result;
}

export function extractToolProviderOverrides(
  credentialRefs: Map<string, PersaiToolCredentialRef>,
): Map<string, string> {
  const overrides = new Map<string, string>();
  for (const ref of credentialRefs.values()) {
    if (ref.providerId && ref.configured) {
      overrides.set(ref.toolCode, ref.providerId);
    }
  }
  return overrides;
}

export function extractToolQuotaPolicy(
  bootstrap: unknown,
): Map<string, PersaiToolQuotaEntry> {
  const result = new Map<string, PersaiToolQuotaEntry>();
  const governance = asRecord(asRecord(bootstrap)?.governance);
  if (!governance) {
    return result;
  }
  const policy = governance.toolQuotaPolicy;
  if (!Array.isArray(policy)) {
    return result;
  }

  for (const entry of policy) {
    const row = asRecord(entry);
    if (!row) continue;

    const toolCode = asNonEmptyString(row.toolCode);
    if (!toolCode) continue;

    const activationStatus =
      row.activationStatus === "active" || row.activationStatus === "inactive"
        ? row.activationStatus
        : "inactive";

    const dailyCallLimit =
      typeof row.dailyCallLimit === "number" &&
      Number.isFinite(row.dailyCallLimit)
        ? row.dailyCallLimit
        : null;

    result.set(toolCode, { toolCode, activationStatus, dailyCallLimit });
  }

  return result;
}

export function buildToolDenyList(
  quotaPolicy: Map<string, PersaiToolQuotaEntry>,
): string[] {
  const denied: string[] = [];
  for (const entry of quotaPolicy.values()) {
    if (entry.activationStatus === "inactive") {
      denied.push(entry.toolCode);
    }
  }
  return denied;
}

export async function resolveToolCredentials(
  credentialRefs: Map<string, PersaiToolCredentialRef>,
  config: OpenClawConfig,
): Promise<Map<string, string>> {
  const configuredRefs: {
    toolCode: string;
    ref: SecretRef;
    providerId?: string;
  }[] = [];
  for (const entry of credentialRefs.values()) {
    if (entry.configured) {
      configuredRefs.push({
        toolCode: entry.toolCode,
        ref: entry.secretRef,
        providerId: entry.providerId,
      });
    }
  }

  if (configuredRefs.length === 0) {
    return new Map();
  }

  const secretRefs = configuredRefs.map((r) => r.ref);
  const resolved = await resolveSecretRefValues(secretRefs, {
    config,
    env: process.env,
  });

  const credentials = new Map<string, string>();
  for (const { ref, providerId } of configuredRefs) {
    const key = secretRefKey(ref);
    const value = resolved.get(key);
    if (typeof value === "string" && value.length > 0) {
      const envVar = resolveCredentialEnvVar(ref.id, providerId);
      if (envVar) {
        credentials.set(envVar, value);
      }
    }
  }

  return credentials;
}

export function extractWorkspaceQuotaBytes(
  bootstrap: unknown,
): number | null {
  const governance = asRecord(asRecord(bootstrap)?.governance);
  if (!governance) return null;
  const raw = governance.workspaceQuotaBytes;
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0
    ? raw
    : null;
}

export async function validateToolPolicyForApply(
  bootstrap: unknown,
): Promise<void> {
  const credentialRefs = extractToolCredentialRefs(bootstrap);
  const quotaPolicy = extractToolQuotaPolicy(bootstrap);

  for (const entry of credentialRefs.values()) {
    if (!entry.configured) continue;
    const ref = entry.secretRef;
    if (
      ref.source !== "persai" &&
      ref.source !== "env" &&
      ref.source !== "file" &&
      ref.source !== "exec"
    ) {
      throw new PersaiToolPolicyValidationError(
        `Tool credential ref for "${entry.toolCode}" has unsupported source "${ref.source}".`,
      );
    }
  }

  for (const entry of quotaPolicy.values()) {
    if (
      entry.activationStatus !== "active" &&
      entry.activationStatus !== "inactive"
    ) {
      throw new PersaiToolPolicyValidationError(
        `Tool quota policy for "${entry.toolCode}" has invalid activationStatus "${String(entry.activationStatus)}".`,
      );
    }
  }
}
