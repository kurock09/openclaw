import { describe, expect, test } from "vitest";
import {
  buildTelegramHtmlMessageBodies,
  convertAssistantParagraphToTelegramHtml,
  escapeTelegramHtmlText,
  lossyPlainFromTelegramHtml,
} from "./telegram-assistant-markdown-html.js";
import { TELEGRAM_BOT_API_MAX_MESSAGE_LENGTH } from "./telegram-outbound-chunks.js";

describe("escapeTelegramHtmlText", () => {
  test("escapes ampersand and angle brackets", () => {
    expect(escapeTelegramHtmlText(`a < b & c > d`)).toBe("a &lt; b &amp; c &gt; d");
  });
});

describe("convertAssistantParagraphToTelegramHtml", () => {
  test("wraps fenced code in pre", () => {
    expect(convertAssistantParagraphToTelegramHtml("```\nline1\n```")).toBe(
      "<pre>line1\n</pre>",
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
