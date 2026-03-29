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

import { cleanupPersaiAssistantSessions } from "./persai-runtime-session-cleanup.js";

let tempDir = "";
let storePath = "";

async function writeStore(payload: Record<string, unknown>) {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify(payload, null, 2), "utf-8");
}

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-persai-session-cleanup-"));
  storePath = path.join(tempDir, "persai", "sessions.json");
  loadConfigMock.mockReturnValue({
    session: {
      store: storePath,
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
  test("removes only the target assistant's PersAI runtime sessions", async () => {
    await writeStore({
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
      "agent:main:main": {
        sessionId: "session-main",
        updatedAt: Date.now(),
        sessionFile: "session-main.jsonl",
      },
    });
    await fs.writeFile(path.join(path.dirname(storePath), "session-a1.jsonl"), "{}", "utf-8");
    await fs.writeFile(path.join(path.dirname(storePath), "session-a2.jsonl"), "{}", "utf-8");
    await fs.writeFile(path.join(path.dirname(storePath), "session-b1.jsonl"), "{}", "utf-8");

    await expect(cleanupPersaiAssistantSessions("assistant-a")).resolves.toEqual({
      storePath: path.resolve(storePath),
      removedCount: 2,
    });

    const remaining = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<string, unknown>;
    expect(Object.keys(remaining)).toEqual(["agent:persai:assistant-b:web:chat-2", "agent:main:main"]);
  });
});
