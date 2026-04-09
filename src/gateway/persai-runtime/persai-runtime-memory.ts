import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { authorizeHttpGatewayConnect, type ResolvedGatewayAuth } from "../auth.js";
import { readJsonBody } from "../hooks.js";
import { sendGatewayAuthFailure } from "../http-common.js";
import { getBearerToken } from "../http-utils.js";
import type { PersaiRuntimeSpecStore } from "./persai-runtime-spec-store.js";
import { resolvePersaiAssistantWorkspaceDir } from "./persai-runtime-workspace.js";

const log = createSubsystemLogger("persai-runtime-memory");
const MAX_JSON_BYTES = 512_000;
const MEMORY_FILENAME = "MEMORY.md";
const ITEM_SEPARATOR = "\n---\n";

export const RUNTIME_MEMORY_ITEMS_PATH = "/api/v1/runtime/memory/items";
export const RUNTIME_MEMORY_ADD_PATH = "/api/v1/runtime/memory/add";
export const RUNTIME_MEMORY_EDIT_PATH = "/api/v1/runtime/memory/edit";
export const RUNTIME_MEMORY_FORGET_PATH = "/api/v1/runtime/memory/forget";
export const RUNTIME_MEMORY_SEARCH_PATH = "/api/v1/runtime/memory/search";

type MemoryItem = {
  id: string;
  content: string;
  createdAt: string | null;
  source: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function resolveMemoryFilePath(assistantId: string): string {
  const dir = resolvePersaiAssistantWorkspaceDir(assistantId);
  return path.join(dir, MEMORY_FILENAME);
}

async function readMemoryFile(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return "";
  }
}

function parseMemoryItems(raw: string): MemoryItem[] {
  if (!raw.trim()) {
    return [];
  }
  const items: MemoryItem[] = [];
  const blocks = raw.split(ITEM_SEPARATOR);

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) {
      continue;
    }

    const idMatch = trimmed.match(/<!-- id:(\S+) -->/);
    const dateMatch = trimmed.match(/<!-- date:(\S+) -->/);
    const id = idMatch?.[1] ?? randomUUID();
    const createdAt = dateMatch?.[1] ?? null;

    let content = trimmed
      .replace(/<!-- id:\S+ -->\n?/g, "")
      .replace(/<!-- date:\S+ -->\n?/g, "")
      .trim();

    if (content.startsWith("# MEMORY.md")) {
      content = content.replace(/^# MEMORY\.md\s*\n?/, "").trim();
      if (!content) {
        continue;
      }
    }

    items.push({ id, content, createdAt, source: "user" });
  }

  return items;
}

function serializeMemoryItems(items: MemoryItem[]): string {
  const lines = ["# MEMORY.md\n"];
  for (const item of items) {
    const meta = [`<!-- id:${item.id} -->`];
    if (item.createdAt) {
      meta.push(`<!-- date:${item.createdAt} -->`);
    }
    lines.push(`${meta.join("\n")}\n${item.content}`);
  }
  return lines.join(ITEM_SEPARATOR) + "\n";
}

async function authenticateRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  resolvedAuth: ResolvedGatewayAuth;
  trustedProxies: string[];
  allowRealIpFallback: boolean;
}): Promise<boolean> {
  const bearerToken = getBearerToken(params.req);
  const auth = await authorizeHttpGatewayConnect({
    auth: params.resolvedAuth,
    connectAuth: bearerToken ? { token: bearerToken, password: bearerToken } : null,
    req: params.req,
    trustedProxies: params.trustedProxies,
    allowRealIpFallback: params.allowRealIpFallback,
  });
  if (!auth.ok) {
    sendGatewayAuthFailure(params.res, auth);
    return false;
  }
  return true;
}

function extractAssistantId(params: {
  req: IncomingMessage;
  res: ServerResponse;
  payload?: Record<string, unknown>;
}): string | null {
  const { req, res, payload } = params;
  const url = new URL(req.url ?? "/", "http://localhost");

  const id =
    (payload && typeof payload.assistantId === "string" ? payload.assistantId.trim() : "") ||
    url.searchParams.get("assistantId")?.trim() ||
    "";

  if (!id) {
    sendJson(res, 400, {
      ok: false,
      error: "assistantId is required.",
    });
    return null;
  }
  return id;
}

export async function handleRuntimeMemoryItemsHttpRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  requestPath: string;
  resolvedAuth: ResolvedGatewayAuth;
  trustedProxies: string[];
  allowRealIpFallback: boolean;
  store: PersaiRuntimeSpecStore;
}): Promise<boolean> {
  if (params.requestPath !== RUNTIME_MEMORY_ITEMS_PATH) {
    return false;
  }

  if ((params.req.method ?? "GET").toUpperCase() !== "GET") {
    params.res.statusCode = 405;
    params.res.setHeader("Allow", "GET");
    params.res.end("Method Not Allowed");
    return true;
  }

  if (!(await authenticateRequest(params))) {
    return true;
  }

  const assistantId = extractAssistantId({
    req: params.req,
    res: params.res,
  });
  if (!assistantId) {
    return true;
  }

  const filePath = resolveMemoryFilePath(assistantId);
  const raw = await readMemoryFile(filePath);
  const items = parseMemoryItems(raw);

  sendJson(params.res, 200, { ok: true, items });
  return true;
}

export async function handleRuntimeMemoryAddHttpRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  requestPath: string;
  resolvedAuth: ResolvedGatewayAuth;
  trustedProxies: string[];
  allowRealIpFallback: boolean;
  store: PersaiRuntimeSpecStore;
}): Promise<boolean> {
  if (params.requestPath !== RUNTIME_MEMORY_ADD_PATH) {
    return false;
  }

  if ((params.req.method ?? "GET").toUpperCase() !== "POST") {
    params.res.statusCode = 405;
    params.res.setHeader("Allow", "POST");
    params.res.end("Method Not Allowed");
    return true;
  }

  if (!(await authenticateRequest(params))) {
    return true;
  }

  const parsed = await readJsonBody(params.req, MAX_JSON_BYTES);
  if (!parsed.ok) {
    sendJson(params.res, 400, { ok: false, error: parsed.error });
    return true;
  }

  const payload = isRecord(parsed.value) ? parsed.value : {};
  const assistantId = extractAssistantId({
    req: params.req,
    res: params.res,
    payload,
  });
  if (!assistantId) {
    return true;
  }

  const content = typeof payload.content === "string" ? payload.content.trim() : "";
  if (!content) {
    sendJson(params.res, 400, {
      ok: false,
      error: "content is required.",
    });
    return true;
  }

  const filePath = resolveMemoryFilePath(assistantId);
  const raw = await readMemoryFile(filePath);
  const items = parseMemoryItems(raw);
  const newItem: MemoryItem = {
    id: randomUUID(),
    content,
    createdAt: new Date().toISOString(),
    source: "user",
  };
  items.push(newItem);

  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, serializeMemoryItems(items), "utf-8");

  log.debug("memory item added", { assistantId, itemId: newItem.id });
  sendJson(params.res, 200, { ok: true, item: newItem });
  return true;
}

export async function handleRuntimeMemoryEditHttpRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  requestPath: string;
  resolvedAuth: ResolvedGatewayAuth;
  trustedProxies: string[];
  allowRealIpFallback: boolean;
  store: PersaiRuntimeSpecStore;
}): Promise<boolean> {
  if (params.requestPath !== RUNTIME_MEMORY_EDIT_PATH) {
    return false;
  }

  if ((params.req.method ?? "GET").toUpperCase() !== "PATCH") {
    params.res.statusCode = 405;
    params.res.setHeader("Allow", "PATCH");
    params.res.end("Method Not Allowed");
    return true;
  }

  if (!(await authenticateRequest(params))) {
    return true;
  }

  const parsed = await readJsonBody(params.req, MAX_JSON_BYTES);
  if (!parsed.ok) {
    sendJson(params.res, 400, { ok: false, error: parsed.error });
    return true;
  }

  const payload = isRecord(parsed.value) ? parsed.value : {};
  const assistantId = extractAssistantId({
    req: params.req,
    res: params.res,
    payload,
  });
  if (!assistantId) {
    return true;
  }

  const itemId = typeof payload.itemId === "string" ? payload.itemId.trim() : "";
  const content = typeof payload.content === "string" ? payload.content.trim() : "";
  if (!itemId || !content) {
    sendJson(params.res, 400, {
      ok: false,
      error: "itemId and content are required.",
    });
    return true;
  }

  const filePath = resolveMemoryFilePath(assistantId);
  const raw = await readMemoryFile(filePath);
  const items = parseMemoryItems(raw);
  const target = items.find((i) => i.id === itemId);

  if (!target) {
    sendJson(params.res, 404, {
      ok: false,
      error: `Memory item ${itemId} not found.`,
    });
    return true;
  }

  target.content = content;
  await fs.writeFile(filePath, serializeMemoryItems(items), "utf-8");

  log.debug("memory item edited", { assistantId, itemId });
  sendJson(params.res, 200, { ok: true, item: target });
  return true;
}

export async function handleRuntimeMemoryForgetHttpRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  requestPath: string;
  resolvedAuth: ResolvedGatewayAuth;
  trustedProxies: string[];
  allowRealIpFallback: boolean;
  store: PersaiRuntimeSpecStore;
}): Promise<boolean> {
  if (params.requestPath !== RUNTIME_MEMORY_FORGET_PATH) {
    return false;
  }

  if ((params.req.method ?? "GET").toUpperCase() !== "POST") {
    params.res.statusCode = 405;
    params.res.setHeader("Allow", "POST");
    params.res.end("Method Not Allowed");
    return true;
  }

  if (!(await authenticateRequest(params))) {
    return true;
  }

  const parsed = await readJsonBody(params.req, MAX_JSON_BYTES);
  if (!parsed.ok) {
    sendJson(params.res, 400, { ok: false, error: parsed.error });
    return true;
  }

  const payload = isRecord(parsed.value) ? parsed.value : {};
  const assistantId = extractAssistantId({
    req: params.req,
    res: params.res,
    payload,
  });
  if (!assistantId) {
    return true;
  }

  const itemId = typeof payload.itemId === "string" ? payload.itemId.trim() : "";
  if (!itemId) {
    sendJson(params.res, 400, {
      ok: false,
      error: "itemId is required.",
    });
    return true;
  }

  const filePath = resolveMemoryFilePath(assistantId);
  const raw = await readMemoryFile(filePath);
  const items = parseMemoryItems(raw);
  const before = items.length;
  const filtered = items.filter((i) => i.id !== itemId);

  if (filtered.length === before) {
    sendJson(params.res, 404, {
      ok: false,
      error: `Memory item ${itemId} not found.`,
    });
    return true;
  }

  await fs.writeFile(filePath, serializeMemoryItems(filtered), "utf-8");

  log.debug("memory item forgotten", { assistantId, itemId });
  sendJson(params.res, 200, { ok: true, forgotten: itemId });
  return true;
}

export async function handleRuntimeMemorySearchHttpRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  requestPath: string;
  resolvedAuth: ResolvedGatewayAuth;
  trustedProxies: string[];
  allowRealIpFallback: boolean;
  store: PersaiRuntimeSpecStore;
}): Promise<boolean> {
  if (params.requestPath !== RUNTIME_MEMORY_SEARCH_PATH) {
    return false;
  }

  if ((params.req.method ?? "GET").toUpperCase() !== "GET") {
    params.res.statusCode = 405;
    params.res.setHeader("Allow", "GET");
    params.res.end("Method Not Allowed");
    return true;
  }

  if (!(await authenticateRequest(params))) {
    return true;
  }

  const url = new URL(params.req.url ?? "/", "http://localhost");
  const assistantId = url.searchParams.get("assistantId")?.trim() ?? "";
  const query = url.searchParams.get("q")?.trim() ?? "";

  if (!assistantId) {
    sendJson(params.res, 400, {
      ok: false,
      error: "assistantId is required.",
    });
    return true;
  }

  if (!query) {
    sendJson(params.res, 400, {
      ok: false,
      error: "q (search query) is required.",
    });
    return true;
  }

  const filePath = resolveMemoryFilePath(assistantId);
  const raw = await readMemoryFile(filePath);
  const items = parseMemoryItems(raw);
  const lowerQuery = query.toLowerCase();
  const results = items.filter((item) => item.content.toLowerCase().includes(lowerQuery));

  sendJson(params.res, 200, { ok: true, items: results });
  return true;
}
