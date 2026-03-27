import { Bot, webhookCallback } from "grammy";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PersaiRuntimeSpecStore } from "./persai-runtime-spec-store.js";
import {
  extractPersaiRuntimeModelOverride,
} from "./persai-runtime-provider-profile.js";
import {
  buildToolDenyList,
  extractToolCredentialRefs,
  extractToolQuotaPolicy,
  resolveToolCredentials,
} from "./persai-runtime-tool-policy.js";
import { extractPersonaInstructionsFromWorkspace } from "./persai-runtime-http.js";
import { loadConfig } from "../../config/config.js";
import { runPersaiTelegramAgentTurn } from "./persai-runtime-agent-turn.js";

type WebhookHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

interface ManagedTelegramBot {
  bot: Bot;
  assistantId: string;
  webhookSecret: string;
  handleWebhook: WebhookHandler;
  mode: "webhook" | "polling";
}

const activeBots = new Map<string, ManagedTelegramBot>();

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
  if (!isRecord(bootstrap)) return null;
  const channels = bootstrap.channels;
  if (!isRecord(channels)) return null;
  const tg = channels.telegram;
  if (!isRecord(tg)) return null;
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

export async function syncTelegramBotForAssistant(params: {
  assistantId: string;
  bootstrap: unknown;
  workspace: unknown;
  store: PersaiRuntimeSpecStore;
  persaiCallbackBaseUrl?: string;
  workspaceDir?: string;
}): Promise<void> {
  const { assistantId, bootstrap, workspace } = params;
  const tgConfig = extractTelegramChannel(bootstrap);

  if (!tgConfig || !tgConfig.enabled || !tgConfig.botToken) {
    await stopTelegramBot(assistantId);
    return;
  }

  const existing = activeBots.get(assistantId);
  if (existing) {
    await stopTelegramBot(assistantId);
  }

  const bot = new Bot(tgConfig.botToken);

  bot.on("my_chat_member", async (ctx) => {
    const update = ctx.myChatMember;
    const chat = update.chat;
    if (chat.type !== "group" && chat.type !== "supergroup") return;

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
    if (!tgConfig.inbound) return;

    const chatType = ctx.chat.type;
    const isGroup = chatType === "group" || chatType === "supergroup";

    if (isGroup && tgConfig.groupReplyMode === "mention_reply") {
      const botInfo = ctx.me;
      const text = ctx.message.text ?? "";
      const isReply = ctx.message.reply_to_message?.from?.id === botInfo.id;
      const isMentioned = text.includes(`@${botInfo.username}`);
      if (!isReply && !isMentioned) return;
    }

    if (!tgConfig.outbound) return;

    try {
      const reply = await runTelegramAgentTurn({
        assistantId,
        userMessage: ctx.message.text ?? "",
        chatId: String(ctx.chat.id),
        bootstrap,
        workspace,
        workspaceDir: params.workspaceDir,
      });
      const parseMode = tgConfig.parseMode === "markdown" ? "MarkdownV2" : undefined;
      await ctx.reply(reply, { parse_mode: parseMode });
    } catch (err) {
      console.error(`[persai-telegram] Agent turn failed for ${assistantId}:`, err);
      await ctx.reply("Sorry, I encountered an error. Please try again.").catch(() => {});
    }
  });

  if (tgConfig.webhookUrl) {
    const handler = webhookCallback(bot, "http", {
      secretToken: tgConfig.webhookSecret ?? undefined,
    }) as unknown as WebhookHandler;

    activeBots.set(assistantId, {
      bot,
      assistantId,
      webhookSecret: tgConfig.webhookSecret ?? "",
      handleWebhook: handler,
      mode: "webhook",
    });

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
    activeBots.set(assistantId, {
      bot,
      assistantId,
      webhookSecret: "",
      handleWebhook: async (_req, res) => { res.statusCode = 404; res.end("Polling mode"); },
      mode: "polling",
    });

    try {
      await bot.api.deleteWebhook({ drop_pending_updates: false });
    } catch {
      // best effort — ensure no stale webhook blocks polling
    }

    bot.start({
      allowed_updates: ["message", "my_chat_member"],
      drop_pending_updates: false,
      onStart: () => console.log(`[persai-telegram] Polling started for ${assistantId}`),
    });
  }
}

async function stopTelegramBot(assistantId: string): Promise<void> {
  const existing = activeBots.get(assistantId);
  if (!existing) return;
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

  const result = await runPersaiTelegramAgentTurn({
    userMessage,
    sessionKey,
    extraSystemPrompt,
    providerOverride: runtimeOverride?.provider,
    modelOverride: runtimeOverride?.model,
    resolvedToolCredentials,
    toolDenyList,
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
  const cfg = loadConfig();
  const provider = cfg.secrets?.providers?.["persai-runtime"];
  const baseUrl = provider?.source === "persai" ? provider.baseUrl : undefined;
  if (!baseUrl) return;

  const token = process.env.OPENCLAW_GATEWAY_TOKEN ?? "";
  if (!token) return;

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

export async function handleTelegramWebhookRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  requestPath: string;
}): Promise<boolean> {
  const { req, res, requestPath } = params;
  const prefix = "/telegram-webhook/";
  if (!requestPath.startsWith(prefix)) return false;

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
): Promise<void> {
  const allSpecs = await store.getAll();
  if (!allSpecs || allSpecs.length === 0) return;

  let started = 0;
  for (const spec of allSpecs) {
    const tgConfig = extractTelegramChannel(spec.bootstrap);
    if (tgConfig?.enabled && tgConfig.botToken) {
      try {
        await syncTelegramBotForAssistant({
          assistantId: spec.assistantId,
          bootstrap: spec.bootstrap,
          workspace: spec.workspace,
          store,
          workspaceDir: spec.workspaceDir,
        });
        started++;
      } catch (err) {
        console.error(`[persai-telegram] Failed to reinit bot for ${spec.assistantId}:`, err);
      }
    }
  }
  if (started > 0) {
    console.log(`[persai-telegram] Reinitialized ${started} Telegram bot(s) from store`);
  }
}
