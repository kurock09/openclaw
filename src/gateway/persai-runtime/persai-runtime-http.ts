import * as fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as path from "node:path";
import { createCronTool } from "../../agents/tools/cron-tool.js";
import { loadConfig } from "../../config/config.js";
import { authorizeHttpGatewayConnect, type ResolvedGatewayAuth } from "../auth.js";
import { readJsonBody } from "../hooks.js";
import { sendGatewayAuthFailure } from "../http-common.js";
import { getBearerToken } from "../http-utils.js";
import {
  runPersaiWebRuntimeAgentTurnStream,
  runPersaiWebRuntimeAgentTurnSync,
} from "./persai-runtime-agent-turn.js";
import { ensureSpecFreshness } from "./persai-runtime-freshness.js";
import { applyPersaiRuntimeSpecLocally, PersaiRuntimeSpecApplyValidationError } from "./persai-runtime-local-apply.js";
import { extractPersaiRuntimeModelOverride } from "./persai-runtime-provider-profile.js";
import { cleanupPersaiAssistantSessions } from "./persai-runtime-session-cleanup.js";
import { derivePersaiWebRuntimeSessionKey } from "./persai-runtime-session.js";
import type { PersaiRuntimeSpecStore } from "./persai-runtime-spec-store.js";
import {
  buildToolDenyList,
  extractToolCredentialRefs,
  extractToolQuotaPolicy,
  resolveToolCredentials,
} from "./persai-runtime-tool-policy.js";
import {
  cleanupPersaiAssistantWorkspace,
  resetPersaiAssistantMemoryWorkspace,
  resolvePersaiAssistantWorkspaceDir,
} from "./persai-runtime-workspace.js";

export const RUNTIME_SPEC_APPLY_PATH = "/api/v1/runtime/spec/apply";
export const RUNTIME_WORKSPACE_CLEANUP_PATH = "/api/v1/runtime/workspace/cleanup";
export const RUNTIME_WORKSPACE_RESET_PATH = "/api/v1/runtime/workspace/reset";
export const RUNTIME_WORKSPACE_MEMORY_RESET_PATH = "/api/v1/runtime/workspace/memory/reset";
export const RUNTIME_CRON_CONTROL_PATH = "/api/v1/runtime/cron/control";
export const RUNTIME_CHAT_WEB_PATH = "/api/v1/runtime/chat/web";
export const RUNTIME_CHAT_WEB_STREAM_PATH = "/api/v1/runtime/chat/web/stream";
export const RUNTIME_WORKSPACE_AVATAR_PATH = "/api/v1/runtime/workspace/avatar";

const MAX_RUNTIME_JSON_BYTES = 1_000_000;
const MISSING_APPLIED_SPEC_ERROR =
  "Applied runtime spec was not found for the requested assistant version.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function unwrapToolResultDetails(result: unknown): unknown {
  return isRecord(result) && "details" in result ? result.details : result;
}

function resolvePersaiInternalApiBaseUrl(): string | undefined {
  const cfg = loadConfig();
  const provider = cfg.secrets?.providers?.["persai-runtime"];
  return provider?.source === "persai" ? provider.baseUrl : undefined;
}

function resolveCronWebhookUrl(assistantId: string): string | undefined {
  const baseUrl = resolvePersaiInternalApiBaseUrl();
  if (!baseUrl) {
    return undefined;
  }
  return `${baseUrl}/api/v1/internal/cron-fire?assistantId=${encodeURIComponent(assistantId)}`;
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

function buildSchedulingContext(params: {
  currentTimeIso?: string;
  userTimezone?: string;
}): string | null {
  if (!params.currentTimeIso) {
    return null;
  }
  const currentTimeMs = Date.parse(params.currentTimeIso);
  if (!Number.isFinite(currentTimeMs)) {
    return null;
  }

  const lines = ["# Scheduling Context", `- Current UTC time: ${params.currentTimeIso}`];
  if (params.userTimezone) {
    lines.push(`- User timezone: ${params.userTimezone}`);
    try {
      const localTime = new Intl.DateTimeFormat("en-US", {
        timeZone: params.userTimezone,
        dateStyle: "full",
        timeStyle: "long",
      }).format(new Date(currentTimeMs));
      lines.push(`- Current local time in the user's timezone: ${localTime}`);
    } catch {
      // Ignore invalid timezone formatting and keep the raw timezone string.
    }
  }
  lines.push(
    "- For relative reminders like 'in 5 minutes', calculate from this current time instead of guessing.",
  );
  return lines.join("\n");
}

function mergeSystemPrompt(base: string | undefined, addition: string | null): string | undefined {
  if (!addition) {
    return base;
  }
  return base ? `${base}\n\n${addition}` : addition;
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
  const { req, res, requestPath, resolvedAuth, trustedProxies, allowRealIpFallback, store } =
    params;
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

  let localApply;
  try {
    localApply = await applyPersaiRuntimeSpecLocally({
      payload: {
        assistantId,
        publishedVersionId,
        contentHash,
        reapply,
        spec: {
          bootstrap: spec.bootstrap,
          workspace: spec.workspace,
        },
      },
      store,
    });
  } catch (error) {
    if (error instanceof PersaiRuntimeSpecApplyValidationError) {
      sendJson(res, 400, {
        ok: false,
        error: error.message,
      });
      return true;
    }
    throw error;
  }

  sendJson(res, 200, {
    ok: true,
    accepted: true,
    assistantId,
    publishedVersionId,
    contentHash,
    reapply,
    appliedAt: localApply.appliedAt,
    workspaceDir: localApply.workspaceDir,
    bootstrapFiles: localApply.bootstrapFiles,
  });
  return true;
}

export async function handleRuntimeWorkspaceCleanupHttpRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  requestPath: string;
  resolvedAuth: ResolvedGatewayAuth;
  trustedProxies: string[];
  allowRealIpFallback: boolean;
  store: PersaiRuntimeSpecStore;
}): Promise<boolean> {
  const { req, res, requestPath, resolvedAuth, trustedProxies, allowRealIpFallback, store } =
    params;
  if (requestPath !== RUNTIME_WORKSPACE_CLEANUP_PATH) {
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
    sendJson(res, 400, { ok: false, error: parsed.error });
    return true;
  }

  const payload = isRecord(parsed.value) ? parsed.value : {};
  const assistantId = typeof payload.assistantId === "string" ? payload.assistantId.trim() : "";

  if (!assistantId) {
    sendJson(res, 400, { ok: false, error: "assistantId is required." });
    return true;
  }

  const { workspaceDir, deleted } = await cleanupPersaiAssistantWorkspace(assistantId);
  await store.remove(assistantId);

  sendJson(res, 200, { ok: true, assistantId, workspaceDir, deleted });
  return true;
}

export async function handleRuntimeWorkspaceResetHttpRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  requestPath: string;
  resolvedAuth: ResolvedGatewayAuth;
  trustedProxies: string[];
  allowRealIpFallback: boolean;
  store: PersaiRuntimeSpecStore;
}): Promise<boolean> {
  const { req, res, requestPath, resolvedAuth, trustedProxies, allowRealIpFallback, store } =
    params;
  if (requestPath !== RUNTIME_WORKSPACE_RESET_PATH) {
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
    sendJson(res, 400, { ok: false, error: parsed.error });
    return true;
  }

  const payload = isRecord(parsed.value) ? parsed.value : {};
  const assistantId = typeof payload.assistantId === "string" ? payload.assistantId.trim() : "";

  if (!assistantId) {
    sendJson(res, 400, { ok: false, error: "assistantId is required." });
    return true;
  }

  const cleanup = await cleanupPersaiAssistantWorkspace(assistantId);
  await store.remove(assistantId);
  const memory = await resetPersaiAssistantMemoryWorkspace(assistantId);
  const sessions = await cleanupPersaiAssistantSessions(assistantId);

  sendJson(res, 200, {
    ok: true,
    assistantId,
    cleanedWorkspaceDir: cleanup.workspaceDir,
    deleted: cleanup.deleted,
    workspaceDir: memory.workspaceDir,
    memoryFilePath: memory.memoryFilePath,
    memoryDirPath: memory.memoryDirPath,
    sessionStorePath: sessions.storePath,
    removedSessions: sessions.removedCount,
  });
  return true;
}

export async function handleRuntimeWorkspaceMemoryResetHttpRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  requestPath: string;
  resolvedAuth: ResolvedGatewayAuth;
  trustedProxies: string[];
  allowRealIpFallback: boolean;
}): Promise<boolean> {
  const { req, res, requestPath, resolvedAuth, trustedProxies, allowRealIpFallback } = params;
  if (requestPath !== RUNTIME_WORKSPACE_MEMORY_RESET_PATH) {
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
    sendJson(res, 400, { ok: false, error: parsed.error });
    return true;
  }

  const payload = isRecord(parsed.value) ? parsed.value : {};
  const assistantId = typeof payload.assistantId === "string" ? payload.assistantId.trim() : "";
  if (!assistantId) {
    sendJson(res, 400, { ok: false, error: "assistantId is required." });
    return true;
  }

  const result = await resetPersaiAssistantMemoryWorkspace(assistantId);
  const sessions = await cleanupPersaiAssistantSessions(assistantId);
  sendJson(res, 200, {
    ok: true,
    assistantId,
    ...result,
    sessionStorePath: sessions.storePath,
    removedSessions: sessions.removedCount,
  });
  return true;
}

export async function handleRuntimeCronControlHttpRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  requestPath: string;
  resolvedAuth: ResolvedGatewayAuth;
  trustedProxies: string[];
  allowRealIpFallback: boolean;
}): Promise<boolean> {
  const { req, res, requestPath, resolvedAuth, trustedProxies, allowRealIpFallback } = params;
  if (requestPath !== RUNTIME_CRON_CONTROL_PATH) {
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
    sendJson(res, 400, { ok: false, error: parsed.error });
    return true;
  }

  const payload = isRecord(parsed.value) ? parsed.value : {};
  const action = typeof payload.action === "string" ? payload.action.trim() : "";
  const sessionKey = typeof payload.sessionKey === "string" ? payload.sessionKey.trim() : "";
  const contextSessionKey =
    typeof payload.contextSessionKey === "string" ? payload.contextSessionKey.trim() : "";
  const args = isRecord(payload.args) ? payload.args : {};
  if (action !== "add" && action !== "update" && action !== "remove") {
    sendJson(res, 400, {
      ok: false,
      error: "action must be one of: add, update, remove.",
    });
    return true;
  }

  const cronTool = createCronTool(
    sessionKey || contextSessionKey
      ? {
          ...(sessionKey ? { agentSessionKey: sessionKey } : {}),
          ...(contextSessionKey ? { contextSessionKey } : {}),
        }
      : undefined,
  );
  if (!cronTool.execute) {
    sendJson(res, 500, { ok: false, error: "cron tool execute handler is unavailable." });
    return true;
  }

  try {
    const result = await cronTool.execute(`persai-runtime-cron-${Date.now()}`, {
      ...args,
      action,
    });
    sendJson(res, 200, {
      ok: true,
      result: unwrapToolResultDetails(result),
    });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, 400, { ok: false, error: message });
    return true;
  }
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
  const { req, res, requestPath, resolvedAuth, trustedProxies, allowRealIpFallback, store } =
    params;
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
  const userMessageId =
    typeof payload.userMessageId === "string" ? payload.userMessageId.trim() : "";
  const userMessage = typeof payload.userMessage === "string" ? payload.userMessage.trim() : "";
  const userTimezone =
    typeof payload.userTimezone === "string" ? payload.userTimezone.trim() : undefined;
  const currentTimeIso =
    typeof payload.currentTimeIso === "string" ? payload.currentTimeIso.trim() : undefined;

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

  let applied = await store.get(assistantId, publishedVersionId);
  if (applied) {
    const freshness = await ensureSpecFreshness({
      assistantId,
      applied,
      store,
    });
    if (freshness.rematerialized) {
      applied = (await store.get(assistantId, publishedVersionId)) ?? applied;
    }

    const extraSystemPrompt = mergeSystemPrompt(
      extractPersonaInstructionsFromWorkspace(applied.workspace) ?? undefined,
      buildSchedulingContext({ currentTimeIso, userTimezone }),
    );
    const runtimeOverride = extractPersaiRuntimeModelOverride(applied.bootstrap);

    const credentialRefs = extractToolCredentialRefs(applied.bootstrap);
    const quotaPolicy = extractToolQuotaPolicy(applied.bootstrap);
    const toolDenyList = buildToolDenyList(quotaPolicy);

    let resolvedToolCredentials = new Map<string, string>();
    if (credentialRefs.size > 0) {
      try {
        const cfg = loadConfig();
        resolvedToolCredentials = await resolveToolCredentials(credentialRefs, cfg);
      } catch {
        // Non-fatal: tools will fall back to existing env vars
      }
    }

    const agentOut = await runPersaiWebRuntimeAgentTurnSync({
      assistantId,
      userMessage,
      sessionKey,
      extraSystemPrompt,
      providerOverride: runtimeOverride?.provider,
      modelOverride: runtimeOverride?.model,
      resolvedToolCredentials,
      toolDenyList,
      cronWebhookUrl: resolveCronWebhookUrl(assistantId),
      workspaceDir: applied.workspaceDir,
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

  sendJson(res, 503, {
    ok: false,
    error: MISSING_APPLIED_SPEC_ERROR,
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
  const { req, res, requestPath, resolvedAuth, trustedProxies, allowRealIpFallback, store } =
    params;
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
  const userMessageId =
    typeof payload.userMessageId === "string" ? payload.userMessageId.trim() : "";
  const userMessage = typeof payload.userMessage === "string" ? payload.userMessage.trim() : "";
  const userTimezone =
    typeof payload.userTimezone === "string" ? payload.userTimezone.trim() : undefined;
  const currentTimeIso =
    typeof payload.currentTimeIso === "string" ? payload.currentTimeIso.trim() : undefined;

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

  let applied = await store.get(assistantId, publishedVersionId);
  if (!applied) {
    sendJson(res, 503, {
      ok: false,
      error: MISSING_APPLIED_SPEC_ERROR,
    });
    return true;
  }

  const streamFreshness = await ensureSpecFreshness({
    assistantId,
    applied,
    store,
  });
  if (streamFreshness.rematerialized) {
    applied = (await store.get(assistantId, publishedVersionId)) ?? applied;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");

  const extraSystemPrompt = mergeSystemPrompt(
    extractPersonaInstructionsFromWorkspace(applied.workspace) ?? undefined,
    buildSchedulingContext({ currentTimeIso, userTimezone }),
  );
  const runtimeOverride = extractPersaiRuntimeModelOverride(applied.bootstrap);

  const streamCredentialRefs = extractToolCredentialRefs(applied.bootstrap);
  const streamQuotaPolicy = extractToolQuotaPolicy(applied.bootstrap);
  const streamToolDenyList = buildToolDenyList(streamQuotaPolicy);

  let streamResolvedToolCredentials = new Map<string, string>();
  if (streamCredentialRefs.size > 0) {
    try {
      const cfg = loadConfig();
      streamResolvedToolCredentials = await resolveToolCredentials(streamCredentialRefs, cfg);
    } catch {
      // Non-fatal: tools will fall back to existing env vars
    }
  }

  await runPersaiWebRuntimeAgentTurnStream({
    req,
    res,
    assistantId,
    userMessage,
    sessionKey,
    extraSystemPrompt,
    providerOverride: runtimeOverride?.provider,
    modelOverride: runtimeOverride?.model,
    resolvedToolCredentials: streamResolvedToolCredentials,
    toolDenyList: streamToolDenyList,
    cronWebhookUrl: resolveCronWebhookUrl(assistantId),
    workspaceDir: applied.workspaceDir,
  });
  return true;
}

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const AVATAR_ALLOWED_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

function readRawBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) {
        reject(new Error("Payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export async function handleRuntimeWorkspaceAvatarHttpRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  requestPath: string;
  resolvedAuth: ResolvedGatewayAuth;
  trustedProxies: string[];
  allowRealIpFallback: boolean;
}): Promise<boolean> {
  const { req, res, requestPath, resolvedAuth, trustedProxies, allowRealIpFallback } = params;
  if (!requestPath.startsWith(RUNTIME_WORKSPACE_AVATAR_PATH)) {
    return false;
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

  const url = new URL(req.url ?? "/", "http://localhost");
  const assistantId = url.searchParams.get("assistantId");
  if (!assistantId) {
    sendJson(res, 400, { error: "assistantId query parameter is required." });
    return true;
  }

  const workspaceDir = resolvePersaiAssistantWorkspaceDir(assistantId);

  if (req.method === "POST") {
    const ext = (url.searchParams.get("ext") ?? "png").toLowerCase();
    if (!AVATAR_ALLOWED_EXTENSIONS.has(ext)) {
      sendJson(res, 400, { error: `Extension "${ext}" is not allowed.` });
      return true;
    }

    let body: Buffer;
    try {
      body = await readRawBody(req, MAX_AVATAR_BYTES);
    } catch {
      sendJson(res, 413, { error: "Avatar file too large (max 2MB)." });
      return true;
    }

    fs.mkdirSync(workspaceDir, { recursive: true });

    // Remove any existing avatar files first.
    for (const existing of fs.readdirSync(workspaceDir)) {
      if (existing.startsWith("avatar.")) {
        fs.unlinkSync(path.join(workspaceDir, existing));
      }
    }

    const avatarFileName = `avatar.${ext}`;
    fs.writeFileSync(path.join(workspaceDir, avatarFileName), body);

    sendJson(res, 200, {
      avatarUrl: `/api/v1/assistant/avatar`,
      avatarFileName,
    });
    return true;
  }

  if (req.method === "GET") {
    if (!fs.existsSync(workspaceDir)) {
      sendJson(res, 404, { error: "No avatar found." });
      return true;
    }

    const files = fs.readdirSync(workspaceDir).filter((f) => f.startsWith("avatar."));
    if (files.length === 0) {
      sendJson(res, 404, { error: "No avatar found." });
      return true;
    }

    const avatarFile = files[0];
    const filePath = path.join(workspaceDir, avatarFile);
    const ext = avatarFile.split(".").pop() ?? "png";
    const mimeMap: Record<string, string> = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
    };

    res.statusCode = 200;
    res.setHeader("Content-Type", mimeMap[ext] ?? "application/octet-stream");
    res.setHeader("Cache-Control", "public, max-age=300");
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    return true;
  }

  sendJson(res, 405, { error: "Method not allowed." });
  return true;
}
