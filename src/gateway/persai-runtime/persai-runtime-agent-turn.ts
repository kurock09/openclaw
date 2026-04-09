import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { persaiRuntimeRequestContext } from "../../agents/openclaw-tools.js";
import { PersaiRuntimeToolLimitError } from "../../agents/persai-runtime-tool-limits.js";
import { isSilentReplyPrefixText, isSilentReplyText } from "../../auto-reply/tokens.js";
import { createDefaultDeps } from "../../cli/deps.js";
import { agentCommandFromIngress } from "../../commands/agent.js";
import type { OpenClawConfig } from "../../config/config.js";
import { onAgentEvent } from "../../infra/agent-events.js";
import { normalizeOutboundPayloads } from "../../infra/outbound/payloads.js";
import { logWarn } from "../../logger.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveAssistantStreamDeltaText } from "../agent-event-assistant-text.js";
import type { PersaiRuntimeTraceHandle } from "./persai-runtime-trace.js";

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

export type PersaiMediaArtifact = {
  url: string;
  type: "image" | "audio" | "video" | "document";
  audioAsVoice?: boolean;
};

type AgentResponse = {
  text: string;
  media: PersaiMediaArtifact[];
};

function inferMediaType(url: string): PersaiMediaArtifact["type"] {
  const lower = url.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|svg|bmp)$/.test(lower)) {
    return "image";
  }
  if (/\.(mp3|ogg|opus|wav|webm|m4a|aac|flac)$/.test(lower)) {
    return "audio";
  }
  if (/\.(mp4|mkv|avi|mov)$/.test(lower)) {
    return "video";
  }
  return "document";
}

function resolveAgentResponse(result: unknown): AgentResponse {
  const raw = result as { payloads?: unknown[] } | null;
  const payloads = Array.isArray(raw?.payloads) ? raw.payloads : [];

  if (payloads.length === 0) {
    return { text: "No response from OpenClaw.", media: [] };
  }

  const normalized = normalizeOutboundPayloads(payloads as never[]);

  const textParts: string[] = [];
  const media: PersaiMediaArtifact[] = [];

  for (const p of normalized) {
    if (p.text) {
      textParts.push(p.text);
    }
    for (const url of p.mediaUrls) {
      const baseType = inferMediaType(url);
      const isVoice = p.audioAsVoice === true && baseType === "audio";
      media.push({
        url,
        type: baseType,
        ...(isVoice ? { audioAsVoice: true } : {}),
      });
    }
  }

  const text = textParts.filter(Boolean).join("\n\n");
  if (!text && media.length === 0) {
    return { text: "No response from OpenClaw.", media: [] };
  }
  return { text, media };
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
  toolProviderOverrides?: Map<string, string>;
  toolDenyList?: string[];
  toolQuotaPolicy?: Map<string, { toolCode: string; dailyCallLimit: number | null }>;
  toolLimitWebhookUrl?: string;
  cronWebhookUrl?: string;
  workspaceDir?: string;
  assistantGender?: string | null;
  workspaceQuotaBytes?: number | null;
  configOverride?: OpenClawConfig;
  trace?: PersaiRuntimeTraceHandle;
}): Promise<
  | { ok: true; assistantMessage: string; media: PersaiMediaArtifact[] }
  | { ok: false; error: PersaiRuntimeTurnError }
> {
  const runId = randomUUID();
  params.trace?.stage("agent_turn.run_id_created", { runId });
  const deps = createDefaultDeps();
  params.trace?.stage("agent_turn.deps_created");
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
  params.trace?.stage("agent_turn.command_built");

  const runtimeCtx = {
    assistantId: params.assistantId,
    toolDenyList: params.toolDenyList,
    toolQuotaPolicy: params.toolQuotaPolicy,
    toolLimitWebhookUrl: params.toolLimitWebhookUrl,
    cronWebhookUrl: params.cronWebhookUrl,
    workspaceDir: params.workspaceDir,
    toolCredentials: params.resolvedToolCredentials,
    toolProviderOverrides: params.toolProviderOverrides,
    assistantGender: params.assistantGender,
    workspaceQuotaBytes: params.workspaceQuotaBytes,
    configOverride: params.configOverride,
  };
  params.trace?.stage("agent_turn.runtime_ctx_built");

  try {
    params.trace?.stage("agent_turn.request_context_enter");
    const result = await persaiRuntimeRequestContext.run(runtimeCtx, () =>
      agentCommandFromIngress(commandInput, defaultRuntime, deps),
    );
    params.trace?.stage("agent_turn.command_completed");
    const response = resolveAgentResponse(result);
    params.trace?.stage("agent_turn.response_resolved", {
      mediaCount: response.media.length,
      textLength: response.text.length,
    });
    return { ok: true, assistantMessage: response.text, media: response.media };
  } catch (err) {
    params.trace?.fail("agent_turn.sync_failed", err);
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
  toolProviderOverrides?: Map<string, string>;
  toolDenyList?: string[];
  toolQuotaPolicy?: Map<string, { toolCode: string; dailyCallLimit: number | null }>;
  toolLimitWebhookUrl?: string;
  cronWebhookUrl?: string;
  workspaceDir?: string;
  assistantGender?: string | null;
  workspaceQuotaBytes?: number | null;
  configOverride?: OpenClawConfig;
  trace?: PersaiRuntimeTraceHandle;
}): Promise<
  | { ok: true; assistantMessage: string; media: PersaiMediaArtifact[] }
  | { ok: false; error: PersaiRuntimeTurnError }
> {
  const runId = randomUUID();
  params.trace?.stage("agent_turn.run_id_created", { runId });
  const deps = createDefaultDeps();
  params.trace?.stage("agent_turn.deps_created");
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
  params.trace?.stage("agent_turn.command_built");

  const runtimeCtx = {
    assistantId: params.assistantId,
    toolDenyList: params.toolDenyList,
    toolQuotaPolicy: params.toolQuotaPolicy,
    toolLimitWebhookUrl: params.toolLimitWebhookUrl,
    cronWebhookUrl: params.cronWebhookUrl,
    workspaceDir: params.workspaceDir,
    toolCredentials: params.resolvedToolCredentials,
    toolProviderOverrides: params.toolProviderOverrides,
    assistantGender: params.assistantGender,
    workspaceQuotaBytes: params.workspaceQuotaBytes,
    configOverride: params.configOverride,
  };
  params.trace?.stage("agent_turn.runtime_ctx_built");

  try {
    params.trace?.stage("agent_turn.request_context_enter");
    const result = await persaiRuntimeRequestContext.run(runtimeCtx, () =>
      agentCommandFromIngress(commandInput, defaultRuntime, deps),
    );
    params.trace?.stage("agent_turn.command_completed");
    const response = resolveAgentResponse(result);
    params.trace?.stage("agent_turn.response_resolved", {
      mediaCount: response.media.length,
      textLength: response.text.length,
    });
    return { ok: true, assistantMessage: response.text, media: response.media };
  } catch (err) {
    params.trace?.fail("agent_turn.telegram_failed", err);
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
  toolProviderOverrides?: Map<string, string>;
  toolDenyList?: string[];
  toolQuotaPolicy?: Map<string, { toolCode: string; dailyCallLimit: number | null }>;
  toolLimitWebhookUrl?: string;
  cronWebhookUrl?: string;
  workspaceDir?: string;
  assistantGender?: string | null;
  workspaceQuotaBytes?: number | null;
  configOverride?: OpenClawConfig;
  trace?: PersaiRuntimeTraceHandle;
}): Promise<void> {
  const runId = randomUUID();
  params.trace?.stage("agent_turn.run_id_created", { runId });
  const deps = createDefaultDeps();
  params.trace?.stage("agent_turn.deps_created");
  const commandInput = buildPersaiWebIngressCommandInput({
    userMessage: params.userMessage,
    extraSystemPrompt: params.extraSystemPrompt,
    providerOverride: params.providerOverride,
    modelOverride: params.modelOverride,
    sessionKey: params.sessionKey,
    runId,
    workspaceDir: params.workspaceDir,
  });
  params.trace?.stage("agent_turn.command_built");

  const runtimeCtx = {
    assistantId: params.assistantId,
    toolDenyList: params.toolDenyList,
    toolQuotaPolicy: params.toolQuotaPolicy,
    toolLimitWebhookUrl: params.toolLimitWebhookUrl,
    cronWebhookUrl: params.cronWebhookUrl,
    workspaceDir: params.workspaceDir,
    toolCredentials: params.resolvedToolCredentials,
    toolProviderOverrides: params.toolProviderOverrides,
    assistantGender: params.assistantGender,
    workspaceQuotaBytes: params.workspaceQuotaBytes,
    configOverride: params.configOverride,
  };
  params.trace?.stage("agent_turn.runtime_ctx_built");

  let closed = false;
  let sawAssistantDelta = false;
  let sawThinkingDelta = false;
  let finalTraceStatus: "ok" | "error" = "ok";

  const unsubscribe = onAgentEvent((evt) => {
    if (evt.runId !== runId || closed) {
      return;
    }
    if (evt.stream === "compaction") {
      const phase = typeof evt.data?.phase === "string" ? evt.data.phase : "";
      if (phase === "start" || phase === "end") {
        params.res.write(
          `${JSON.stringify({
            type: "compaction",
            phase,
            completed: evt.data?.completed === true,
            willRetry: evt.data?.willRetry === true,
          })}\n`,
        );
      }
      return;
    }
    if (evt.stream === "assistant") {
      const content = resolveAssistantStreamDeltaText(evt) ?? "";
      if (content && !isSilentReplyText(content) && !isSilentReplyPrefixText(content)) {
        if (!sawAssistantDelta) {
          sawAssistantDelta = true;
          params.trace?.stage("agent_turn.first_assistant_delta", {
            deltaLength: content.length,
          });
        }
        params.res.write(`${JSON.stringify({ type: "delta", delta: content })}\n`);
      }
      return;
    }
    if (evt.stream === "thinking") {
      const delta = typeof evt.data?.delta === "string" ? evt.data.delta : "";
      const text = typeof evt.data?.text === "string" ? evt.data.text : "";
      if (delta && text) {
        if (!sawThinkingDelta) {
          sawThinkingDelta = true;
          params.trace?.stage("agent_turn.first_thinking_delta", {
            deltaLength: delta.length,
          });
        }
        params.res.write(`${JSON.stringify({ type: "thinking", delta, text })}\n`);
      }
      return;
    }
  });

  params.req.on("close", () => {
    closed = true;
    unsubscribe();
  });

  return new Promise((resolve) => {
    void (async () => {
      try {
        params.trace?.stage("agent_turn.request_context_enter");
        const result = await persaiRuntimeRequestContext.run(runtimeCtx, () =>
          agentCommandFromIngress(commandInput, defaultRuntime, deps),
        );
        params.trace?.stage("agent_turn.command_completed");
        if (closed) {
          return;
        }
        const response = resolveAgentResponse(result);
        params.trace?.stage("agent_turn.response_resolved", {
          mediaCount: response.media.length,
          textLength: response.text.length,
          sawAssistantDelta,
        });
        if (!sawAssistantDelta && response.text) {
          params.res.write(`${JSON.stringify({ type: "delta", delta: response.text })}\n`);
        }
        if (response.media.length > 0) {
          params.res.write(`${JSON.stringify({ type: "media", media: response.media })}\n`);
        }
      } catch (err) {
        finalTraceStatus = "error";
        params.trace?.fail("agent_turn.stream_failed", err);
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
          const runtimeTrace = params.trace?.finish(finalTraceStatus);
          params.res.write(
            `${JSON.stringify({
              type: "done",
              respondedAt: new Date().toISOString(),
              ...(runtimeTrace ? { runtimeTrace } : {}),
            })}\n`,
          );
          params.res.end();
        }
        resolve();
      }
    })();
  });
}
