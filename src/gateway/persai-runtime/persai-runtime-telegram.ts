import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as path from "node:path";
import { Bot, InputFile, webhookCallback } from "grammy";
import { loadConfig } from "../../config/config.js";
import { transcribeAudioFile } from "../../media-understanding/transcribe-audio.js";
import type { ReadinessChecker } from "../server/readiness.js";
import { resolvePersaiWorkspaceMediaStoragePath } from "./persai-runtime-media.js";
import type {
  PersaiAppliedRuntimeSpec,
  PersaiRuntimeSpecStore,
} from "./persai-runtime-spec-store.js";
import { resolvePersaiAssistantWorkspaceDir } from "./persai-runtime-workspace.js";
import {
  buildTelegramHtmlMessageBodies,
  lossyPlainFromTelegramHtml,
} from "./telegram-assistant-markdown-html.js";
import {
  splitTelegramOutboundText,
  TELEGRAM_BOT_API_MAX_MESSAGE_LENGTH,
} from "./telegram-outbound-chunks.js";

export { splitTelegramOutboundText, TELEGRAM_BOT_API_MAX_MESSAGE_LENGTH };

const TELEGRAM_OUTBOUND_MEDIA_MAX_BYTES = 25 * 1024 * 1024;

type WebhookHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

type TelegramRuntimeMetadata = NonNullable<PersaiAppliedRuntimeSpec["telegramRuntime"]>;

type TelegramChannelConfig = NonNullable<ReturnType<typeof extractTelegramChannel>>;

type ManagedTelegramState = {
  assistantId: string;
  publishedVersionId: string;
  bootstrap: unknown;
  workspace: unknown;
  workspaceDir?: string;
  transportFingerprint: string;
  profileFingerprint: string;
};

interface ManagedTelegramBot {
  bot: Bot;
  assistantId: string;
  webhookSecret: string;
  handleWebhook: WebhookHandler;
  mode: "webhook" | "polling";
  state: ManagedTelegramState;
  profileSyncTimer: NodeJS.Timeout | null;
}

const activeBots = new Map<string, ManagedTelegramBot>();

/** Default handler budget; Telegram webhook must answer in ~60s. Override via PERSAI_TELEGRAM_WEBHOOK_HANDLER_TIMEOUT_MS. */
const DEFAULT_TELEGRAM_WEBHOOK_HANDLER_TIMEOUT_MS = 55_000;
/** Hard cap so we stay under Telegram's webhook deadline and avoid 500 → retries. */
const TELEGRAM_WEBHOOK_HANDLER_TIMEOUT_MAX_MS = 58_000;

const DEFAULT_TELEGRAM_PROFILE_COOLDOWN_MS = 10 * 60_000;
const DEFAULT_TELEGRAM_REINIT_CONCURRENCY = 4;
const DEFAULT_TELEGRAM_REINIT_JITTER_MS = 1_500;
const DEFAULT_TELEGRAM_REINIT_RETRIES = 3;
const DEFAULT_TELEGRAM_REINIT_BACKOFF_MS = 1_000;
const DEFAULT_READINESS_RECHECK_MS = 5_000;
const TELEGRAM_UPDATE_DEDUPE_TTL_MS = 10 * 60_000;

const processedTelegramUpdates = new Map<string, number>();

export class TelegramProfileSyncError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number | null,
    readonly terminal = false,
  ) {
    super(message);
    this.name = "TelegramProfileSyncError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractTelegramChannel(bootstrap: unknown): {
  enabled: boolean;
  botToken: string | null;
  webhookUrl: string | null;
  webhookSecret: string | null;
  groupReplyMode: string;
  parseMode: string;
  inbound: boolean;
  outbound: boolean;
  accessMode: string;
  ownerClaimStatus: string;
  ownerClaimToken: string | null;
  ownerTelegramUserId: number | null;
  ownerTelegramUsername: string | null;
  ownerTelegramChatId: string | null;
  runtimeHealth: string;
} | null {
  if (!isRecord(bootstrap)) {
    return null;
  }
  const channels = bootstrap.channels;
  if (!isRecord(channels)) {
    return null;
  }
  const tg = channels.telegram;
  if (!isRecord(tg)) {
    return null;
  }
  return {
    enabled: tg.enabled === true,
    botToken: typeof tg.botToken === "string" ? tg.botToken : null,
    webhookUrl: typeof tg.webhookUrl === "string" ? tg.webhookUrl : null,
    webhookSecret: typeof tg.webhookSecret === "string" ? tg.webhookSecret : null,
    groupReplyMode: typeof tg.groupReplyMode === "string" ? tg.groupReplyMode : "mention_reply",
    parseMode: typeof tg.parseMode === "string" ? tg.parseMode : "plain_text",
    inbound: tg.inbound !== false,
    outbound: tg.outbound !== false,
    accessMode: typeof tg.accessMode === "string" ? tg.accessMode : "owner_only",
    ownerClaimStatus: typeof tg.ownerClaimStatus === "string" ? tg.ownerClaimStatus : "not_started",
    ownerClaimToken: typeof tg.ownerClaimToken === "string" ? tg.ownerClaimToken : null,
    ownerTelegramUserId:
      typeof tg.ownerTelegramUserId === "number" && Number.isFinite(tg.ownerTelegramUserId)
        ? tg.ownerTelegramUserId
        : null,
    ownerTelegramUsername:
      typeof tg.ownerTelegramUsername === "string" ? tg.ownerTelegramUsername : null,
    ownerTelegramChatId: typeof tg.ownerTelegramChatId === "string" ? tg.ownerTelegramChatId : null,
    runtimeHealth: typeof tg.runtimeHealth === "string" ? tg.runtimeHealth : "ok",
  };
}

function cleanupProcessedTelegramUpdates(): void {
  const cutoff = Date.now() - TELEGRAM_UPDATE_DEDUPE_TTL_MS;
  for (const [key, seenAt] of processedTelegramUpdates.entries()) {
    if (seenAt < cutoff) {
      processedTelegramUpdates.delete(key);
    }
  }
}

function claimCommandToken(text: string | null | undefined): string | null {
  if (!text) {
    return null;
  }
  const match = text.trim().match(/^\/start(?:@\w+)?\s+persai_claim_([a-z0-9]+)$/i);
  return match?.[1] ?? null;
}

function shouldProcessTelegramUpdate(assistantId: string, updateId: number | null): boolean {
  if (updateId === null) {
    return true;
  }
  cleanupProcessedTelegramUpdates();
  const key = `${assistantId}:${updateId}`;
  if (processedTelegramUpdates.has(key)) {
    return false;
  }
  processedTelegramUpdates.set(key, Date.now());
  return true;
}

function isTelegramUnauthorizedError(error: unknown): boolean {
  return isRecord(error) && error.error_code === 401;
}

function resolveSystemLocale(workspace: unknown): string {
  if (!isRecord(workspace)) {
    return "en";
  }
  const userContext = workspace.userContext;
  if (!isRecord(userContext)) {
    return "en";
  }
  return typeof userContext.locale === "string" && userContext.locale.trim().length > 0
    ? userContext.locale.trim().toLowerCase()
    : "en";
}

function buildTelegramOwnerClaimedWelcome(locale: string): string {
  return locale.startsWith("ru")
    ? "Telegram подключен. Это приватный чат хозяина. Я уже здесь и готова продолжать разговор прямо в этом диалоге."
    : "Telegram is connected. This is the owner's private chat. I'm here now, and you can continue right in this conversation.";
}

function buildTelegramOwnerClaimRequiredReply(locale: string): string {
  return locale.startsWith("ru")
    ? "Этот бот приватный. Сначала откройте персональную ссылку привязки из PersAI, чтобы подтвердить аккаунт владельца."
    : "This bot is private. First open the personal claim link from PersAI to confirm the owner's Telegram account.";
}

function buildTelegramUnauthorizedUserReply(locale: string): string {
  return locale.startsWith("ru")
    ? "Этот бот доступен только хозяину ассистента."
    : "This bot is available only to the assistant owner.";
}

function evaluateTelegramOwnerGate(params: {
  currentConfig: ReturnType<typeof extractTelegramChannel>;
  incomingText?: string | null;
  telegramUserId: number | null;
  locale: string;
}): {
  allowed: boolean;
  claimNow: boolean;
  replyText: string | null;
} {
  const { currentConfig, incomingText, telegramUserId, locale } = params;
  if (!currentConfig || currentConfig.accessMode !== "owner_only") {
    return { allowed: true, claimNow: false, replyText: null };
  }

  if (currentConfig.ownerClaimStatus !== "claimed") {
    const incomingClaimToken = claimCommandToken(incomingText);
    if (
      incomingClaimToken &&
      currentConfig.ownerClaimToken &&
      incomingClaimToken === currentConfig.ownerClaimToken
    ) {
      return { allowed: false, claimNow: true, replyText: null };
    }
    return {
      allowed: false,
      claimNow: false,
      replyText: buildTelegramOwnerClaimRequiredReply(locale),
    };
  }

  if (
    currentConfig.ownerTelegramUserId !== null &&
    telegramUserId !== null &&
    currentConfig.ownerTelegramUserId !== telegramUserId
  ) {
    return {
      allowed: false,
      claimNow: false,
      replyText: buildTelegramUnauthorizedUserReply(locale),
    };
  }

  return { allowed: true, claimNow: false, replyText: null };
}

function extractPersonaFromWorkspace(workspace: unknown): {
  displayName: string | null;
  instructions: string | null;
  avatarUrl: string | null;
} {
  if (!isRecord(workspace)) {
    return { displayName: null, instructions: null, avatarUrl: null };
  }
  const persona = workspace.persona;
  if (!isRecord(persona)) {
    return { displayName: null, instructions: null, avatarUrl: null };
  }
  return {
    displayName: typeof persona.displayName === "string" ? persona.displayName : null,
    instructions: typeof persona.instructions === "string" ? persona.instructions : null,
    avatarUrl: typeof persona.avatarUrl === "string" ? persona.avatarUrl : null,
  };
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parsePositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getTelegramProfileCooldownMs(): number {
  return parsePositiveIntegerEnv(
    "PERSAI_TELEGRAM_PROFILE_COOLDOWN_MS",
    DEFAULT_TELEGRAM_PROFILE_COOLDOWN_MS,
  );
}

function getTelegramReinitConcurrency(): number {
  return parsePositiveIntegerEnv(
    "PERSAI_TELEGRAM_REINIT_CONCURRENCY",
    DEFAULT_TELEGRAM_REINIT_CONCURRENCY,
  );
}

function getTelegramReinitJitterMs(): number {
  return parsePositiveIntegerEnv(
    "PERSAI_TELEGRAM_REINIT_JITTER_MS",
    DEFAULT_TELEGRAM_REINIT_JITTER_MS,
  );
}

function getTelegramReinitRetries(): number {
  return parsePositiveIntegerEnv("PERSAI_TELEGRAM_REINIT_RETRIES", DEFAULT_TELEGRAM_REINIT_RETRIES);
}

function getTelegramReinitBackoffMs(): number {
  return parsePositiveIntegerEnv(
    "PERSAI_TELEGRAM_REINIT_BACKOFF_MS",
    DEFAULT_TELEGRAM_REINIT_BACKOFF_MS,
  );
}

function getReadinessRecheckMs(): number {
  return parsePositiveIntegerEnv(
    "PERSAI_TELEGRAM_PROFILE_READY_RECHECK_MS",
    DEFAULT_READINESS_RECHECK_MS,
  );
}

function getTelegramWebhookHandlerTimeoutMs(): number {
  const raw = parsePositiveIntegerEnv(
    "PERSAI_TELEGRAM_WEBHOOK_HANDLER_TIMEOUT_MS",
    DEFAULT_TELEGRAM_WEBHOOK_HANDLER_TIMEOUT_MS,
  );
  return Math.min(TELEGRAM_WEBHOOK_HANDLER_TIMEOUT_MAX_MS, Math.max(10_000, raw));
}

function extractTelegramRetryAfterMs(error: unknown): number | null {
  if (!isRecord(error)) {
    return null;
  }
  const directRetryAfter = error.retryAfterMs;
  if (
    typeof directRetryAfter === "number" &&
    Number.isFinite(directRetryAfter) &&
    directRetryAfter > 0
  ) {
    return directRetryAfter;
  }
  const parameters = error.parameters;
  if (!isRecord(parameters)) {
    return null;
  }
  const retryAfterSeconds = parameters.retry_after;
  if (
    typeof retryAfterSeconds !== "number" ||
    !Number.isFinite(retryAfterSeconds) ||
    retryAfterSeconds <= 0
  ) {
    return null;
  }
  return Math.ceil(retryAfterSeconds * 1000);
}

export function isTelegramMarkdownParseError(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }
  return (
    error.error_code === 400 &&
    typeof error.description === "string" &&
    error.description.includes("can't parse entities")
  );
}

/** HTML and MarkdownV2 both surface `can't parse entities` on invalid markup. */
export function isTelegramEntityParseError(error: unknown): boolean {
  return isTelegramMarkdownParseError(error);
}

export async function sendTelegramReplyWithConfiguredParseMode(
  ctx: {
    reply(text: string, options?: { parse_mode?: "HTML" }): Promise<unknown>;
  },
  reply: string,
  parseMode: string,
): Promise<void> {
  if (reply.length === 0) {
    return;
  }

  if (parseMode !== "markdown") {
    const chunks = splitTelegramOutboundText(reply, TELEGRAM_BOT_API_MAX_MESSAGE_LENGTH);
    for (const chunk of chunks) {
      await ctx.reply(chunk);
    }
    return;
  }

  const bodies = buildTelegramHtmlMessageBodies(reply, TELEGRAM_BOT_API_MAX_MESSAGE_LENGTH);
  for (const body of bodies) {
    try {
      await ctx.reply(body, { parse_mode: "HTML" });
    } catch (error) {
      if (!isTelegramEntityParseError(error)) {
        throw error;
      }
      console.warn("[persai-telegram] HTML parse failed, retrying as plain text:", error);
      await ctx.reply(lossyPlainFromTelegramHtml(body));
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomJitter(maxMs: number): number {
  if (maxMs <= 0) {
    return 0;
  }
  return Math.floor(Math.random() * maxMs);
}

function parseIsoTimestampMs(value: string | null | undefined): number {
  if (!value) {
    return Number.NaN;
  }
  return Date.parse(value);
}

export function selectLatestRuntimeSpecs(specs: PersaiAppliedRuntimeSpec[]): {
  latestSpecs: PersaiAppliedRuntimeSpec[];
  duplicateAssistantIds: string[];
} {
  const latestByAssistant = new Map<string, PersaiAppliedRuntimeSpec>();
  const countsByAssistant = new Map<string, number>();
  for (const spec of specs) {
    countsByAssistant.set(spec.assistantId, (countsByAssistant.get(spec.assistantId) ?? 0) + 1);
    const previous = latestByAssistant.get(spec.assistantId);
    if (!previous) {
      latestByAssistant.set(spec.assistantId, spec);
      continue;
    }
    const previousAppliedAt = parseIsoTimestampMs(previous.appliedAt);
    const nextAppliedAt = parseIsoTimestampMs(spec.appliedAt);
    if (
      nextAppliedAt > previousAppliedAt ||
      (nextAppliedAt === previousAppliedAt && spec.publishedVersionId > previous.publishedVersionId)
    ) {
      latestByAssistant.set(spec.assistantId, spec);
    }
  }
  return {
    latestSpecs: [...latestByAssistant.values()],
    duplicateAssistantIds: [...countsByAssistant.entries()]
      .filter(([, count]) => count > 1)
      .map(([assistantId]) => assistantId),
  };
}

function resolveTransportMode(config: TelegramChannelConfig): "webhook" | "polling" {
  return config.webhookUrl ? "webhook" : "polling";
}

function buildTransportFingerprint(config: TelegramChannelConfig): string {
  return hashJson({
    tokenHash: hashText(config.botToken ?? ""),
    mode: resolveTransportMode(config),
    webhookUrl: config.webhookUrl ?? "",
    webhookSecretHash: config.webhookSecret ? hashText(config.webhookSecret) : "",
  });
}

function resolveAvatarPath(assistantId: string): string | null {
  const workspaceDir = resolvePersaiAssistantWorkspaceDir(assistantId);
  if (!fs.existsSync(workspaceDir)) {
    return null;
  }
  const avatarFile = fs.readdirSync(workspaceDir).find((file) => file.startsWith("avatar."));
  return avatarFile ? path.join(workspaceDir, avatarFile) : null;
}

function buildProfileFingerprint(workspace: unknown, assistantId: string): string {
  const persona = extractPersonaFromWorkspace(workspace);
  let avatarHash = "";
  const avatarPath = resolveAvatarPath(assistantId);
  if (avatarPath) {
    try {
      avatarHash = createHash("sha256").update(fs.readFileSync(avatarPath)).digest("hex");
    } catch {
      avatarHash = "";
    }
  }
  return hashJson({
    displayName: persona.displayName ?? "",
    instructions: persona.instructions ?? "",
    avatarUrl: persona.avatarUrl ?? "",
    avatarHash,
  });
}

async function loadStoredSpec(
  store: PersaiRuntimeSpecStore,
  assistantId: string,
  publishedVersionId: string,
): Promise<PersaiAppliedRuntimeSpec | null> {
  return await store.get(assistantId, publishedVersionId);
}

async function updateStoredTelegramRuntime(
  store: PersaiRuntimeSpecStore,
  assistantId: string,
  publishedVersionId: string,
  patch: Partial<TelegramRuntimeMetadata>,
): Promise<TelegramRuntimeMetadata | null> {
  const record = await loadStoredSpec(store, assistantId, publishedVersionId);
  if (!record) {
    return null;
  }
  const telegramRuntime: TelegramRuntimeMetadata = {
    ...record.telegramRuntime,
    ...patch,
  };
  await store.put({
    ...record,
    telegramRuntime,
  });
  return telegramRuntime;
}

function resolvePersaiInternalApiBaseUrl(): string | undefined {
  const cfg = loadConfig();
  const provider = cfg.secrets?.providers?.["persai-runtime"];
  return provider?.source === "persai" ? provider.baseUrl : undefined;
}

export async function syncBotProfile(
  bot: Bot,
  workspace: unknown,
  assistantId: string,
): Promise<void> {
  const persona = extractPersonaFromWorkspace(workspace);
  const failures: string[] = [];
  let retryAfterMs: number | null = null;
  let unauthorized = false;

  if (persona.displayName) {
    try {
      await bot.api.setMyName(persona.displayName.slice(0, 64));
    } catch (err) {
      console.warn(`[persai-telegram] setMyName failed for ${assistantId}:`, err);
      failures.push("setMyName");
      unauthorized ||= isTelegramUnauthorizedError(err);
      retryAfterMs = Math.max(retryAfterMs ?? 0, extractTelegramRetryAfterMs(err) ?? 0) || null;
    }
  }

  if (persona.instructions) {
    try {
      await bot.api.setMyDescription(persona.instructions.slice(0, 512));
    } catch (err) {
      console.warn(`[persai-telegram] setMyDescription failed for ${assistantId}:`, err);
      failures.push("setMyDescription");
      unauthorized ||= isTelegramUnauthorizedError(err);
      retryAfterMs = Math.max(retryAfterMs ?? 0, extractTelegramRetryAfterMs(err) ?? 0) || null;
    }
  }

  try {
    const avatarPath = resolveAvatarPath(assistantId);
    if (avatarPath) {
      const buffer = fs.readFileSync(avatarPath);
      await bot.api.setMyProfilePhoto({
        type: "static",
        photo: new InputFile(buffer, path.basename(avatarPath)),
      });
      console.log(`[persai-telegram] Profile photo set for ${assistantId}`);
    }
  } catch (err) {
    console.warn(`[persai-telegram] setMyProfilePhoto failed for ${assistantId}:`, err);
    failures.push("setMyProfilePhoto");
    unauthorized ||= isTelegramUnauthorizedError(err);
    retryAfterMs = Math.max(retryAfterMs ?? 0, extractTelegramRetryAfterMs(err) ?? 0) || null;
  }

  if (failures.length > 0) {
    throw new TelegramProfileSyncError(
      `Telegram profile sync failed for ${assistantId}: ${failures.join(", ")}`,
      retryAfterMs,
      unauthorized,
    );
  }
}

function clearProfileSyncTimer(managed: ManagedTelegramBot): void {
  if (managed.profileSyncTimer) {
    clearTimeout(managed.profileSyncTimer);
    managed.profileSyncTimer = null;
  }
}

function scheduleProfileSync(params: {
  assistantId: string;
  store: PersaiRuntimeSpecStore;
  getReadiness?: ReadinessChecker;
  deferUntilReady?: boolean;
  delayMs?: number;
  force?: boolean;
}): void {
  const managed = activeBots.get(params.assistantId);
  if (!managed) {
    return;
  }
  clearProfileSyncTimer(managed);
  managed.profileSyncTimer = setTimeout(
    () => {
      managed.profileSyncTimer = null;
      void reconcileTelegramProfile(params).catch((err) => {
        console.warn(
          `[persai-telegram] Deferred profile reconcile failed for ${params.assistantId}:`,
          err,
        );
      });
    },
    Math.max(0, params.delayMs ?? 0),
  );
}

async function reconcileTelegramProfile(params: {
  assistantId: string;
  store: PersaiRuntimeSpecStore;
  getReadiness?: ReadinessChecker;
  deferUntilReady?: boolean;
  force?: boolean;
}): Promise<void> {
  const managed = activeBots.get(params.assistantId);
  if (!managed) {
    return;
  }
  const state = managed.state;
  const record = await loadStoredSpec(params.store, state.assistantId, state.publishedVersionId);
  const currentMeta = record?.telegramRuntime ?? {};
  const desiredProfileFingerprint = buildProfileFingerprint(state.workspace, state.assistantId);
  managed.state.profileFingerprint = desiredProfileFingerprint;

  if (!params.force && currentMeta.profileFingerprint === desiredProfileFingerprint) {
    return;
  }

  if (params.deferUntilReady && params.getReadiness && !params.getReadiness().ready) {
    scheduleProfileSync({
      ...params,
      delayMs: getReadinessRecheckMs(),
    });
    return;
  }

  const cooldownMs = getTelegramProfileCooldownMs();
  const lastAttemptAt = currentMeta.lastProfileSyncAttemptAt
    ? Date.parse(currentMeta.lastProfileSyncAttemptAt)
    : Number.NaN;
  const notBeforeAt = parseIsoTimestampMs(currentMeta.nextProfileSyncNotBeforeAt ?? null);
  if (!params.force) {
    const remainingCooldown = Number.isFinite(lastAttemptAt)
      ? cooldownMs - (Date.now() - lastAttemptAt)
      : 0;
    const remainingNotBefore = Number.isFinite(notBeforeAt) ? notBeforeAt - Date.now() : 0;
    const delayMs = Math.max(remainingCooldown, remainingNotBefore, 0);
    if (delayMs > 0) {
      scheduleProfileSync({
        ...params,
        delayMs,
      });
      return;
    }
  }

  const attemptAt = new Date().toISOString();
  await updateStoredTelegramRuntime(params.store, state.assistantId, state.publishedVersionId, {
    transportFingerprint: state.transportFingerprint,
    lastProfileSyncAttemptAt: attemptAt,
  });

  try {
    await syncBotProfile(managed.bot, state.workspace, state.assistantId);
    await updateStoredTelegramRuntime(params.store, state.assistantId, state.publishedVersionId, {
      transportFingerprint: state.transportFingerprint,
      profileFingerprint: desiredProfileFingerprint,
      lastProfileSyncAt: attemptAt,
      lastProfileSyncAttemptAt: attemptAt,
      nextProfileSyncNotBeforeAt: null,
      lastProfileSyncError: null,
    });
  } catch (err) {
    if (err instanceof TelegramProfileSyncError && err.terminal) {
      await notifyPersaiTelegramChatTarget({
        assistantId: state.assistantId,
        telegramChatId: currentConfigFromState(state)?.ownerTelegramChatId ?? "",
        chatType: "private",
        title: "",
        username: currentConfigFromState(state)?.ownerTelegramUsername ?? "",
        runtimeHealth: "invalid_token",
        runtimeHealthMessage: err.message,
      }).catch(() => undefined);
      await updateStoredTelegramRuntime(params.store, state.assistantId, state.publishedVersionId, {
        transportFingerprint: state.transportFingerprint,
        lastProfileSyncAttemptAt: attemptAt,
        nextProfileSyncNotBeforeAt: null,
        lastProfileSyncError: err.message,
      });
      return;
    }
    const retryAfterMs = extractTelegramRetryAfterMs(err) ?? cooldownMs;
    const nextProfileSyncNotBeforeAt = new Date(Date.now() + retryAfterMs).toISOString();
    await updateStoredTelegramRuntime(params.store, state.assistantId, state.publishedVersionId, {
      transportFingerprint: state.transportFingerprint,
      lastProfileSyncAttemptAt: attemptAt,
      nextProfileSyncNotBeforeAt,
      lastProfileSyncError: err instanceof Error ? err.message : String(err),
    });
    scheduleProfileSync({
      ...params,
      delayMs: retryAfterMs,
    });
  }
}

function currentConfigFromState(
  state: ManagedTelegramState,
): ReturnType<typeof extractTelegramChannel> | null {
  return extractTelegramChannel(state.bootstrap);
}

export async function syncTelegramBotForAssistant(params: {
  assistantId: string;
  publishedVersionId: string;
  bootstrap: unknown;
  workspace: unknown;
  store: PersaiRuntimeSpecStore;
  workspaceDir?: string;
  getReadiness?: ReadinessChecker;
  deferProfileUntilReady?: boolean;
  forceProfileSync?: boolean;
}): Promise<void> {
  const { assistantId, bootstrap, workspace } = params;
  const tgConfig = extractTelegramChannel(bootstrap);

  if (!tgConfig || !tgConfig.enabled || !tgConfig.botToken) {
    await stopTelegramBot(assistantId);
    return;
  }

  const transportFingerprint = buildTransportFingerprint(tgConfig);
  const profileFingerprint = buildProfileFingerprint(workspace, assistantId);
  const desiredState: ManagedTelegramState = {
    assistantId,
    publishedVersionId: params.publishedVersionId,
    bootstrap,
    workspace,
    workspaceDir: params.workspaceDir,
    transportFingerprint,
    profileFingerprint,
  };

  const storedSpec = await loadStoredSpec(params.store, assistantId, params.publishedVersionId);
  const existing = activeBots.get(assistantId);
  const shouldRestartTransport =
    !existing || existing.state.transportFingerprint !== transportFingerprint;

  if (existing && shouldRestartTransport) {
    await stopTelegramBot(assistantId);
  }

  if (!shouldRestartTransport && existing) {
    existing.state = desiredState;
    await updateStoredTelegramRuntime(params.store, assistantId, params.publishedVersionId, {
      transportFingerprint,
    });
    if (
      params.forceProfileSync ||
      storedSpec?.telegramRuntime?.profileFingerprint !== profileFingerprint
    ) {
      scheduleProfileSync({
        assistantId,
        store: params.store,
        getReadiness: params.getReadiness,
        deferUntilReady: params.deferProfileUntilReady,
        force: params.forceProfileSync,
      });
    }
    return;
  }

  const bot = new Bot(tgConfig.botToken);
  const managed: ManagedTelegramBot = {
    bot,
    assistantId,
    webhookSecret: tgConfig.webhookSecret ?? "",
    handleWebhook: async (_req, res) => {
      res.statusCode = 404;
      res.end("Telegram bot not initialized");
    },
    mode: resolveTransportMode(tgConfig),
    state: desiredState,
    profileSyncTimer: null,
  };
  activeBots.set(assistantId, managed);

  bot.on("my_chat_member", async (ctx) => {
    const update = ctx.myChatMember;
    const chat = update.chat;
    if (chat.type !== "group" && chat.type !== "supergroup") {
      return;
    }

    const newStatus = update.new_chat_member.status;
    const event = newStatus === "member" || newStatus === "administrator" ? "joined" : "left";

    void notifyPersaiGroupUpdate({
      assistantId,
      telegramChatId: String(chat.id),
      title: chat.title ?? "",
      event,
    }).catch((err) => {
      console.error(`[persai-telegram] Group update notification failed:`, err);
    });
  });

  bot.on("message:text", async (ctx) => {
    const currentManaged = activeBots.get(assistantId);
    if (!currentManaged) {
      return;
    }
    const currentConfig = extractTelegramChannel(currentManaged.state.bootstrap);
    if (!currentConfig || !currentConfig.inbound) {
      return;
    }
    const locale = resolveSystemLocale(currentManaged.state.workspace);
    const updateId = typeof ctx.update.update_id === "number" ? ctx.update.update_id : null;
    if (!shouldProcessTelegramUpdate(assistantId, updateId)) {
      console.log(`[persai-telegram] Dropped duplicate update ${updateId} for ${assistantId}`);
      return;
    }

    const chatType = ctx.chat.type;
    const isGroup = chatType === "group" || chatType === "supergroup";

    if (isGroup && currentConfig.groupReplyMode === "mention_reply") {
      const botInfo = ctx.me;
      const text = ctx.message.text ?? "";
      const isReply = ctx.message.reply_to_message?.from?.id === botInfo.id;
      const isMentioned = text.includes(`@${botInfo.username}`);
      if (!isReply && !isMentioned) {
        return;
      }
    }

    if (!currentConfig.outbound) {
      return;
    }

    try {
      const ownerGate = evaluateTelegramOwnerGate({
        currentConfig,
        incomingText: ctx.message.text ?? "",
        telegramUserId: ctx.from?.id ?? null,
        locale,
      });
      if (ownerGate.claimNow) {
        await notifyPersaiTelegramChatTarget({
          assistantId,
          telegramChatId: String(ctx.chat.id),
          chatType: ctx.chat.type,
          title: "title" in ctx.chat && typeof ctx.chat.title === "string" ? ctx.chat.title : "",
          username: typeof ctx.from?.username === "string" ? ctx.from.username : "",
          telegramUserId: ctx.from?.id,
          claimOwner: true,
        });
        await ctx.reply(buildTelegramOwnerClaimedWelcome(locale));
        await notifyPersaiTelegramChatTarget({
          assistantId,
          telegramChatId: String(ctx.chat.id),
          chatType: ctx.chat.type,
          title: "title" in ctx.chat && typeof ctx.chat.title === "string" ? ctx.chat.title : "",
          username: typeof ctx.from?.username === "string" ? ctx.from.username : "",
          telegramUserId: ctx.from?.id,
          systemWelcomeSentAt: new Date().toISOString(),
          runtimeHealth: "ok",
        });
        return;
      }
      if (!ownerGate.allowed) {
        if (ownerGate.replyText) {
          await ctx.reply(ownerGate.replyText).catch(() => {});
        }
        return;
      }

      if (isGroup) {
        await notifyPersaiGroupUpdate({
          assistantId,
          telegramChatId: String(ctx.chat.id),
          title: "title" in ctx.chat && typeof ctx.chat.title === "string" ? ctx.chat.title : "",
          event: "joined",
        });
      }
      await notifyPersaiTelegramChatTarget({
        assistantId,
        telegramChatId: String(ctx.chat.id),
        chatType: ctx.chat.type,
        title: "title" in ctx.chat && typeof ctx.chat.title === "string" ? ctx.chat.title : "",
        username: typeof ctx.from?.username === "string" ? ctx.from.username : "",
        telegramUserId: ctx.from?.id,
      });
      const turnResult = await requestPersaiTelegramTurn({
        assistantId,
        userMessage: ctx.message.text ?? "",
        chatId: String(ctx.chat.id),
        updateId,
      });
      await sendTelegramAssistantTurnReply(
        ctx,
        bot,
        ctx.chat.id,
        assistantId,
        turnResult,
        currentConfig.parseMode,
      );
    } catch (err) {
      console.error(`[persai-telegram] Agent turn failed for ${assistantId}:`, err);
      await ctx.reply("Sorry, I encountered an error. Please try again.").catch(() => {});
    }
  });

  bot.on("message:voice", async (ctx) => {
    const currentManaged = activeBots.get(assistantId);
    if (!currentManaged) return;
    const currentConfig = extractTelegramChannel(currentManaged.state.bootstrap);
    if (!currentConfig || !currentConfig.inbound || !currentConfig.outbound) return;
    const locale = resolveSystemLocale(currentManaged.state.workspace);
    const updateId = typeof ctx.update.update_id === "number" ? ctx.update.update_id : null;
    if (!shouldProcessTelegramUpdate(assistantId, updateId)) return;

    try {
      const ownerGate = evaluateTelegramOwnerGate({
        currentConfig,
        telegramUserId: ctx.from?.id ?? null,
        locale,
      });
      if (!ownerGate.allowed) {
        if (ownerGate.replyText) {
          await ctx.reply(ownerGate.replyText).catch(() => {});
        }
        return;
      }
      const voice = ctx.message.voice;
      const { buffer, filePath: tgFilePath } = await downloadTelegramFile(bot, voice.file_id);
      const ext = inferExtFromMime(voice.mime_type ?? "audio/ogg");
      const saved = await saveTelegramMediaToWorkspace({
        assistantId,
        chatId: String(ctx.chat.id),
        buffer,
        ext,
      });

      const cfg = loadConfig();
      const absPath = path.join(resolveMediaDir(assistantId), saved.storagePath);
      let transcription = "";
      try {
        const sttResult = await transcribeAudioFile({ filePath: absPath, cfg });
        transcription = sttResult.text ?? "";
      } catch (sttErr) {
        console.warn(`[persai-telegram] Voice STT failed for ${assistantId}:`, sttErr);
      }

      const userMessage = transcription.trim() || "(voice message)";
      const turnResult = await requestPersaiTelegramTurn({
        assistantId,
        userMessage,
        chatId: String(ctx.chat.id),
        updateId,
        attachments: [
          {
            type: "voice",
            storagePath: saved.storagePath,
            mimeType: voice.mime_type ?? "audio/ogg",
            sizeBytes: saved.sizeBytes,
            originalFilename: tgFilePath.split("/").pop() ?? null,
            transcription: transcription || undefined,
          },
        ],
      });
      await sendTelegramAssistantTurnReply(
        ctx,
        bot,
        ctx.chat.id,
        assistantId,
        turnResult,
        currentConfig.parseMode,
      );
    } catch (err) {
      console.error(`[persai-telegram] Voice turn failed for ${assistantId}:`, err);
      await ctx
        .reply("Sorry, I couldn't process your voice message. Please try again.")
        .catch(() => {});
    }
  });

  bot.on("message:photo", async (ctx) => {
    const currentManaged = activeBots.get(assistantId);
    if (!currentManaged) return;
    const currentConfig = extractTelegramChannel(currentManaged.state.bootstrap);
    if (!currentConfig || !currentConfig.inbound || !currentConfig.outbound) return;
    const locale = resolveSystemLocale(currentManaged.state.workspace);
    const updateId = typeof ctx.update.update_id === "number" ? ctx.update.update_id : null;
    if (!shouldProcessTelegramUpdate(assistantId, updateId)) return;

    try {
      const ownerGate = evaluateTelegramOwnerGate({
        currentConfig,
        incomingText: ctx.message.caption ?? "",
        telegramUserId: ctx.from?.id ?? null,
        locale,
      });
      if (!ownerGate.allowed) {
        if (ownerGate.replyText) {
          await ctx.reply(ownerGate.replyText).catch(() => {});
        }
        return;
      }
      const photos = ctx.message.photo;
      const largest = photos[photos.length - 1];
      if (!largest) return;
      const { buffer, filePath: tgFilePath } = await downloadTelegramFile(bot, largest.file_id);
      const saved = await saveTelegramMediaToWorkspace({
        assistantId,
        chatId: String(ctx.chat.id),
        buffer,
        ext: "jpg",
      });

      const caption = ctx.message.caption ?? "";
      const userMessage = caption.trim() || "(sent a photo)";
      const turnResult = await requestPersaiTelegramTurn({
        assistantId,
        userMessage,
        chatId: String(ctx.chat.id),
        updateId,
        attachments: [
          {
            type: "image",
            storagePath: saved.storagePath,
            mimeType: "image/jpeg",
            sizeBytes: saved.sizeBytes,
            originalFilename: tgFilePath.split("/").pop() ?? null,
          },
        ],
      });
      await sendTelegramAssistantTurnReply(
        ctx,
        bot,
        ctx.chat.id,
        assistantId,
        turnResult,
        currentConfig.parseMode,
      );
    } catch (err) {
      console.error(`[persai-telegram] Photo turn failed for ${assistantId}:`, err);
      await ctx.reply("Sorry, I couldn't process your photo. Please try again.").catch(() => {});
    }
  });

  bot.on("message:document", async (ctx) => {
    const currentManaged = activeBots.get(assistantId);
    if (!currentManaged) return;
    const currentConfig = extractTelegramChannel(currentManaged.state.bootstrap);
    if (!currentConfig || !currentConfig.inbound || !currentConfig.outbound) return;
    const locale = resolveSystemLocale(currentManaged.state.workspace);
    const updateId = typeof ctx.update.update_id === "number" ? ctx.update.update_id : null;
    if (!shouldProcessTelegramUpdate(assistantId, updateId)) return;

    try {
      const ownerGate = evaluateTelegramOwnerGate({
        currentConfig,
        incomingText: ctx.message.caption ?? "",
        telegramUserId: ctx.from?.id ?? null,
        locale,
      });
      if (!ownerGate.allowed) {
        if (ownerGate.replyText) {
          await ctx.reply(ownerGate.replyText).catch(() => {});
        }
        return;
      }
      const doc = ctx.message.document;
      if (!doc) return;
      const { buffer, filePath: tgFilePath } = await downloadTelegramFile(bot, doc.file_id);
      const mime = doc.mime_type ?? "application/octet-stream";
      const ext = inferExtFromMime(mime);
      const saved = await saveTelegramMediaToWorkspace({
        assistantId,
        chatId: String(ctx.chat.id),
        buffer,
        ext,
      });

      const caption = ctx.message.caption ?? "";
      const docName = doc.file_name ?? tgFilePath.split("/").pop() ?? "document";
      const userMessage = caption.trim() || `(sent a file: ${docName})`;
      const turnResult = await requestPersaiTelegramTurn({
        assistantId,
        userMessage,
        chatId: String(ctx.chat.id),
        updateId,
        attachments: [
          {
            type: mime.startsWith("audio/")
              ? "audio"
              : mime.startsWith("video/")
                ? "video"
                : "document",
            storagePath: saved.storagePath,
            mimeType: mime,
            sizeBytes: saved.sizeBytes,
            originalFilename: doc.file_name ?? null,
          },
        ],
      });
      await sendTelegramAssistantTurnReply(
        ctx,
        bot,
        ctx.chat.id,
        assistantId,
        turnResult,
        currentConfig.parseMode,
      );
    } catch (err) {
      console.error(`[persai-telegram] Document turn failed for ${assistantId}:`, err);
      await ctx.reply("Sorry, I couldn't process your file. Please try again.").catch(() => {});
    }
  });

  if (tgConfig.webhookUrl) {
    managed.handleWebhook = webhookCallback(bot, "http", {
      secretToken: tgConfig.webhookSecret ?? undefined,
      timeoutMilliseconds: getTelegramWebhookHandlerTimeoutMs(),
      // Match extensions/telegram: avoid throwing at grammY's wall — Telegram retries on non-2xx → duplicate turns.
      onTimeout: "return",
    }) as unknown as WebhookHandler;

    try {
      await bot.api.setWebhook(tgConfig.webhookUrl, {
        secret_token: tgConfig.webhookSecret ?? undefined,
        allowed_updates: ["message", "my_chat_member"],
        drop_pending_updates: false,
      });
      console.log(`[persai-telegram] Webhook set for ${assistantId}: ${tgConfig.webhookUrl}`);
    } catch (err) {
      console.error(`[persai-telegram] Failed to set webhook for ${assistantId}:`, err);
    }
  } else {
    managed.handleWebhook = async (_req, res) => {
      res.statusCode = 404;
      res.end("Polling mode");
    };

    try {
      await bot.api.deleteWebhook({ drop_pending_updates: false });
    } catch {
      // Best effort — ensure no stale webhook blocks polling.
    }

    bot
      .start({
        allowed_updates: ["message", "my_chat_member"],
        drop_pending_updates: false,
        onStart: () => console.log(`[persai-telegram] Polling started for ${assistantId}`),
      })
      .catch((err) => {
        console.warn(`[persai-telegram] Polling error for ${assistantId} (non-fatal):`, err);
      });
  }

  await updateStoredTelegramRuntime(params.store, assistantId, params.publishedVersionId, {
    transportFingerprint,
  });

  const shouldSyncProfile =
    params.forceProfileSync ||
    storedSpec?.telegramRuntime?.profileFingerprint !== profileFingerprint;
  if (shouldSyncProfile) {
    scheduleProfileSync({
      assistantId,
      store: params.store,
      getReadiness: params.getReadiness,
      deferUntilReady: params.deferProfileUntilReady,
      force: params.forceProfileSync,
      delayMs: shouldRestartTransport ? randomJitter(getTelegramReinitJitterMs()) : 0,
    });
  }
}

async function stopTelegramBot(assistantId: string): Promise<void> {
  const existing = activeBots.get(assistantId);
  if (!existing) {
    return;
  }
  clearProfileSyncTimer(existing);
  try {
    if (existing.mode === "polling") {
      await existing.bot.stop();
    } else {
      await existing.bot.api.deleteWebhook({ drop_pending_updates: false });
    }
  } catch {
    // Best effort
  }
  activeBots.delete(assistantId);
  console.log(`[persai-telegram] Bot stopped for ${assistantId} (${existing.mode})`);
}

type TelegramAttachmentPayload = {
  type: "image" | "audio" | "voice" | "video" | "document";
  storagePath: string;
  mimeType: string;
  sizeBytes: number;
  originalFilename: string | null;
  transcription?: string;
};

async function downloadTelegramFile(
  bot: Bot,
  fileId: string,
): Promise<{ buffer: Buffer; filePath: string }> {
  const file = await bot.api.getFile(fileId);
  if (!file.file_path) {
    throw new Error("Telegram file_path is missing.");
  }
  const url = `https://api.telegram.org/file/bot${bot.token}/${file.file_path}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download Telegram file: ${res.status}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, filePath: file.file_path };
}

function resolveMediaDir(assistantId: string): string {
  const workspaceDir = resolvePersaiAssistantWorkspaceDir(assistantId);
  return path.join(workspaceDir, "media");
}

async function saveTelegramMediaToWorkspace(params: {
  assistantId: string;
  chatId: string;
  buffer: Buffer;
  ext: string;
}): Promise<{ storagePath: string; sizeBytes: number }> {
  const mediaDir = resolveMediaDir(params.assistantId);
  const chatDir = path.join(mediaDir, params.chatId);
  await fsp.mkdir(chatDir, { recursive: true });
  const filename = `tg-${Date.now()}.${params.ext}`;
  const filePath = path.join(chatDir, filename);
  await fsp.writeFile(filePath, params.buffer);
  return {
    storagePath: `${params.chatId}/${filename}`,
    sizeBytes: params.buffer.length,
  };
}

function inferExtFromMime(mime: string): string {
  const map: Record<string, string> = {
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "video/mp4": "mp4",
    "application/pdf": "pdf",
  };
  return map[mime] ?? mime.split("/").pop() ?? "bin";
}

type PersaiTurnMedia = {
  url: string;
  type: "image" | "audio" | "video" | "document";
  audioAsVoice?: boolean;
};

type PersaiTelegramTurnResult = {
  text: string;
  media: PersaiTurnMedia[];
};

function parseTurnMedia(raw: unknown): PersaiTurnMedia[] {
  if (!Array.isArray(raw)) return [];
  const result: PersaiTurnMedia[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    const url = typeof r.url === "string" ? r.url : "";
    const type = typeof r.type === "string" ? r.type : "";
    if (!url || !["image", "audio", "video", "document"].includes(type)) continue;
    result.push({
      url,
      type: type as PersaiTurnMedia["type"],
      ...(r.audioAsVoice === true ? { audioAsVoice: true } : {}),
    });
  }
  return result;
}

async function requestPersaiTelegramTurn(params: {
  assistantId: string;
  userMessage: string;
  chatId: string;
  attachments?: TelegramAttachmentPayload[];
  updateId?: number | null;
}): Promise<PersaiTelegramTurnResult> {
  const fallback: PersaiTelegramTurnResult = {
    text: "I'm having trouble responding right now. Please try again.",
    media: [],
  };
  const baseUrl = resolvePersaiInternalApiBaseUrl();
  const token = process.env.PERSAI_INTERNAL_API_TOKEN?.trim();
  if (!baseUrl || !token) {
    return fallback;
  }

  try {
    const response = await fetch(`${baseUrl}/api/v1/internal/runtime/turns/telegram`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        assistantId: params.assistantId,
        threadId: params.chatId,
        message: params.userMessage,
        ...(params.updateId !== null && params.updateId !== undefined
          ? { updateId: params.updateId }
          : {}),
        ...(params.attachments && params.attachments.length > 0
          ? { attachments: params.attachments }
          : {}),
      }),
    });
    if (!response.ok) {
      return fallback;
    }
    const payload = (await response.json()) as Record<string, unknown>;
    if (payload && payload.ok === true && typeof payload.assistantMessage === "string") {
      return {
        text: payload.assistantMessage.trim() || "...",
        media: parseTurnMedia(payload.media),
      };
    }
    if (payload && payload.ok === false && typeof payload.renderedMessage === "string") {
      return {
        text:
          payload.renderedMessage.trim() ||
          "I'm having trouble responding right now. Please try again.",
        media: [],
      };
    }
  } catch (err) {
    console.error(`[persai-telegram] PersAI turn gateway failed for ${params.assistantId}:`, err);
  }

  return fallback;
}

async function deliverTelegramMedia(
  bot: Bot,
  chatId: string | number,
  assistantId: string,
  media: PersaiTurnMedia[],
): Promise<void> {
  for (const item of media) {
    try {
      const filePath = resolvePersaiWorkspaceMediaStoragePath(assistantId, item.url);
      if (!filePath || !fs.existsSync(filePath)) {
        console.warn(`[persai-telegram] Media file not found: ${item.url}`);
        continue;
      }
      const st = await fsp.stat(filePath);
      if (!st.isFile() || st.size > TELEGRAM_OUTBOUND_MEDIA_MAX_BYTES) {
        console.warn(`[persai-telegram] Media file missing or too large: ${filePath}`);
        continue;
      }
      const buffer = await fsp.readFile(filePath);
      const filename = path.basename(filePath);

      if (item.type === "image") {
        await bot.api.sendPhoto(chatId, new InputFile(buffer, filename));
      } else if (item.type === "audio" && item.audioAsVoice) {
        await bot.api.sendVoice(chatId, new InputFile(buffer, filename));
      } else if (item.type === "audio") {
        await bot.api.sendAudio(chatId, new InputFile(buffer, filename));
      } else if (item.type === "video") {
        await bot.api.sendVideo(chatId, new InputFile(buffer, filename));
      } else {
        await bot.api.sendDocument(chatId, new InputFile(buffer, filename));
      }
    } catch (err) {
      console.warn(`[persai-telegram] Failed to send media to ${chatId}:`, err);
    }
  }
}

function persaiTelegramTurnHasVoiceNote(media: PersaiTurnMedia[]): boolean {
  return media.some((m) => m.type === "audio" && m.audioAsVoice === true);
}

/** Voice-note replies: Telegram UX is voice-only (no duplicate text). Other media still sent in full. */
async function sendTelegramAssistantTurnReply(
  ctx: Parameters<typeof sendTelegramReplyWithConfiguredParseMode>[0],
  bot: Bot,
  chatId: string | number,
  assistantId: string,
  turnResult: PersaiTelegramTurnResult,
  parseMode: string,
): Promise<void> {
  if (!persaiTelegramTurnHasVoiceNote(turnResult.media)) {
    await sendTelegramReplyWithConfiguredParseMode(ctx, turnResult.text, parseMode);
  }
  if (turnResult.media.length > 0) {
    await deliverTelegramMedia(bot, chatId, assistantId, turnResult.media);
  }
}

async function notifyPersaiGroupUpdate(params: {
  assistantId: string;
  telegramChatId: string;
  title: string;
  event: "joined" | "left";
}): Promise<void> {
  const baseUrl = resolvePersaiInternalApiBaseUrl();
  if (!baseUrl) {
    return;
  }

  const token = process.env.PERSAI_INTERNAL_API_TOKEN ?? "";
  if (!token) {
    return;
  }

  const url = `${baseUrl}/api/v1/internal/runtime/telegram/group-update`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(params),
  });

  if (!res.ok) {
    console.error(`[persai-telegram] Group update POST failed: ${res.status} ${res.statusText}`);
  }
}

async function notifyPersaiTelegramChatTarget(params: {
  assistantId: string;
  telegramChatId: string;
  chatType: string;
  title: string;
  username: string;
  telegramUserId?: number;
  claimOwner?: boolean;
  systemWelcomeSentAt?: string;
  runtimeHealth?: "ok" | "invalid_token";
  runtimeHealthMessage?: string;
}): Promise<void> {
  const baseUrl = resolvePersaiInternalApiBaseUrl();
  if (!baseUrl) {
    return;
  }

  const token = process.env.PERSAI_INTERNAL_API_TOKEN ?? "";
  if (!token) {
    return;
  }

  const url = `${baseUrl}/api/v1/internal/runtime/telegram/chat-target`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(params),
  });

  if (!res.ok) {
    console.error(`[persai-telegram] Chat target POST failed: ${res.status} ${res.statusText}`);
  }
}

export async function handleTelegramWebhookRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  requestPath: string;
  store: PersaiRuntimeSpecStore;
  getReadiness?: ReadinessChecker;
}): Promise<boolean> {
  const { req, res, requestPath } = params;
  const prefix = "/telegram-webhook/";
  if (!requestPath.startsWith(prefix)) {
    return false;
  }

  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "POST") {
    res.statusCode = 405;
    res.end("Method Not Allowed");
    return true;
  }

  const assistantId = requestPath.slice(prefix.length).split("/")[0] ?? "";
  if (!assistantId) {
    res.statusCode = 400;
    res.end("Missing assistantId");
    return true;
  }

  let managed = activeBots.get(assistantId);
  if (!managed) {
    const allSpecs = await params.store.getAll();
    const { latestSpecs } = selectLatestRuntimeSpecs(allSpecs);
    const spec = latestSpecs.find((candidate) => candidate.assistantId === assistantId) ?? null;
    const tgConfig = spec ? extractTelegramChannel(spec.bootstrap) : null;
    if (spec && tgConfig?.enabled && tgConfig.botToken) {
      try {
        await syncTelegramBotForAssistant({
          assistantId: spec.assistantId,
          publishedVersionId: spec.publishedVersionId,
          bootstrap: spec.bootstrap,
          workspace: spec.workspace,
          store: params.store,
          workspaceDir: spec.workspaceDir,
          getReadiness: params.getReadiness,
          deferProfileUntilReady: true,
        });
      } catch (err) {
        console.error(`[persai-telegram] Lazy bot bootstrap failed for ${assistantId}:`, err);
      }
      managed = activeBots.get(assistantId);
    }
    if (!managed) {
      res.statusCode = 404;
      res.end("Bot not found");
      return true;
    }
  }

  try {
    await managed.handleWebhook(req, res);
  } catch (err) {
    console.error(`[persai-telegram] Webhook handler error for ${assistantId}:`, err);
    if (!res.writableEnded) {
      res.statusCode = 500;
      res.end("Internal error");
    }
  }
  return true;
}

export async function reinitializeTelegramBotsFromStore(
  store: PersaiRuntimeSpecStore,
  opts: {
    getReadiness?: ReadinessChecker;
  } = {},
): Promise<void> {
  const allSpecs = await store.getAll();
  if (!allSpecs || allSpecs.length === 0) {
    return;
  }

  const { latestSpecs, duplicateAssistantIds } = selectLatestRuntimeSpecs(allSpecs);
  if (duplicateAssistantIds.length > 0) {
    for (const assistantId of duplicateAssistantIds) {
      const latestSpec = latestSpecs.find((spec) => spec.assistantId === assistantId);
      if (!latestSpec) {
        continue;
      }
      await store.remove(assistantId);
      await store.put(latestSpec);
    }
    console.warn(
      `[persai-telegram] Collapsed ${allSpecs.length - latestSpecs.length} stale runtime spec(s) across ${duplicateAssistantIds.length} assistant(s) before bot reinit`,
    );
  }

  const candidates = latestSpecs.filter((spec) => {
    const tgConfig = extractTelegramChannel(spec.bootstrap);
    return Boolean(tgConfig?.enabled && tgConfig.botToken);
  });
  if (candidates.length === 0) {
    return;
  }

  const concurrency = Math.max(1, getTelegramReinitConcurrency());
  const retries = Math.max(1, getTelegramReinitRetries());
  const baseBackoffMs = getTelegramReinitBackoffMs();
  const jitterMs = getTelegramReinitJitterMs();
  let started = 0;
  let index = 0;

  const workers = Array.from({ length: Math.min(concurrency, candidates.length) }, async () => {
    while (true) {
      const currentIndex = index++;
      const spec = candidates[currentIndex];
      if (!spec) {
        return;
      }
      await sleep(randomJitter(jitterMs));
      for (let attempt = 1; attempt <= retries; attempt += 1) {
        try {
          await syncTelegramBotForAssistant({
            assistantId: spec.assistantId,
            publishedVersionId: spec.publishedVersionId,
            bootstrap: spec.bootstrap,
            workspace: spec.workspace,
            store,
            workspaceDir: spec.workspaceDir,
            getReadiness: opts.getReadiness,
            deferProfileUntilReady: true,
          });
          started += 1;
          break;
        } catch (err) {
          if (attempt >= retries) {
            console.error(`[persai-telegram] Failed to reinit bot for ${spec.assistantId}:`, err);
            break;
          }
          const backoffMs = baseBackoffMs * attempt + randomJitter(baseBackoffMs);
          await sleep(backoffMs);
        }
      }
    }
  });

  await Promise.all(workers);
  if (started > 0) {
    console.log(
      `[persai-telegram] Reinitialized ${started} Telegram bot(s) from store with concurrency ${concurrency}`,
    );
  }
}
