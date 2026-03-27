# PersAI Fork Patches

This document tracks every PersAI-specific modification to native OpenClaw files.
After merging upstream, walk this checklist to verify all patches survived.

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

## Quick full verification

Run `node scripts/verify-persai-patches.mjs` (see script in `scripts/`).
