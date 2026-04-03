import { describe, expect, test } from "vitest";
import type { PersaiAppliedRuntimeSpec } from "./persai-runtime-spec-store.js";
import {
  isTelegramMarkdownParseError,
  sendTelegramReplyWithConfiguredParseMode,
  selectLatestRuntimeSpecs,
  splitTelegramOutboundText,
  syncBotProfile,
  TelegramProfileSyncError,
  TELEGRAM_BOT_API_MAX_MESSAGE_LENGTH,
} from "./persai-runtime-telegram.js";

function sampleSpec(params: {
  assistantId: string;
  publishedVersionId: string;
  appliedAt: string;
  groupReplyMode: "mention_reply" | "all_messages";
}): PersaiAppliedRuntimeSpec {
  return {
    assistantId: params.assistantId,
    publishedVersionId: params.publishedVersionId,
    contentHash: `hash-${params.publishedVersionId}`,
    reapply: false,
    bootstrap: {
      channels: {
        telegram: {
          enabled: true,
          botToken: "token-1",
          groupReplyMode: params.groupReplyMode,
          inbound: true,
          outbound: true,
        },
      },
    },
    workspace: {
      persona: {
        displayName: params.publishedVersionId,
        instructions: "Be helpful.",
      },
    },
    appliedAt: params.appliedAt,
  };
}

describe("selectLatestRuntimeSpecs", () => {
  test("keeps only the newest runtime spec per assistant", () => {
    const { latestSpecs, duplicateAssistantIds } = selectLatestRuntimeSpecs([
      sampleSpec({
        assistantId: "assistant-1",
        publishedVersionId: "version-1",
        appliedAt: "2026-03-29T10:00:00.000Z",
        groupReplyMode: "all_messages",
      }),
      sampleSpec({
        assistantId: "assistant-1",
        publishedVersionId: "version-2",
        appliedAt: "2026-03-29T11:00:00.000Z",
        groupReplyMode: "mention_reply",
      }),
      sampleSpec({
        assistantId: "assistant-2",
        publishedVersionId: "version-3",
        appliedAt: "2026-03-29T09:00:00.000Z",
        groupReplyMode: "all_messages",
      }),
    ]);

    expect(duplicateAssistantIds).toEqual(["assistant-1"]);
    expect(latestSpecs).toHaveLength(2);
    expect(latestSpecs.find((spec) => spec.assistantId === "assistant-1")?.bootstrap).toMatchObject(
      {
        channels: {
          telegram: {
            groupReplyMode: "mention_reply",
          },
        },
      },
    );
  });
});

describe("syncBotProfile", () => {
  test("throws retry-aware error when Telegram profile APIs return 429", async () => {
    const bot = {
      api: {
        setMyName: async () => {
          throw {
            parameters: {
              retry_after: 40104,
            },
          };
        },
        setMyDescription: async () => undefined,
        setMyProfilePhoto: async () => undefined,
      },
    };

    await expect(
      syncBotProfile(
        bot as never,
        {
          persona: {
            displayName: "RADXA",
            instructions: "Be helpful.",
          },
        },
        "assistant-1",
      ),
    ).rejects.toMatchObject<TelegramProfileSyncError>({
      name: "TelegramProfileSyncError",
      retryAfterMs: 40104000,
    });
  });
});

describe("splitTelegramOutboundText", () => {
  test("returns empty array for empty string", () => {
    expect(splitTelegramOutboundText("", 10)).toEqual([]);
  });

  test("keeps one chunk under the limit", () => {
    const s = "a".repeat(100);
    expect(splitTelegramOutboundText(s, TELEGRAM_BOT_API_MAX_MESSAGE_LENGTH)).toEqual([s]);
  });

  test("splits at code-point boundaries (emoji is one character)", () => {
    const emoji = "😀";
    const chunks = splitTelegramOutboundText(`${emoji}${emoji}`, 1);
    expect(chunks).toEqual([emoji, emoji]);
  });

  test("splits long ASCII into multiple chunks", () => {
    const s = "x".repeat(TELEGRAM_BOT_API_MAX_MESSAGE_LENGTH + 50);
    const chunks = splitTelegramOutboundText(s, TELEGRAM_BOT_API_MAX_MESSAGE_LENGTH);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.length).toBe(TELEGRAM_BOT_API_MAX_MESSAGE_LENGTH);
    expect(chunks[1]!.length).toBe(50);
  });
});

describe("sendTelegramReplyWithConfiguredParseMode", () => {
  test("retries as plain text when Telegram rejects HTML entities", async () => {
    const calls: Array<{ text: string; options?: { parse_mode?: "HTML" } }> = [];
    const ctx = {
      reply: async (text: string, options?: { parse_mode?: "HTML" }) => {
        calls.push({ text, options });
        if (options?.parse_mode === "HTML") {
          throw {
            error_code: 400,
            description: "Bad Request: can't parse entities: Unsupported start tag",
          };
        }
        return undefined;
      },
    };

    await expect(
      sendTelegramReplyWithConfiguredParseMode(ctx, "Привет, Алекс! Чем могу помочь?", "markdown"),
    ).resolves.toBeUndefined();

    expect(calls).toHaveLength(2);
    expect(calls[0]?.options).toEqual({ parse_mode: "HTML" });
    expect(calls[1]?.options).toBeUndefined();
    expect(calls[1]?.text).toContain("Привет");
  });

  test("uses plain text directly when markdown mode is disabled", async () => {
    const calls: Array<{ text: string; options?: { parse_mode?: "HTML" } }> = [];
    const ctx = {
      reply: async (text: string, options?: { parse_mode?: "HTML" }) => {
        calls.push({ text, options });
        return undefined;
      },
    };

    await sendTelegramReplyWithConfiguredParseMode(ctx, "Hello", "plain_text");

    expect(calls).toEqual([{ text: "Hello", options: undefined }]);
  });

  test("sends multiple HTML chunks when formatted text exceeds Telegram limit", async () => {
    const calls: Array<{ text: string; options?: { parse_mode?: "HTML" } }> = [];
    const ctx = {
      reply: async (text: string, options?: { parse_mode?: "HTML" }) => {
        calls.push({ text, options });
        return undefined;
      },
    };

    const partA = "a".repeat(TELEGRAM_BOT_API_MAX_MESSAGE_LENGTH);
    const partB = "tail";
    await sendTelegramReplyWithConfiguredParseMode(ctx, `${partA}\n\n${partB}`, "markdown");

    expect(calls).toHaveLength(2);
    expect(calls[0]?.options).toEqual({ parse_mode: "HTML" });
    expect(calls[1]?.options).toEqual({ parse_mode: "HTML" });
    expect(calls[0]?.text.length).toBeLessThanOrEqual(TELEGRAM_BOT_API_MAX_MESSAGE_LENGTH);
    expect(calls[1]?.text.length).toBeLessThanOrEqual(TELEGRAM_BOT_API_MAX_MESSAGE_LENGTH);
  });

  test("does not call reply for empty string", async () => {
    const calls: Array<{ text: string; options?: { parse_mode?: "HTML" } }> = [];
    const ctx = {
      reply: async (text: string, options?: { parse_mode?: "HTML" }) => {
        calls.push({ text, options });
        return undefined;
      },
    };

    await sendTelegramReplyWithConfiguredParseMode(ctx, "", "plain_text");
    expect(calls).toHaveLength(0);
  });
});

describe("isTelegramMarkdownParseError", () => {
  test("matches Telegram entity parse failures", () => {
    expect(
      isTelegramMarkdownParseError({
        error_code: 400,
        description: "Bad Request: can't parse entities: Character '!' is reserved",
      }),
    ).toBe(true);
    expect(
      isTelegramMarkdownParseError({
        error_code: 400,
        description: "Bad Request: chat not found",
      }),
    ).toBe(false);
  });
});
