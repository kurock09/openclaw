import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { persaiRuntimeRequestContext } from "../../agents/openclaw-tools.js";
import { PersaiRuntimeToolLimitError } from "../../agents/persai-runtime-tool-limits.js";
import { createDefaultDeps } from "../../cli/deps.js";
import { agentCommandFromIngress } from "../../commands/agent.js";
import { onAgentEvent } from "../../infra/agent-events.js";
import { logWarn } from "../../logger.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveAssistantStreamDeltaText } from "../agent-event-assistant-text.js";

type PersaiRuntimeTurnError = {
  code: string;
  message: string;
  status: number;
};

function toPersaiRuntimeTurnError(error: unknown): PersaiRuntimeTurnError {
  if (error instanceof PersaiRuntimeToolLimitError) {
    return {
      code: error.code,
      message: error.message,
      status: error.status,
    };
  }
  if (error instanceof Error) {
    return {
      code: "assistant_turn_failed",
      message: error.message,
      status: 500,
    };
  }
  return {
    code: "assistant_turn_failed",
    message: String(error),
    status: 500,
  };
}

function resolveAgentResponseText(result: unknown): string {
  const payloads = (result as { payloads?: Array<{ text?: string }> } | null)?.payloads;
  if (!Array.isArray(payloads) || payloads.length === 0) {
    return "No response from OpenClaw.";
  }
  const content = payloads
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .filter(Boolean)
    .join("\n\n");
  return content || "No response from OpenClaw.";
}

function buildPersaiWebIngressCommandInput(params: {
  userMessage: string;
  extraSystemPrompt?: string;
  providerOverride?: string;
  modelOverride?: string;
  reasoning?: string;
  sessionKey: string;
  runId: string;
  workspaceDir?: string;
}) {
  return {
    message: params.userMessage,
    extraSystemPrompt: params.extraSystemPrompt,
    provider: params.providerOverride,
    model: params.modelOverride,
    reasoning: params.reasoning,
    sessionKey: params.sessionKey,
    runId: params.runId,
    deliver: false as const,
    messageChannel: "webchat" as const,
    bestEffortDeliver: false as const,
    senderIsOwner: true as const,
    allowModelOverride: true as const,
    workspaceDir: params.workspaceDir,
  };
}

/** P3: one full embedded agent turn for PersAI web runtime (sync). */
export async function runPersaiWebRuntimeAgentTurnSync(params: {
  assistantId: string;
  userMessage: string;
  sessionKey: string;
  extraSystemPrompt?: string;
  providerOverride?: string;
  modelOverride?: string;
  resolvedToolCredentials?: Map<string, string>;
  toolDenyList?: string[];
  toolQuotaPolicy?: Map<string, { toolCode: string; dailyCallLimit: number | null }>;
  toolLimitWebhookUrl?: string;
  cronWebhookUrl?: string;
  workspaceDir?: string;
}): Promise<{ ok: true; assistantMessage: string } | { ok: false; error: PersaiRuntimeTurnError }> {
  const runId = randomUUID();
  const deps = createDefaultDeps();
  const commandInput = buildPersaiWebIngressCommandInput({
    userMessage: params.userMessage,
    extraSystemPrompt: params.extraSystemPrompt,
    providerOverride: params.providerOverride,
    modelOverride: params.modelOverride,
    reasoning: "stream",
    sessionKey: params.sessionKey,
    runId,
    workspaceDir: params.workspaceDir,
  });

  const runtimeCtx = {
    assistantId: params.assistantId,
    toolDenyList: params.toolDenyList,
    toolQuotaPolicy: params.toolQuotaPolicy,
    toolLimitWebhookUrl: params.toolLimitWebhookUrl,
    cronWebhookUrl: params.cronWebhookUrl,
    workspaceDir: params.workspaceDir,
    toolCredentials: params.resolvedToolCredentials,
  };

  try {
    const result = await persaiRuntimeRequestContext.run(runtimeCtx, () =>
      agentCommandFromIngress(commandInput, defaultRuntime, deps),
    );
    return { ok: true, assistantMessage: resolveAgentResponseText(result) };
  } catch (err) {
    const normalized = toPersaiRuntimeTurnError(err);
    logWarn(`persai-runtime: sync agent turn failed: ${normalized.message}`);
    return { ok: false, error: normalized };
  }
}

/** Telegram agent turn (sync, non-streaming). */
export async function runPersaiTelegramAgentTurn(params: {
  assistantId: string;
  userMessage: string;
  sessionKey: string;
  extraSystemPrompt?: string;
  providerOverride?: string;
  modelOverride?: string;
  resolvedToolCredentials?: Map<string, string>;
  toolDenyList?: string[];
  toolQuotaPolicy?: Map<string, { toolCode: string; dailyCallLimit: number | null }>;
  toolLimitWebhookUrl?: string;
  cronWebhookUrl?: string;
  workspaceDir?: string;
}): Promise<{ ok: true; assistantMessage: string } | { ok: false; error: PersaiRuntimeTurnError }> {
  const runId = randomUUID();
  const deps = createDefaultDeps();
  const commandInput = {
    message: params.userMessage,
    extraSystemPrompt: params.extraSystemPrompt,
    provider: params.providerOverride,
    model: params.modelOverride,
    sessionKey: params.sessionKey,
    runId,
    deliver: false as const,
    messageChannel: "telegram" as const,
    bestEffortDeliver: false as const,
    senderIsOwner: true as const,
    allowModelOverride: true as const,
    workspaceDir: params.workspaceDir,
  };

  const runtimeCtx = {
    assistantId: params.assistantId,
    toolDenyList: params.toolDenyList,
    toolQuotaPolicy: params.toolQuotaPolicy,
    toolLimitWebhookUrl: params.toolLimitWebhookUrl,
    cronWebhookUrl: params.cronWebhookUrl,
    workspaceDir: params.workspaceDir,
    toolCredentials: params.resolvedToolCredentials,
  };

  try {
    const result = await persaiRuntimeRequestContext.run(runtimeCtx, () =>
      agentCommandFromIngress(commandInput, defaultRuntime, deps),
    );
    return { ok: true, assistantMessage: resolveAgentResponseText(result) };
  } catch (err) {
    const normalized = toPersaiRuntimeTurnError(err);
    logWarn(`persai-runtime: telegram agent turn failed: ${normalized.message}`);
    return { ok: false, error: normalized };
  }
}

/**
 * P3: stream assistant text as PersAI NDJSON (`delta` / `done`).
 * Mirrors openai-http streaming lifecycle handling.
 */
export function runPersaiWebRuntimeAgentTurnStream(params: {
  req: IncomingMessage;
  res: ServerResponse;
  assistantId: string;
  userMessage: string;
  sessionKey: string;
  extraSystemPrompt?: string;
  providerOverride?: string;
  modelOverride?: string;
  resolvedToolCredentials?: Map<string, string>;
  toolDenyList?: string[];
  toolQuotaPolicy?: Map<string, { toolCode: string; dailyCallLimit: number | null }>;
  toolLimitWebhookUrl?: string;
  cronWebhookUrl?: string;
  workspaceDir?: string;
}): Promise<void> {
  const runId = randomUUID();
  const deps = createDefaultDeps();
  const commandInput = buildPersaiWebIngressCommandInput({
    userMessage: params.userMessage,
    extraSystemPrompt: params.extraSystemPrompt,
    providerOverride: params.providerOverride,
    modelOverride: params.modelOverride,
    sessionKey: params.sessionKey,
    runId,
    workspaceDir: params.workspaceDir,
  });

  const runtimeCtx = {
    assistantId: params.assistantId,
    toolDenyList: params.toolDenyList,
    toolQuotaPolicy: params.toolQuotaPolicy,
    toolLimitWebhookUrl: params.toolLimitWebhookUrl,
    cronWebhookUrl: params.cronWebhookUrl,
    workspaceDir: params.workspaceDir,
    toolCredentials: params.resolvedToolCredentials,
  };

  let closed = false;
  let sawAssistantDelta = false;

  const unsubscribe = onAgentEvent((evt) => {
    if (evt.runId !== runId || closed) {
      return;
    }
    if (evt.stream === "assistant") {
      const content = resolveAssistantStreamDeltaText(evt) ?? "";
      if (content) {
        sawAssistantDelta = true;
        params.res.write(`${JSON.stringify({ type: "delta", delta: content })}\n`);
      }
      return;
    }
    if (evt.stream === "thinking") {
      const delta = typeof evt.data?.delta === "string" ? evt.data.delta : "";
      const text = typeof evt.data?.text === "string" ? evt.data.text : "";
      if (delta && text) {
        params.res.write(`${JSON.stringify({ type: "thinking", delta, text })}\n`);
      }
      return;
    }
    if (evt.stream === "lifecycle") {
      const phase = evt.data?.phase;
      if (phase === "end" || phase === "error") {
        closed = true;
        unsubscribe();
        params.res.write(
          `${JSON.stringify({ type: "done", respondedAt: new Date().toISOString() })}\n`,
        );
        params.res.end();
      }
    }
  });

  params.req.on("close", () => {
    closed = true;
    unsubscribe();
  });

  return new Promise((resolve) => {
    void (async () => {
      try {
        const result = await persaiRuntimeRequestContext.run(runtimeCtx, () =>
          agentCommandFromIngress(commandInput, defaultRuntime, deps),
        );
        if (closed) {
          return;
        }
        if (!sawAssistantDelta) {
          const content = resolveAgentResponseText(result);
          params.res.write(`${JSON.stringify({ type: "delta", delta: content })}\n`);
        }
      } catch (err) {
        const normalized = toPersaiRuntimeTurnError(err);
        logWarn(`persai-runtime: stream agent turn failed: ${normalized.message}`);
        if (!closed) {
          params.res.write(
            `${JSON.stringify({
              type: "failed",
              code: normalized.code,
              message: normalized.message,
            })}\n`,
          );
        }
      } finally {
        if (!closed) {
          closed = true;
          unsubscribe();
          params.res.write(
            `${JSON.stringify({ type: "done", respondedAt: new Date().toISOString() })}\n`,
          );
          params.res.end();
        }
        resolve();
      }
    })();
  });
}
