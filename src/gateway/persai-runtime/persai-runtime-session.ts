/**
 * Stable assistant-scoped session identity for PersAI web chat turns.
 * Keeping web turns inside the persai agent namespace prevents assistant
 * runtime state from leaking into the default main session bucket.
 */

export function derivePersaiWebRuntimeSessionKey(params: {
  assistantId: string;
  chatId: string;
  surfaceThreadKey: string;
}): string {
  const { assistantId, chatId, surfaceThreadKey } = params;
  return `agent:persai:${assistantId}:web:${chatId}:${surfaceThreadKey}`;
}

export function derivePersaiWebSandboxSessionKey(params: {
  assistantId: string;
}): string {
  const { assistantId } = params;
  return `agent:persai:${assistantId}:web:sandbox`;
}

export function derivePersaiTelegramRuntimeSessionKey(params: {
  assistantId: string;
  threadId: string;
}): string {
  const { assistantId, threadId } = params;
  return `agent:persai:${assistantId}:telegram:${threadId}`;
}
