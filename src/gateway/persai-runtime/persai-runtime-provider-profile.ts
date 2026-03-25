import { DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { buildConfiguredAllowlistKeys, modelKey } from "../../agents/model-selection.js";
import { loadConfig } from "../../config/config.js";
import type { SecretRef } from "../../config/types.secrets.js";
import { resolveSecretRefString } from "../../secrets/resolve.js";

type ManagedRuntimeProvider = "openai" | "anthropic";

type RuntimeProviderCredentialRef = {
  refKey: string;
  secretRef: SecretRef;
};

type AdminManagedRuntimeProviderProfile = {
  schema: "persai.runtimeProviderProfile.v1";
  mode: "admin_managed";
  primary: {
    provider: ManagedRuntimeProvider;
    model: string;
    credentialRef: RuntimeProviderCredentialRef;
  };
  fallback:
    | {
        provider: ManagedRuntimeProvider;
        model: string;
        credentialRef: RuntimeProviderCredentialRef;
      }
    | null;
};

type LegacyRuntimeProviderProfile = {
  schema: "persai.runtimeProviderProfile.v1";
  mode: "legacy_openclaw_default";
};

export type PersaiRuntimeProviderProfile =
  | AdminManagedRuntimeProviderProfile
  | LegacyRuntimeProviderProfile;

export class PersaiRuntimeProviderProfileValidationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PersaiRuntimeProviderProfileValidationError";
  }
}

const MAX_MODEL_LENGTH = 256;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function containsControlCharacters(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code === undefined) {
      continue;
    }
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

function parseManagedProvider(value: unknown, path: string): ManagedRuntimeProvider {
  const normalized = asNonEmptyString(value)?.toLowerCase();
  if (normalized === "openai" || normalized === "anthropic") {
    return normalized;
  }
  throw new PersaiRuntimeProviderProfileValidationError(
    `${path} must be one of: openai, anthropic.`,
  );
}

function parseModel(value: unknown, path: string): string {
  const normalized = asNonEmptyString(value);
  if (normalized === null) {
    throw new PersaiRuntimeProviderProfileValidationError(`${path} must be a non-empty string.`);
  }
  if (normalized.length > MAX_MODEL_LENGTH) {
    throw new PersaiRuntimeProviderProfileValidationError(
      `${path} must be at most ${String(MAX_MODEL_LENGTH)} characters.`,
    );
  }
  if (containsControlCharacters(normalized)) {
    throw new PersaiRuntimeProviderProfileValidationError(
      `${path} contains invalid control characters.`,
    );
  }
  return normalized;
}

function parseSecretRef(value: unknown, path: string): SecretRef {
  const row = asRecord(value);
  if (row === null) {
    throw new PersaiRuntimeProviderProfileValidationError(`${path} must be an object.`);
  }
  const source =
    row.source === "env" ||
    row.source === "file" ||
    row.source === "exec" ||
    row.source === "persai"
      ? row.source
      : null;
  const provider = asNonEmptyString(row.provider);
  const id = asNonEmptyString(row.id);
  if (source === null || provider === null || id === null) {
    throw new PersaiRuntimeProviderProfileValidationError(
      `${path} must include valid source, provider, and id fields.`,
    );
  }
  return {
    source,
    provider,
    id,
  };
}

function parseCredentialRef(value: unknown, path: string): RuntimeProviderCredentialRef {
  const row = asRecord(value);
  if (row === null) {
    throw new PersaiRuntimeProviderProfileValidationError(`${path} must be an object.`);
  }
  const secretRef = parseSecretRef(row.secretRef, `${path}.secretRef`);
  return {
    refKey: asNonEmptyString(row.refKey) ?? `${secretRef.source}:${secretRef.provider}:${secretRef.id}`,
    secretRef,
  };
}

function parseSelection(
  value: unknown,
  path: string,
): {
  provider: ManagedRuntimeProvider;
  model: string;
  credentialRef: RuntimeProviderCredentialRef;
} {
  const row = asRecord(value);
  if (row === null) {
    throw new PersaiRuntimeProviderProfileValidationError(`${path} must be an object.`);
  }
  return {
    provider: parseManagedProvider(row.provider, `${path}.provider`),
    model: parseModel(row.model, `${path}.model`),
    credentialRef: parseCredentialRef(row.credentialRef, `${path}.credentialRef`),
  };
}

export function resolvePersaiRuntimeProviderProfile(
  bootstrap: unknown,
): PersaiRuntimeProviderProfile | null {
  const bootstrapRow = asRecord(bootstrap);
  const governance = asRecord(bootstrapRow?.governance);
  const rawProfile = asRecord(governance?.runtimeProviderProfile);
  if (rawProfile === null) {
    return null;
  }
  if (rawProfile.schema !== "persai.runtimeProviderProfile.v1") {
    throw new PersaiRuntimeProviderProfileValidationError(
      'governance.runtimeProviderProfile.schema must equal "persai.runtimeProviderProfile.v1".',
    );
  }
  if (rawProfile.mode === "legacy_openclaw_default") {
    return {
      schema: "persai.runtimeProviderProfile.v1",
      mode: "legacy_openclaw_default",
    };
  }
  if (rawProfile.mode !== "admin_managed") {
    throw new PersaiRuntimeProviderProfileValidationError(
      'governance.runtimeProviderProfile.mode must be "legacy_openclaw_default" or "admin_managed".',
    );
  }
  return {
    schema: "persai.runtimeProviderProfile.v1",
    mode: "admin_managed",
    primary: parseSelection(rawProfile.primary, "governance.runtimeProviderProfile.primary"),
    fallback:
      rawProfile.fallback === undefined || rawProfile.fallback === null
        ? null
        : parseSelection(rawProfile.fallback, "governance.runtimeProviderProfile.fallback"),
  };
}

function assertAllowlistedModel(provider: ManagedRuntimeProvider, model: string): void {
  const cfg = loadConfig();
  const allowlist = buildConfiguredAllowlistKeys({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
  });
  if (allowlist === null) {
    return;
  }
  const key = modelKey(provider, model);
  if (!allowlist.has(key)) {
    throw new PersaiRuntimeProviderProfileValidationError(
      `Runtime provider profile model "${key}" is not configured in the OpenClaw allowlist.`,
    );
  }
}

async function assertResolvableSecretRef(ref: RuntimeProviderCredentialRef): Promise<void> {
  const cfg = loadConfig();
  try {
    await resolveSecretRefString(ref.secretRef, {
      config: cfg,
      env: process.env,
    });
  } catch (error) {
    throw new PersaiRuntimeProviderProfileValidationError(
      `Runtime provider credential ref "${ref.refKey}" could not be resolved by OpenClaw.`,
      { cause: error },
    );
  }
}

export async function validatePersaiRuntimeProviderProfileForApply(
  bootstrap: unknown,
): Promise<void> {
  const profile = resolvePersaiRuntimeProviderProfile(bootstrap);
  if (profile === null || profile.mode === "legacy_openclaw_default") {
    return;
  }
  assertAllowlistedModel(profile.primary.provider, profile.primary.model);
  await assertResolvableSecretRef(profile.primary.credentialRef);
  if (profile.fallback !== null) {
    assertAllowlistedModel(profile.fallback.provider, profile.fallback.model);
    await assertResolvableSecretRef(profile.fallback.credentialRef);
  }
}

export function extractPersaiRuntimeModelOverride(
  bootstrap: unknown,
): { provider: ManagedRuntimeProvider; model: string } | null {
  const profile = resolvePersaiRuntimeProviderProfile(bootstrap);
  if (profile === null || profile.mode === "legacy_openclaw_default") {
    return null;
  }
  return {
    provider: profile.primary.provider,
    model: profile.primary.model,
  };
}
