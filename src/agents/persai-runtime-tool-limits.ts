import { persaiRuntimeRequestContext } from "./persai-runtime-context.js";

type ToolQuotaPolicyEntry = {
  toolCode: string;
  dailyCallLimit: number | null;
};

type ConsumeFailurePayload = {
  error?: {
    code?: unknown;
    message?: unknown;
  };
  code?: unknown;
  message?: unknown;
};

function readPayloadCode(payload: ConsumeFailurePayload): string | null {
  if (typeof payload.error?.code === "string" && payload.error.code.trim().length > 0) {
    return payload.error.code.trim();
  }
  return typeof payload.code === "string" && payload.code.trim().length > 0
    ? payload.code.trim()
    : null;
}

function readPayloadMessage(payload: ConsumeFailurePayload): string | null {
  if (typeof payload.error?.message === "string" && payload.error.message.trim().length > 0) {
    return payload.error.message.trim();
  }
  return typeof payload.message === "string" && payload.message.trim().length > 0
    ? payload.message.trim()
    : null;
}

export class PersaiRuntimeToolLimitError extends Error {
  readonly code = "tool_daily_limit_reached";
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = "PersaiRuntimeToolLimitError";
  }
}

export async function enforcePersaiRuntimeToolLimit(toolName: string): Promise<void> {
  const runtimeCtx = persaiRuntimeRequestContext.getStore();
  const assistantId = runtimeCtx?.assistantId?.trim();
  const webhookUrl = runtimeCtx?.toolLimitWebhookUrl?.trim();
  const token = process.env.PERSAI_INTERNAL_API_TOKEN?.trim();
  const quotaEntry = runtimeCtx?.toolQuotaPolicy?.get(toolName) as ToolQuotaPolicyEntry | undefined;

  if (!assistantId || !webhookUrl || !token || !quotaEntry || quotaEntry.dailyCallLimit === null) {
    return;
  }

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      assistantId,
      toolCode: quotaEntry.toolCode,
      dailyCallLimit: quotaEntry.dailyCallLimit,
    }),
  });
  if (response.ok) {
    return;
  }

  let payload: ConsumeFailurePayload = {};
  try {
    payload = (await response.json()) as ConsumeFailurePayload;
  } catch {
    payload = {};
  }

  const code = readPayloadCode(payload);
  const message =
    readPayloadMessage(payload) ??
    `PersAI tool limit enforcement failed for "${toolName}" with HTTP ${response.status}.`;
  if (code === "tool_daily_limit_reached") {
    throw new PersaiRuntimeToolLimitError(message);
  }
  throw new Error(message);
}
