// Public auth/onboarding helpers for provider plugins.

export type { OpenClawConfig } from "../config/config.js";
export type { SecretInput } from "../config/types.secrets.js";
import { promptSecretRefForSetup as promptSecretRefForSetupImpl } from "../plugins/provider-auth-ref.js";
import type { SecretRef } from "../config/types.secrets.js";
import type { OpenClawConfig } from "../config/config.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import type { SecretRefSetupPromptCopy } from "../plugins/provider-auth-ref.js";
export type { ProviderAuthResult } from "../plugins/types.js";
export type { ProviderAuthContext } from "../plugins/types.js";
export type { AuthProfileStore, OAuthCredential } from "../agents/auth-profiles/types.js";

export { CLAUDE_CLI_PROFILE_ID, CODEX_CLI_PROFILE_ID } from "../agents/auth-profiles/constants.js";
export { ensureAuthProfileStore } from "../agents/auth-profiles/store.js";
export { listProfilesForProvider, upsertAuthProfile } from "../agents/auth-profiles/profiles.js";
export { suggestOAuthProfileIdForLegacyDefault } from "../agents/auth-profiles/repair.js";
export {
  MINIMAX_OAUTH_MARKER,
  resolveOAuthApiKeyMarker,
  resolveNonEnvSecretRefApiKeyMarker,
} from "../agents/model-auth-markers.js";
export {
  formatApiKeyPreview,
  normalizeApiKeyInput,
  validateApiKeyInput,
} from "../plugins/provider-auth-input.js";
export {
  ensureApiKeyFromOptionEnvOrPrompt,
  normalizeSecretInputModeInput,
  resolveSecretInputModeForEnvSelection,
} from "../plugins/provider-auth-input.js";
export {
  buildTokenProfileId,
  validateAnthropicSetupToken,
} from "../plugins/provider-auth-token.js";
export { applyAuthProfileConfig, buildApiKeyCredential } from "../plugins/provider-auth-helpers.js";
export { createProviderApiKeyAuthMethod } from "../plugins/provider-api-key-auth.js";
export { coerceSecretRef } from "../config/types.secrets.js";
export { resolveDefaultSecretProviderAlias } from "../secrets/ref-contract.js";
export { resolveRequiredHomeDir } from "../infra/home-dir.js";
export {
  normalizeOptionalSecretInput,
  normalizeSecretInput,
} from "../utils/normalize-secret-input.js";
export {
  listKnownProviderAuthEnvVarNames,
  omitEnvKeysCaseInsensitive,
} from "../secrets/provider-env-vars.js";
export { buildOauthProviderAuthResult } from "./provider-auth-result.js";
export { generatePkceVerifierChallenge, toFormUrlEncoded } from "./oauth-utils.js";

export type SetupSecretRef = Omit<SecretRef, "source"> & {
  source: "env" | "file" | "exec";
};

export async function promptSecretRefForSetup(params: {
  provider: string;
  config: OpenClawConfig;
  prompter: WizardPrompter;
  preferredEnvVar?: string;
  copy?: SecretRefSetupPromptCopy;
}): Promise<{ ref: SetupSecretRef; resolvedValue: string }> {
  const resolved = await promptSecretRefForSetupImpl(params);
  return resolved as { ref: SetupSecretRef; resolvedValue: string };
}
