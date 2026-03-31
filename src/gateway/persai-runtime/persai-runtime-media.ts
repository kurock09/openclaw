import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as path from "node:path";
import { loadConfig } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { transcribeAudioFile } from "../../media-understanding/transcribe-audio.js";
import { authorizeHttpGatewayConnect, type ResolvedGatewayAuth } from "../auth.js";
import { sendGatewayAuthFailure } from "../http-common.js";
import { getBearerToken } from "../http-utils.js";
import { resolvePersaiAssistantWorkspaceDir } from "./persai-runtime-workspace.js";

const log = createSubsystemLogger("persai-runtime-media");

export const RUNTIME_WORKSPACE_MEDIA_UPLOAD_PATH = "/api/v1/runtime/workspace/media/upload";
export const RUNTIME_WORKSPACE_MEDIA_DOWNLOAD_PATH = "/api/v1/runtime/workspace/media/download";
export const RUNTIME_WORKSPACE_MEDIA_DELETE_PATH = "/api/v1/runtime/workspace/media/delete";
export const RUNTIME_WORKSPACE_MEDIA_DELETE_CHAT_PATH =
  "/api/v1/runtime/workspace/media/delete-chat";
export const RUNTIME_WORKSPACE_MEDIA_TRANSCRIBE_PATH =
  "/api/v1/runtime/workspace/media/transcribe";

const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
const MEDIA_DIR_NAME = "media";

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

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

function resolveMediaDir(assistantId: string): string {
  const workspaceDir = resolvePersaiAssistantWorkspaceDir(assistantId);
  return path.join(workspaceDir, MEDIA_DIR_NAME);
}

function resolveMediaFilePath(assistantId: string, relativePath: string): string | null {
  const mediaDir = resolveMediaDir(assistantId);
  const resolved = path.resolve(mediaDir, relativePath);
  if (!resolved.startsWith(mediaDir)) {
    return null;
  }
  return resolved;
}

const MIME_EXT_MAP: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/wav": "wav",
  "audio/webm": "webm",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "application/pdf": "pdf",
  "application/octet-stream": "bin",
};

const EXT_MIME_MAP: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  opus: "audio/opus",
  wav: "audio/wav",
  mp4: "video/mp4",
  pdf: "application/pdf",
  bin: "application/octet-stream",
};

export async function handleRuntimeWorkspaceMediaUploadHttpRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  requestPath: string;
  resolvedAuth: ResolvedGatewayAuth;
  trustedProxies: string[];
  allowRealIpFallback: boolean;
}): Promise<boolean> {
  const { req, res, requestPath, resolvedAuth, trustedProxies, allowRealIpFallback } = params;
  if (requestPath !== RUNTIME_WORKSPACE_MEDIA_UPLOAD_PATH) {
    return false;
  }
  if ((req.method ?? "GET").toUpperCase() !== "POST") {
    sendJson(res, 405, { error: "Method not allowed." });
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

  const url = new URL(req.url ?? "/", "http://localhost");
  const assistantId = url.searchParams.get("assistantId")?.trim();
  const chatId = url.searchParams.get("chatId")?.trim();
  const messageId = url.searchParams.get("messageId")?.trim();
  const mimeType = (req.headers["content-type"] ?? "application/octet-stream").split(";")[0].trim();

  if (!assistantId || !chatId || !messageId) {
    sendJson(res, 400, { error: "assistantId, chatId, and messageId are required." });
    return true;
  }

  let body: Buffer;
  try {
    body = await readRawBody(req, MAX_MEDIA_BYTES);
  } catch {
    sendJson(res, 413, { error: "Media file too large (max 25MB)." });
    return true;
  }

  const ext = MIME_EXT_MAP[mimeType] ?? "bin";
  const filename = `${messageId}-${Date.now()}.${ext}`;
  const relativeDir = chatId;
  const mediaDir = resolveMediaDir(assistantId);
  const chatMediaDir = path.join(mediaDir, relativeDir);
  const filePath = path.join(chatMediaDir, filename);
  const storagePath = `${relativeDir}/${filename}`;

  await fsp.mkdir(chatMediaDir, { recursive: true });
  await fsp.writeFile(filePath, body);

  log.debug("media file uploaded", {
    assistantId,
    chatId,
    messageId,
    storagePath,
    sizeBytes: body.length,
  });

  sendJson(res, 200, {
    ok: true,
    storagePath,
    sizeBytes: body.length,
    mimeType,
  });
  return true;
}

export async function handleRuntimeWorkspaceMediaDownloadHttpRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  requestPath: string;
  resolvedAuth: ResolvedGatewayAuth;
  trustedProxies: string[];
  allowRealIpFallback: boolean;
}): Promise<boolean> {
  const { req, res, requestPath, resolvedAuth, trustedProxies, allowRealIpFallback } = params;
  if (requestPath !== RUNTIME_WORKSPACE_MEDIA_DOWNLOAD_PATH) {
    return false;
  }
  if ((req.method ?? "GET").toUpperCase() !== "GET") {
    sendJson(res, 405, { error: "Method not allowed." });
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

  const url = new URL(req.url ?? "/", "http://localhost");
  const assistantId = url.searchParams.get("assistantId")?.trim();
  const storagePath = url.searchParams.get("storagePath")?.trim();

  if (!assistantId || !storagePath) {
    sendJson(res, 400, { error: "assistantId and storagePath are required." });
    return true;
  }

  const filePath = resolveMediaFilePath(assistantId, storagePath);
  if (!filePath) {
    sendJson(res, 400, { error: "Invalid storage path." });
    return true;
  }

  if (!fs.existsSync(filePath)) {
    sendJson(res, 404, { error: "Media file not found." });
    return true;
  }

  const ext = path.extname(filePath).slice(1).toLowerCase();
  const contentType = EXT_MIME_MAP[ext] ?? "application/octet-stream";

  res.statusCode = 200;
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "private, max-age=3600");
  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
  return true;
}

export async function handleRuntimeWorkspaceMediaDeleteHttpRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  requestPath: string;
  resolvedAuth: ResolvedGatewayAuth;
  trustedProxies: string[];
  allowRealIpFallback: boolean;
}): Promise<boolean> {
  const { req, res, requestPath, resolvedAuth, trustedProxies, allowRealIpFallback } = params;
  if (requestPath !== RUNTIME_WORKSPACE_MEDIA_DELETE_PATH) {
    return false;
  }
  if ((req.method ?? "GET").toUpperCase() !== "POST") {
    sendJson(res, 405, { error: "Method not allowed." });
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

  const url = new URL(req.url ?? "/", "http://localhost");
  const assistantId = url.searchParams.get("assistantId")?.trim();
  const storagePath = url.searchParams.get("storagePath")?.trim();

  if (!assistantId || !storagePath) {
    sendJson(res, 400, { error: "assistantId and storagePath are required." });
    return true;
  }

  const filePath = resolveMediaFilePath(assistantId, storagePath);
  if (!filePath) {
    sendJson(res, 400, { error: "Invalid storage path." });
    return true;
  }

  try {
    await fsp.rm(filePath, { force: true });
    log.debug("media file deleted", { assistantId, storagePath });
    sendJson(res, 200, { ok: true, deleted: true });
  } catch {
    sendJson(res, 200, { ok: true, deleted: false });
  }
  return true;
}

export async function handleRuntimeWorkspaceMediaDeleteChatHttpRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  requestPath: string;
  resolvedAuth: ResolvedGatewayAuth;
  trustedProxies: string[];
  allowRealIpFallback: boolean;
}): Promise<boolean> {
  const { req, res, requestPath, resolvedAuth, trustedProxies, allowRealIpFallback } = params;
  if (requestPath !== RUNTIME_WORKSPACE_MEDIA_DELETE_CHAT_PATH) {
    return false;
  }
  if ((req.method ?? "GET").toUpperCase() !== "POST") {
    sendJson(res, 405, { error: "Method not allowed." });
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

  const url = new URL(req.url ?? "/", "http://localhost");
  const assistantId = url.searchParams.get("assistantId")?.trim();
  const chatId = url.searchParams.get("chatId")?.trim();

  if (!assistantId || !chatId) {
    sendJson(res, 400, { error: "assistantId and chatId are required." });
    return true;
  }

  const mediaDir = resolveMediaDir(assistantId);
  const chatMediaDir = path.join(mediaDir, chatId);

  try {
    await fsp.rm(chatMediaDir, { recursive: true, force: true });
    log.debug("chat media directory deleted", { assistantId, chatId });
    sendJson(res, 200, { ok: true, deleted: true });
  } catch {
    sendJson(res, 200, { ok: true, deleted: false });
  }
  return true;
}

export async function handleRuntimeWorkspaceMediaTranscribeHttpRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  requestPath: string;
  resolvedAuth: ResolvedGatewayAuth;
  trustedProxies: string[];
  allowRealIpFallback: boolean;
}): Promise<boolean> {
  const { req, res, requestPath, resolvedAuth, trustedProxies, allowRealIpFallback } = params;
  if (requestPath !== RUNTIME_WORKSPACE_MEDIA_TRANSCRIBE_PATH) {
    return false;
  }
  if ((req.method ?? "GET").toUpperCase() !== "POST") {
    sendJson(res, 405, { error: "Method not allowed." });
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

  const url = new URL(req.url ?? "/", "http://localhost");
  const assistantId = url.searchParams.get("assistantId")?.trim();
  const storagePath = url.searchParams.get("storagePath")?.trim();

  if (!assistantId || !storagePath) {
    sendJson(res, 400, { error: "assistantId and storagePath are required." });
    return true;
  }

  const filePath = resolveMediaFilePath(assistantId, storagePath);
  if (!filePath) {
    sendJson(res, 400, { error: "Invalid storage path." });
    return true;
  }

  if (!fs.existsSync(filePath)) {
    sendJson(res, 404, { error: "Media file not found." });
    return true;
  }

  const cfg = loadConfig();
  try {
    const result = await transcribeAudioFile({
      filePath,
      cfg,
    });
    const text = result.text ?? "";
    log.debug("audio transcribed", { assistantId, storagePath, textLength: text.length });
    sendJson(res, 200, { ok: true, text });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn("audio transcription failed", { assistantId, storagePath, error: msg });
    sendJson(res, 500, { ok: false, error: `Transcription failed: ${msg}` });
  }
  return true;
}
