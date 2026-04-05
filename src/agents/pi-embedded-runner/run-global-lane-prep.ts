import type { OpenClawConfig } from "../../config/config.js";
import { resolveOpenClawAgentDir } from "../agent-paths.js";
import { hasConfiguredModelFallbacks } from "../agent-scope.js";
import { ensureOpenClawModelsJson } from "../models-config.js";
import { resolveRunWorkspaceDir, type ResolveRunWorkspaceResult } from "../workspace-run.js";

export type EmbeddedRunGlobalLanePrep = {
  workspaceResolution: ResolveRunWorkspaceResult;
  resolvedWorkspace: string;
  agentDir: string;
  fallbackConfigured: boolean;
};

type PrepareEmbeddedRunBeforeGlobalLaneDeps = {
  resolveRunWorkspaceDir: typeof resolveRunWorkspaceDir;
  resolveOpenClawAgentDir: typeof resolveOpenClawAgentDir;
  hasConfiguredModelFallbacks: typeof hasConfiguredModelFallbacks;
  ensureOpenClawModelsJson: typeof ensureOpenClawModelsJson;
};

const defaultDeps: PrepareEmbeddedRunBeforeGlobalLaneDeps = {
  resolveRunWorkspaceDir,
  resolveOpenClawAgentDir,
  hasConfiguredModelFallbacks,
  ensureOpenClawModelsJson,
};

export async function prepareEmbeddedRunBeforeGlobalLane(
  params: {
    workspaceDir?: string;
    sessionKey?: string;
    agentId?: string;
    config?: OpenClawConfig;
    agentDir?: string;
  },
  deps: PrepareEmbeddedRunBeforeGlobalLaneDeps = defaultDeps,
): Promise<EmbeddedRunGlobalLanePrep> {
  const workspaceResolution = deps.resolveRunWorkspaceDir({
    workspaceDir: params.workspaceDir,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    config: params.config,
  });
  const resolvedWorkspace = workspaceResolution.workspaceDir;
  const agentDir = params.agentDir ?? deps.resolveOpenClawAgentDir();
  const fallbackConfigured = deps.hasConfiguredModelFallbacks({
    cfg: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });

  // models.json preparation is cache-backed and write-lock guarded, so it can
  // happen before the global active-turn lane without changing run ordering.
  await deps.ensureOpenClawModelsJson(params.config, agentDir);

  return {
    workspaceResolution,
    resolvedWorkspace,
    agentDir,
    fallbackConfigured,
  };
}
