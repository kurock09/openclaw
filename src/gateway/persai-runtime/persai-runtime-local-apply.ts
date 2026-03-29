import {
  PersaiRuntimeProviderProfileValidationError,
  validatePersaiRuntimeProviderProfileForApply,
} from "./persai-runtime-provider-profile.js";
import type { PersaiRuntimeSpecStore } from "./persai-runtime-spec-store.js";
import { syncTelegramBotForAssistant } from "./persai-runtime-telegram.js";
import {
  PersaiToolPolicyValidationError,
  validateToolPolicyForApply,
} from "./persai-runtime-tool-policy.js";
import { writeBootstrapFilesToWorkspace } from "./persai-runtime-workspace.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class PersaiRuntimeSpecApplyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersaiRuntimeSpecApplyValidationError";
  }
}

export type PersaiRuntimeSpecApplyPayload = {
  assistantId: string;
  publishedVersionId: string;
  contentHash: string;
  reapply: boolean;
  spec: {
    bootstrap: unknown;
    workspace: unknown;
  };
};

export type PersaiRuntimeFreshSpecResponse = {
  generation: number;
  assistantId: string;
  publishedVersionId: string;
  contentHash: string;
  spec: {
    bootstrap: unknown;
    workspace: unknown;
  };
};

export function parseFreshSpecResponse(body: unknown): PersaiRuntimeFreshSpecResponse | null {
  if (!isRecord(body)) {
    return null;
  }
  const assistantId = typeof body.assistantId === "string" ? body.assistantId.trim() : "";
  const publishedVersionId =
    typeof body.publishedVersionId === "string" ? body.publishedVersionId.trim() : "";
  const contentHash = typeof body.contentHash === "string" ? body.contentHash.trim() : "";
  const generation = body.generation;
  const spec = body.spec;
  if (
    !assistantId ||
    !publishedVersionId ||
    !contentHash ||
    typeof generation !== "number" ||
    !Number.isFinite(generation) ||
    !isRecord(spec) ||
    !Object.prototype.hasOwnProperty.call(spec, "bootstrap") ||
    !Object.prototype.hasOwnProperty.call(spec, "workspace")
  ) {
    return null;
  }
  return {
    generation,
    assistantId,
    publishedVersionId,
    contentHash,
    spec: {
      bootstrap: spec.bootstrap,
      workspace: spec.workspace,
    },
  };
}

export async function applyPersaiRuntimeSpecLocally(params: {
  payload: PersaiRuntimeSpecApplyPayload;
  store: PersaiRuntimeSpecStore;
}): Promise<{
  appliedAt: string;
  workspaceDir: string;
  bootstrapFiles: { written: string[]; skipped: string[] };
}> {
  const { payload, store } = params;
  const { assistantId, publishedVersionId, contentHash, reapply, spec } = payload;

  if (!assistantId || !publishedVersionId || !contentHash || !isRecord(spec)) {
    throw new PersaiRuntimeSpecApplyValidationError(
      "Invalid runtime spec apply payload. Required fields: assistantId, publishedVersionId, contentHash, spec.bootstrap, spec.workspace.",
    );
  }
  if (
    !Object.prototype.hasOwnProperty.call(spec, "bootstrap") ||
    !Object.prototype.hasOwnProperty.call(spec, "workspace")
  ) {
    throw new PersaiRuntimeSpecApplyValidationError(
      "Invalid runtime spec apply payload. Required fields: assistantId, publishedVersionId, contentHash, spec.bootstrap, spec.workspace.",
    );
  }

  try {
    await validatePersaiRuntimeProviderProfileForApply(spec.bootstrap);
  } catch (error) {
    if (error instanceof PersaiRuntimeProviderProfileValidationError) {
      throw new PersaiRuntimeSpecApplyValidationError(error.message);
    }
    throw error;
  }

  try {
    await validateToolPolicyForApply(spec.bootstrap);
  } catch (error) {
    if (error instanceof PersaiToolPolicyValidationError) {
      throw new PersaiRuntimeSpecApplyValidationError(error.message);
    }
    throw error;
  }

  const appliedAt = new Date().toISOString();
  const bootstrapFiles = await writeBootstrapFilesToWorkspace({
    assistantId,
    workspace: spec.workspace,
    reapply,
  });

  // Keep a single runtime spec per assistant so restarts do not resurrect stale versions.
  await store.remove(assistantId);
  await store.put({
    assistantId,
    publishedVersionId,
    contentHash,
    reapply,
    bootstrap: spec.bootstrap,
    workspace: spec.workspace,
    appliedAt,
    workspaceDir: bootstrapFiles.workspaceDir,
  });

  void syncTelegramBotForAssistant({
    assistantId,
    publishedVersionId,
    bootstrap: spec.bootstrap,
    workspace: spec.workspace,
    store,
    workspaceDir: bootstrapFiles.workspaceDir,
  }).catch((err) => {
    console.error(`[persai-runtime] Telegram bot sync failed for ${assistantId}:`, err);
  });

  return {
    appliedAt,
    workspaceDir: bootstrapFiles.workspaceDir,
    bootstrapFiles: {
      written: bootstrapFiles.written,
      skipped: bootstrapFiles.skipped,
    },
  };
}
