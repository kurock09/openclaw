import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { Type } from "@sinclair/typebox";
import { persaiRuntimeRequestContext } from "../persai-runtime-context.js";
import type { AnyAgentTool } from "./common.js";
import { ToolInputError } from "./common.js";

const MAX_BYTES = 25 * 1024 * 1024;

const PersaiWorkspaceAttachSchema = Type.Object(
  {
    relativePath: Type.String(),
    audioAsVoice: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

function toPosixStoragePath(rel: string): string {
  return rel.split(path.sep).join("/");
}

export function createPersaiWorkspaceAttachTool(): AnyAgentTool | null {
  const runtimeCtx = persaiRuntimeRequestContext.getStore();
  if (!runtimeCtx?.assistantId?.trim() || !runtimeCtx.workspaceDir?.trim()) {
    return null;
  }

  return {
    label: "PersAI workspace attach",
    name: "persai_workspace_attach",
    description:
      "Attach an existing file from this assistant's workspace to the chat reply (images, audio, video, documents). Pass a path relative to the workspace root (for example `media/...` or `reports/summary.pdf`). Does not load file bytes into the model — only schedules delivery via the same pipeline as generated images. Optional `audioAsVoice` sends supported audio as a voice note (Telegram-style).",
    parameters: PersaiWorkspaceAttachSchema,
    execute: async (_toolCallId, args) => {
      const ctx = persaiRuntimeRequestContext.getStore();
      const workspaceDir = ctx?.workspaceDir?.trim();
      if (!workspaceDir) {
        throw new ToolInputError("PersAI runtime context is not available.");
      }

      const params = args as { relativePath?: unknown; audioAsVoice?: unknown };
      const rawPath =
        typeof params.relativePath === "string" ? params.relativePath.trim() : "";
      if (!rawPath) {
        throw new ToolInputError("relativePath is required.");
      }
      if (path.isAbsolute(rawPath)) {
        throw new ToolInputError("relativePath must be relative to the workspace root.");
      }

      const wsResolved = path.resolve(workspaceDir);
      const resolved = path.resolve(workspaceDir, rawPath);
      if (resolved !== wsResolved && !resolved.startsWith(wsResolved + path.sep)) {
        throw new ToolInputError("Path escapes the workspace.");
      }

      let st: Awaited<ReturnType<typeof fsp.stat>>;
      try {
        st = await fsp.stat(resolved);
      } catch {
        throw new ToolInputError(`File not found: ${rawPath}`);
      }
      if (!st.isFile()) {
        throw new ToolInputError("Path must be a file, not a directory.");
      }
      if (st.size > MAX_BYTES) {
        throw new ToolInputError(
          `File exceeds ${String(MAX_BYTES / (1024 * 1024))}MB limit.`,
        );
      }

      const mediaDir = path.join(workspaceDir, "media");
      const storagePath = toPosixStoragePath(path.relative(mediaDir, resolved));
      const audioAsVoice = params.audioAsVoice === true;
      const basename = path.basename(resolved);

      return {
        content: [
          {
            type: "text" as const,
            text: `Attached \`${basename}\` for delivery (${storagePath}).`,
          },
        ],
        details: {
          status: "ok",
          relativePath: rawPath.replace(/\\/g, "/"),
          storagePath,
          media: {
            mediaUrls: [storagePath],
            ...(audioAsVoice ? { audioAsVoice: true } : {}),
          },
        },
      };
    },
  };
}
