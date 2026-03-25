import type { IncomingMessage, ServerResponse } from "node:http";
import {
  authorizeHttpGatewayConnect,
  type ResolvedGatewayAuth,
} from "../auth.js";
import { readJsonBody } from "../hooks.js";
import { sendGatewayAuthFailure } from "../http-common.js";
import { getBearerToken } from "../http-utils.js";
import {
  runPersaiWebRuntimeAgentTurnStream,
  runPersaiWebRuntimeAgentTurnSync,
} from "./persai-runtime-agent-turn.js";
import { derivePersaiWebRuntimeSessionKey } from "./persai-runtime-session.js";
import type { PersaiRuntimeSpecStore } from "./persai-runtime-spec-store.js";

export const RUNTIME_SPEC_APPLY_PATH = "/api/v1/runtime/spec/apply";
export const RUNTIME_CHAT_WEB_PATH = "/api/v1/runtime/chat/web";
export const RUNTIME_CHAT_WEB_STREAM_PATH = "/api/v1/runtime/chat/web/stream";

const MAX_RUNTIME_JSON_BYTES = 1_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

/** P2: read persona instructions from materialized openclaw.workspace.v1 for native hydrate / echo hints. */
export function extractPersonaInstructionsFromWorkspace(workspace: unknown): string | null {
  if (!isRecord(workspace)) {
    return null;
  }
  const persona = workspace.persona;
  if (!isRecord(persona)) {
    return null;
  }
  const ins = persona.instructions;
  if (typeof ins !== "string" || !ins.trim()) {
    return null;
  }
  return ins.trim().slice(0, 4000);
}

export async function handleRuntimeSpecApplyHttpRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  requestPath: string;
  resolvedAuth: ResolvedGatewayAuth;
  trustedProxies: string[];
  allowRealIpFallback: boolean;
  store: PersaiRuntimeSpecStore;
}): Promise<boolean> {
  const { req, res, requestPath, resolvedAuth, trustedProxies, allowRealIpFallback, store } = params;
  if (requestPath !== RUNTIME_SPEC_APPLY_PATH) {
    return false;
  }

  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Method Not Allowed");
    return true;
  }

  const bearerToken = getBearerToken(req);
  const auth = await authorizeHttpGatewayConnect({
    auth: resolvedAuth,
    connectAuth: bearerToken ? { token: bearerToken, password: bearerToken } : null,
    req,
    trustedProxies,
    allowRealIpFallback,
  });
  if (!auth.ok) {
    sendGatewayAuthFailure(res, auth);
    return true;
  }

  const parsed = await readJsonBody(req, MAX_RUNTIME_JSON_BYTES);
  if (!parsed.ok) {
    const status =
      parsed.error === "payload too large"
        ? 413
        : parsed.error === "request body timeout"
          ? 408
          : 400;
    sendJson(res, status, { ok: false, error: parsed.error });
    return true;
  }

  const payload = isRecord(parsed.value) ? parsed.value : {};
  const assistantId = typeof payload.assistantId === "string" ? payload.assistantId.trim() : "";
  const publishedVersionId =
    typeof payload.publishedVersionId === "string" ? payload.publishedVersionId.trim() : "";
  const contentHash = typeof payload.contentHash === "string" ? payload.contentHash.trim() : "";
  const reapply = payload.reapply === true;
  const spec = payload.spec;
  const specOk =
    isRecord(spec) &&
    Object.prototype.hasOwnProperty.call(spec, "bootstrap") &&
    Object.prototype.hasOwnProperty.call(spec, "workspace");

  if (!assistantId || !publishedVersionId || !contentHash || !specOk) {
    sendJson(res, 400, {
      ok: false,
      error:
        "Invalid runtime spec apply payload. Required fields: assistantId, publishedVersionId, contentHash, spec.bootstrap, spec.workspace.",
    });
    return true;
  }

  const appliedAt = new Date().toISOString();
  await store.put({
    assistantId,
    publishedVersionId,
    contentHash,
    reapply,
    bootstrap: (spec as Record<string, unknown>).bootstrap,
    workspace: (spec as Record<string, unknown>).workspace,
    appliedAt,
  });

  sendJson(res, 200, {
    ok: true,
    accepted: true,
    assistantId,
    publishedVersionId,
    contentHash,
    reapply,
    appliedAt,
  });
  return true;
}

export async function handleRuntimeChatWebHttpRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  requestPath: string;
  resolvedAuth: ResolvedGatewayAuth;
  trustedProxies: string[];
  allowRealIpFallback: boolean;
  store: PersaiRuntimeSpecStore;
}): Promise<boolean> {
  const { req, res, requestPath, resolvedAuth, trustedProxies, allowRealIpFallback, store } = params;
  if (requestPath !== RUNTIME_CHAT_WEB_PATH) {
    return false;
  }

  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Method Not Allowed");
    return true;
  }

  const bearerToken = getBearerToken(req);
  const auth = await authorizeHttpGatewayConnect({
    auth: resolvedAuth,
    connectAuth: bearerToken ? { token: bearerToken, password: bearerToken } : null,
    req,
    trustedProxies,
    allowRealIpFallback,
  });
  if (!auth.ok) {
    sendGatewayAuthFailure(res, auth);
    return true;
  }

  const parsed = await readJsonBody(req, MAX_RUNTIME_JSON_BYTES);
  if (!parsed.ok) {
    const status =
      parsed.error === "payload too large"
        ? 413
        : parsed.error === "request body timeout"
          ? 408
          : 400;
    sendJson(res, status, { ok: false, error: parsed.error });
    return true;
  }

  const payload = isRecord(parsed.value) ? parsed.value : {};
  const assistantId = typeof payload.assistantId === "string" ? payload.assistantId.trim() : "";
  const publishedVersionId =
    typeof payload.publishedVersionId === "string" ? payload.publishedVersionId.trim() : "";
  const chatId = typeof payload.chatId === "string" ? payload.chatId.trim() : "";
  const surfaceThreadKey =
    typeof payload.surfaceThreadKey === "string" ? payload.surfaceThreadKey.trim() : "";
  const userMessageId = typeof payload.userMessageId === "string" ? payload.userMessageId.trim() : "";
  const userMessage = typeof payload.userMessage === "string" ? payload.userMessage.trim() : "";

  if (
    !assistantId ||
    !publishedVersionId ||
    !chatId ||
    !surfaceThreadKey ||
    !userMessageId ||
    !userMessage
  ) {
    sendJson(res, 400, {
      ok: false,
      error:
        "Invalid runtime web chat payload. Required fields: assistantId, publishedVersionId, chatId, surfaceThreadKey, userMessageId, userMessage.",
    });
    return true;
  }

  const sessionKey = derivePersaiWebRuntimeSessionKey({
    assistantId,
    publishedVersionId,
    chatId,
    surfaceThreadKey,
  });
  res.setHeader("X-Persai-Runtime-Session-Key", sessionKey);

  const applied = await store.get(assistantId, publishedVersionId);
  if (applied) {
    const extraSystemPrompt = extractPersonaInstructionsFromWorkspace(applied.workspace) ?? undefined;
    const agentOut = await runPersaiWebRuntimeAgentTurnSync({
      userMessage,
      sessionKey,
      extraSystemPrompt,
    });
    if (!agentOut.ok) {
      sendJson(res, 500, { ok: false, error: agentOut.error });
      return true;
    }
    const assistantMessage = agentOut.assistantMessage.trim() || "No response from OpenClaw.";
    sendJson(res, 200, {
      ok: true,
      assistantMessage,
      respondedAt: new Date().toISOString(),
    });
    return true;
  }

  sendJson(res, 200, {
    ok: true,
    assistantMessage: `[openclaw-compat] ${userMessage}`,
    respondedAt: new Date().toISOString(),
  });
  return true;
}

export async function handleRuntimeChatWebStreamHttpRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  requestPath: string;
  resolvedAuth: ResolvedGatewayAuth;
  trustedProxies: string[];
  allowRealIpFallback: boolean;
  store: PersaiRuntimeSpecStore;
}): Promise<boolean> {
  const { req, res, requestPath, resolvedAuth, trustedProxies, allowRealIpFallback, store } = params;
  if (requestPath !== RUNTIME_CHAT_WEB_STREAM_PATH) {
    return false;
  }

  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Method Not Allowed");
    return true;
  }

  const bearerToken = getBearerToken(req);
  const auth = await authorizeHttpGatewayConnect({
    auth: resolvedAuth,
    connectAuth: bearerToken ? { token: bearerToken, password: bearerToken } : null,
    req,
    trustedProxies,
    allowRealIpFallback,
  });
  if (!auth.ok) {
    sendGatewayAuthFailure(res, auth);
    return true;
  }

  const parsed = await readJsonBody(req, MAX_RUNTIME_JSON_BYTES);
  if (!parsed.ok) {
    const status =
      parsed.error === "payload too large"
        ? 413
        : parsed.error === "request body timeout"
          ? 408
          : 400;
    sendJson(res, status, { ok: false, error: parsed.error });
    return true;
  }

  const payload = isRecord(parsed.value) ? parsed.value : {};
  const assistantId = typeof payload.assistantId === "string" ? payload.assistantId.trim() : "";
  const publishedVersionId =
    typeof payload.publishedVersionId === "string" ? payload.publishedVersionId.trim() : "";
  const chatId = typeof payload.chatId === "string" ? payload.chatId.trim() : "";
  const surfaceThreadKey =
    typeof payload.surfaceThreadKey === "string" ? payload.surfaceThreadKey.trim() : "";
  const userMessageId = typeof payload.userMessageId === "string" ? payload.userMessageId.trim() : "";
  const userMessage = typeof payload.userMessage === "string" ? payload.userMessage.trim() : "";

  if (
    !assistantId ||
    !publishedVersionId ||
    !chatId ||
    !surfaceThreadKey ||
    !userMessageId ||
    !userMessage
  ) {
    sendJson(res, 400, {
      ok: false,
      error:
        "Invalid runtime web chat stream payload. Required fields: assistantId, publishedVersionId, chatId, surfaceThreadKey, userMessageId, userMessage.",
    });
    return true;
  }

  const sessionKey = derivePersaiWebRuntimeSessionKey({
    assistantId,
    publishedVersionId,
    chatId,
    surfaceThreadKey,
  });
  res.setHeader("X-Persai-Runtime-Session-Key", sessionKey);

  const applied = await store.get(assistantId, publishedVersionId);
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");

  if (applied) {
    const extraSystemPrompt = extractPersonaInstructionsFromWorkspace(applied.workspace) ?? undefined;
    await runPersaiWebRuntimeAgentTurnStream({
      req,
      res,
      userMessage,
      sessionKey,
      extraSystemPrompt,
    });
    return true;
  }

  const prefix = `[openclaw-compat-stream]`;
  const answer = `${prefix} ${userMessage}`;
  const chunks = answer.split(" ");
  for (let index = 0; index < chunks.length; index += 1) {
    const text = index === chunks.length - 1 ? chunks[index] : `${chunks[index]} `;
    res.write(`${JSON.stringify({ type: "delta", delta: text })}\n`);
  }
  res.write(`${JSON.stringify({ type: "done", respondedAt: new Date().toISOString() })}\n`);
  res.end();
  return true;
}
