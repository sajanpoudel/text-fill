import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../../src/lib/dom/walker.ts", () => ({
  extractCleanText: (value: { innerText?: string; textContent?: string } | null, maxLength = 1800) =>
    String(value?.innerText ?? value?.textContent ?? "").slice(0, maxLength),
}));

import { buildAgentRunBootstrapContext } from "../../../src/lib/agent-run-bootstrap.ts";

class FakeElement {
  textContent: string;
  innerText: string;
  parentElement: FakeElement | null = null;
  private selectorAllMap = new Map<string, FakeElement[]>();

  constructor(textContent = "") {
    this.textContent = textContent;
    this.innerText = textContent;
  }

  querySelectorAll<T>(selector: string): T[] {
    return (this.selectorAllMap.get(selector) ?? []) as T[];
  }

  setQuerySelectorAll(selector: string, value: FakeElement[]) {
    this.selectorAllMap.set(selector, value);
  }

  getBoundingClientRect() {
    return { width: 120, height: 20, top: 0, left: 0, right: 120, bottom: 20 };
  }

  getAttribute(name: string) {
    if (name === "href" && "href" in this) {
      return (this as FakeAnchorElement).href;
    }
    return null;
  }

  closest<T>(selector: string): T | null {
    if (
      selector.includes("header") ||
      selector.includes("nav") ||
      selector.includes("aside") ||
      selector.includes("footer") ||
      selector.includes("navigation") ||
      selector.includes("banner") ||
      selector.includes("contentinfo")
    ) {
      return null;
    }
    return this.parentElement as T | null;
  }
}

class FakeAnchorElement extends FakeElement {
  href: string;

  constructor(textContent: string, href: string) {
    super(textContent);
    this.href = href;
  }
}

describe("agent run bootstrap", () => {
  beforeAll(() => {
    (globalThis as any).Element = FakeElement;
    (globalThis as any).HTMLElement = FakeElement;
    (globalThis as any).HTMLAnchorElement = FakeAnchorElement;
    (globalThis as any).window = {
      getComputedStyle: () => ({
        display: "block",
        visibility: "visible",
        opacity: "1",
      }),
    };
  });

  beforeEach(() => {
    (globalThis as any).location = {
      href: "https://example.com/search?q=recruiter",
    };
  });

  test("derives generic work items from repeated visible links on a page", () => {
    const mainRoot = new FakeElement("Search results page");
    const firstCard = new FakeElement(
      "Taylor Recruiter Senior recruiter at ExampleCo Open profile"
    );
    const secondCard = new FakeElement(
      "Jordan Hiring Technical recruiter at ExampleCo Open profile"
    );

    const firstLink = new FakeAnchorElement(
      "Taylor Recruiter",
      "https://example.com/profiles/taylor"
    );
    firstLink.parentElement = firstCard;

    const secondLink = new FakeAnchorElement(
      "Jordan Hiring",
      "https://example.com/profiles/jordan"
    );
    secondLink.parentElement = secondCard;

    mainRoot.setQuerySelectorAll("a[href]", [firstLink, secondLink]);

    (globalThis as any).document = {
      title: "Recruiter search",
      body: mainRoot,
      querySelector: (selector: string) =>
        selector === "main, article, [role='main']" ? mainRoot : null,
    };

    const bootstrap = buildAgentRunBootstrapContext("general");

    expect(bootstrap.pageUrl).toBe("https://example.com/search?q=recruiter");
    expect(bootstrap.workItems).toHaveLength(2);
    expect(bootstrap.workItems).toMatchObject([
      {
        title: "Handle Taylor Recruiter",
        pageUrl: "https://example.com/profiles/taylor",
        targetName: "Taylor Recruiter",
        sourceType: "page_link",
      },
      {
        title: "Handle Jordan Hiring",
        pageUrl: "https://example.com/profiles/jordan",
        targetName: "Jordan Hiring",
        sourceType: "page_link",
      },
    ]);
  });
});
