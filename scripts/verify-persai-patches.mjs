#!/usr/bin/env node
// Verifies that all PersAI cross-cutting patches are present after an upstream merge.
// Run: node scripts/verify-persai-patches.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

let failures = 0;
let checks = 0;

function check(description, fn) {
  checks++;
  try {
    const ok = fn();
    if (!ok) {
      failures++;
      console.error(`  FAIL: ${description}`);
    } else {
      console.log(`  ok: ${description}`);
    }
  } catch (err) {
    failures++;
    console.error(`  FAIL: ${description} (${err.message})`);
  }
}

function fileExists(relPath) {
  return fs.existsSync(path.join(root, relPath));
}

function fileContains(relPath, needle) {
  if (!fileExists(relPath)) return false;
  const content = fs.readFileSync(path.join(root, relPath), "utf8");
  return content.includes(needle);
}

function fileContainsCount(relPath, needle) {
  if (!fileExists(relPath)) return 0;
  const content = fs.readFileSync(path.join(root, relPath), "utf8");
  return content.split(needle).length - 1;
}

console.log("\n--- PersAI fork patch verification ---\n");

console.log("[1] PersAI-only files exist");
check("persai-runtime-context.ts exists", () => fileExists("src/agents/persai-runtime-context.ts"));
check("plugin-sdk/persai-credential.ts exists", () =>
  fileExists("src/plugin-sdk/persai-credential.ts"),
);
check("persai-runtime/ directory exists", () => fileExists("src/gateway/persai-runtime"));
check("persai-runtime-agent-turn.ts exists", () =>
  fileExists("src/gateway/persai-runtime/persai-runtime-agent-turn.ts"),
);
check("persai-runtime-http.ts exists", () =>
  fileExists("src/gateway/persai-runtime/persai-runtime-http.ts"),
);
check("persai-runtime-telegram.ts exists", () =>
  fileExists("src/gateway/persai-runtime/persai-runtime-telegram.ts"),
);

console.log("\n[2] Secret ref source: persai type");
check(
  "types.secrets.ts has persai source",
  () => fileContainsCount("src/config/types.secrets.ts", '"persai"') >= 4,
);
check("ref-contract.ts has persai default", () =>
  fileContains("src/secrets/ref-contract.ts", "persai"),
);
check("resolve.ts has resolvePersaiRefs", () =>
  fileContains("src/secrets/resolve.ts", "resolvePersaiRefs"),
);

console.log("\n[3] Tool deny list via AsyncLocalStorage");
check("openclaw-tools.ts imports persaiRuntimeRequestContext", () =>
  fileContains("src/agents/openclaw-tools.ts", "persaiRuntimeRequestContext"),
);
check("openclaw-tools.ts re-exports persaiRuntimeRequestContext", () =>
  fileContains("src/agents/openclaw-tools.ts", "export { persaiRuntimeRequestContext }"),
);

console.log("\n[4] Memory workspace override");
check("backend-config.ts has persaiRuntimeRequestContext", () =>
  fileContains("src/memory/backend-config.ts", "persaiRuntimeRequestContext"),
);
check("manager.ts has persaiRuntimeRequestContext", () =>
  fileContains("src/memory/manager.ts", "persaiRuntimeRequestContext"),
);
check("qmd-manager.ts has persaiRuntimeRequestContext", () =>
  fileContains("src/memory/qmd-manager.ts", "persaiRuntimeRequestContext"),
);
check("read-file.ts has persaiRuntimeRequestContext", () =>
  fileContains("src/memory/read-file.ts", "persaiRuntimeRequestContext"),
);

console.log("\n[5] Per-request tool credential isolation (H9)");
check("persai-runtime-context.ts exports getPersaiToolCredential", () =>
  fileContains("src/agents/persai-runtime-context.ts", "getPersaiToolCredential"),
);
check("persai-runtime-context.ts has toolCredentials field", () =>
  fileContains("src/agents/persai-runtime-context.ts", "toolCredentials"),
);
check("persai-runtime-context.ts has central runtime credential resolver", () =>
  fileContains("src/agents/persai-runtime-context.ts", "resolvePersaiToolCredentialForEnvVars"),
);
check("persai-runtime-context.ts tracks active tool name", () =>
  fileContains("src/agents/persai-runtime-context.ts", "activeToolName"),
);
check("pi-tool-definition-adapter.ts wraps tool execution with active tool context", () =>
  fileContains("src/agents/pi-tool-definition-adapter.ts", "withPersaiActiveTool"),
);
check("model-auth-env.ts honors request-scoped tool credentials", () =>
  fileContains("src/agents/model-auth-env.ts", "resolvePersaiToolCredentialForEnvVars"),
);
check("image-generate-tool.ts mounts with explicit image_generate tool auth", () =>
  fileContains("src/agents/tools/image-generate-tool.ts", 'toolName: "image_generate"'),
);
check("tavily config reads from context", () =>
  fileContains("extensions/tavily/src/config.ts", "getPersaiToolCredential"),
);
check("firecrawl config reads from context", () =>
  fileContains("extensions/firecrawl/src/config.ts", "getPersaiToolCredential"),
);
check("web-search runtime reads from central runtime resolver", () =>
  fileContains("src/web-search/runtime.ts", "resolvePersaiToolCredentialForEnvVars"),
);
check("web-fetch reads from central runtime resolver", () =>
  fileContains("src/agents/tools/web-fetch.ts", "resolvePersaiToolCredentialForEnvVars"),
);
check("tts.ts reads from central runtime resolver", () =>
  fileContains("src/tts/tts.ts", "resolvePersaiToolCredentialForEnvVars"),
);
check("OpenAI TTS provider reads from central runtime resolver", () =>
  fileContains("src/tts/providers/openai.ts", "resolvePersaiToolCredentialForEnvVars"),
);
check("ElevenLabs TTS provider reads from central runtime resolver", () =>
  fileContains("src/tts/providers/elevenlabs.ts", "resolvePersaiToolCredentialForEnvVars"),
);

console.log("\n[6] Plugin-sdk export");
check("package.json has persai-credential export", () =>
  fileContains("package.json", "persai-credential"),
);
check("entrypoints.json has persai-credential", () =>
  fileContains("scripts/lib/plugin-sdk-entrypoints.json", "persai-credential"),
);

console.log("\n[7] Thinking/reasoning stream for PersAI web chat (H10)");
check("command types expose reasoning option", () =>
  fileContains("src/agents/command/types.ts", "reasoning?: string"),
);
check("agent-command resolves reasoning level", () =>
  fileContains("src/agents/agent-command.ts", "resolvedReasoningLevel"),
);
check("persai runtime stream emits thinking chunks", () =>
  fileContains("src/gateway/persai-runtime/persai-runtime-agent-turn.ts", 'type: "thinking"'),
);

console.log("\n[8] Workspace avatar file endpoints");
check(
  "persai-runtime-http.ts has RUNTIME_WORKSPACE_AVATAR_PATH",
  () =>
    fileContainsCount(
      "src/gateway/persai-runtime/persai-runtime-http.ts",
      "RUNTIME_WORKSPACE_AVATAR_PATH",
    ) >= 2,
);
check("server-http.ts registers workspace-avatar stage", () =>
  fileContains("src/gateway/server-http.ts", "persai-runtime-workspace-avatar"),
);

console.log("\n[9] Telegram bot profile sync + PersAI turn gateway");
check(
  "persai-runtime-telegram.ts has syncBotProfile",
  () =>
    fileContainsCount("src/gateway/persai-runtime/persai-runtime-telegram.ts", "syncBotProfile") >=
    2,
);
check("persai-runtime-telegram.ts syncs inbound chat target back to PersAI", () =>
  fileContains(
    "src/gateway/persai-runtime/persai-runtime-telegram.ts",
    "/api/v1/internal/runtime/telegram/chat-target",
  ),
);
check("persai-runtime-telegram.ts calls PersAI internal turn gateway", () =>
  fileContains(
    "src/gateway/persai-runtime/persai-runtime-telegram.ts",
    "/api/v1/internal/runtime/turns/telegram",
  ),
);

console.log("\n[10] Gateway HTTP route registration");
check(
  "server-http.ts imports persai-runtime modules",
  () => fileContainsCount("src/gateway/server-http.ts", "persai-runtime") >= 5,
);
check("server-runtime-state.ts creates persai spec store", () =>
  fileContains("src/gateway/server-runtime-state.ts", "persaiRuntimeSpecStore"),
);
check("server-http.ts registers channel chat stage", () =>
  fileContains("src/gateway/server-http.ts", "persai-runtime-chat-channel"),
);

console.log("\n[11] Cron callback bridge + task registry sync (H12)");
check("persai-runtime-context.ts exposes cronWebhookUrl", () =>
  fileContains("src/agents/persai-runtime-context.ts", "cronWebhookUrl"),
);
check("persai-runtime-context.ts exposes assistantId", () =>
  fileContains("src/agents/persai-runtime-context.ts", "assistantId"),
);
check("cron-tool.ts syncs task registry to PersAI", () =>
  fileContains("src/agents/tools/cron-tool.ts", "internal/runtime/tasks/sync"),
);
check("persai-runtime-http.ts derives internal cron-fire callback", () =>
  fileContains("src/gateway/persai-runtime/persai-runtime-http.ts", "/api/v1/internal/cron-fire"),
);
check("persai-runtime-http.ts exposes internal cron control route", () =>
  fileContains("src/gateway/persai-runtime/persai-runtime-http.ts", "/api/v1/runtime/cron/control"),
);
check("reminder-task-tool.ts exposes reminder_task", () =>
  fileContains("src/agents/tools/reminder-task-tool.ts", 'name: "reminder_task"'),
);
check("openclaw-tools.ts wires reminder_task into tool list", () =>
  fileContains("src/agents/openclaw-tools.ts", "createReminderTaskTool"),
);
check("server-http.ts registers cron control stage", () =>
  fileContains("src/gateway/server-http.ts", "persai-runtime-cron-control"),
);

console.log("\n[12] Memory lifecycle reset bridge (H12g)");
check("persai-runtime-workspace.ts resets assistant memory workspace", () =>
  fileContains(
    "src/gateway/persai-runtime/persai-runtime-workspace.ts",
    "resetPersaiAssistantMemoryWorkspace",
  ),
);
check("persai-runtime-http.ts exposes workspace memory reset route", () =>
  fileContains(
    "src/gateway/persai-runtime/persai-runtime-http.ts",
    "/api/v1/runtime/workspace/memory/reset",
  ),
);
check("persai-runtime-http.ts exposes strict workspace reset route", () =>
  fileContains(
    "src/gateway/persai-runtime/persai-runtime-http.ts",
    "/api/v1/runtime/workspace/reset",
  ),
);
check("server-http.ts registers workspace reset stage", () =>
  fileContains("src/gateway/server-http.ts", "persai-runtime-workspace-reset"),
);
check("server-http.ts registers workspace memory reset stage", () =>
  fileContains("src/gateway/server-http.ts", "persai-runtime-workspace-memory-reset"),
);

console.log("\n[13] Non-web runtime execute seam (H13 core)");
check("persai-runtime-http.ts exposes runtime chat channel route", () =>
  fileContains("src/gateway/persai-runtime/persai-runtime-http.ts", "/api/v1/runtime/chat/channel"),
);
check("persai-runtime-http.ts exposes PersAI tool limit consume callback", () =>
  fileContains(
    "src/gateway/persai-runtime/persai-runtime-http.ts",
    "/api/v1/internal/runtime/tools/consume",
  ),
);
check("persai-runtime-context.ts carries tool limit webhook url", () =>
  fileContains("src/agents/persai-runtime-context.ts", "toolLimitWebhookUrl"),
);
check("pi-tools.before-tool-call.ts enforces PersAI tool limits", () =>
  fileContains("src/agents/pi-tools.before-tool-call.ts", "enforcePersaiRuntimeToolLimit"),
);

console.log("\n[14] Bootstrap consume + heartbeat hygiene");
check("persai-runtime-workspace.ts exposes bootstrap consume helper", () =>
  fileContains(
    "src/gateway/persai-runtime/persai-runtime-workspace.ts",
    "consumePersaiAssistantBootstrapFile",
  ),
);
check("persai-runtime-http.ts exposes bootstrap consume route", () =>
  fileContains(
    "src/gateway/persai-runtime/persai-runtime-http.ts",
    "/api/v1/runtime/workspace/bootstrap/consume",
  ),
);
check("server-http.ts registers bootstrap consume stage", () =>
  fileContains("src/gateway/server-http.ts", "persai-runtime-workspace-bootstrap-consume"),
);
check("heartbeat-runner.ts resolves PersAI heartbeat model override", () =>
  fileContains("src/infra/heartbeat-runner.ts", "resolvePersaiHeartbeatModelOverride"),
);
check("heartbeat-runner.ts uses dedicated heartbeat session key", () =>
  fileContains("src/infra/heartbeat-runner.ts", ":heartbeat"),
);

console.log("\n[15] Workspace media bridge (M-series M1/M3)");
check("persai-runtime-media.ts exists", () =>
  fileExists("src/gateway/persai-runtime/persai-runtime-media.ts"),
);
check("persai-runtime-media.ts has upload handler", () =>
  fileContains(
    "src/gateway/persai-runtime/persai-runtime-media.ts",
    "handleRuntimeWorkspaceMediaUploadHttpRequest",
  ),
);
check("persai-runtime-media.ts has transcribe handler", () =>
  fileContains(
    "src/gateway/persai-runtime/persai-runtime-media.ts",
    "handleRuntimeWorkspaceMediaTranscribeHttpRequest",
  ),
);
check("server-http.ts registers media upload stage", () =>
  fileContains("src/gateway/server-http.ts", "persai-runtime-workspace-media-upload"),
);
check("server-http.ts registers media transcribe stage", () =>
  fileContains("src/gateway/server-http.ts", "persai-runtime-workspace-media-transcribe"),
);

console.log("\n[16] Agent turn media extraction (M-series M2)");
check("persai-runtime-agent-turn.ts has resolveAgentResponse", () =>
  fileContains("src/gateway/persai-runtime/persai-runtime-agent-turn.ts", "resolveAgentResponse"),
);
check("persai-runtime-agent-turn.ts has PersaiMediaArtifact", () =>
  fileContains("src/gateway/persai-runtime/persai-runtime-agent-turn.ts", "PersaiMediaArtifact"),
);

console.log("\n[17] Telegram inbound/outbound media (M-series M5/M6)");
check("persai-runtime-telegram.ts handles voice messages", () =>
  fileContains("src/gateway/persai-runtime/persai-runtime-telegram.ts", "message:voice"),
);
check("persai-runtime-telegram.ts handles photo messages", () =>
  fileContains("src/gateway/persai-runtime/persai-runtime-telegram.ts", "message:photo"),
);
check("persai-runtime-telegram.ts handles document messages", () =>
  fileContains("src/gateway/persai-runtime/persai-runtime-telegram.ts", "message:document"),
);
check(
  "persai-runtime-telegram.ts delivers outbound media",
  () =>
    fileContainsCount(
      "src/gateway/persai-runtime/persai-runtime-telegram.ts",
      "deliverTelegramMedia",
    ) >= 2,
);

console.log("\n[18] Yandex SpeechKit TTS provider (M-series M7)");
check("yandex.ts TTS provider exists", () => fileExists("src/tts/providers/yandex.ts"));
check("provider-registry.ts has buildYandexSpeechProvider", () =>
  fileContains("src/tts/provider-registry.ts", "buildYandexSpeechProvider"),
);
check("tts.ts includes yandex in providers", () =>
  fileContainsCount("src/tts/tts.ts", '"yandex"') >= 2,
);
check("types.tts.ts has yandex config section", () =>
  fileContains("src/config/types.tts.ts", "yandex"),
);
check("runtime-config-collectors-tts.ts collects yandex apiKey", () =>
  fileContains("src/secrets/runtime-config-collectors-tts.ts", "yandex"),
);
check("persai-runtime-context.ts has Yandex TTS env fallback", () =>
  fileContains("src/agents/persai-runtime-context.ts", "YANDEX_TTS_API_KEY"),
);

console.log(`\n--- Result: ${checks - failures}/${checks} passed ---`);
if (failures > 0) {
  console.error(
    `\n${failures} check(s) FAILED. PersAI patches may be missing after upstream merge.`,
  );
  process.exit(1);
} else {
  console.log("\nAll PersAI patches verified.\n");
}
