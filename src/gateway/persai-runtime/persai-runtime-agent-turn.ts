import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { persaiRuntimeRequestContext } from "../../agents/openclaw-tools.js";
import { PersaiRuntimeToolLimitError } from "../../agents/persai-runtime-tool-limits.js";
import { createDefaultDeps } from "../../cli/deps.js";
import { agentCommandFromIngress } from "../../commands/agent.js";
import { loadConfig } from "../../config/config.js";
import { onAgentEvent } from "../../infra/agent-events.js";
import { normalizeOutboundPayloads } from "../../infra/outbound/payloads.js";
import { logWarn } from "../../logger.js";
import { defaultRuntime } from "../../runtime.js";
import { maybeApplyTtsToPayload } from "../../tts/tts.js";
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

export type PersaiMediaArtifact = {
  url: string;
  type: "image" | "audio" | "video" | "document";
  audioAsVoice?: boolean;
};

type AgentResponse = {
  text: string;
  media: PersaiMediaArtifact[];
};

const TTS_DIRECTIVE_RE = /\[\[\/?(tts(?::[^\]]*)?)\]\]/gi;

/**
 * Stateful TTS directive stripper for streaming deltas.  Buffers text that
 * looks like the start of a `[[tts:…]]` directive until enough tokens arrive
 * to decide whether it's a complete directive (strip) or a false positive
 * (flush as regular text).
 */
function createTtsDeltaStripper(): (text: string) => string {
  let buffer = "";
  return (text: string): string => {
    buffer += text;
    if (!buffer.includes("[[")) {
      const out = buffer;
      buffer = "";
      return out;
    }
    let result = "";
    let i = 0;
    while (i < buffer.length) {
      const openIdx = buffer.indexOf("[[", i);
      if (openIdx === -1) {
        result += buffer.slice(i);
        i = buffer.length;
        break;
      }
      result += buffer.slice(i, openIdx);
      const afterOpen = buffer.slice(openIdx);
      const match = afterOpen.match(/^\[\[\/?(tts(?::[^\]]*)?)\]\]/i);
      if (match) {
        i = openIdx + match[0].length;
        continue;
      }
      if (/^\[\[\/?(tts[^\]]*)?$/i.test(afterOpen)) {
        buffer = afterOpen;
        return result;
      }
      result += "[[";
      i = openIdx + 2;
    }
    buffer = "";
    return result;
  };
}

function flushTtsDeltaStripper(
  stripper: (text: string) => string,
): string {
  return stripper("");
}

function inferMediaType(url: string): PersaiMediaArtifact["type"] {
  const lower = url.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|svg|bmp)$/.test(lower)) return "image";
  if (/\.(mp3|ogg|opus|wav|webm|m4a|aac|flac)$/.test(lower)) return "audio";
  if (/\.(mp4|mkv|avi|mov)$/.test(lower)) return "video";
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
    if (p.text) textParts.push(p.text);
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

  const text =
    textParts.filter(Boolean).join("\n\n") || "No response from OpenClaw.";
  return { text, media };
}

function stripTtsDirectives(text: string): string {
  return text.replace(TTS_DIRECTIVE_RE, "").trim();
}

/**
 * Process the agent result through the TTS pipeline: `maybeApplyTtsToPayload`
 * parses `[[tts:…]]` directives, strips them from the display text, generates
 * audio when enabled, and returns a clean response with media artifacts.
 */
async function resolveAgentResponseWithTts(
  result: unknown,
  channel: string,
): Promise<AgentResponse> {
  const response = resolveAgentResponse(result);
  try {
    const cfg = loadConfig();
    const ttsPayload = await maybeApplyTtsToPayload({
      payload: { text: response.text },
      cfg,
      channel,
      kind: "final",
    });
    const media = [...response.media];
    if (ttsPayload.mediaUrl) {
      media.push({
        url: ttsPayload.mediaUrl,
        type: "audio" as const,
        audioAsVoice: ttsPayload.audioAsVoice ?? false,
      });
    }
    const cleaned = ttsPayload.text?.trim();
    const fallback = stripTtsDirectives(response.text) || response.text;
    return { text: cleaned || fallback, media };
  } catch (err) {
    logWarn(
      `persai-runtime: TTS processing failed, returning raw text: ${err instanceof Error ? err.message : String(err)}`,
    );
    const fallback = stripTtsDirectives(response.text) || response.text;
    return { text: fallback, media: response.media };
  }
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
  toolQuotaPolicy?: Map<
    string,
    { toolCode: string; dailyCallLimit: number | null }
  >;
  toolLimitWebhookUrl?: string;
  cronWebhookUrl?: string;
  workspaceDir?: string;
  assistantGender?: string | null;
}): Promise<
  | { ok: true; assistantMessage: string; media: PersaiMediaArtifact[] }
  | { ok: false; error: PersaiRuntimeTurnError }
> {
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
    toolProviderOverrides: params.toolProviderOverrides,
    assistantGender: params.assistantGender,
  };

  try {
    const result = await persaiRuntimeRequestContext.run(runtimeCtx, () =>
      agentCommandFromIngress(commandInput, defaultRuntime, deps),
    );
    const response = await resolveAgentResponseWithTts(result, "webchat");
    return { ok: true, assistantMessage: response.text, media: response.media };
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
  toolProviderOverrides?: Map<string, string>;
  toolDenyList?: string[];
  toolQuotaPolicy?: Map<
    string,
    { toolCode: string; dailyCallLimit: number | null }
  >;
  toolLimitWebhookUrl?: string;
  cronWebhookUrl?: string;
  workspaceDir?: string;
  assistantGender?: string | null;
}): Promise<
  | { ok: true; assistantMessage: string; media: PersaiMediaArtifact[] }
  | { ok: false; error: PersaiRuntimeTurnError }
> {
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
    toolProviderOverrides: params.toolProviderOverrides,
    assistantGender: params.assistantGender,
  };

  try {
    const result = await persaiRuntimeRequestContext.run(runtimeCtx, () =>
      agentCommandFromIngress(commandInput, defaultRuntime, deps),
    );
    const response = await resolveAgentResponseWithTts(result, "telegram");
    return { ok: true, assistantMessage: response.text, media: response.media };
  } catch (err) {
    const normalized = toPersaiRuntimeTurnError(err);
    logWarn(
      `persai-runtime: telegram agent turn failed: ${normalized.message}`,
    );
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
  toolQuotaPolicy?: Map<
    string,
    { toolCode: string; dailyCallLimit: number | null }
  >;
  toolLimitWebhookUrl?: string;
  cronWebhookUrl?: string;
  workspaceDir?: string;
  assistantGender?: string | null;
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
    toolProviderOverrides: params.toolProviderOverrides,
    assistantGender: params.assistantGender,
  };

  let closed = false;
  let sawAssistantDelta = false;
  const stripDelta = createTtsDeltaStripper();

  const unsubscribe = onAgentEvent((evt) => {
    if (evt.runId !== runId || closed) {
      return;
    }
    if (evt.stream === "assistant") {
      const rawContent = resolveAssistantStreamDeltaText(evt) ?? "";
      const content = stripDelta(rawContent);
      if (content) {
        sawAssistantDelta = true;
        params.res.write(
          `${JSON.stringify({ type: "delta", delta: content })}\n`,
        );
      }
      return;
    }
    if (evt.stream === "thinking") {
      const delta = typeof evt.data?.delta === "string" ? evt.data.delta : "";
      const text = typeof evt.data?.text === "string" ? evt.data.text : "";
      if (delta && text) {
        params.res.write(
          `${JSON.stringify({ type: "thinking", delta, text })}\n`,
        );
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
        const result = await persaiRuntimeRequestContext.run(runtimeCtx, () =>
          agentCommandFromIngress(commandInput, defaultRuntime, deps),
        );
        if (closed) {
          return;
        }
        const flushed = flushTtsDeltaStripper(stripDelta);
        if (flushed) {
          sawAssistantDelta = true;
          params.res.write(
            `${JSON.stringify({ type: "delta", delta: flushed })}\n`,
          );
        }
        const response = await resolveAgentResponseWithTts(result, "webchat");
        if (!sawAssistantDelta) {
          params.res.write(
            `${JSON.stringify({ type: "delta", delta: response.text })}\n`,
          );
        }
        if (response.media.length > 0) {
          params.res.write(
            `${JSON.stringify({ type: "media", media: response.media })}\n`,
          );
        }
      } catch (err) {
        const normalized = toPersaiRuntimeTurnError(err);
        logWarn(
          `persai-runtime: stream agent turn failed: ${normalized.message}`,
        );
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
