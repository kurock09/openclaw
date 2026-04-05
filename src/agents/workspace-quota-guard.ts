import { execSync } from "node:child_process";
import { persaiRuntimeRequestContext } from "./persai-runtime-context.js";

const CACHE_TTL_MS = 30_000;

const usageCache = new Map<string, { bytes: number; ts: number }>();

export function getWorkspaceUsageBytes(workspaceDir: string): number {
  const now = Date.now();
  const cached = usageCache.get(workspaceDir);
  if (cached && now - cached.ts < CACHE_TTL_MS) return cached.bytes;

  try {
    const out = execSync(`du -sb "${workspaceDir}"`, {
      timeout: 10_000,
      encoding: "utf8",
    });
    const bytes = parseInt(out.split("\t")[0], 10) || 0;
    usageCache.set(workspaceDir, { bytes, ts: now });
    return bytes;
  } catch {
    return cached?.bytes ?? 0;
  }
}

export function enforceWorkspaceQuota(params: {
  workspaceDir: string;
  additionalBytes?: number;
  quotaBytes: number;
}): { allowed: boolean; usedBytes: number; quotaBytes: number } {
  const used = getWorkspaceUsageBytes(params.workspaceDir);
  const total = used + (params.additionalBytes ?? 0);
  return {
    allowed: total <= params.quotaBytes,
    usedBytes: used,
    quotaBytes: params.quotaBytes,
  };
}

export function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1_048_576) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1_073_741_824) return `${(b / 1_048_576).toFixed(1)} MB`;
  return `${(b / 1_073_741_824).toFixed(1)} GB`;
}

/**
 * Read the workspace quota and directory from the current PersAI runtime
 * request context. Returns null when quota is not configured or there is
 * no active request context.
 */
export function getWorkspaceQuotaFromContext(): {
  workspaceDir: string;
  quotaBytes: number;
} | null {
  const ctx = persaiRuntimeRequestContext.getStore();
  if (!ctx?.workspaceQuotaBytes || !ctx.workspaceDir) return null;
  return { workspaceDir: ctx.workspaceDir, quotaBytes: ctx.workspaceQuotaBytes };
}
