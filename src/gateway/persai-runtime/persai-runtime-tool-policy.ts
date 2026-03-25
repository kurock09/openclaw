import type { OpenClawConfig } from "../../config/config.js";
import type { SecretRef } from "../../config/types.secrets.js";
import { resolveSecretRefValues } from "../../secrets/resolve.js";
import { secretRefKey } from "../../secrets/ref-contract.js";

export type PersaiToolCredentialRef = {
  toolCode: string;
  secretRef: SecretRef;
  configured: boolean;
};

export type PersaiToolQuotaEntry = {
  toolCode: string;
  activationStatus: "active" | "inactive";
  dailyCallLimit: number | null;
};

/**
 * Maps tool credential IDs from the PersAI bootstrap to the environment
 * variable names that OpenClaw tools actually read at runtime.
 */
const TOOL_CREDENTIAL_ENV_MAP: Record<string, string> = {
  "tool/web_search/api-key": "TAVILY_API_KEY",
  "tool/web_fetch/api-key": "FIRECRAWL_API_KEY",
  "tool/image_generate/api-key": "OPENAI_IMAGE_GEN_API_KEY",
  "tool/tts/api-key": "OPENAI_TTS_API_KEY",
  "tool/memory_search/api-key": "OPENAI_EMBEDDINGS_API_KEY",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export class PersaiToolPolicyValidationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PersaiToolPolicyValidationError";
  }
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
  if (!Array.isArray(refs)) {
    return result;
  }

  for (const entry of refs) {
    const row = asRecord(entry);
    if (!row) continue;

    const toolCode = asNonEmptyString(row.toolCode);
    if (!toolCode) continue;

    const configured = row.configured === true;
    const secretRefObj = asRecord(row.secretRef);
    if (!secretRefObj) continue;

    const source = secretRefObj.source;
    const provider = asNonEmptyString(secretRefObj.provider);
    const id = asNonEmptyString(secretRefObj.id);
    if (
      (source !== "env" && source !== "file" && source !== "exec" && source !== "persai") ||
      !provider ||
      !id
    ) {
      continue;
    }

    result.set(toolCode, {
      toolCode,
      secretRef: { source, provider, id },
      configured,
    });
  }

  return result;
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
      typeof row.dailyCallLimit === "number" && Number.isFinite(row.dailyCallLimit)
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
  const configuredRefs: { toolCode: string; ref: SecretRef }[] = [];
  for (const entry of credentialRefs.values()) {
    if (entry.configured) {
      configuredRefs.push({ toolCode: entry.toolCode, ref: entry.secretRef });
    }
  }

  if (configuredRefs.length === 0) {
    return new Map();
  }

  const secretRefs = configuredRefs.map((r) => r.ref);
  const resolved = await resolveSecretRefValues(secretRefs, { config, env: process.env });

  const credentials = new Map<string, string>();
  for (const { ref } of configuredRefs) {
    const key = secretRefKey(ref);
    const value = resolved.get(key);
    if (typeof value === "string" && value.length > 0) {
      const envVar = TOOL_CREDENTIAL_ENV_MAP[ref.id];
      if (envVar) {
        credentials.set(envVar, value);
      }
    }
  }

  return credentials;
}

export async function validateToolPolicyForApply(
  bootstrap: unknown,
): Promise<void> {
  const credentialRefs = extractToolCredentialRefs(bootstrap);
  const quotaPolicy = extractToolQuotaPolicy(bootstrap);

  for (const entry of credentialRefs.values()) {
    if (!entry.configured) continue;
    const ref = entry.secretRef;
    if (ref.source !== "persai" && ref.source !== "env" && ref.source !== "file" && ref.source !== "exec") {
      throw new PersaiToolPolicyValidationError(
        `Tool credential ref for "${entry.toolCode}" has unsupported source "${ref.source}".`,
      );
    }
  }

  for (const entry of quotaPolicy.values()) {
    if (entry.activationStatus !== "active" && entry.activationStatus !== "inactive") {
      throw new PersaiToolPolicyValidationError(
        `Tool quota policy for "${entry.toolCode}" has invalid activationStatus "${String(entry.activationStatus)}".`,
      );
    }
  }
}
