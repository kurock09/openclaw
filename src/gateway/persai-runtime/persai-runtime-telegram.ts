import * as fs from "node:fs";
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as path from "node:path";
import { Bot, InputFile, webhookCallback } from "grammy";
import { loadConfig } from "../../config/config.js";
import type { ReadinessChecker } from "../server/readiness.js";
import { runPersaiTelegramAgentTurn } from "./persai-runtime-agent-turn.js";
import { extractPersonaInstructionsFromWorkspace } from "./persai-runtime-http.js";
import { extractPersaiRuntimeModelOverride } from "./persai-runtime-provider-profile.js";
import type {
  PersaiAppliedRuntimeSpec,
  PersaiRuntimeSpecStore,
} from "./persai-runtime-spec-store.js";
import {
  buildToolDenyList,
  extractToolCredentialRefs,
  extractToolQuotaPolicy,
  resolveToolCredentials,
} from "./persai-runtime-tool-policy.js";
import { resolvePersaiAssistantWorkspaceDir } from "./persai-runtime-workspace.js";

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

const DEFAULT_TELEGRAM_PROFILE_COOLDOWN_MS = 10 * 60_000;
const DEFAULT_TELEGRAM_REINIT_CONCURRENCY = 4;
const DEFAULT_TELEGRAM_REINIT_JITTER_MS = 1_500;
const DEFAULT_TELEGRAM_REINIT_RETRIES = 3;
const DEFAULT_TELEGRAM_REINIT_BACKOFF_MS = 1_000;
const DEFAULT_READINESS_RECHECK_MS = 5_000;

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
  };
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
  return parsePositiveIntegerEnv("PERSAI_TELEGRAM_REINIT_JITTER_MS", DEFAULT_TELEGRAM_REINIT_JITTER_MS);
}

function getTelegramReinitRetries(): number {
  return parsePositiveIntegerEnv("PERSAI_TELEGRAM_REINIT_RETRIES", DEFAULT_TELEGRAM_REINIT_RETRIES);
}

function getTelegramReinitBackoffMs(): number {
  return parsePositiveIntegerEnv("PERSAI_TELEGRAM_REINIT_BACKOFF_MS", DEFAULT_TELEGRAM_REINIT_BACKOFF_MS);
}

function getReadinessRecheckMs(): number {
  return parsePositiveIntegerEnv("PERSAI_TELEGRAM_PROFILE_READY_RECHECK_MS", DEFAULT_READINESS_RECHECK_MS);
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

async function syncBotProfile(bot: Bot, workspace: unknown, assistantId: string): Promise<void> {
  const persona = extractPersonaFromWorkspace(workspace);

  if (persona.displayName) {
    try {
      await bot.api.setMyName(persona.displayName.slice(0, 64));
    } catch (err) {
      console.warn(`[persai-telegram] setMyName failed for ${assistantId}:`, err);
    }
  }

  if (persona.instructions) {
    try {
      await bot.api.setMyDescription(persona.instructions.slice(0, 512));
    } catch (err) {
      console.warn(`[persai-telegram] setMyDescription failed for ${assistantId}:`, err);
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
  managed.profileSyncTimer = setTimeout(() => {
    managed.profileSyncTimer = null;
    void reconcileTelegramProfile(params).catch((err) => {
      console.warn(`[persai-telegram] Deferred profile reconcile failed for ${params.assistantId}:`, err);
    });
  }, Math.max(0, params.delayMs ?? 0));
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
  if (!params.force && Number.isFinite(lastAttemptAt)) {
    const remainingCooldown = cooldownMs - (Date.now() - lastAttemptAt);
    if (remainingCooldown > 0) {
      scheduleProfileSync({
        ...params,
        delayMs: remainingCooldown,
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
      lastProfileSyncError: null,
    });
  } catch (err) {
    await updateStoredTelegramRuntime(params.store, state.assistantId, state.publishedVersionId, {
      transportFingerprint: state.transportFingerprint,
      lastProfileSyncAttemptAt: attemptAt,
      lastProfileSyncError: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
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
        username:
          "username" in ctx.chat && typeof ctx.chat.username === "string" ? ctx.chat.username : "",
      });
      const reply = await runTelegramAgentTurn({
        assistantId,
        userMessage: ctx.message.text ?? "",
        chatId: String(ctx.chat.id),
        bootstrap: currentManaged.state.bootstrap,
        workspace: currentManaged.state.workspace,
        workspaceDir: currentManaged.state.workspaceDir,
      });
      const parseMode = currentConfig.parseMode === "markdown" ? "MarkdownV2" : undefined;
      await ctx.reply(reply, { parse_mode: parseMode });
    } catch (err) {
      console.error(`[persai-telegram] Agent turn failed for ${assistantId}:`, err);
      await ctx.reply("Sorry, I encountered an error. Please try again.").catch(() => {});
    }
  });

  if (tgConfig.webhookUrl) {
    managed.handleWebhook = webhookCallback(bot, "http", {
      secretToken: tgConfig.webhookSecret ?? undefined,
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

async function runTelegramAgentTurn(params: {
  assistantId: string;
  userMessage: string;
  chatId: string;
  bootstrap: unknown;
  workspace: unknown;
  workspaceDir?: string;
}): Promise<string> {
  const { assistantId, userMessage, bootstrap, workspace, chatId } = params;
  const extraSystemPrompt = extractPersonaInstructionsFromWorkspace(workspace) ?? undefined;
  const runtimeOverride = extractPersaiRuntimeModelOverride(bootstrap);
  const credentialRefs = extractToolCredentialRefs(bootstrap);
  const quotaPolicy = extractToolQuotaPolicy(bootstrap);
  const toolDenyList = buildToolDenyList(quotaPolicy);

  let resolvedToolCredentials = new Map<string, string>();
  if (credentialRefs.size > 0) {
    try {
      const cfg = loadConfig();
      resolvedToolCredentials = await resolveToolCredentials(credentialRefs, cfg);
    } catch {
      // Non-fatal
    }
  }

  const sessionKey = `agent:persai:${assistantId}:telegram:${chatId}`;
  const cronWebhookUrl = (() => {
    const baseUrl = resolvePersaiInternalApiBaseUrl();
    return baseUrl
      ? `${baseUrl}/api/v1/internal/cron-fire?assistantId=${encodeURIComponent(assistantId)}`
      : undefined;
  })();

  const result = await runPersaiTelegramAgentTurn({
    assistantId,
    userMessage,
    sessionKey,
    extraSystemPrompt,
    providerOverride: runtimeOverride?.provider,
    modelOverride: runtimeOverride?.model,
    resolvedToolCredentials,
    toolDenyList,
    cronWebhookUrl,
    workspaceDir: params.workspaceDir,
  });

  return result.ok
    ? result.assistantMessage.trim() || "..."
    : "I'm having trouble responding right now. Please try again.";
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

  const token = process.env.OPENCLAW_GATEWAY_TOKEN ?? "";
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
}): Promise<void> {
  const baseUrl = resolvePersaiInternalApiBaseUrl();
  if (!baseUrl) {
    return;
  }

  const token = process.env.OPENCLAW_GATEWAY_TOKEN ?? "";
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

  const managed = activeBots.get(assistantId);
  if (!managed) {
    res.statusCode = 404;
    res.end("Bot not found");
    return true;
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

  const candidates = allSpecs.filter((spec) => {
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
