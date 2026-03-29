# PersAI Fork Patches

This document tracks every PersAI-specific modification to native OpenClaw files.
After merging upstream, walk this checklist to verify all patches survived.

## Safety note

Not all fork patches have the same risk.

- **Lower-risk patches:** PersAI-specific bridge files and verification/docs changes
- **Higher-risk patches:** edits inside native OpenClaw execution/config/runtime files

Before preserving or adding a higher-risk patch, confirm:

1. a PersAI-only fix is not enough
2. the behavior must change inside OpenClaw runtime
3. the patch has a concrete merge-time verification check

## Fork metadata

- **Upstream**: `https://github.com/openclaw/openclaw.git`
- **Fork base**: tag `persai-fork-base` (`aa6b962a3`)
- **PersAI-only files** (zero merge risk — upstream doesn't have them):
  - `src/gateway/persai-runtime/` (14 files)
  - `src/agents/persai-runtime-context.ts`
  - `src/plugin-sdk/persai-credential.ts`

## Cross-cutting patches (must survive upstream merge)

### 1. Secret ref source: `"persai"` type

**Files:**

- `src/config/types.secrets.ts` — added `"persai"` to `SecretRefSource` union, `PersaiSecretProviderConfig` type, `isSecretRef`/`coerceSecretRef` guards
- `src/secrets/ref-contract.ts` — `persai` default provider alias resolution
- `src/secrets/resolve.ts` — `resolvePersaiRefs()` function (+186 lines), wired into `resolveProviderRefs()`

**Introduced by:** `acbb22f53` (feat: add persai secret source)
**Verify:** `grep -c '"persai"' src/config/types.secrets.ts` should return >= 4

### 2. Tool deny list via AsyncLocalStorage

**File:** `src/agents/openclaw-tools.ts`
**Change:** Import `persaiRuntimeRequestContext`, re-export it. After tool assembly, read `toolDenyList` from context (then fallback to `process.env.PERSAI_TOOL_DENY`).
**Introduced by:** `5c4153daf` (fix: credential refs Object parsing, eliminate process.env race)
**Verify:** `grep -c 'persaiRuntimeRequestContext' src/agents/openclaw-tools.ts` should return >= 2

### 3. Memory workspace override via AsyncLocalStorage

**Files:**

- `src/memory/backend-config.ts`
- `src/memory/manager.ts`
- `src/memory/qmd-manager.ts`
- `src/memory/read-file.ts`

**Change:** Each file imports `persaiRuntimeRequestContext` and reads `workspaceDir` from context before falling back to `resolveAgentWorkspaceDir()`.
**Introduced by:** `6cf3824e7` (feat: H3 workspace isolation) + `9d6173980` (fix: H8k)
**Verify:** `grep -rl 'persaiRuntimeRequestContext' src/memory/` should return all 4 files

### 4. Per-request tool credential isolation (H9)

**Files:**

- `extensions/tavily/src/config.ts` — import `getPersaiToolCredential`, call before `process.env.TAVILY_API_KEY`
- `extensions/firecrawl/src/config.ts` — import `getPersaiToolCredential`, call before `process.env.FIRECRAWL_API_KEY`
- `src/agents/tools/web-fetch.ts` — import `getPersaiToolCredential`, call before `process.env.FIRECRAWL_API_KEY`

**Introduced by:** `97706dbea` (feat: H9)
**Verify:** `grep -rl 'getPersaiToolCredential' extensions/ src/agents/tools/` should return all 3 files

### 5. Plugin-sdk export for persai-credential

**Files:**

- `package.json` — `"./plugin-sdk/persai-credential"` export entry
- `scripts/lib/plugin-sdk-entrypoints.json` — `"persai-credential"` entry

**Introduced by:** `97706dbea` (feat: H9)
**Verify:** `grep -c 'persai-credential' package.json` should return >= 1

### 6. Thinking/reasoning stream for PersAI web chat (H10)

**Risk:** Higher-risk native OpenClaw patch

**Files:**

- `src/agents/command/types.ts` — adds per-run `reasoning` ingress option
- `src/agents/agent-command.ts` — normalizes/passes `resolvedReasoningLevel` into `runEmbeddedPiAgent()`
- `src/gateway/persai-runtime/persai-runtime-agent-turn.ts` — PersAI web stream requests `reasoning: "stream"` and forwards `thinking` NDJSON chunks

**Introduced by:** `TBD` (feat: H10)
**Verify:** `grep -c 'resolvedReasoningLevel' src/agents/agent-command.ts` should return >= 2

### 7. Gateway HTTP route registration

**Files:**

- `src/gateway/server-http.ts` — imports from `persai-runtime/` modules, registers HTTP request stages (spec apply, chat, stream, memory, telegram webhook), resolves spec store singleton
- `src/gateway/server-runtime-state.ts` — creates `persaiRuntimeSpecStore` and passes it to `createGatewayHttpServer`

**Introduced by:** `8e61e0ba5` (feat: native PersAI runtime HTTP) through `88c47b1ed` (feat: H8 Telegram bridge)
**Verify:** `grep -c 'persai-runtime' src/gateway/server-http.ts` should return >= 5

### 8. Workspace avatar file endpoints

**Risk:** Lower-risk PersAI-specific bridge file

**Files:**

- `src/gateway/persai-runtime/persai-runtime-http.ts` — `POST/GET /api/v1/runtime/workspace/avatar` handler (file write/read to workspace dir)
- `src/gateway/server-http.ts` — registers the `persai-runtime-workspace-avatar` request stage

**Introduced by:** UI polish (avatar upload to workspace)
**Verify:** `grep -c 'RUNTIME_WORKSPACE_AVATAR_PATH' src/gateway/persai-runtime/persai-runtime-http.ts` should return >= 2

### 9. Telegram lifecycle reconcile, profile sync, and markdown fallback hardening (H8-scale + follow-up)

**Risk:** Lower-risk PersAI-specific bridge file

**Files:**

- `src/gateway/persai-runtime/persai-runtime-telegram.ts` — `syncBotProfile()` helper: sets bot name, description, and profile photo from workspace persona on every `syncTelegramBotForAssistant` call; posts the latest inbound Telegram chat target back to PersAI so reminder delivery can reuse the correct `telegramChatId`; retries Telegram replies as plain text when `MarkdownV2` entity parsing fails
- `src/gateway/persai-runtime/persai-runtime-spec-store.ts` — persisted `telegramRuntime` metadata (transport/profile fingerprints + profile sync timestamps/errors)

**Introduced by:** H8 Telegram bridge + H8-scale lifecycle hardening + Telegram markdown fallback follow-up
**Verify:**

- `grep -c 'syncBotProfile' src/gateway/persai-runtime/persai-runtime-telegram.ts` should return >= 2
- `grep -c 'transportFingerprint' src/gateway/persai-runtime/persai-runtime-telegram.ts` should return >= 2
- `grep -c 'telegramRuntime' src/gateway/persai-runtime/persai-runtime-spec-store.ts` should return >= 1
- `grep -c '/api/v1/internal/runtime/telegram/chat-target' src/gateway/persai-runtime/persai-runtime-telegram.ts` should return >= 1
- `grep -c 'sendTelegramReplyWithConfiguredParseMode' src/gateway/persai-runtime/persai-runtime-telegram.ts` should return >= 1

### 10. Cron callback bridge + task registry sync (H12)

**Risk:** Mixed

- Lower-risk bridge files:
  - `src/agents/persai-runtime-context.ts` — request context now carries `assistantId` and `cronWebhookUrl`
  - `src/gateway/persai-runtime/persai-runtime-agent-turn.ts` — PersAI runtime turns pass those values through AsyncLocalStorage
  - `src/gateway/persai-runtime/persai-runtime-http.ts` — derives `/api/v1/internal/cron-fire?assistantId=...` callback URL from the PersAI secret provider base URL
- Higher-risk native patch:
  - `src/agents/tools/cron-tool.ts` — auto-injects webhook delivery when `cronWebhookUrl` exists and mirrors `cron.add` / `cron.update` / `cron.remove` to PersAI `POST /api/v1/internal/runtime/tasks/sync`
- `src/agents/tools/reminder-task-tool.ts` — new product-facing reminder/task tool that exposes `create/list/pause/resume/cancel`; `list` resolves current tasks through PersAI registry state, while write actions route through PersAI internal control-plane instead of direct user-flow `cron.add/update/remove`
- `src/gateway/persai-runtime/persai-runtime-http.ts` — exposes `POST /api/v1/runtime/cron/control` so PersAI backend can drive internal cron mutations through PersAI-owned runtime bridge instead of native `/tools/invoke`
- `src/gateway/server-http.ts` — registers the `persai-runtime-cron-control` request stage
  - `src/agents/openclaw-tools.ts` — exposes `reminder_task` in the core tool list so plan/tool policy can show it while hiding `cron`

**Introduced by:** H12 task registry + cron callback slice
**Verify:**

- `grep -c 'cronWebhookUrl' src/agents/persai-runtime-context.ts` should return >= 1
- `grep -c 'internal/runtime/tasks/sync' src/agents/tools/cron-tool.ts` should return >= 1
- `grep -c '/api/v1/internal/cron-fire' src/gateway/persai-runtime/persai-runtime-http.ts` should return >= 1
- `grep -c '/api/v1/runtime/cron/control' src/gateway/persai-runtime/persai-runtime-http.ts` should return >= 1
- `grep -c 'name: "reminder_task"' src/agents/tools/reminder-task-tool.ts` should return >= 1
- `grep -c 'createReminderTaskTool' src/agents/openclaw-tools.ts` should return >= 1
- `grep -c 'persai-runtime-cron-control' src/gateway/server-http.ts` should return >= 1

### 11. Memory/session lifecycle reset bridge (H12g + H8s8)

**Risk:** Lower-risk PersAI-specific bridge files

**Files:**

- `src/gateway/persai-runtime/persai-runtime-workspace.ts` — helper to recreate clean `MEMORY.md` + `memory/`
- `src/gateway/persai-runtime/persai-runtime-session-cleanup.ts` — assistant-scoped cleanup of `agent:persai:<assistantId>:*` sessions plus transcript archival
- `src/gateway/persai-runtime/persai-runtime-http.ts` — `POST /api/v1/runtime/workspace/memory/reset` and strict `POST /api/v1/runtime/workspace/reset`, both now clear assistant-scoped PersAI runtime sessions
- `src/gateway/server-http.ts` — registers the request stage

**Introduced by:** H12g memory lifecycle bridge + H8s8 runtime session cleanup
**Verify:**

- `grep -c 'resetPersaiAssistantMemoryWorkspace' src/gateway/persai-runtime/persai-runtime-workspace.ts` should return >= 1
- `grep -c 'cleanupPersaiAssistantSessions' src/gateway/persai-runtime/persai-runtime-http.ts` should return >= 2
- `grep -c 'agent:persai' src/gateway/persai-runtime/persai-runtime-session-cleanup.ts` should return >= 1
- `grep -c '/api/v1/runtime/workspace/memory/reset' src/gateway/persai-runtime/persai-runtime-http.ts` should return >= 1
- `grep -c '/api/v1/runtime/workspace/reset' src/gateway/persai-runtime/persai-runtime-http.ts` should return >= 1
- `grep -c 'persai-runtime-workspace-reset' src/gateway/server-http.ts` should return >= 1
- `grep -c 'persai-runtime-workspace-memory-reset' src/gateway/server-http.ts` should return >= 1

## Quick full verification

Run `node scripts/verify-persai-patches.mjs` (see script in `scripts/`).
