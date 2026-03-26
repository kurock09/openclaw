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
import {
  extractPersaiRuntimeModelOverride,
  PersaiRuntimeProviderProfileValidationError,
  validatePersaiRuntimeProviderProfileForApply,
} from "./persai-runtime-provider-profile.js";
import { derivePersaiWebRuntimeSessionKey } from "./persai-runtime-session.js";
import type { PersaiRuntimeSpecStore } from "./persai-runtime-spec-store.js";
import {
  buildToolDenyList,
  extractToolCredentialRefs,
  extractToolQuotaPolicy,
  PersaiToolPolicyValidationError,
  resolveToolCredentials,
  validateToolPolicyForApply,
} from "./persai-runtime-tool-policy.js";
import {
  cleanupPersaiAssistantWorkspace,
  writeBootstrapFilesToWorkspace,
} from "./persai-runtime-workspace.js";
import { loadConfig } from "../../config/config.js";
import { ensureSpecFreshness } from "./persai-runtime-freshness.js";

export const RUNTIME_SPEC_APPLY_PATH = "/api/v1/runtime/spec/apply";
export const RUNTIME_WORKSPACE_CLEANUP_PATH = "/api/v1/runtime/workspace/cleanup";
export const RUNTIME_CHAT_WEB_PATH = "/api/v1/runtime/chat/web";
export const RUNTIME_CHAT_WEB_STREAM_PATH = "/api/v1/runtime/chat/web/stream";

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

  try {
    await validatePersaiRuntimeProviderProfileForApply(
      (spec as Record<string, unknown>).bootstrap,
    );
  } catch (error) {
    if (error instanceof PersaiRuntimeProviderProfileValidationError) {
      sendJson(res, 400, {
        ok: false,
        error: error.message,
      });
      return true;
    }
    throw error;
  }

  try {
    await validateToolPolicyForApply(
      (spec as Record<string, unknown>).bootstrap,
    );
  } catch (error) {
    if (error instanceof PersaiToolPolicyValidationError) {
      sendJson(res, 400, {
        ok: false,
        error: error.message,
      });
      return true;
    }
    throw error;
  }

  const appliedAt = new Date().toISOString();
  const workspacePayload = (spec as Record<string, unknown>).workspace;

  const { workspaceDir, written, skipped } = await writeBootstrapFilesToWorkspace({
    assistantId,
    workspace: workspacePayload,
    reapply,
  });

  await store.put({
    assistantId,
    publishedVersionId,
    contentHash,
    reapply,
    bootstrap: (spec as Record<string, unknown>).bootstrap,
    workspace: workspacePayload,
    appliedAt,
    workspaceDir,
  });

  sendJson(res, 200, {
    ok: true,
    accepted: true,
    assistantId,
    publishedVersionId,
    contentHash,
    reapply,
    appliedAt,
    workspaceDir,
    bootstrapFiles: { written, skipped },
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
  const { req, res, requestPath, resolvedAuth, trustedProxies, allowRealIpFallback, store } = params;
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

  let applied = await store.get(assistantId, publishedVersionId);
  if (applied) {
    const freshness = await ensureSpecFreshness({
      assistantId,
      bootstrap: applied.bootstrap,
    });
    if (freshness.rematerialized) {
      applied = (await store.get(assistantId, publishedVersionId)) ?? applied;
    }

    const extraSystemPrompt = extractPersonaInstructionsFromWorkspace(applied.workspace) ?? undefined;
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
      userMessage,
      sessionKey,
      extraSystemPrompt,
      providerOverride: runtimeOverride?.provider,
      modelOverride: runtimeOverride?.model,
      resolvedToolCredentials,
      toolDenyList,
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
    error: MISSING_APPLIED_SPEC_ERROR
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

  let applied = await store.get(assistantId, publishedVersionId);
  if (!applied) {
    sendJson(res, 503, {
      ok: false,
      error: MISSING_APPLIED_SPEC_ERROR
    });
    return true;
  }

  const streamFreshness = await ensureSpecFreshness({
    assistantId,
    bootstrap: applied.bootstrap,
  });
  if (streamFreshness.rematerialized) {
    applied = (await store.get(assistantId, publishedVersionId)) ?? applied;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");

  const extraSystemPrompt = extractPersonaInstructionsFromWorkspace(applied.workspace) ?? undefined;
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
    userMessage,
    sessionKey,
    extraSystemPrompt,
    providerOverride: runtimeOverride?.provider,
    modelOverride: runtimeOverride?.model,
    resolvedToolCredentials: streamResolvedToolCredentials,
    toolDenyList: streamToolDenyList,
    workspaceDir: applied.workspaceDir,
  });
  return true;
}
