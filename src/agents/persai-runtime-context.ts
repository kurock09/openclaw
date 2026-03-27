import { AsyncLocalStorage } from "node:async_hooks";

export interface PersaiRuntimeRequestCtx {
  toolDenyList?: string[];
  workspaceDir?: string;
  /** Per-request resolved tool credentials (env var name → secret value). */
  toolCredentials?: Map<string, string>;
}

/**
 * Per-request context for PersAI runtime. Allows concurrent requests to carry
 * their own toolDenyList, workspaceDir, and toolCredentials without sharing
 * process.env.
 *
 * Extracted to a dependency-free module so that low-level helpers (memory tools,
 * workspace resolution, extension credential resolvers) can read the store
 * without pulling in the full openclaw-tools graph.
 */
export const persaiRuntimeRequestContext = new AsyncLocalStorage<PersaiRuntimeRequestCtx>();

/**
 * Read a per-request tool credential by its conventional env var name
 * (e.g. "TAVILY_API_KEY"). Returns `undefined` when called outside a PersAI
 * runtime request or when the credential was not injected.
 */
export function getPersaiToolCredential(envVar: string): string | undefined {
  return persaiRuntimeRequestContext.getStore()?.toolCredentials?.get(envVar);
}
