import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createDefaultDeps } from "../../cli/deps.js";
import { agentCommandFromIngress } from "../../commands/agent.js";
import { onAgentEvent } from "../../infra/agent-events.js";
import { logWarn } from "../../logger.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveAssistantStreamDeltaText } from "../agent-event-assistant-text.js";

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

const PERSAI_TOOL_DENY_ENV = "PERSAI_TOOL_DENY";

function buildPersaiWebIngressCommandInput(params: {
  userMessage: string;
  extraSystemPrompt?: string;
  providerOverride?: string;
  modelOverride?: string;
  sessionKey: string;
  runId: string;
}) {
  return {
    message: params.userMessage,
    extraSystemPrompt: params.extraSystemPrompt,
    provider: params.providerOverride,
    model: params.modelOverride,
    sessionKey: params.sessionKey,
    runId: params.runId,
    deliver: false as const,
    messageChannel: "webchat" as const,
    bestEffortDeliver: false as const,
    senderIsOwner: true as const,
    allowModelOverride: true as const,
  };
}

function injectToolCredentials(credentials: Map<string, string>): string[] {
  const injectedKeys: string[] = [];
  for (const [envVar, value] of credentials) {
    process.env[envVar] = value;
    injectedKeys.push(envVar);
  }
  return injectedKeys;
}

function cleanupInjectedEnv(keys: string[]): void {
  for (const key of keys) {
    delete process.env[key];
  }
}

/** P3: one full embedded agent turn for PersAI web runtime (sync). */
export async function runPersaiWebRuntimeAgentTurnSync(params: {
  userMessage: string;
  sessionKey: string;
  extraSystemPrompt?: string;
  providerOverride?: string;
  modelOverride?: string;
  resolvedToolCredentials?: Map<string, string>;
  toolDenyList?: string[];
}): Promise<{ ok: true; assistantMessage: string } | { ok: false; error: string }> {
  const runId = randomUUID();
  const deps = createDefaultDeps();
  const commandInput = buildPersaiWebIngressCommandInput({
    userMessage: params.userMessage,
    extraSystemPrompt: params.extraSystemPrompt,
    providerOverride: params.providerOverride,
    modelOverride: params.modelOverride,
    sessionKey: params.sessionKey,
    runId,
  });

  const injectedKeys = params.resolvedToolCredentials
    ? injectToolCredentials(params.resolvedToolCredentials)
    : [];
  const prevDeny = process.env[PERSAI_TOOL_DENY_ENV];
  if (params.toolDenyList && params.toolDenyList.length > 0) {
    process.env[PERSAI_TOOL_DENY_ENV] = params.toolDenyList.join(",");
  }

  try {
    const result = await agentCommandFromIngress(commandInput, defaultRuntime, deps);
    return { ok: true, assistantMessage: resolveAgentResponseText(result) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logWarn(`persai-runtime: sync agent turn failed: ${message}`);
    return { ok: false, error: message };
  } finally {
    cleanupInjectedEnv(injectedKeys);
    if (prevDeny !== undefined) {
      process.env[PERSAI_TOOL_DENY_ENV] = prevDeny;
    } else {
      delete process.env[PERSAI_TOOL_DENY_ENV];
    }
  }
}

/**
 * P3: stream assistant text as PersAI NDJSON (`delta` / `done`).
 * Mirrors openai-http streaming lifecycle handling.
 */
export function runPersaiWebRuntimeAgentTurnStream(params: {
  req: IncomingMessage;
  res: ServerResponse;
  userMessage: string;
  sessionKey: string;
  extraSystemPrompt?: string;
  providerOverride?: string;
  modelOverride?: string;
  resolvedToolCredentials?: Map<string, string>;
  toolDenyList?: string[];
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
  });

  const injectedKeys = params.resolvedToolCredentials
    ? injectToolCredentials(params.resolvedToolCredentials)
    : [];
  const prevDeny = process.env[PERSAI_TOOL_DENY_ENV];
  if (params.toolDenyList && params.toolDenyList.length > 0) {
    process.env[PERSAI_TOOL_DENY_ENV] = params.toolDenyList.join(",");
  }

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
        const result = await agentCommandFromIngress(commandInput, defaultRuntime, deps);
        if (closed) {
          return;
        }
        if (!sawAssistantDelta) {
          const content = resolveAgentResponseText(result);
          params.res.write(`${JSON.stringify({ type: "delta", delta: content })}\n`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logWarn(`persai-runtime: stream agent turn failed: ${message}`);
        if (!closed) {
          params.res.write(`${JSON.stringify({ type: "delta", delta: `Error: ${message}` })}\n`);
        }
      } finally {
        cleanupInjectedEnv(injectedKeys);
        if (prevDeny !== undefined) {
          process.env[PERSAI_TOOL_DENY_ENV] = prevDeny;
        } else {
          delete process.env[PERSAI_TOOL_DENY_ENV];
        }

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
