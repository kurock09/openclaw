import { Type } from "@sinclair/typebox";
import { loadConfig } from "../../config/config.js";
import { persaiRuntimeRequestContext } from "../persai-runtime-context.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, ToolInputError } from "./common.js";

const PersaiToolQuotaStatusSchema = Type.Object(
  {
    toolCode: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

function resolvePersaiInternalApiBaseUrl(): string | undefined {
  const cfg = loadConfig();
  const provider = cfg.secrets?.providers?.["persai-runtime"];
  return provider?.source === "persai" ? provider.baseUrl : undefined;
}

export function createPersaiToolQuotaStatusTool(): AnyAgentTool | null {
  const runtimeCtx = persaiRuntimeRequestContext.getStore();
  if (!runtimeCtx?.assistantId?.trim()) {
    return null;
  }

  return {
    label: "PersAI tool quotas",
    name: "persai_tool_quota_status",
    description:
      "Read live PersAI daily tool quotas for this assistant from the control plane (today's usage vs current plan caps). Use when the user asks about limits or remaining calls, or after plan/admin changes. Do not infer exhaustion from earlier chat messages.",
    parameters: PersaiToolQuotaStatusSchema,
    execute: async (_toolCallId, args) => {
      const ctx = persaiRuntimeRequestContext.getStore();
      const assistantId = ctx?.assistantId?.trim();
      if (!assistantId) {
        throw new ToolInputError("PersAI runtime context is not available.");
      }
      const baseUrl = resolvePersaiInternalApiBaseUrl();
      if (!baseUrl) {
        throw new ToolInputError("PersAI internal API base URL is not configured.");
      }
      const token = process.env.PERSAI_INTERNAL_API_TOKEN?.trim();
      if (!token) {
        throw new ToolInputError("PERSAI_INTERNAL_API_TOKEN is not configured.");
      }

      const params = args as { toolCode?: unknown };
      const toolCode =
        typeof params.toolCode === "string" && params.toolCode.trim().length > 0
          ? params.toolCode.trim()
          : undefined;

      const response = await fetch(`${baseUrl}/api/v1/internal/runtime/tools/check`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          assistantId,
          ...(toolCode ? { toolCode } : {}),
        }),
      });

      if (!response.ok) {
        let detail = "";
        try {
          const err = (await response.json()) as { message?: unknown };
          if (typeof err.message === "string") {
            detail = err.message;
          } else if (Array.isArray(err.message)) {
            detail = err.message.join(" ");
          }
        } catch {
          /* ignore */
        }
        throw new ToolInputError(
          `PersAI quota check failed (HTTP ${String(response.status)}).${detail ? ` ${detail}` : ""}`,
        );
      }

      const payload = (await response.json()) as {
        ok: true;
        planCode: string | null;
        tools: Array<{
          toolCode: string;
          activationStatus: string;
          dailyCallLimit: number | null;
          currentCount: number;
          allowed: boolean;
        }>;
      };
      return jsonResult(payload);
    },
  };
}
