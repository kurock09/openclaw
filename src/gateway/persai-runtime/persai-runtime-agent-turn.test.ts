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

import { runPersaiWebRuntimeAgentTurnSync } from "./persai-runtime-agent-turn.js";

afterEach(() => {
  vi.clearAllMocks();
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
});
