/**
 * Stable session identity for PersAI web chat turns (P1 / ADR-048).
 * OpenClaw native pipeline can adopt this key when wiring agentCommandFromIngress / hooks.
 */

export function derivePersaiWebRuntimeSessionKey(params: {
  assistantId: string;
  publishedVersionId: string;
  chatId: string;
  surfaceThreadKey: string;
}): string {
  const { assistantId, publishedVersionId, chatId, surfaceThreadKey } = params;
  return `persai:web:${assistantId}:${publishedVersionId}:${chatId}:${surfaceThreadKey}`;
}
