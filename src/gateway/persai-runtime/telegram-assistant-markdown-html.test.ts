import { describe, expect, test } from "vitest";
import {
  buildTelegramHtmlMessageBodies,
  convertAssistantParagraphToTelegramHtml,
  escapeTelegramHtmlText,
  fencedBlockToHtml,
  lossyPlainFromTelegramHtml,
  normalizeTelegramLanguageId,
  segmentSourceByFencedBlocks,
} from "./telegram-assistant-markdown-html.js";
import { TELEGRAM_BOT_API_MAX_MESSAGE_LENGTH } from "./telegram-outbound-chunks.js";

describe("escapeTelegramHtmlText", () => {
  test("escapes ampersand and angle brackets", () => {
    expect(escapeTelegramHtmlText(`a < b & c > d`)).toBe("a &lt; b &amp; c &gt; d");
  });
});

describe("normalizeTelegramLanguageId", () => {
  test("maps common aliases", () => {
    expect(normalizeTelegramLanguageId("C++")).toBe("cpp");
    expect(normalizeTelegramLanguageId("c#")).toBe("csharp");
    expect(normalizeTelegramLanguageId("py")).toBe("python");
  });
});

describe("fencedBlockToHtml", () => {
  test("uses nested code with language class for Telegram highlighting", () => {
    expect(fencedBlockToHtml("python", "print(1)")).toBe(
      '<pre><code class="language-python">print(1)</code></pre>',
    );
    expect(fencedBlockToHtml("cpp", "int x = 0;")).toBe(
      '<pre><code class="language-cpp">int x = 0;</code></pre>',
    );
  });

  test("plain pre when no language", () => {
    expect(fencedBlockToHtml("", "x")).toBe("<pre>x</pre>");
  });
});

describe("segmentSourceByFencedBlocks", () => {
  test("keeps blank lines inside a fence as one block", () => {
    const segs = segmentSourceByFencedBlocks("Hi\n\n```py\na = 1\n\nb = 2\n```\n\nBye");
    expect(segs).toHaveLength(3);
    expect(segs[0]).toEqual({ kind: "text", raw: "Hi\n\n" });
    expect(segs[1]).toEqual({ kind: "fence", language: "py", code: "a = 1\n\nb = 2\n" });
    expect(segs[2]).toEqual({ kind: "text", raw: "\n\nBye" });
  });
});

describe("convertAssistantParagraphToTelegramHtml", () => {
  test("wraps fenced code in pre", () => {
    expect(convertAssistantParagraphToTelegramHtml("```\nline1\n```")).toBe(
      "<pre>line1\n</pre>",
    );
  });

  test("fenced block with language uses nested pre/code", () => {
    expect(convertAssistantParagraphToTelegramHtml("```python\nprint(2)\n```")).toBe(
      '<pre><code class="language-python">print(2)\n</code></pre>',
    );
  });

  test("inline code and bold", () => {
    expect(convertAssistantParagraphToTelegramHtml("Say `x` and **yes**")).toBe(
      "Say <code>x</code> and <b>yes</b>",
    );
  });

  test("allows only http(s) links", () => {
    expect(
      convertAssistantParagraphToTelegramHtml("[ok](https://a.com) [bad](javascript:alert(1))"),
    ).toBe('<a href="https://a.com">ok</a> [bad](javascript:alert(1))');
  });
});

describe("buildTelegramHtmlMessageBodies", () => {
  test("packs short paragraphs into one message", () => {
    const bodies = buildTelegramHtmlMessageBodies("Hello\n\nWorld", TELEGRAM_BOT_API_MAX_MESSAGE_LENGTH);
    expect(bodies).toEqual(["Hello\n\nWorld"]);
  });

  test("splits when combined length exceeds limit", () => {
    const a = "a".repeat(3000);
    const b = "b".repeat(3000);
    const bodies = buildTelegramHtmlMessageBodies(`${a}\n\n${b}`, TELEGRAM_BOT_API_MAX_MESSAGE_LENGTH);
    expect(bodies.length).toBeGreaterThanOrEqual(2);
    for (const body of bodies) {
      expect(body.length).toBeLessThanOrEqual(TELEGRAM_BOT_API_MAX_MESSAGE_LENGTH);
    }
  });
});

describe("lossyPlainFromTelegramHtml", () => {
  test("strips basic tags", () => {
    expect(lossyPlainFromTelegramHtml("<b>x</b> &amp; y")).toBe("x & y");
  });
});
