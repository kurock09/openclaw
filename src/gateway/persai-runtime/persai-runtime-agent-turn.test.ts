import { afterEach, describe, expect, test, vi } from "vitest";

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
        userMessage: "hi",
        sessionKey: "persai:web:a:v:c:t",
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
        sessionKey: "persai:web:a:v:c:t",
      }),
    );
  });
});
