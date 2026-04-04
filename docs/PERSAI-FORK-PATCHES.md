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
  - `src/gateway/persai-runtime/` (15 files, including new `persai-runtime-media.ts`)
  - `src/agents/persai-runtime-context.ts`
  - `src/agents/tools/persai-tool-quota-status-tool.ts` (runtime tool: live quota read)
  - `src/agents/tools/persai-workspace-attach-tool.ts` (runtime tool: attach existing workspace files to chat media)
  - `src/plugin-sdk/persai-credential.ts`
  - `src/tts/providers/yandex.ts` (new in M7)

## Cross-cutting patches (must survive upstream merge)

### 1. Secret ref source: `"persai"` type

**Files:**

- `src/config/types.secrets.ts` — added `"persai"` to `SecretRefSource` union, `PersaiSecretProviderConfig` type, `isSecretRef`/`coerceSecretRef` guards
- `src/secrets/ref-contract.ts` — `persai` default provider alias resolution
- `src/secrets/resolve.ts` — `resolvePersaiRefs()` function (+186 lines), wired into `resolveProviderRefs()`

**Introduced by:** `acbb22f53` (feat: add persai secret source)
**Verify:** `grep -c '"persai"' src/config/types.secrets.ts` should return >= 4

### 2. Tool deny list via AsyncLocalStorage (+ PersAI quota status tool)

**File:** `src/agents/openclaw-tools.ts`
**Change:** Import `persaiRuntimeRequestContext`, re-export it. After tool assembly, read `toolDenyList` from context (then fallback to `process.env.PERSAI_TOOL_DENY`). When the request store has a PersAI `assistantId`, also append `persai_tool_quota_status` (from `createPersaiToolQuotaStatusTool()`) so the model can read live daily usage vs current plan caps from PersAI `POST /api/v1/internal/runtime/tools/check` instead of guessing from chat history. When the store has both `assistantId` and `workspaceDir`, append `persai_workspace_attach` (from `createPersaiWorkspaceAttachTool()`) so the model can return existing workspace files through the outbound `media[]` pipeline without embedding bytes in the prompt.
**Introduced by:** `5c4153daf` (fix: credential refs Object parsing, eliminate process.env race); quota-status tool added later (see `persai-tool-quota-status-tool.ts`); workspace-attach tool added later (see `persai-workspace-attach-tool.ts`)
**Verify:** `grep -c 'persaiRuntimeRequestContext' src/agents/openclaw-tools.ts` should return >= 2; `grep -c 'createPersaiToolQuotaStatusTool' src/agents/openclaw-tools.ts` should return >= 1; `grep -c 'createPersaiWorkspaceAttachTool' src/agents/openclaw-tools.ts` should return >= 1

### 3. Memory workspace override via AsyncLocalStorage

**Files:**

- `src/memory/backend-config.ts`
- `src/memory/manager.ts`
- `src/memory/qmd-manager.ts`
- `src/memory/read-file.ts`

**Change:** Each file imports `persaiRuntimeRequestContext` and reads `workspaceDir` from context before falling back to `resolveAgentWorkspaceDir()`.
**Introduced by:** `6cf3824e7` (feat: H3 workspace isolation) + `9d6173980` (fix: H8k)
**Verify:** `grep -rl 'persaiRuntimeRequestContext' src/memory/` should return all 4 files

### 4. Per-request tool credential isolation (H9 + systemic follow-up)

**Files:**

- `extensions/tavily/src/config.ts` — import `getPersaiToolCredential`, call before `process.env.TAVILY_API_KEY`
- `extensions/firecrawl/src/config.ts` — import `getPersaiToolCredential`, call before `process.env.FIRECRAWL_API_KEY`
- `src/agents/persai-runtime-context.ts` — central `resolvePersaiToolCredentialForEnvVars()` helper plus request-local `activeToolName`
- `src/agents/pi-tool-definition-adapter.ts` — wraps each server-side tool execute with `withPersaiActiveTool(...)`
- `src/agents/model-auth-env.ts` — provider auth resolution now honors request-scoped PersAI tool credentials before global `process.env`
- `src/agents/tools/model-config.helpers.ts` — tool mount-time auth inference accepts an explicit `toolName`
- `src/agents/tools/image-generate-tool.ts` — image tool mounting resolves auth with `toolName: "image_generate"`
- `src/web-search/runtime.ts` — provider credential detection uses the central helper and still prefers the credential-backed provider when runtime metadata is stale
- `src/agents/tools/web-fetch.ts` — Firecrawl auth uses the central helper
- `src/tts/tts.ts` — provider auto-pick resolves request-scoped TTS credentials
- `src/tts/providers/openai.ts` — OpenAI TTS runtime auth uses the central helper
- `src/tts/providers/elevenlabs.ts` — ElevenLabs TTS runtime auth uses the central helper

**Why native patch is required:** PersAI can inject the right per-request tool secrets, but the final provider selection and provider auth resolution still happen inside OpenClaw runtime. A PersAI-only fix cannot force native `model-auth`, TTS providers, or `web_search` provider auto-detection to honor request-scoped tool credentials once the turn is already executing in OpenClaw.

**Introduced by:** `97706dbea` (feat: H9) + follow-up systemic credential fix
**Verify:**

- `grep -c 'resolvePersaiToolCredentialForEnvVars' src/agents/persai-runtime-context.ts` should return >= 1
- `grep -c 'withPersaiActiveTool' src/agents/pi-tool-definition-adapter.ts` should return >= 1
- `grep -c 'resolvePersaiToolCredentialForEnvVars' src/agents/model-auth-env.ts` should return >= 1
- `grep -c 'toolName: "image_generate"' src/agents/tools/image-generate-tool.ts` should return >= 1
- `grep -c 'resolvePersaiToolCredentialForEnvVars' src/web-search/runtime.ts` should return >= 1
- `grep -c 'resolvePersaiToolCredentialForEnvVars' src/agents/tools/web-fetch.ts` should return >= 1
- `grep -c 'resolvePersaiToolCredentialForEnvVars' src/tts/tts.ts` should return >= 1
- `grep -c 'resolvePersaiToolCredentialForEnvVars' src/tts/providers/openai.ts` should return >= 1
- `grep -c 'resolvePersaiToolCredentialForEnvVars' src/tts/providers/elevenlabs.ts` should return >= 1

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
- `src/gateway/persai-runtime/persai-runtime-telegram.ts` — inbound Telegram turns now call PersAI internal turn gateway (`POST /api/v1/internal/runtime/turns/telegram`) instead of deciding turn admission fully inside OpenClaw
- `src/gateway/persai-runtime/persai-runtime-spec-store.ts` — persisted `telegramRuntime` metadata (transport/profile fingerprints + profile sync timestamps/errors)

**Introduced by:** H8 Telegram bridge + H8-scale lifecycle hardening + Telegram markdown fallback follow-up
**Verify:**

- `grep -c 'syncBotProfile' src/gateway/persai-runtime/persai-runtime-telegram.ts` should return >= 2
- `grep -c 'transportFingerprint' src/gateway/persai-runtime/persai-runtime-telegram.ts` should return >= 2
- `grep -c 'telegramRuntime' src/gateway/persai-runtime/persai-runtime-spec-store.ts` should return >= 1
- `grep -c '/api/v1/internal/runtime/telegram/chat-target' src/gateway/persai-runtime/persai-runtime-telegram.ts` should return >= 1
- `grep -c 'sendTelegramReplyWithConfiguredParseMode' src/gateway/persai-runtime/persai-runtime-telegram.ts` should return >= 1
- `grep -c '/api/v1/internal/runtime/turns/telegram' src/gateway/persai-runtime/persai-runtime-telegram.ts` should return >= 1

### 12. Non-web runtime execute seam for PersAI-owned turn gateway (H13 core)

**Risk:** Lower-risk PersAI-specific bridge files

**Files:**

- `src/gateway/persai-runtime/persai-runtime-http.ts` — exposes `POST /api/v1/runtime/chat/channel` so PersAI can execute Telegram turns through the same runtime bridge after backend policy checks
- `src/gateway/persai-runtime/persai-runtime-http.ts` — derives PersAI `POST /api/v1/internal/runtime/tools/consume` callback URL and forwards `toolQuotaPolicy` metadata only for PersAI runtime turns
- `src/gateway/persai-runtime/persai-runtime-agent-turn.ts` — passes PersAI tool quota metadata through request-local context and returns stable error payloads when runtime tool enforcement blocks a turn
- `src/agents/persai-runtime-context.ts` — request context carries per-turn `toolQuotaPolicy` + `toolLimitWebhookUrl`
- `src/agents/pi-tools.before-tool-call.ts` — reuses the existing `before_tool_call` seam to enforce PersAI daily tool limits before a runtime tool executes
- `src/gateway/server-http.ts` — registers the `persai-runtime-chat-channel` request stage

**Introduced by:** H13 core unified turn gateway
**Verify:**

- `grep -c '/api/v1/runtime/chat/channel' src/gateway/persai-runtime/persai-runtime-http.ts` should return >= 1
- `grep -c '/api/v1/internal/runtime/tools/consume' src/gateway/persai-runtime/persai-runtime-http.ts` should return >= 1
- `grep -c 'toolLimitWebhookUrl' src/agents/persai-runtime-context.ts` should return >= 1
- `grep -c 'enforcePersaiRuntimeToolLimit' src/agents/pi-tools.before-tool-call.ts` should return >= 1
- `grep -c 'persai-runtime-chat-channel' src/gateway/server-http.ts` should return >= 1

### 13. Ephemeral setup preview runtime seam

**Risk:** Lower-risk PersAI-specific bridge files

**Files:**

- `src/gateway/persai-runtime/persai-runtime-preview.ts` — dedicated preview-only executor that validates transient artifacts, creates a temp preview workspace root, runs one turn, then removes preview workspace + isolated session
- `src/gateway/persai-runtime/persai-runtime-turn-context.ts` — shared helpers for persona/scheduling prompt enrichment reused by live web turns and preview turns
- `src/gateway/persai-runtime/persai-runtime-http.ts` — exposes `POST /api/v1/runtime/chat/web/preview` without touching the normal applied-spec store/workspace cleanup path
- `src/gateway/persai-runtime/persai-runtime-workspace.ts` — `writeBootstrapFilesToWorkspace()` accepts an explicit env so preview can target a temp root
- `src/gateway/persai-runtime/persai-runtime-session-cleanup.ts` — precise session-key cleanup for preview isolation
- `src/gateway/server-http.ts` — registers the `persai-runtime-chat-web-preview` request stage

**Why native patch is required:** PersAI can materialize the transient spec, but the actual workspace write path, prompt hydration, tool credential resolution, and embedded agent execution all happen inside OpenClaw runtime. A PersAI-only change cannot make preview execute in a separate temp workspace once the request crosses the runtime boundary.

**Verify:**

- `grep -c '/api/v1/runtime/chat/web/preview' src/gateway/persai-runtime/persai-runtime-http.ts` should return >= 1
- `grep -c 'persai-runtime-chat-web-preview' src/gateway/server-http.ts` should return >= 1
- `grep -c 'cleanupPersaiSessionKey' src/gateway/persai-runtime/persai-runtime-session-cleanup.ts` should return >= 1

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

### 12. Bootstrap consume + heartbeat hygiene bridge

**Risk:** Mostly lower-risk PersAI bridge files plus one small heartbeat/session isolation patch in native runtime

**Files:**

- `src/gateway/persai-runtime/persai-runtime-workspace.ts` — assistant bootstrap consume helper + consumed marker so ordinary future applies do not recreate `BOOTSTRAP.md`
- `src/gateway/persai-runtime/persai-runtime-http.ts` — `POST /api/v1/runtime/workspace/bootstrap/consume`
- `src/gateway/persai-runtime/persai-runtime-heartbeat-model.ts` — fetches PersAI admin global default model for background heartbeat
- `src/gateway/server-http.ts` — registers bootstrap-consume route
- `src/infra/heartbeat-runner.ts` — uses dedicated `:heartbeat` session and PersAI-derived default model when no explicit heartbeat model override exists
- `src/agents/workspace.ts` — heartbeat sessions get reduced bootstrap-file allowlist (no `BOOTSTRAP.md` bleed-through)

**Introduced by:** bootstrap/heartbeat hygiene fix
**Verify:**

- `grep -c 'consumePersaiAssistantBootstrapFile' src/gateway/persai-runtime/persai-runtime-workspace.ts` should return >= 1
- `grep -c '/api/v1/runtime/workspace/bootstrap/consume' src/gateway/persai-runtime/persai-runtime-http.ts` should return >= 1
- `grep -c 'persai-runtime-workspace-bootstrap-consume' src/gateway/server-http.ts` should return >= 1
- `grep -c 'resolvePersaiHeartbeatModelOverride' src/infra/heartbeat-runner.ts` should return >= 1
- `grep -c ':heartbeat' src/infra/heartbeat-runner.ts` should return >= 1

### 13. Workspace media upload/download/transcribe bridge (M-series M1/M3)

**Risk:** Lower-risk PersAI-specific bridge file

**Files:**

- `src/gateway/persai-runtime/persai-runtime-media.ts` (new) — HTTP handlers for workspace media operations: upload, download, delete, delete-chat, transcribe (calls native `transcribeAudioFile`)
- `src/gateway/server-http.ts` — registers 5 media request stages: `persai-runtime-workspace-media-upload`, `-download`, `-delete`, `-delete-chat`, `-transcribe`

**Introduced by:** M-series M1 foundation + M3 voice transcription
**Verify:**

- `grep -c 'handleRuntimeWorkspaceMediaUploadHttpRequest' src/gateway/persai-runtime/persai-runtime-media.ts` should return >= 1
- `grep -c 'handleRuntimeWorkspaceMediaTranscribeHttpRequest' src/gateway/persai-runtime/persai-runtime-media.ts` should return >= 1
- `grep -c 'persai-runtime-workspace-media-upload' src/gateway/server-http.ts` should return >= 1
- `grep -c 'persai-runtime-workspace-media-transcribe' src/gateway/server-http.ts` should return >= 1

### 14. Agent turn media extraction + web/stream media delivery (M-series M2)

**Risk:** Lower-risk PersAI-specific bridge changes

**Files:**

- `src/gateway/persai-runtime/persai-runtime-agent-turn.ts` — `resolveAgentResponse` extracts `{ text, media: PersaiMediaArtifact[] }` from `normalizeOutboundPayloads`; web sync returns `media[]` in JSON; web stream emits `{ type: "media", media }` NDJSON event after `done`
- `src/gateway/persai-runtime/persai-runtime-http.ts` — sync chat response includes `media: agentOut.media`

**Introduced by:** M-series M2 tool media delivery
**Verify:**

- `grep -c 'resolveAgentResponse' src/gateway/persai-runtime/persai-runtime-agent-turn.ts` should return >= 2
- `grep -c 'PersaiMediaArtifact' src/gateway/persai-runtime/persai-runtime-agent-turn.ts` should return >= 1
- `grep -c '"media"' src/gateway/persai-runtime/persai-runtime-agent-turn.ts` should return >= 1

### 14a. Workspace cleanup preserves assistant workspace root

**Risk:** Lower-risk PersAI-specific bridge change

**Files:**

- `src/gateway/persai-runtime/persai-runtime-workspace.ts` — `cleanupPersaiAssistantWorkspace()` clears assistant workspace contents but preserves the workspace root directory; avoids crashing live runs that already `chdir(workspaceDir)` when assistant recreate/reset/preview cleanup happens
- `src/gateway/persai-runtime/persai-runtime-workspace.test.ts` — regression test asserts cleanup removes contents but keeps the root directory

**Why native patch is required:** The unsafe `rm -rf workspaceRoot` happens inside the OpenClaw PersAI runtime bridge. PersAI-only changes cannot prevent a live OpenClaw run from losing its current working directory once this cleanup endpoint is called.

**Introduced by:** runtime workspace root preservation hotfix
**Verify:**

- `grep -c 'root preserved' src/gateway/persai-runtime/persai-runtime-workspace.ts` should return >= 1
- `grep -c 'preserves the workspace root' src/gateway/persai-runtime/persai-runtime-workspace.test.ts` should return >= 1

### 15. Telegram inbound/outbound media (M-series M5/M6)

**Risk:** Lower-risk PersAI-specific bridge changes

**Files:**

- `src/gateway/persai-runtime/persai-runtime-telegram.ts` — handlers for `message:voice` (download + STT + turn with attachment), `message:photo` (download + turn with attachment), `message:document` (download + turn with attachment); `requestPersaiTelegramTurn` returns `{ text, media[] }`; `deliverTelegramMedia` sends `sendPhoto`/`sendVoice`/`sendAudio`/`sendVideo`/`sendDocument` via Grammy `InputFile`; `sendTelegramReplyWithConfiguredParseMode` uses `splitTelegramOutboundText` / `TELEGRAM_BOT_API_MAX_MESSAGE_LENGTH` from `telegram-outbound-chunks.ts`; when bootstrap `parseMode` is `markdown`, assistant text is converted to **Telegram HTML** via `telegram-assistant-markdown-html.ts` (`buildTelegramHtmlMessageBodies`, `parse_mode: "HTML"`) instead of raw MarkdownV2, with safe escaping, **fenced code** mapped to `<pre><code class="language-…">` (normalized language tokens), **segmentation** so blank lines inside fences do not break outer paragraph runs, **oversized fence splitting** for the 4096 code-point packing path, and paragraph-aware packing under 4096 chars per message

**Introduced by:** M-series M5 Telegram inbound + M6 Telegram outbound
**Verify:**

- `grep -c 'message:voice' src/gateway/persai-runtime/persai-runtime-telegram.ts` should return >= 1
- `grep -c 'message:photo' src/gateway/persai-runtime/persai-runtime-telegram.ts` should return >= 1
- `grep -c 'message:document' src/gateway/persai-runtime/persai-runtime-telegram.ts` should return >= 1
- `grep -c 'deliverTelegramMedia' src/gateway/persai-runtime/persai-runtime-telegram.ts` should return >= 2
- `grep -c 'PersaiTelegramTurnResult' src/gateway/persai-runtime/persai-runtime-telegram.ts` should return >= 1
- `grep -c 'TELEGRAM_BOT_API_MAX_MESSAGE_LENGTH' src/gateway/persai-runtime/persai-runtime-telegram.ts` should return >= 1

### 16. Yandex SpeechKit TTS provider (M-series M7)

**Risk:** Higher-risk — new native OpenClaw TTS provider file + modifications to native TTS config/registry/resolution

**Files:**

- `src/tts/providers/yandex.ts` (new) — Yandex SpeechKit v1 REST API TTS provider implementing `SpeechProviderPlugin` (oggopus + mp3 output, API-Key + IAM Token auth, 18 voices)
- `src/tts/provider-registry.ts` — `buildYandexSpeechProvider` added to `BUILTIN_SPEECH_PROVIDER_BUILDERS`
- `src/tts/tts.ts` — `"yandex"` in `TTS_PROVIDERS`, `ResolvedTtsConfig.yandex`, `resolveTtsConfig` maps `raw.yandex`, `resolveTtsApiKey` checks Yandex keys
- `src/config/types.tts.ts` — `TtsConfig.yandex` section (apiKey, folderId, voice, lang, emotion, speed)
- `src/secrets/runtime-config-collectors-tts.ts` — collects `yandex.apiKey` secret
- `src/agents/persai-runtime-context.ts` — `TOOL_PROVIDER_ENV_FALLBACKS.tts.yandex` env aliases

**Why native patch is required:** TTS provider registration, config resolution, and secret collection all happen inside native OpenClaw TTS infrastructure. A PersAI-only fix cannot add a new provider to the built-in registry.

**Introduced by:** M-series M7 Yandex SpeechKit TTS
**Verify:**

- `grep -c 'buildYandexSpeechProvider' src/tts/provider-registry.ts` should return >= 1
- `grep -c '"yandex"' src/tts/tts.ts` should return >= 2
- `grep -c 'yandex' src/config/types.tts.ts` should return >= 1
- `grep -c 'yandex' src/secrets/runtime-config-collectors-tts.ts` should return >= 1
- `grep -c 'YANDEX_TTS_API_KEY' src/agents/persai-runtime-context.ts` should return >= 1

### 17. Tool-generated media saves to user workspace + download path fix (M-series M8 hotfix)

**Risk:** Higher-risk — native OpenClaw `store.ts` and `image-generate-tool.ts` patched

**Files:**

- `src/media/store.ts` — `saveMediaBuffer` accepts optional `baseDirOverride` parameter to redirect media writes away from `.openclaw-state/media/` to a caller-chosen directory
- `src/agents/tools/image-generate-tool.ts` — when `workspaceDir` is set, passes `workspaceDir/media` as `baseDirOverride` so generated images persist in the user workspace and are reachable by PersAI download handler
- `src/gateway/persai-runtime/persai-runtime-media.ts` — `resolvePersaiWorkspaceMediaStoragePath` (exported) resolves download/delete paths under `workspaceDir/media/` or `../…` within `PERSAI_WORKSPACE_ROOT` as a safety net for tool-generated and workspace-attached media

**Why native patch is required:** `saveMediaBuffer` is a core OpenClaw media utility with a hardcoded save directory. PersAI needs tool-generated images to land in the per-user workspace so they survive cleanup and are served by the PersAI download handler. Without the `baseDirOverride` parameter, there is no way to redirect the save path from a PersAI-only fix.

**Introduced by:** M-series M8 hotfix (tool media delivery)
**Verify:**

- `grep -c 'baseDirOverride' src/media/store.ts` should return >= 2
- `grep -c 'mediaBaseDir' src/agents/tools/image-generate-tool.ts` should return >= 2
- `grep -c 'resolvePersaiWorkspaceRoot' src/gateway/persai-runtime/persai-runtime-media.ts` should return >= 1

### 18. Fix stream race condition — media NDJSON event was never emitted

**Risk:** Lower-risk — PersAI bridge file only

**Files:**

- `src/gateway/persai-runtime/persai-runtime-agent-turn.ts` — removed lifecycle `end` event handler that prematurely closed the HTTP response before `resolveAgentResponse` could extract and emit the `{ type: "media" }` NDJSON event

**Why patch is required:** The `onAgentEvent` lifecycle `end` handler set `closed = true` and called `res.end()` before `agentCommandFromIngress` returned its result. The media extraction block was guarded by `if (closed) return`, so it was always skipped. The `finally` block already handled proper response closing, making the lifecycle handler redundant and harmful.

**Introduced by:** M-series media stream delivery fix
**Verify:**

- `grep -c 'evt.stream === "lifecycle"' src/gateway/persai-runtime/persai-runtime-agent-turn.ts` should return 0 (lifecycle handler removed from stream function)

### 19. Capture tool-generated media into result payloads when onBlockReply is absent

**Risk:** Lower-risk — no behavior change when `onBlockReply` is provided by the caller

**Files:**

- `src/agents/pi-embedded-runner/run.ts` — added a fallback `onBlockReply` that captures media-bearing block replies into a local array, then merges them into `result.payloads` after `buildEmbeddedRunPayloads`

**Why patch is required:** `agentCommandFromIngress` (used by PersAI web/Telegram runtime) does not pass `onBlockReply` to `runEmbeddedPiAgent`. Tool-generated media (e.g. from `image_generate`) flows exclusively through the block-reply callback via `consumePendingToolMediaReply`. Without `onBlockReply`, `emitBlockReplySafely` returns early and the media URLs are silently lost. `buildEmbeddedRunPayloads` only extracts media from `MEDIA:` text directives in `assistantTexts`, not from `pendingToolMediaUrls`. This patch provides a minimal media-capture fallback so tool-generated media appears in `result.payloads` and reaches the PersAI NDJSON/Telegram delivery pipeline.

**Introduced by:** M-series media delivery root-cause fix
**Verify:**

- `grep -c '_capturedBlockReplyMedia' src/agents/pi-embedded-runner/run.ts` should return >= 4
- `grep -c '_effectiveOnBlockReply' src/agents/pi-embedded-runner/run.ts` should return >= 2

### 20. Include media in Telegram agent turn response

**Risk:** Lower-risk — Telegram code path only, no effect on web

**Files:**

- `src/gateway/persai-runtime/persai-runtime-agent-turn.ts` — `runPersaiTelegramAgentTurn` now calls `resolveAgentResponse` (text + media) instead of `resolveAgentResponseText` (text only), and its return type includes the `media` field
- `src/gateway/persai-runtime/persai-runtime-http.ts` — the Telegram channel HTTP handler now includes `media: agentOut.media` in the JSON response, matching the web sync endpoint

**Why patch is required:** `runPersaiTelegramAgentTurn` used `resolveAgentResponseText` which discards the media array. The HTTP handler also omitted `media` from the response JSON. As a result, even though `_capturedBlockReplyMedia` (patch #19) successfully captured tool-generated images, the media never reached the OpenClaw Telegram polling handler's `deliverTelegramMedia` function. Images were generated and saved to disk but never sent to the Telegram chat.

**Introduced by:** M-series Telegram media delivery fix
**Verify:**

- `grep -c 'resolveAgentResponse(result)' src/gateway/persai-runtime/persai-runtime-agent-turn.ts` should return >= 2 (web sync + telegram)
- `grep -c 'media: agentOut.media' src/gateway/persai-runtime/persai-runtime-http.ts` should return >= 2 (web sync + telegram channel)

### 21. Redirect TTS audio output to user workspace

**Risk:** Lower-risk — only changes save location when `workspaceDir` is set

**Files:**

- `src/agents/openclaw-tools.ts` — passes `workspaceDir` to `createTtsTool`
- `src/agents/tools/tts-tool.ts` — accepts `workspaceDir`, computes `outputDir` as `workspaceDir/media/tts`
- `src/tts/tts.ts` — `textToSpeech` accepts optional `outputDir`; when provided, saves audio there instead of ephemeral `/tmp/openclaw/tts-*`

**Note:** `maybeApplyTtsToPayload` previously had an `outputDir` pass-through (commit `9a4d8a9d56`), but it was removed when the directive pipeline was replaced by tool-call-only TTS (`tts.auto: "off"`). The `textToSpeech` `outputDir` remains — it is used by the TTS tool-call path.

**Why patch is required:** TTS audio was saved to `/tmp/openclaw/` which is ephemeral and not accessible by PersAI's media download handler. PersAI API logs showed `Tool media not found on storage: /tmp/openclaw/tts-*/voice-*.mp3`. Same root cause as image_generate (patch #17).

**Introduced by:** M-series TTS media delivery fix
**Verify:**

- `grep -c 'outputDir' src/tts/tts.ts` should return >= 3
- `grep -c 'workspaceDir' src/agents/tools/tts-tool.ts` should return >= 2

### 22. TTS provider selection from PersAI admin override

**Risk:** Lower-risk — extends existing PersAI bridge context, minimal native change in `tts.ts`

**Files:**

- `src/agents/persai-runtime-context.ts` — added `toolProviderOverrides` field to `PersaiRuntimeRequestCtx`, added `getPersaiToolProviderOverride()` helper
- `src/gateway/persai-runtime/persai-runtime-tool-policy.ts` — added `extractToolProviderOverrides()` that extracts `providerId` from `toolCredentialRefs`
- `src/gateway/persai-runtime/persai-runtime-agent-turn.ts` — all three turn functions (`sync`, `telegram`, `stream`) accept and propagate `toolProviderOverrides` into runtime context
- `src/gateway/persai-runtime/persai-runtime-http.ts` — all three HTTP handlers extract provider overrides from bootstrap and pass to agent turn
- `src/tts/tts.ts` — `getTtsProvider()` checks PersAI context override first (highest priority), added `YANDEX_TTS_API_KEY` to primary Yandex key lookup
- `src/tts/providers/yandex.ts` — `resolveYandexApiKey()` added `YANDEX_TTS_API_KEY` to primary env var lookup

**Why patch is required:** `getTtsProvider()` resolves the active TTS provider from config file or filesystem prefs — neither of which PersAI populates. When admin selects "yandex" in PersAI, the `providerId` is stored in `toolCredentialRefs` but never reaches the TTS provider selector. The API key resolves correctly, but the wrong provider (openai) is used because `OPENAI_API_KEY` exists globally. The fix propagates PersAI's `providerId` through the request context so `getTtsProvider()` sees it first.

**Introduced by:** TTS provider selection fix
**Verify:**

- `grep -c 'toolProviderOverrides' src/agents/persai-runtime-context.ts` should return >= 2
- `grep -c 'getPersaiToolProviderOverride' src/tts/tts.ts` should return >= 1
- `grep -c 'extractToolProviderOverrides' src/gateway/persai-runtime/persai-runtime-http.ts` should return >= 3
- `grep -c 'toolProviderOverrides' src/gateway/persai-runtime/persai-runtime-agent-turn.ts` should return >= 6
- `grep -c 'YANDEX_TTS_API_KEY' src/tts/providers/yandex.ts` should return >= 2

### 23. Explicit audio MIME type in transcribe handler

**Risk:** Lower-risk — only changes how MIME is inferred in the PersAI transcribe endpoint

**Files:**

- `src/gateway/persai-runtime/persai-runtime-media.ts` — `handleRuntimeWorkspaceMediaTranscribeHttpRequest` now infers `audio/*` MIME from file extension before calling `transcribeAudioFile`, instead of relying on content-type sniffing which misclassified `.webm` as video

**Why patch is required:** OpenClaw's `resolveAttachmentKind()` checks video extensions before audio, and `.webm` is a valid video container extension. When the transcribe handler passed no explicit MIME, the system classified webm voice recordings as "video" and skipped audio transcription entirely.

**Introduced by:** Web voice transcription fix
**Verify:**

- `grep -c 'AUDIO_MIME_BY_EXT' src/gateway/persai-runtime/persai-runtime-media.ts` should return >= 2

### 24. Runtime file-security gate + request-level fallback model override

**Risk:** Lower-risk — PersAI bridge/runtime enforcement files only

**Files:**

- `src/gateway/persai-runtime/persai-runtime-file-security.ts` — shared runtime-side validator for media/file payloads
- `src/gateway/persai-runtime/persai-runtime-media.ts` — validates fetched outbound artifacts with the runtime-side file gate before normal delivery
- `src/agents/tools/persai-workspace-attach-tool.ts` — validates attached workspace files with the same runtime-side file gate
- `src/gateway/persai-runtime/persai-runtime-http.ts` — web/chat handlers accept request-level `providerOverride` / `modelOverride` so PersAI can apply materialized quota-fallback routing without rewriting stored bootstrap

**Introduced by:** K16 file hardening + graceful quota fallback follow-up
**Verify:**

- `grep -c 'validatePersaiRuntimeMedia' src/gateway/persai-runtime/persai-runtime-media.ts` should return >= 1
- `grep -c 'validatePersaiRuntimeMedia' src/agents/tools/persai-workspace-attach-tool.ts` should return >= 1
- `grep -c 'providerOverride' src/gateway/persai-runtime/persai-runtime-http.ts` should return >= 3
- `grep -c 'modelOverride' src/gateway/persai-runtime/persai-runtime-http.ts` should return >= 3

---

### Patch #25 — Auto-configure persai secret provider from PERSAI_API_BASE_URL

**Files:**

- `src/secrets/resolve.ts` — `resolveConfiguredProvider` now auto-creates a `PersaiSecretProviderConfig` from `PERSAI_API_BASE_URL` when a persai-source secret ref is encountered but no explicit `secrets.providers` config exists

**Why patch is required:** PersAI runtime deploys do not write an OpenClaw `config.json`. Without explicit `secrets.providers["persai-runtime"]` config, `resolveSecretRefValues` throws "not configured" for persai-source refs, which is silently caught. This leaves `resolvedToolCredentials` empty — all per-provider API keys (Yandex TTS, etc.) are invisible to tool code, causing silent fallback to default providers.

**Introduced by:** Yandex TTS credential resolution fix
**Verify:**

- `grep -c 'PERSAI_API_BASE_URL' src/secrets/resolve.ts` should return >= 1

---

### Patch #25 — TTS provider fallback diagnostic logging

**Files:**

- `src/tts/tts.ts` — `synthesizeSpeech` now logs provider order, per-provider attempt/skip/success/failure with latency and error details via `logVerbose`

**Why patch is required:** TTS provider fallback chain silently swallows errors, making it impossible to diagnose why a configured provider (e.g. Yandex) is not used.

**Introduced by:** TTS provider debugging
**Verify:**

- `grep -c 'TTS: provider' src/tts/tts.ts` should return >= 4

### Patch #26 — Secret schema allows `persai` refs/providers

**Risk:** Higher-risk native OpenClaw patch

**Files:**

- `src/config/zod-schema.core.ts` — adds `PersaiSecretRefSchema`, `SecretsPersaiProviderSchema`, and `secrets.defaults.persai` so PersAI-managed secret refs/providers validate in core config parsing

**Why patch is required:** PersAI secret refs are consumed inside native OpenClaw config/secrets resolution. Without the schema support in core config validation, PersAI-managed provider refs and defaults are rejected before runtime bridging can use them. A PersAI-only patch cannot make native OpenClaw accept a config shape it rejects during parse/validation.

**Introduced by:** PersAI secret-provider integration
**Verify:**

- `grep -c 'PersaiSecretRefSchema' src/config/zod-schema.core.ts` should return >= 1
- `grep -c 'SecretsPersaiProviderSchema' src/config/zod-schema.core.ts` should return >= 1
- `grep -c 'persai: z.string' src/config/zod-schema.core.ts` should return >= 1

### Patch #27 — Interactive secret configure supports `persai` providers

**Risk:** Higher-risk native OpenClaw patch

**Files:**

- `src/secrets/configure.ts` — interactive secrets-configure flow recognizes `persai` providers in hints/discovery and preserves PersAI provider entries during configure workflows

**Why patch is required:** OpenClaw's native interactive secret configuration tooling is part of the operator/maintainer workflow for inspecting and evolving runtime config. Once PersAI secret providers exist in real runtime config, the native configure flow must understand them instead of treating them as unknown or silently excluding them from source choices/hints. A PersAI-only patch cannot change native OpenClaw configure UX/behavior after operators enter the OpenClaw-side workflow.

**Introduced by:** PersAI secret-provider integration follow-up
**Verify:**

- `grep -c 'persai (' src/secrets/configure.ts` should return >= 1
- `grep -c 'hasSource("persai")' src/secrets/configure.ts` should return >= 1
- `grep -c 'value: "persai"' src/secrets/configure.ts` should return >= 1

## Quick full verification

Run `node scripts/verify-persai-patches.mjs` (see script in `scripts/`).
