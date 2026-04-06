import { execSync } from "node:child_process";
import { persaiRuntimeRequestContext } from "./persai-runtime-context.js";

const CACHE_TTL_MS = 30_000;

const usageCache = new Map<string, { bytes: number; ts: number }>();

type WorkspaceUsageMeasurement = { ok: true; bytes: number } | { ok: false; reason: string };

function readWorkspaceUsageBytes(workspaceDir: string): WorkspaceUsageMeasurement {
  const now = Date.now();
  const cached = usageCache.get(workspaceDir);
  if (cached && now - cached.ts < CACHE_TTL_MS) {
    return { ok: true, bytes: cached.bytes };
  }

  try {
    const out = execSync(`du -sb "${workspaceDir}"`, {
      timeout: 10_000,
      encoding: "utf8",
    });
    const match = out.trim().match(/^(\d+)(?:\s|$)/);
    if (!match) {
      return { ok: false, reason: "Unexpected du output." };
    }
    const bytes = Number.parseInt(match[1], 10);
    if (!Number.isFinite(bytes) || bytes < 0) {
      return { ok: false, reason: "Invalid workspace usage measurement." };
    }
    usageCache.set(workspaceDir, { bytes, ts: now });
    return { ok: true, bytes };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "Workspace usage measurement failed.",
    };
  }
}

export function getWorkspaceUsageBytes(workspaceDir: string): number {
  const measurement = readWorkspaceUsageBytes(workspaceDir);
  return measurement.ok ? measurement.bytes : 0;
}

export function enforceWorkspaceQuota(params: {
  workspaceDir: string;
  additionalBytes?: number;
  quotaBytes: number;
}): {
  allowed: boolean;
  usedBytes: number;
  quotaBytes: number;
  measurementFailed?: boolean;
  measurementFailureReason?: string;
} {
  const measurement = readWorkspaceUsageBytes(params.workspaceDir);
  if (!measurement.ok) {
    return {
      allowed: false,
      usedBytes: 0,
      quotaBytes: params.quotaBytes,
      measurementFailed: true,
      measurementFailureReason: measurement.reason,
    };
  }
  const used = measurement.bytes;
  const total = used + (params.additionalBytes ?? 0);
  return {
    allowed: total <= params.quotaBytes,
    usedBytes: used,
    quotaBytes: params.quotaBytes,
  };
}

export function invalidateWorkspaceCache(workspaceDir: string): void {
  usageCache.delete(workspaceDir);
}

export function adjustWorkspaceUsageCache(workspaceDir: string, deltaBytes: number): void {
  const cached = usageCache.get(workspaceDir);
  if (!cached || !Number.isFinite(deltaBytes) || deltaBytes === 0) {
    return;
  }
  usageCache.set(workspaceDir, {
    bytes: Math.max(0, cached.bytes + deltaBytes),
    ts: Date.now(),
  });
}

export function formatBytes(b: number): string {
  if (b < 1024) {
    return `${b} B`;
  }
  if (b < 1_048_576) {
    return `${(b / 1024).toFixed(1)} KB`;
  }
  if (b < 1_073_741_824) {
    return `${(b / 1_048_576).toFixed(1)} MB`;
  }
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
  if (!ctx?.workspaceQuotaBytes || !ctx.workspaceDir) {
    return null;
  }
  return { workspaceDir: ctx.workspaceDir, quotaBytes: ctx.workspaceQuotaBytes };
}
