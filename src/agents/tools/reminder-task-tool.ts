import { Type } from "@sinclair/typebox";
import { loadConfig } from "../../config/config.js";
import { persaiRuntimeRequestContext } from "../persai-runtime-context.js";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readNumberParam, readStringParam } from "./common.js";

const REMINDER_TASK_ACTIONS = ["create", "list", "pause", "resume", "cancel"] as const;
const REMINDER_CONTEXT_MESSAGES_MAX = 10;

const ReminderTaskToolSchema = Type.Object(
  {
    action: stringEnum(REMINDER_TASK_ACTIONS),
    title: Type.Optional(Type.String()),
    reminderText: Type.Optional(Type.String()),
    taskId: Type.Optional(Type.String()),
    titleMatch: Type.Optional(Type.String()),
    runAt: Type.Optional(Type.String()),
    delayMs: Type.Optional(Type.Number({ minimum: 1 })),
    everyMs: Type.Optional(Type.Number({ minimum: 1 })),
    anchorAt: Type.Optional(Type.String()),
    cronExpr: Type.Optional(Type.String()),
    timezone: Type.Optional(Type.String()),
    contextMessages: Type.Optional(
      Type.Number({ minimum: 0, maximum: REMINDER_CONTEXT_MESSAGES_MAX }),
    ),
  },
  { additionalProperties: true },
);

type ReminderTaskToolOptions = {
  agentSessionKey?: string;
};

type InternalTaskItem = {
  id: string;
  title: string;
  controlStatus: "active" | "disabled";
  nextRunAt: string | null;
  externalRef: string | null;
};

function normalizeNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function resolvePersaiInternalApiBaseUrl(): string | undefined {
  const cfg = loadConfig();
  const provider = cfg.secrets?.providers?.["persai-runtime"];
  return provider?.source === "persai" ? provider.baseUrl : undefined;
}

async function fetchInternalTaskItems(assistantId: string): Promise<InternalTaskItem[]> {
  const baseUrl = resolvePersaiInternalApiBaseUrl();
  const token = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
  if (!baseUrl || !token || !assistantId.trim()) {
    return [];
  }

  const url = `${baseUrl}/api/v1/internal/runtime/tasks/items?assistantId=${encodeURIComponent(assistantId)}`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  if (!response.ok) {
    throw new Error(`PersAI internal task list failed: ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as { items?: unknown };
  return Array.isArray(payload.items)
    ? payload.items.filter((item): item is InternalTaskItem => {
        if (item === null || typeof item !== "object" || Array.isArray(item)) {
          return false;
        }
        const row = item as Record<string, unknown>;
        return (
          typeof row.id === "string" &&
          typeof row.title === "string" &&
          (row.controlStatus === "active" || row.controlStatus === "disabled") &&
          (row.nextRunAt === null || typeof row.nextRunAt === "string") &&
          (row.externalRef === null || typeof row.externalRef === "string")
        );
      })
    : [];
}

async function postReminderTaskControl(body: Record<string, unknown>): Promise<unknown> {
  const baseUrl = resolvePersaiInternalApiBaseUrl();
  const token = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
  if (!baseUrl || !token) {
    throw new Error("PersAI internal task control is not configured.");
  }

  const response = await fetch(`${baseUrl}/api/v1/internal/runtime/tasks/control`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    let message = `PersAI internal task control failed: ${response.status} ${response.statusText}`;
    try {
      const payload = (await response.json()) as {
        error?: { message?: unknown } | string;
      };
      if (
        payload?.error &&
        typeof payload.error === "object" &&
        !Array.isArray(payload.error) &&
        typeof payload.error.message === "string" &&
        payload.error.message.trim().length > 0
      ) {
        message = payload.error.message.trim();
      } else if (typeof payload?.error === "string" && payload.error.trim().length > 0) {
        message = payload.error.trim();
      }
    } catch {
      // Ignore JSON parsing issues and keep the generic status-based message.
    }
    throw new Error(message);
  }
  return (await response.json()) as unknown;
}

function buildCreateRulesDescription(): string {
  return [
    "CREATE RULES:",
    "- title is required",
    "- exactly one schedule must be provided: runAt, delayMs, everyMs, or cronExpr",
    "- reminderText is the text delivered when the reminder fires; defaults to title",
    "- use contextMessages (0-10) to include recent chat context in the reminder payload",
    "- for relative one-time reminders like 'in 5 minutes', prefer delayMs instead of calculating runAt yourself",
    "- use runAt only for an already-resolved absolute datetime in the future",
  ].join("\n");
}

async function resolveTaskTarget(params: {
  assistantId: string;
  taskId?: string;
  titleMatch?: string;
}): Promise<InternalTaskItem> {
  const items = await fetchInternalTaskItems(params.assistantId);
  if (params.taskId) {
    const match = items.find((item) => item.id === params.taskId);
    if (!match) {
      throw new Error(`Task "${params.taskId}" was not found.`);
    }
    return match;
  }

  const titleMatch = params.titleMatch?.toLowerCase();
  if (!titleMatch) {
    throw new Error("taskId or titleMatch is required.");
  }

  const matches = items.filter((item) => item.title.toLowerCase().includes(titleMatch));
  if (matches.length === 0) {
    throw new Error(`No current task matched "${params.titleMatch}".`);
  }
  if (matches.length > 1) {
    throw new Error(`Multiple current tasks matched "${params.titleMatch}". Use taskId.`);
  }
  return matches[0];
}

export function createReminderTaskTool(opts?: ReminderTaskToolOptions): AnyAgentTool {
  return {
    label: "Reminder Task",
    name: "reminder_task",
    ownerOnly: true,
    description: `Create, list, pause, resume, and cancel reminders or recurring tasks.

Use this tool for user-facing reminder/task requests instead of cron.

ACTIONS:
- create: create a one-time or recurring reminder/task
- list: show current active/paused reminders/tasks
- pause: pause an active reminder/task
- resume: resume a paused reminder/task
- cancel: permanently cancel and remove a reminder/task

${buildCreateRulesDescription()}

TARGET RULES:
- pause/resume/cancel prefer taskId from a prior list result
- if taskId is unavailable, use titleMatch to resolve one current task by title`,
    parameters: ReminderTaskToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const runtimeCtx = persaiRuntimeRequestContext.getStore();
      const assistantId = runtimeCtx?.assistantId?.trim() ?? "";

      if (!assistantId) {
        throw new Error("PersAI assistant context is required for reminder_task.");
      }

      switch (action) {
        case "list": {
          const items = await fetchInternalTaskItems(assistantId);
          return jsonResult({
            items: items.map((item) => ({
              id: item.id,
              title: item.title,
              controlStatus: item.controlStatus,
              nextRunAt: item.nextRunAt,
            })),
          });
        }

        case "create": {
          const title = readStringParam(params, "title", { required: true });
          const reminderText = readStringParam(params, "reminderText") ?? title;
          const delayMs = readNumberParam(params, "delayMs");
          const everyMs = readNumberParam(params, "everyMs");
          const response = await postReminderTaskControl({
            assistantId,
            action: "create",
            title,
            reminderText,
            ...(opts?.agentSessionKey ? { contextSessionKey: opts.agentSessionKey } : {}),
            ...(normalizeNonEmptyString(params.runAt)
              ? { runAt: normalizeNonEmptyString(params.runAt) }
              : {}),
            ...(delayMs !== undefined ? { delayMs } : {}),
            ...(everyMs !== undefined ? { everyMs } : {}),
            ...(normalizeNonEmptyString(params.anchorAt)
              ? { anchorAt: normalizeNonEmptyString(params.anchorAt) }
              : {}),
            ...(normalizeNonEmptyString(params.cronExpr)
              ? { cronExpr: normalizeNonEmptyString(params.cronExpr) }
              : {}),
            ...(normalizeNonEmptyString(params.timezone)
              ? { timezone: normalizeNonEmptyString(params.timezone) }
              : {}),
            ...(typeof params.contextMessages === "number" &&
            Number.isFinite(params.contextMessages)
              ? { contextMessages: params.contextMessages }
              : {}),
          });
          return jsonResult(response);
        }

        case "pause":
        case "resume": {
          const target = await resolveTaskTarget({
            assistantId,
            taskId: readStringParam(params, "taskId"),
            titleMatch: readStringParam(params, "titleMatch"),
          });
          const response = await postReminderTaskControl({
            assistantId,
            action,
            taskId: target.id,
          });
          return jsonResult(response);
        }

        case "cancel": {
          const target = await resolveTaskTarget({
            assistantId,
            taskId: readStringParam(params, "taskId"),
            titleMatch: readStringParam(params, "titleMatch"),
          });
          const response = await postReminderTaskControl({
            assistantId,
            action: "cancel",
            taskId: target.id,
          });
          return jsonResult(response);
        }

        default:
          throw new Error(`Unknown action: ${action}`);
      }
    },
  };
}
