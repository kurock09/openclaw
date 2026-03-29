import { describe, expect, test } from "vitest";
import type { PersaiAppliedRuntimeSpec } from "./persai-runtime-spec-store.js";
import {
  isTelegramMarkdownParseError,
  sendTelegramReplyWithConfiguredParseMode,
  selectLatestRuntimeSpecs,
  syncBotProfile,
  TelegramProfileSyncError,
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

describe("sendTelegramReplyWithConfiguredParseMode", () => {
  test("retries as plain text when Telegram rejects MarkdownV2 entities", async () => {
    const calls: Array<{ text: string; options?: { parse_mode?: "MarkdownV2" } }> = [];
    const ctx = {
      reply: async (text: string, options?: { parse_mode?: "MarkdownV2" }) => {
        calls.push({ text, options });
        if (options?.parse_mode === "MarkdownV2") {
          throw {
            error_code: 400,
            description:
              "Bad Request: can't parse entities: Character '!' is reserved and must be escaped with the preceding '\\'",
          };
        }
        return undefined;
      },
    };

    await expect(
      sendTelegramReplyWithConfiguredParseMode(ctx, "Привет, Алекс! Чем могу помочь?", "markdown"),
    ).resolves.toBeUndefined();

    expect(calls).toEqual([
      {
        text: "Привет, Алекс! Чем могу помочь?",
        options: { parse_mode: "MarkdownV2" },
      },
      {
        text: "Привет, Алекс! Чем могу помочь?",
        options: undefined,
      },
    ]);
  });

  test("uses plain text directly when markdown mode is disabled", async () => {
    const calls: Array<{ text: string; options?: { parse_mode?: "MarkdownV2" } }> = [];
    const ctx = {
      reply: async (text: string, options?: { parse_mode?: "MarkdownV2" }) => {
        calls.push({ text, options });
        return undefined;
      },
    };

    await sendTelegramReplyWithConfiguredParseMode(ctx, "Hello", "plain_text");

    expect(calls).toEqual([{ text: "Hello", options: undefined }]);
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
