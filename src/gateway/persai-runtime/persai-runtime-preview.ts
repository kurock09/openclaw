import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../../config/config.js";
import { logWarn } from "../../logger.js";
import {
  runPersaiWebRuntimeAgentTurnSync,
  type PersaiMediaArtifact,
} from "./persai-runtime-agent-turn.js";
import { extractPersaiRuntimeModelOverride } from "./persai-runtime-provider-profile.js";
import {
  validatePersaiRuntimeProviderProfileForApply,
  PersaiRuntimeProviderProfileValidationError,
} from "./persai-runtime-provider-profile.js";
import { cleanupPersaiSessionKey } from "./persai-runtime-session-cleanup.js";
import {
  buildToolDenyList,
  extractToolCredentialRefs,
  extractToolProviderOverrides,
  extractToolQuotaPolicy,
  resolveToolCredentials,
  validateToolPolicyForApply,
  PersaiToolPolicyValidationError,
} from "./persai-runtime-tool-policy.js";
import {
  buildSchedulingContext,
  extractAssistantGenderFromWorkspace,
  extractPersonaInstructionsFromWorkspace,
  mergeSystemPrompt,
} from "./persai-runtime-turn-context.js";
import { writeBootstrapFilesToWorkspace } from "./persai-runtime-workspace.js";

type PersaiRuntimeTurnError = {
  code: string;
  message: string;
  status: number;
};

export type PersaiRuntimePreviewPayload = {
  assistantId: string;
  userMessage: string;
  currentTimeIso?: string;
  userTimezone?: string;
  spec: {
    bootstrap: unknown;
    workspace: unknown;
  };
};

export type PersaiRuntimePreviewResult =
  | { ok: true; assistantMessage: string; media: PersaiMediaArtifact[] }
  | { ok: false; error: PersaiRuntimeTurnError };

type PreviewDeps = {
  runAgentTurn: typeof runPersaiWebRuntimeAgentTurnSync;
  cleanupSessionKey: typeof cleanupPersaiSessionKey;
  resolveCredentials: typeof resolveToolCredentials;
};

function toPreviewSessionKey(assistantId: string): string {
  return `agent:persai:${assistantId}:setup-preview:${randomUUID()}`;
}

const DEFAULT_DEPS: PreviewDeps = {
  runAgentTurn: runPersaiWebRuntimeAgentTurnSync,
  cleanupSessionKey: cleanupPersaiSessionKey,
  resolveCredentials: resolveToolCredentials,
};

export async function runPersaiWebRuntimePreviewTurn(
  payload: PersaiRuntimePreviewPayload,
  deps: PreviewDeps = DEFAULT_DEPS,
): Promise<PersaiRuntimePreviewResult> {
  try {
    await validatePersaiRuntimeProviderProfileForApply(payload.spec.bootstrap);
  } catch (error) {
    if (error instanceof PersaiRuntimeProviderProfileValidationError) {
      return {
        ok: false,
        error: {
          code: "assistant_turn_failed",
          message: error.message,
          status: 400,
        },
      };
    }
    throw error;
  }

  try {
    await validateToolPolicyForApply(payload.spec.bootstrap);
  } catch (error) {
    if (error instanceof PersaiToolPolicyValidationError) {
      return {
        ok: false,
        error: {
          code: "assistant_turn_failed",
          message: error.message,
          status: 400,
        },
      };
    }
    throw error;
  }

  const previewRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-persai-setup-preview-"));
  const previewAssistantId = `preview-${payload.assistantId}-${randomUUID()}`;
  const previewEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PERSAI_WORKSPACE_ROOT: previewRoot,
  };
  const sessionKey = toPreviewSessionKey(payload.assistantId);

  try {
    const bootstrapFiles = await writeBootstrapFilesToWorkspace({
      assistantId: previewAssistantId,
      workspace: payload.spec.workspace,
      reapply: false,
      env: previewEnv,
    });

    const extraSystemPrompt = mergeSystemPrompt(
      extractPersonaInstructionsFromWorkspace(payload.spec.workspace) ?? undefined,
      buildSchedulingContext({
        currentTimeIso: payload.currentTimeIso,
        userTimezone: payload.userTimezone,
      }),
    );
    const runtimeOverride = extractPersaiRuntimeModelOverride(payload.spec.bootstrap);
    const credentialRefs = extractToolCredentialRefs(payload.spec.bootstrap);
    const quotaPolicy = extractToolQuotaPolicy(payload.spec.bootstrap);
    const toolDenyList = buildToolDenyList(quotaPolicy);
    const toolProviderOverrides = extractToolProviderOverrides(credentialRefs);

    let resolvedToolCredentials = new Map<string, string>();
    if (credentialRefs.size > 0) {
      try {
        resolvedToolCredentials = await deps.resolveCredentials(credentialRefs, loadConfig());
      } catch (credErr) {
        logWarn(
          `persai-runtime: resolveToolCredentials failed (preview): ${credErr instanceof Error ? credErr.message : String(credErr)}`,
        );
      }
    }

    return await deps.runAgentTurn({
      assistantId: payload.assistantId,
      userMessage: payload.userMessage,
      sessionKey,
      extraSystemPrompt,
      providerOverride: runtimeOverride?.provider,
      modelOverride: runtimeOverride?.model,
      resolvedToolCredentials,
      toolProviderOverrides,
      toolDenyList,
      toolQuotaPolicy: quotaPolicy,
      workspaceDir: bootstrapFiles.workspaceDir,
      assistantGender: extractAssistantGenderFromWorkspace(payload.spec.workspace),
    });
  } finally {
    await deps.cleanupSessionKey(sessionKey).catch(() => {});
    await fs.rm(previewRoot, { recursive: true, force: true }).catch(() => {});
  }
}
