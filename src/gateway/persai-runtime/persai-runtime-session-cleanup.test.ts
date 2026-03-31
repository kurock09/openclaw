import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { loadConfigMock } = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: loadConfigMock,
}));

import {
  cleanupPersaiAssistantSessions,
  cleanupPersaiWebChatSession,
} from "./persai-runtime-session-cleanup.js";

let tempDir = "";
let storeTemplate = "";

function storePathFor(agentId: string): string {
  return path.join(tempDir, "agents", agentId, "sessions", "sessions.json");
}

async function writeStore(agentId: string, payload: Record<string, unknown>) {
  const storePath = storePathFor(agentId);
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify(payload, null, 2), "utf-8");
}

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-persai-session-cleanup-"));
  storeTemplate = path.join(tempDir, "agents", "{agentId}", "sessions", "sessions.json");
  loadConfigMock.mockReturnValue({
    session: {
      store: storeTemplate,
    },
  });
});

afterEach(async () => {
  vi.clearAllMocks();
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

describe("cleanupPersaiAssistantSessions", () => {
  test("purges assistant sessions from persai and legacy main stores without reset archives", async () => {
    const persaiStorePath = storePathFor("persai");
    const mainStorePath = storePathFor("main");

    await writeStore("persai", {
      "agent:persai:assistant-a:web:chat-1": {
        sessionId: "session-a1",
        updatedAt: Date.now(),
        sessionFile: "session-a1.jsonl",
      },
      "agent:persai:assistant-a:telegram:123": {
        sessionId: "session-a2",
        updatedAt: Date.now(),
        sessionFile: "session-a2.jsonl",
      },
      "agent:persai:assistant-b:web:chat-2": {
        sessionId: "session-b1",
        updatedAt: Date.now(),
        sessionFile: "session-b1.jsonl",
      },
    });
    await writeStore("main", {
      "persai:web:assistant-a:version-1:chat-1:thread-1": {
        sessionId: "session-main-a1",
        updatedAt: Date.now(),
        sessionFile: "session-main-a1.jsonl",
      },
      "agent:main:main": {
        sessionId: "session-main",
        updatedAt: Date.now(),
        sessionFile: "session-main.jsonl",
      },
    });
    await fs.writeFile(path.join(path.dirname(persaiStorePath), "session-a1.jsonl"), "{}", "utf-8");
    await fs.writeFile(path.join(path.dirname(persaiStorePath), "session-a2.jsonl"), "{}", "utf-8");
    await fs.writeFile(path.join(path.dirname(persaiStorePath), "session-b1.jsonl"), "{}", "utf-8");
    await fs.writeFile(path.join(path.dirname(mainStorePath), "session-main-a1.jsonl"), "{}", "utf-8");
    await fs.writeFile(path.join(path.dirname(mainStorePath), "session-main.jsonl"), "{}", "utf-8");
    await fs.writeFile(
      path.join(path.dirname(mainStorePath), "session-main-a1.jsonl.reset.2026-03-31T13-01-31Z"),
      `assistant-a transcript snapshot`,
      "utf-8",
    );

    await expect(cleanupPersaiAssistantSessions("assistant-a")).resolves.toEqual({
      storePath: path.resolve(persaiStorePath),
      removedCount: 3,
    });

    const remainingPersai = JSON.parse(
      await fs.readFile(persaiStorePath, "utf-8"),
    ) as Record<string, unknown>;
    expect(Object.keys(remainingPersai)).toEqual(["agent:persai:assistant-b:web:chat-2"]);

    const remainingMain = JSON.parse(await fs.readFile(mainStorePath, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(Object.keys(remainingMain)).toEqual(["agent:main:main"]);

    await expect(fs.stat(path.join(path.dirname(persaiStorePath), "session-a1.jsonl"))).rejects.toThrow();
    await expect(fs.stat(path.join(path.dirname(persaiStorePath), "session-a2.jsonl"))).rejects.toThrow();
    await expect(fs.stat(path.join(path.dirname(mainStorePath), "session-main-a1.jsonl"))).rejects.toThrow();
    await expect(
      fs.stat(path.join(path.dirname(mainStorePath), "session-main-a1.jsonl.reset.2026-03-31T13-01-31Z")),
    ).rejects.toThrow();
    expect(await fs.readFile(path.join(path.dirname(mainStorePath), "session-main.jsonl"), "utf-8")).toBe(
      "{}",
    );
  });
});

describe("cleanupPersaiWebChatSession", () => {
  test("removes the matching web chat session from current and legacy stores only", async () => {
    const persaiStorePath = storePathFor("persai");
    const mainStorePath = storePathFor("main");

    await writeStore("persai", {
      "agent:persai:assistant-a:web:chat-1:thread-1": {
        sessionId: "session-current-web",
        updatedAt: Date.now(),
        sessionFile: "session-current-web.jsonl",
      },
      "agent:persai:assistant-a:web:chat-2:thread-2": {
        sessionId: "session-other-web",
        updatedAt: Date.now(),
        sessionFile: "session-other-web.jsonl",
      },
    });
    await writeStore("main", {
      "persai:web:assistant-a:version-1:chat-1:thread-1": {
        sessionId: "session-legacy-web",
        updatedAt: Date.now(),
        sessionFile: "session-legacy-web.jsonl",
      },
      "agent:main:main": {
        sessionId: "session-main",
        updatedAt: Date.now(),
        sessionFile: "session-main.jsonl",
      },
    });
    await fs.writeFile(
      path.join(path.dirname(persaiStorePath), "session-current-web.jsonl"),
      "{}",
      "utf-8",
    );
    await fs.writeFile(path.join(path.dirname(persaiStorePath), "session-other-web.jsonl"), "{}", "utf-8");
    await fs.writeFile(path.join(path.dirname(mainStorePath), "session-legacy-web.jsonl"), "{}", "utf-8");

    await expect(
      cleanupPersaiWebChatSession({
        assistantId: "assistant-a",
        chatId: "chat-1",
        surfaceThreadKey: "thread-1",
      }),
    ).resolves.toEqual({
      removedCount: 2,
    });

    const remainingPersai = JSON.parse(
      await fs.readFile(persaiStorePath, "utf-8"),
    ) as Record<string, unknown>;
    expect(Object.keys(remainingPersai)).toEqual(["agent:persai:assistant-a:web:chat-2:thread-2"]);

    const remainingMain = JSON.parse(await fs.readFile(mainStorePath, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(Object.keys(remainingMain)).toEqual(["agent:main:main"]);
  });
});
