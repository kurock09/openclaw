import type { IncomingMessage } from "node:http";

export type PersaiRuntimeTraceStagePayload = {
  key: string;
  durationMs: number;
};

export type PersaiRuntimeTracePayload = {
  traceId: string;
  scope: string;
  status: string;
  totalMs: number;
  stages: PersaiRuntimeTraceStagePayload[];
};

type ActivePoint = {
  key: string;
  atMs: number;
};

function computeStages(points: ActivePoint[]): PersaiRuntimeTraceStagePayload[] {
  const result: PersaiRuntimeTraceStagePayload[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (!previous || !current) {
      continue;
    }
    result.push({
      key: `${previous.key} -> ${current.key}`,
      durationMs: Math.max(0, current.atMs - previous.atMs),
    });
  }
  return result;
}

export function readPersaiRuntimeTraceRequest(req: IncomingMessage): {
  enabled: boolean;
  traceId: string | null;
} {
  const raw =
    typeof req.headers["x-persai-overview-trace-id"] === "string"
      ? req.headers["x-persai-overview-trace-id"].trim()
      : "";
  return {
    enabled: raw.length > 0,
    traceId: raw.length > 0 ? raw : null,
  };
}

export interface PersaiRuntimeTraceHandle {
  readonly enabled: boolean;
  readonly traceId: string;
  stage(stage: string, details?: Record<string, unknown>): void;
  finish(status: string, details?: Record<string, unknown>): PersaiRuntimeTracePayload | null;
  fail(stage: string, error: unknown, details?: Record<string, unknown>): void;
}

export function createPersaiRuntimeTrace(params: {
  enabled: boolean;
  scope: string;
  traceId: string;
  meta?: Record<string, unknown>;
}): PersaiRuntimeTraceHandle {
  const startedAtMs = Date.now();
  const points: ActivePoint[] = [{ key: "start", atMs: startedAtMs }];

  return {
    enabled: params.enabled,
    traceId: params.traceId,
    stage(stage: string, _details?: Record<string, unknown>) {
      if (!params.enabled) {
        return;
      }
      points.push({ key: stage, atMs: Date.now() });
    },
    finish(status: string, _details?: Record<string, unknown>) {
      if (!params.enabled) {
        return null;
      }
      const finishedAtMs = Date.now();
      const finalPoints = [...points, { key: "finish", atMs: finishedAtMs }];
      return {
        traceId: params.traceId,
        scope: params.scope,
        status,
        totalMs: Math.max(0, finishedAtMs - startedAtMs),
        stages: computeStages(finalPoints),
      };
    },
    fail(stage: string, _error: unknown, _details?: Record<string, unknown>) {
      if (!params.enabled) {
        return;
      }
      points.push({ key: `${stage}:error`, atMs: Date.now() });
    },
  };
}
