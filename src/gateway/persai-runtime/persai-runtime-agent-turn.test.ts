import { afterEach, describe, expect, test, vi } from "vitest";
import { PersaiRuntimeToolLimitError } from "../../agents/persai-runtime-tool-limits.js";

const { agentCommandFromIngressMock, createDefaultDepsMock } = vi.hoisted(() => ({
  agentCommandFromIngressMock: vi.fn(),
  createDefaultDepsMock: vi.fn(() => ({})),
}));

vi.mock("../../commands/agent.js", () => ({
  agentCommandFromIngress: agentCommandFromIngressMock,
}));

vi.mock("../../cli/deps.js", () => ({
  createDefaultDeps: createDefaultDepsMock,
}));

import { EventEmitter } from "node:events";
import {
  runPersaiWebRuntimeAgentTurnStream,
  runPersaiWebRuntimeAgentTurnSync,
} from "./persai-runtime-agent-turn.js";
import { emitAgentEvent, resetAgentEventsForTest } from "../../infra/agent-events.js";

afterEach(() => {
  vi.clearAllMocks();
  resetAgentEventsForTest();
});

describe("runPersaiWebRuntimeAgentTurnSync", () => {
  test("passes provider and model overrides through ingress command input", async () => {
    agentCommandFromIngressMock.mockResolvedValue({
      payloads: [{ text: "Hello from override." }],
    });

    await expect(
      runPersaiWebRuntimeAgentTurnSync({
        assistantId: "assistant-1",
        userMessage: "hi",
        sessionKey: "agent:persai:a:web:c:t",
        extraSystemPrompt: "Be helpful",
        providerOverride: "openai",
        modelOverride: "gpt-5.4",
      }),
    ).resolves.toEqual({
      ok: true,
      assistantMessage: "Hello from override.",
      media: [],
    });

    expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(1);
    expect(agentCommandFromIngressMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-5.4",
        allowModelOverride: true,
        extraSystemPrompt: "Be helpful",
        sessionKey: "agent:persai:a:web:c:t",
      }),
    );
  });

  test("returns stable tool limit error payload", async () => {
    agentCommandFromIngressMock.mockRejectedValue(
      new PersaiRuntimeToolLimitError('Daily tool usage limit reached for "web_search".'),
    );

    await expect(
      runPersaiWebRuntimeAgentTurnSync({
        assistantId: "assistant-1",
        userMessage: "hi",
        sessionKey: "agent:persai:a:web:c:t",
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "tool_daily_limit_reached",
        message: 'Daily tool usage limit reached for "web_search".',
        status: 409,
      },
    });
  });

  test("keeps media-only responses silent after successful TTS", async () => {
    agentCommandFromIngressMock.mockResolvedValue({
      payloads: [{ text: "NO_REPLY", mediaUrl: "/tmp/reply.ogg", audioAsVoice: true }],
    });

    await expect(
      runPersaiWebRuntimeAgentTurnSync({
        assistantId: "assistant-1",
        userMessage: "hi",
        sessionKey: "agent:persai:a:web:c:t",
      }),
    ).resolves.toEqual({
      ok: true,
      assistantMessage: "",
      media: [{ url: "/tmp/reply.ogg", type: "audio", audioAsVoice: true }],
    });
  });
});

describe("runPersaiWebRuntimeAgentTurnStream", () => {
  test("suppresses NO_REPLY lead fragments and still emits media", async () => {
    agentCommandFromIngressMock.mockImplementation(async (_input) => {
      emitAgentEvent({
        runId: _input.runId,
        stream: "assistant",
        data: { text: "NO" },
      });
      emitAgentEvent({
        runId: _input.runId,
        stream: "assistant",
        data: { text: "NO_REPLY" },
      });
      return {
        payloads: [{ text: "NO_REPLY", mediaUrl: "/tmp/reply.ogg", audioAsVoice: true }],
      };
    });

    const req = new EventEmitter() as EventEmitter & {
      on: (event: string, listener: (...args: unknown[]) => void) => typeof req;
    };
    const written: string[] = [];
    const res = {
      write: vi.fn((chunk: string) => {
        written.push(chunk);
        return true;
      }),
      end: vi.fn(),
    } as unknown as import("node:http").ServerResponse;

    await runPersaiWebRuntimeAgentTurnStream({
      req: req as unknown as import("node:http").IncomingMessage,
      res,
      assistantId: "assistant-1",
      userMessage: "hi",
      sessionKey: "agent:persai:a:web:c:t",
    });

    const events = written
      .join("")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(events.some((evt) => evt.type === "delta")).toBe(false);
    expect(events).toContainEqual({
      type: "media",
      media: [{ url: "/tmp/reply.ogg", type: "audio", audioAsVoice: true }],
    });
  });
});
