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
check("plugin-sdk/persai-credential.ts exists", () => fileExists("src/plugin-sdk/persai-credential.ts"));
check("persai-runtime/ directory exists", () => fileExists("src/gateway/persai-runtime"));
check("persai-runtime-agent-turn.ts exists", () => fileExists("src/gateway/persai-runtime/persai-runtime-agent-turn.ts"));
check("persai-runtime-http.ts exists", () => fileExists("src/gateway/persai-runtime/persai-runtime-http.ts"));
check("persai-runtime-telegram.ts exists", () => fileExists("src/gateway/persai-runtime/persai-runtime-telegram.ts"));

console.log("\n[2] Secret ref source: persai type");
check("types.secrets.ts has persai source", () => fileContainsCount("src/config/types.secrets.ts", '"persai"') >= 4);
check("ref-contract.ts has persai default", () => fileContains("src/secrets/ref-contract.ts", "persai"));
check("resolve.ts has resolvePersaiRefs", () => fileContains("src/secrets/resolve.ts", "resolvePersaiRefs"));

console.log("\n[3] Tool deny list via AsyncLocalStorage");
check("openclaw-tools.ts imports persaiRuntimeRequestContext", () =>
  fileContains("src/agents/openclaw-tools.ts", "persaiRuntimeRequestContext"));
check("openclaw-tools.ts re-exports persaiRuntimeRequestContext", () =>
  fileContains("src/agents/openclaw-tools.ts", "export { persaiRuntimeRequestContext }"));

console.log("\n[4] Memory workspace override");
check("backend-config.ts has persaiRuntimeRequestContext", () =>
  fileContains("src/memory/backend-config.ts", "persaiRuntimeRequestContext"));
check("manager.ts has persaiRuntimeRequestContext", () =>
  fileContains("src/memory/manager.ts", "persaiRuntimeRequestContext"));
check("qmd-manager.ts has persaiRuntimeRequestContext", () =>
  fileContains("src/memory/qmd-manager.ts", "persaiRuntimeRequestContext"));
check("read-file.ts has persaiRuntimeRequestContext", () =>
  fileContains("src/memory/read-file.ts", "persaiRuntimeRequestContext"));

console.log("\n[5] Per-request tool credential isolation (H9)");
check("persai-runtime-context.ts exports getPersaiToolCredential", () =>
  fileContains("src/agents/persai-runtime-context.ts", "getPersaiToolCredential"));
check("persai-runtime-context.ts has toolCredentials field", () =>
  fileContains("src/agents/persai-runtime-context.ts", "toolCredentials"));
check("tavily config reads from context", () =>
  fileContains("extensions/tavily/src/config.ts", "getPersaiToolCredential"));
check("firecrawl config reads from context", () =>
  fileContains("extensions/firecrawl/src/config.ts", "getPersaiToolCredential"));
check("web-fetch reads from context", () =>
  fileContains("src/agents/tools/web-fetch.ts", "getPersaiToolCredential"));

console.log("\n[6] Plugin-sdk export");
check("package.json has persai-credential export", () =>
  fileContains("package.json", "persai-credential"));
check("entrypoints.json has persai-credential", () =>
  fileContains("scripts/lib/plugin-sdk-entrypoints.json", "persai-credential"));

console.log("\n[7] Thinking/reasoning stream for PersAI web chat (H10)");
check("command types expose reasoning option", () =>
  fileContains('src/agents/command/types.ts', "reasoning?: string"));
check("agent-command resolves reasoning level", () =>
  fileContains("src/agents/agent-command.ts", "resolvedReasoningLevel"));
check("persai runtime stream emits thinking chunks", () =>
  fileContains('src/gateway/persai-runtime/persai-runtime-agent-turn.ts', 'type: "thinking"'));

console.log("\n[8] Workspace avatar file endpoints");
check("persai-runtime-http.ts has RUNTIME_WORKSPACE_AVATAR_PATH", () =>
  fileContainsCount("src/gateway/persai-runtime/persai-runtime-http.ts", "RUNTIME_WORKSPACE_AVATAR_PATH") >= 2);
check("server-http.ts registers workspace-avatar stage", () =>
  fileContains("src/gateway/server-http.ts", "persai-runtime-workspace-avatar"));

console.log("\n[9] Telegram bot profile sync");
check("persai-runtime-telegram.ts has syncBotProfile", () =>
  fileContainsCount("src/gateway/persai-runtime/persai-runtime-telegram.ts", "syncBotProfile") >= 2);

console.log("\n[10] Gateway HTTP route registration");
check("server-http.ts imports persai-runtime modules", () =>
  fileContainsCount("src/gateway/server-http.ts", "persai-runtime") >= 5);
check("server-runtime-state.ts creates persai spec store", () =>
  fileContains("src/gateway/server-runtime-state.ts", "persaiRuntimeSpecStore"));

console.log(`\n--- Result: ${checks - failures}/${checks} passed ---`);
if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED. PersAI patches may be missing after upstream merge.`);
  process.exit(1);
} else {
  console.log("\nAll PersAI patches verified.\n");
}
