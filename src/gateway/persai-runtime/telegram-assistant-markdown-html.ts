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

/** First line after ``` is a language id when it matches this (Telegram / libprisma style ids). */
const FENCE_INFO_LINE = /^[A-Za-z0-9][A-Za-z0-9_#.+-]*$/;

const LANGUAGE_ALIASES: Record<string, string> = {
  "c++": "cpp",
  "c#": "csharp",
  "f#": "fsharp",
  "objective-c": "objc",
  objectivec: "objc",
  js: "javascript",
  ts: "typescript",
  py: "python",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  yml: "yaml",
  rs: "rust",
  kt: "kotlin",
};

/**
 * Normalize a fence language token for Telegram's `class="language-…"` (HTML parse mode).
 * See https://core.telegram.org/bots/api#html-style (nested pre/code).
 */
export function normalizeTelegramLanguageId(raw: string): string {
  const t = raw.trim().toLowerCase();
  if (!t) {
    return "";
  }
  const mapped = LANGUAGE_ALIASES[t] ?? t;
  return mapped.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * Fenced code block → Telegram HTML. With language: nested &lt;pre&gt;&lt;code class="language-…"&gt;.
 */
export function fencedBlockToHtml(language: string, code: string): string {
  const escaped = escapeTelegramHtmlText(code);
  const langNorm = normalizeTelegramLanguageId(language);
  if (langNorm) {
    return `<pre><code class="language-${langNorm}">${escaped}</code></pre>`;
  }
  return `<pre>${escaped}</pre>`;
}

type SourceSegment =
  | { kind: "text"; raw: string }
  | { kind: "fence"; language: string; code: string };

/**
 * Split markdown source into text spans and fenced code blocks so inner blank lines do not break paragraphs.
 */
export function segmentSourceByFencedBlocks(source: string): SourceSegment[] {
  const segments: SourceSegment[] = [];
  let pos = 0;
  while (pos < source.length) {
    const open = source.indexOf("```", pos);
    if (open === -1) {
      if (pos < source.length) {
        segments.push({ kind: "text", raw: source.slice(pos) });
      }
      break;
    }
    if (open > pos) {
      segments.push({ kind: "text", raw: source.slice(pos, open) });
    }
    const afterTicks = open + 3;
    const nextNl = source.indexOf("\n", afterTicks);
    if (nextNl === -1) {
      segments.push({ kind: "text", raw: source.slice(open) });
      break;
    }
    const infoLine = source.slice(afterTicks, nextNl).trimEnd();
    const codeStart = nextNl + 1;
    const close = source.indexOf("```", codeStart);
    if (close === -1) {
      segments.push({ kind: "text", raw: source.slice(open) });
      break;
    }
    let language = "";
    let codeBody = source.slice(codeStart, close);
    if (infoLine === "" || FENCE_INFO_LINE.test(infoLine)) {
      language = infoLine;
    } else {
      codeBody = source.slice(afterTicks, close);
    }
    segments.push({ kind: "fence", language, code: codeBody });
    pos = close + 3;
  }
  return segments;
}

function splitFencedHtmlToFit(language: string, code: string, maxChars: number): string[] {
  const single = fencedBlockToHtml(language, code);
  if (single.length <= maxChars) {
    return [single];
  }
  const lines = code.split("\n");
  const out: string[] = [];
  let acc = "";
  const flushAcc = (body: string) => {
    if (body.length === 0) {
      return;
    }
    out.push(fencedBlockToHtml(language, body));
  };
  for (const line of lines) {
    const next = acc.length === 0 ? line : `${acc}\n${line}`;
    if (fencedBlockToHtml(language, next).length <= maxChars) {
      acc = next;
      continue;
    }
    if (acc.length > 0) {
      flushAcc(acc);
      acc = line;
    } else {
      acc = line;
    }
    if (fencedBlockToHtml(language, acc).length > maxChars) {
      const budget = Math.max(64, maxChars - 48);
      for (const pc of splitTelegramOutboundText(escapeTelegramHtmlText(acc), budget)) {
        out.push(`<pre>${pc}</pre>`);
      }
      acc = "";
    }
  }
  flushAcc(acc);
  return out;
}

export function escapeTelegramHtmlText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

  if (trimmed.startsWith("```") && trimmed.length >= 6) {
    const closeInner = trimmed.lastIndexOf("```");
    if (closeInner > 3) {
      const inner = trimmed.slice(3, closeInner);
      const nl = inner.indexOf("\n");
      if (nl === -1) {
        const token = inner.trim();
        if (token.length > 0 && FENCE_INFO_LINE.test(token)) {
          return fencedBlockToHtml(token, "");
        }
        return fencedBlockToHtml("", inner);
      }
      const infoLine = inner.slice(0, nl).trimEnd();
      const code = inner.slice(nl + 1);
      if (infoLine === "" || FENCE_INFO_LINE.test(infoLine)) {
        return fencedBlockToHtml(infoLine, code);
      }
      return fencedBlockToHtml("", inner);
    }
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
  const lines = markdown
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean);
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
 * Fenced blocks (including optional language lines) are extracted before paragraph splitting
 * so blank lines inside code do not break layout. Packs blocks without exceeding max length.
 */
export function buildTelegramHtmlMessageBodies(
  source: string,
  maxChars: number = TELEGRAM_BOT_API_MAX_MESSAGE_LENGTH,
): string[] {
  if (source.trim().length === 0) {
    return [];
  }

  const segments = segmentSourceByFencedBlocks(source);
  const htmlBlocks: string[] = [];

  for (const seg of segments) {
    if (seg.kind === "fence") {
      htmlBlocks.push(...splitFencedHtmlToFit(seg.language, seg.code, maxChars));
      continue;
    }
    const paras = splitParagraphs(seg.raw);
    for (const p of paras) {
      const html = convertAssistantParagraphToTelegramHtml(p);
      if (!html) {
        continue;
      }
      if (html.length > maxChars) {
        emitOversizedParagraph(htmlBlocks, p, maxChars);
      } else {
        htmlBlocks.push(html);
      }
    }
  }

  if (htmlBlocks.length === 0) {
    return [];
  }

  const messages: string[] = [];
  let current = "";

  for (const html of htmlBlocks) {
    if (!html) {
      continue;
    }
    if (html.length > maxChars) {
      current = flushBuffer(current, messages);
      messages.push(html);
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
