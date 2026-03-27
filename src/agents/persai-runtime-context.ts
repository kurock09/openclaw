import { AsyncLocalStorage } from "node:async_hooks";

export interface PersaiRuntimeRequestCtx {
  toolDenyList?: string[];
  workspaceDir?: string;
}

/**
 * Per-request context for PersAI runtime. Allows concurrent requests to carry
 * their own toolDenyList and workspaceDir without sharing process.env.
 *
 * Extracted to a dependency-free module so that low-level helpers (memory tools,
 * workspace resolution) can read the store without pulling in the full
 * openclaw-tools graph.
 */
export const persaiRuntimeRequestContext = new AsyncLocalStorage<PersaiRuntimeRequestCtx>();
