import { describe, expect, test } from "vitest";
import { derivePersaiWebRuntimeSessionKey } from "./persai-runtime-session.js";

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
});
