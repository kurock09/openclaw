import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { persaiRuntimeRequestContext } from "../persai-runtime-context.js";
import { createPersaiWorkspaceAttachTool } from "./persai-workspace-attach-tool.js";

describe("createPersaiWorkspaceAttachTool", () => {
  it("blocks dangerous workspace files by extension", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-attach-"));
    await fs.mkdir(path.join(workspaceDir, "media"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "media", "payload.js"), "console.log('x');");

    await expect(
      persaiRuntimeRequestContext.run({ assistantId: "assistant-1", workspaceDir }, async () => {
        const tool = createPersaiWorkspaceAttachTool();
        if (!tool) {
          throw new Error("Tool unavailable");
        }
        await tool.execute("call-1", { relativePath: "media/payload.js" });
      }),
    ).rejects.toThrow(/Blocked dangerous file extension/);
  });

  it("allows safe image attachments from workspace media", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-attach-"));
    await fs.mkdir(path.join(workspaceDir, "media"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, "media", "ok.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
    );

    const result = await persaiRuntimeRequestContext.run(
      { assistantId: "assistant-1", workspaceDir },
      async () => {
        const tool = createPersaiWorkspaceAttachTool();
        if (!tool) {
          throw new Error("Tool unavailable");
        }
        return await tool.execute("call-2", { relativePath: "media/ok.png" });
      },
    );

    expect(result).toMatchObject({
      details: {
        status: "ok",
        storagePath: "ok.png",
      },
    });
  });
});
