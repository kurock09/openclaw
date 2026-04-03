/** Telegram Bot API `sendMessage` text limit per message (characters). */
export const TELEGRAM_BOT_API_MAX_MESSAGE_LENGTH = 4096;

/**
 * Split outbound assistant text into chunks that fit one Telegram message.
 * Uses Unicode code points (`Array.from`) so astral symbols are not split mid-scalar.
 */
export function splitTelegramOutboundText(text: string, maxChars: number): string[] {
  if (maxChars < 1) {
    throw new RangeError("maxChars must be >= 1");
  }
  const chars = Array.from(text);
  const chunks: string[] = [];
  for (let i = 0; i < chars.length; i += maxChars) {
    chunks.push(chars.slice(i, i + maxChars).join(""));
  }
  return chunks;
}
