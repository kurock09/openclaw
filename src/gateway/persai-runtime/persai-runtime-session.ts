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
