/**
 * Convert assistant output (common Markdown-like text) to Telegram Bot API HTML,
 * with escaping so model output cannot inject tags. Chunk packing stays under
 * {@link TELEGRAM_BOT_API_MAX_MESSAGE_LENGTH} without splitting inside HTML tags.
 */

import {
  splitTelegramOutboundText,
  TELEGRAM_BOT_API_MAX_MESSAGE_LENGTH,
} from "./telegram-outbound-chunks.js";

export { TELEGRAM_BOT_API_MAX_MESSAGE_LENGTH };

const STASH_OPEN = "\uE000";
const STASH_CLOSE = "\uE001";

export function escapeTelegramHtmlText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeHtmlAttrValue(text: string): string {
  return escapeTelegramHtmlText(text).replace(/"/g, "&quot;");
}

function isAllowedHttpUrl(href: string): boolean {
  try {
    const u = new URL(href);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function stash(slots: string[], html: string): string {
  const i = slots.length;
  slots.push(html);
  return `${STASH_OPEN}${String(i)}${STASH_CLOSE}`;
}

function unstashAndEscapeLiterals(s: string, slots: string[]): string {
  const parts = s.split(new RegExp(`(${STASH_OPEN}\\d+${STASH_CLOSE})`, "g"));
  return parts
    .map((part) => {
      const m = part.match(new RegExp(`^${STASH_OPEN}(\\d+)${STASH_CLOSE}$`));
      if (m) {
        const idx = Number(m[1]);
        return slots[idx] ?? "";
      }
      return escapeTelegramHtmlText(part);
    })
    .join("");
}

/** Apply **bold** only (single * is too error-prone for natural language). */
function applyBoldStashed(s: string, slots: string[]): string {
  return s.replace(/\*\*([\s\S]+?)\*\*/g, (full, inner: string) => {
    if (String(inner).includes(STASH_OPEN)) {
      return full;
    }
    return stash(slots, `<b>${unstashAndEscapeLiterals(inner, slots)}</b>`);
  });
}

/**
 * One paragraph or block (no double-newline inside) to Telegram HTML.
 */
export function convertAssistantParagraphToTelegramHtml(paragraph: string): string {
  const trimmed = paragraph.trim();
  if (!trimmed) {
    return "";
  }

  const fence = /^```(?:\w*)\n?([\s\S]*?)```$/;
  const fm = trimmed.match(fence);
  if (fm) {
    return `<pre>${escapeTelegramHtmlText(fm[1] ?? "")}</pre>`;
  }

  const slots: string[] = [];

  let s = trimmed.replace(/`([^`]+)`/g, (_, code: string) => {
    return stash(slots, `<code>${escapeTelegramHtmlText(code)}</code>`);
  });

  s = s.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (full, label: string, url: string) => {
    if (!isAllowedHttpUrl(url)) {
      return full;
    }
    return stash(
      slots,
      `<a href="${escapeHtmlAttrValue(url)}">${escapeTelegramHtmlText(label)}</a>`,
    );
  });

  s = applyBoldStashed(s, slots);
  return unstashAndEscapeLiterals(s, slots);
}

/** Strip Telegram HTML to lossy plain text for send fallback when entities fail. */
export function lossyPlainFromTelegramHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/pre>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function splitParagraphs(source: string): string[] {
  return source
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

function flushBuffer(buf: string, out: string[]): string {
  if (buf) {
    out.push(buf);
  }
  return "";
}

function emitOversizedParagraph(messages: string[], markdown: string, maxChars: number): void {
  const lines = markdown.split(/\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length > 1) {
    for (const line of lines) {
      emitOversizedParagraph(messages, line, maxChars);
    }
    return;
  }
  for (const chunk of splitTelegramOutboundText(markdown, maxChars)) {
    const h = convertAssistantParagraphToTelegramHtml(chunk);
    if (h.length <= maxChars) {
      messages.push(h);
    } else {
      for (const pc of splitTelegramOutboundText(escapeTelegramHtmlText(chunk), maxChars)) {
        messages.push(pc);
      }
    }
  }
}

/**
 * Build one or more Telegram HTML message bodies from assistant markdown-ish text.
 * Packs paragraphs without exceeding max length; avoids splitting inside converted HTML.
 */
export function buildTelegramHtmlMessageBodies(
  source: string,
  maxChars: number = TELEGRAM_BOT_API_MAX_MESSAGE_LENGTH,
): string[] {
  const paragraphs = splitParagraphs(source);
  if (paragraphs.length === 0) {
    return [];
  }

  const messages: string[] = [];
  let current = "";

  for (const p of paragraphs) {
    const html = convertAssistantParagraphToTelegramHtml(p);
    if (!html) {
      continue;
    }
    if (html.length > maxChars) {
      current = flushBuffer(current, messages);
      emitOversizedParagraph(messages, p, maxChars);
      continue;
    }
    const sep = current ? "\n\n" : "";
    const next = current + sep + html;
    if (next.length <= maxChars) {
      current = next;
    } else {
      current = flushBuffer(current, messages) + html;
    }
  }
  current = flushBuffer(current, messages);
  return messages;
}
