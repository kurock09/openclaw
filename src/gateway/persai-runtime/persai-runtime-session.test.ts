import { describe, expect, test } from "vitest";
import {
  derivePersaiWebRuntimeSessionKey,
  derivePersaiWebSandboxSessionKey,
} from "./persai-runtime-session.js";

describe("derivePersaiWebRuntimeSessionKey", () => {
  test("builds stable colon-delimited key from ids", () => {
    expect(
      derivePersaiWebRuntimeSessionKey({
        assistantId: "a1",
        chatId: "c1",
        surfaceThreadKey: "t1",
      }),
    ).toBe("agent:persai:a1:web:c1:t1");
  });

  test("keeps sandbox identity stable across chats", () => {
    expect(
      derivePersaiWebSandboxSessionKey({
        assistantId: "a1",
      }),
    ).toBe("agent:persai:a1:web:sandbox");
  });
});
