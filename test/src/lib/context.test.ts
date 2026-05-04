import { beforeEach, describe, expect, test, vi } from "vitest";

const composeBoundary = { kind: "compose" } as unknown as Element;
const mainRoot = { kind: "main" } as unknown as Element;

vi.mock("../../../src/lib/platform.ts", () => ({
  detectPlatformKey: () => "linkedin",
  getLocationSnapshot: () => ({
    hostname: "www.linkedin.com",
    pathname: "/feed/",
    href: "https://www.linkedin.com/feed/",
    title: "LinkedIn Feed",
  }),
}));

vi.mock("../../../src/lib/platforms/index.ts", () => ({
  getPlatformExtractor: () => ({
    getComposeBoundary: () => composeBoundary,
    extractFieldContext: () => ({
      fieldType: "[COMMENT]",
      recipientName: "Someone",
      recipientRole: "Recruiter",
      profileContext: null,
      extraContext: "Active comment thread:\nParent comment text",
      charLimit: null,
    }),
  }),
}));

vi.mock("../../../src/lib/dom/walker.ts", () => ({
  findContextBoundary: () => composeBoundary,
  extractDomContext: (boundary: Element) =>
    boundary === composeBoundary ? "<form>\n  \"Reply\"\n  → editor" : "",
  extractCleanText: (boundary: Element) =>
    boundary === mainRoot
      ? "Original post text with more context"
      : "",
  normalizeText: (text: string) => text.replace(/\s+/g, " ").trim(),
}));

describe("extractPageContext", () => {
  beforeEach(() => {
    (globalThis as any).document = {
      querySelector: () => mainRoot,
    };
  });

  test("includes foreground, thread, and background context blocks", async () => {
    const { extractPageContext } = await import("../../../src/lib/context.ts");
    const field = {
      closest: () => null,
      tagName: "DIV",
    } as unknown as Element;

    const context = extractPageContext(field);

    expect(context).toContain("[COMMENT]");
    expect(context).toContain("Audience: Someone — Recruiter");
    expect(context).toContain("Foreground context:\n<form>");
    expect(context).toContain("Thread context:\nActive comment thread:\nParent comment text");
    expect(context).toContain("Background context:\nOriginal post text with more context");
  });

  test("keeps background context after thread context instead of dropping the lower block", async () => {
    const { extractPageContext } = await import("../../../src/lib/context.ts");
    const field = {
      closest: () => null,
      tagName: "DIV",
    } as unknown as Element;

    const context = extractPageContext(field);

    const foregroundIndex = context.indexOf("Foreground context:");
    const threadIndex = context.indexOf("Thread context:");
    const backgroundIndex = context.indexOf("Background context:");

    expect(foregroundIndex).toBeGreaterThanOrEqual(0);
    expect(threadIndex).toBeGreaterThan(foregroundIndex);
    expect(backgroundIndex).toBeGreaterThan(threadIndex);
  });

  test("omits background context when it duplicates the foreground context", async () => {
    vi.resetModules();
    vi.doMock("../../../src/lib/platform.ts", () => ({
      detectPlatformKey: () => "linkedin",
      getLocationSnapshot: () => ({
        hostname: "www.linkedin.com",
        pathname: "/feed/",
        href: "https://www.linkedin.com/feed/",
        title: "LinkedIn Feed",
      }),
    }));
    vi.doMock("../../../src/lib/platforms/index.ts", () => ({
      getPlatformExtractor: () => ({
        getComposeBoundary: () => composeBoundary,
        extractFieldContext: () => ({
          fieldType: "[COMMENT]",
          recipientName: null,
          recipientRole: null,
          profileContext: null,
          extraContext: null,
          charLimit: null,
        }),
      }),
    }));
    vi.doMock("../../../src/lib/dom/walker.ts", () => ({
      findContextBoundary: () => composeBoundary,
      extractDomContext: () => "same context",
      extractCleanText: () => "same context",
      normalizeText: (text: string) => text.replace(/\s+/g, " ").trim(),
    }));

    const { extractPageContext } = await import("../../../src/lib/context.ts");
    const field = {
      closest: () => null,
      tagName: "DIV",
    } as unknown as Element;

    const context = extractPageContext(field);

    expect(context).toContain("Foreground context:\nsame context");
    expect(context).not.toContain("Background context:");
  });
});
