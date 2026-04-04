import { describe, expect, it } from "vitest";
import { validatePersaiRuntimeMedia } from "./persai-runtime-file-security.js";

describe("validatePersaiRuntimeMedia", () => {
  it("allows safe x-opus+ogg audio headers for transcription", async () => {
    const validated = await validatePersaiRuntimeMedia({
      buffer: Buffer.from("ogg-placeholder"),
      mimeType: "audio/x-opus+ogg",
      requireAudio: true
    });

    expect(validated.mimeType).toBe("audio/x-opus+ogg");
  });

  it("blocks generic binary payloads without a safe detected type", async () => {
    await expect(
      validatePersaiRuntimeMedia({
        buffer: Buffer.from("not-a-real-media-file"),
        mimeType: "application/octet-stream",
        fileName: "payload.bin"
      })
    ).rejects.toThrow("Unsupported or unsafe file type.");
  });
});
