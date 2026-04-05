import { describe, expect, it, vi } from "vitest";
import { prepareEmbeddedRunBeforeGlobalLane } from "./pi-embedded-runner/run-global-lane-prep.js";

describe("prepareEmbeddedRunBeforeGlobalLane", () => {
  it("resolves cache-backed prep before entering the global lane", async () => {
    const resolveRunWorkspaceDir = vi.fn(() => ({
      workspaceDir: "/tmp/workspace",
      usedFallback: false,
      fallbackReason: undefined,
      agentId: "assistant-a",
    }));
    const resolveOpenClawAgentDir = vi.fn(() => "/tmp/agent");
    const hasConfiguredModelFallbacks = vi.fn(() => true);
    const ensureOpenClawModelsJson = vi.fn(async () => ({ agentDir: "/tmp/agent", wrote: false }));

    const result = await prepareEmbeddedRunBeforeGlobalLane(
      {
        workspaceDir: "/tmp/workspace",
        sessionKey: "agent:main:web-1",
        agentId: "assistant-a",
        config: { agents: { defaults: { maxConcurrent: 4 } } },
      },
      {
        resolveRunWorkspaceDir,
        resolveOpenClawAgentDir,
        hasConfiguredModelFallbacks,
        ensureOpenClawModelsJson,
      },
    );

    expect(resolveRunWorkspaceDir).toHaveBeenCalledOnce();
    expect(resolveOpenClawAgentDir).toHaveBeenCalledOnce();
    expect(hasConfiguredModelFallbacks).toHaveBeenCalledOnce();
    expect(ensureOpenClawModelsJson).toHaveBeenCalledWith(
      { agents: { defaults: { maxConcurrent: 4 } } },
      "/tmp/agent",
    );
    expect(result).toEqual({
      workspaceResolution: {
        workspaceDir: "/tmp/workspace",
        usedFallback: false,
        fallbackReason: undefined,
        agentId: "assistant-a",
      },
      resolvedWorkspace: "/tmp/workspace",
      agentDir: "/tmp/agent",
      fallbackConfigured: true,
    });
  });

  it("honors an explicit agentDir without re-resolving it", async () => {
    const resolveRunWorkspaceDir = vi.fn(() => ({
      workspaceDir: "/tmp/workspace",
      usedFallback: true,
      fallbackReason: "missing-session-workspace",
      agentId: "assistant-b",
    }));
    const resolveOpenClawAgentDir = vi.fn(() => "/tmp/agent");
    const hasConfiguredModelFallbacks = vi.fn(() => false);
    const ensureOpenClawModelsJson = vi.fn(async () => ({
      agentDir: "/tmp/custom-agent",
      wrote: true,
    }));

    const result = await prepareEmbeddedRunBeforeGlobalLane(
      {
        sessionKey: "agent:main:web-2",
        agentId: "assistant-b",
        config: {},
        agentDir: "/tmp/custom-agent",
      },
      {
        resolveRunWorkspaceDir,
        resolveOpenClawAgentDir,
        hasConfiguredModelFallbacks,
        ensureOpenClawModelsJson,
      },
    );

    expect(resolveOpenClawAgentDir).not.toHaveBeenCalled();
    expect(ensureOpenClawModelsJson).toHaveBeenCalledWith({}, "/tmp/custom-agent");
    expect(result.agentDir).toBe("/tmp/custom-agent");
    expect(result.workspaceResolution.usedFallback).toBe(true);
    expect(result.fallbackConfigured).toBe(false);
  });
});
