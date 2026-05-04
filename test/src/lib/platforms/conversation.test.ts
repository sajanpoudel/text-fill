import { beforeEach, describe, expect, test, vi } from "vitest";

const messengerBoundary = makeRoot(["Alex Johnson", "Recruiter at Acme"], [
  '[role="main"]',
  "section",
]);
const gmailDialog = makeRoot(["Taylor Recruiter"], ['[role="dialog"]']);
const gmailMain = makeRoot([], ['[role="main"]']);
const twitterThread = makeRoot([], ["article", "main"]);

vi.mock("../../../../src/lib/dom/walker.ts", () => ({
  extractCleanText: (root: Element) => {
    if (root === messengerBoundary) return "Earlier messages in the thread";
    if (root === gmailMain) return "Quoted email thread and prior context";
    if (root === twitterThread) return "Original post and prior replies";
    return "";
  },
  normalizeText: (text: string) => text.replace(/\s+/g, " ").trim(),
}));

function makeTextElement(text: string): Element {
  return {
    innerText: text,
    textContent: text,
    getAttribute() {
      return null;
    },
  } as unknown as Element;
}

function makeRoot(texts: string[], matches: string[] = []): Element {
  return {
    innerText: texts.join("\n"),
    textContent: texts.join(" "),
    parentElement: null,
    getAttribute() {
      return null;
    },
    matches(selector: string) {
      return matches.includes(selector);
    },
    closest() {
      return null;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return texts.map((text) => makeTextElement(text));
    },
  } as unknown as Element;
}

function makeField(
  attrs: Record<string, string>,
  closestImpl: (selector: string) => Element | null
): Element {
  return {
    parentElement: null,
    getAttribute(name: string) {
      return attrs[name] ?? null;
    },
    closest(selector: string) {
      return closestImpl(selector);
    },
  } as unknown as Element;
}

describe("conversation extractors", () => {
  beforeEach(() => {
    vi.resetModules();
    (globalThis as any).document = {
      querySelector(selector: string) {
        if (selector === '[role="main"]') return gmailMain;
        if (selector === "article" || selector === "main") return twitterThread;
        return null;
      },
    };
  });

  test("registers platform-specific extractors for chat, email, and social platforms", async () => {
    const { getPlatformExtractor } = await import("../../../../src/lib/platforms/index.ts");

    expect(getPlatformExtractor("messenger")).not.toBeNull();
    expect(getPlatformExtractor("gmail")).not.toBeNull();
    expect(getPlatformExtractor("twitter")).not.toBeNull();
  });

  test("extracts messenger audience and thread context", async () => {
    const { messengerExtractor } = await import("../../../../src/lib/platforms/conversation.ts");
    const field = makeField(
      { "aria-label": "Message" },
      (selector) =>
        [
          '[role="dialog"]',
          '[role="main"]',
          '[aria-label*="Conversation" i]',
          "section",
          "article",
        ].includes(selector)
          ? messengerBoundary
          : null
    );

    const composeBoundary = messengerExtractor.getComposeBoundary?.(field);
    expect(composeBoundary).toBe(messengerBoundary);

    const context = messengerExtractor.extractFieldContext(
      field,
      null,
      messengerBoundary
    );

    expect(context.fieldType).toBe("[DM_MESSAGE]");
    expect(context.recipientName).toBe("Alex Johnson");
    expect(context.recipientRole).toBe("Recruiter at Acme");
    expect(context.extraContext).toBe("Earlier messages in the thread");
  });

  test("extracts gmail recipient from compose dialog and thread context from the main view", async () => {
    const { gmailExtractor } = await import("../../../../src/lib/platforms/conversation.ts");
    const field = makeField(
      { "aria-label": "Message body" },
      (selector) => (selector === '[role="dialog"]' ? gmailDialog : null)
    );

    const composeBoundary = gmailExtractor.getComposeBoundary?.(field);
    expect(composeBoundary).toBe(gmailDialog);

    const context = gmailExtractor.extractFieldContext(field, null, gmailDialog);

    expect(context.fieldType).toBe("[EMAIL_BODY]");
    expect(context.recipientName).toBe("Taylor Recruiter");
    expect(context.recipientRole).toBeNull();
    expect(context.extraContext).toBe("Quoted email thread and prior context");
  });

  test("classifies social reply composers and captures surrounding thread context", async () => {
    const { twitterExtractor } = await import("../../../../src/lib/platforms/conversation.ts");
    const field = makeField(
      { "aria-label": "Reply text" },
      (selector) => (["article", "main", "section"].includes(selector) ? twitterThread : null)
    );

    const composeBoundary = twitterExtractor.getComposeBoundary?.(field);
    expect(composeBoundary).toBe(twitterThread);

    const context = twitterExtractor.extractFieldContext(
      field,
      null,
      twitterThread
    );

    expect(context.fieldType).toBe("[COMMENT]");
    expect(context.recipientName).toBeNull();
    expect(context.extraContext).toBe("Original post and prior replies");
  });
});
