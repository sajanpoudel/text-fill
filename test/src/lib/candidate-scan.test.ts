import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { scanLinkedInCandidatesInPage } from "../../../src/lib/candidate-scan.ts";

class FakeElement {
  textContent: string;
  innerText: string;
  tagName = "DIV";
  href?: string;
  parentElement: FakeElement | null = null;
  private attributes = new Map<string, string>();
  private selectorMap = new Map<string, FakeElement | null>();
  private selectorAllMap = new Map<string, FakeElement[]>();

  constructor(textContent = "") {
    this.textContent = textContent;
    this.innerText = textContent;
  }

  getBoundingClientRect() {
    return { width: 120, height: 20, top: 0, left: 0, right: 120, bottom: 20 };
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string) {
    return this.attributes.has(name);
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

  setQuerySelector(selector: string, value: FakeElement | null) {
    this.selectorMap.set(selector, value);
  }

  setQuerySelectorAll(selector: string, value: FakeElement[]) {
    this.selectorAllMap.set(selector, value);
  }

  querySelector<T>(selector: string): T | null {
    return (this.selectorMap.get(selector) ?? null) as T | null;
  }

  querySelectorAll<T>(selector: string): T[] {
    return (this.selectorAllMap.get(selector) ?? []) as T[];
  }
}

describe("candidate scan helpers", () => {
  beforeAll(() => {
    (globalThis as any).Element = FakeElement;
    (globalThis as any).HTMLElement = FakeElement;
    (globalThis as any).window = {
      getComputedStyle: () => ({
        display: "block",
        visibility: "visible",
        opacity: "1",
      }),
      innerHeight: 800,
      innerWidth: 1200,
    };
    (globalThis as any).location = {
      href: "https://www.linkedin.com/search/results/people/?keywords=recruiter",
    };
  });

  beforeEach(() => {
    (globalThis as any).document = {
      querySelectorAll: () => [],
    };
  });

  test("scans connectable LinkedIn candidates and the next page url", () => {
    const firstCard = new FakeElement();
    const firstConnect = new FakeElement("Connect");
    const firstLink = new FakeElement();
    firstLink.href = "https://www.linkedin.com/in/carolyn-wilmes-orr/?trk=feed";
    firstLink.parentElement = firstCard;
    const firstName = new FakeElement("Carolyn Wilmes Orr");
    const firstHeadline = new FakeElement("Senior Software Engineering Recruiter");
    firstCard.setQuerySelectorAll("button, [role='button']", [firstConnect]);
    firstCard.setQuerySelector("a[href*='/in/']", firstLink);
    firstCard.setQuerySelector(
      ".entity-result__title-text a span[aria-hidden='true'], .entity-result__title-line a span[aria-hidden='true']",
      firstName
    );
    firstCard.setQuerySelector(".entity-result__primary-subtitle, .entity-result__summary", firstHeadline);

    const secondCard = new FakeElement();
    const secondConnect = new FakeElement("Connect");
    const secondLink = new FakeElement();
    secondLink.href = "https://www.linkedin.com/in/taylor-recruiter/";
    secondLink.parentElement = secondCard;
    const secondName = new FakeElement("Taylor Recruiter");
    secondCard.setQuerySelectorAll("button, [role='button']", [secondConnect]);
    secondCard.setQuerySelector("a[href*='/in/']", secondLink);
    secondCard.setQuerySelector(
      ".entity-result__title-text a span[aria-hidden='true'], .entity-result__title-line a span[aria-hidden='true']",
      secondName
    );

    const nextLink = new FakeElement("Next");
    nextLink.href =
      "https://www.linkedin.com/search/results/people/?keywords=recruiter&page=2";
    nextLink.setAttribute(
      "href",
      "https://www.linkedin.com/search/results/people/?keywords=recruiter&page=2"
    );

    (globalThis as any).document.querySelectorAll = (selector: string) => {
      if (
        selector ===
        "[data-chameleon-result-urn], .reusable-search__result-container, li.reusable-search__result-container, .entity-result"
      ) {
        return [firstCard, secondCard];
      }
      if (selector === "a[href*='/in/']") {
        return [firstLink, secondLink];
      }
      if (selector === "a[href], button, [role='button']") {
        return [nextLink];
      }
      return [];
    };

    const scan = scanLinkedInCandidatesInPage(5);
    expect(scan.candidates).toEqual([
      {
        targetName: "Carolyn Wilmes Orr",
        targetUrl: "https://www.linkedin.com/in/carolyn-wilmes-orr/",
        headline: "Senior Software Engineering Recruiter",
      },
      {
        targetName: "Taylor Recruiter",
        targetUrl: "https://www.linkedin.com/in/taylor-recruiter/",
      },
    ]);
    expect(scan.nextPageUrl).toContain("page=2");
    expect(scan.diagnostics).toMatchObject({
      totalCards: 2,
      totalProfileLinks: 2,
      cardsWithConnectSignal: 2,
      acceptedCandidates: 2,
    });
  });

  test("detects connectable candidates when the button label is only in aria-label and the name comes from the profile link", () => {
    const card = new FakeElement();
    card.setAttribute("class", "entity-result");

    const connect = new FakeElement();
    connect.setAttribute("aria-label", "Invite Taylor Recruiter to connect");

    const profileLink = new FakeElement("Taylor Recruiter 2nd");
    profileLink.href = "https://www.linkedin.com/in/taylor-recruiter/?miniProfileUrn=abc";
    profileLink.parentElement = card;

    card.setQuerySelectorAll("button, [role='button']", [connect]);
    card.setQuerySelector("a[href*='/in/']", profileLink);
    card.setQuerySelector(
      ".entity-result__title-text a span[aria-hidden='true'], .entity-result__title-line a span[aria-hidden='true']",
      null
    );
    card.setQuerySelector("a[href*='/in/']", profileLink);

    (globalThis as any).document.querySelectorAll = (selector: string) => {
      if (
        selector ===
        "[data-chameleon-result-urn], .reusable-search__result-container, li.reusable-search__result-container, .entity-result"
      ) {
        return [card];
      }
      if (selector === "a[href*='/in/']") {
        return [profileLink];
      }
      if (selector === "a[href], button, [role='button']") {
        return [];
      }
      return [];
    };

    const scan = scanLinkedInCandidatesInPage(5);
    expect(scan.candidates).toEqual([
      {
        targetName: "Taylor Recruiter",
        targetUrl: "https://www.linkedin.com/in/taylor-recruiter/",
      },
    ]);
    expect(scan.diagnostics).toMatchObject({
      totalCards: 1,
      totalProfileLinks: 1,
      cardsWithConnectSignal: 1,
      acceptedCandidates: 1,
    });
  });

  test("falls back to visible profile links on LinkedIn search pages when result card selectors do not match", () => {
    (globalThis as any).location = {
      href: "https://www.linkedin.com/search/results/people/?keywords=software%20engineer%20recuiter&origin=SWITCH_SEARCH_VERTICAL",
    };

    const resultContainer = new FakeElement(
      "Gianna Satriano Software Engineering Recruiter Cincinnati, Ohio"
    );
    const profileLink = new FakeElement("Gianna Satriano");
    profileLink.href = "https://www.linkedin.com/in/gianna-satriano-a467a0228/";
    profileLink.parentElement = resultContainer;

    (globalThis as any).document.querySelectorAll = (selector: string) => {
      if (
        selector ===
        "[data-chameleon-result-urn], .reusable-search__result-container, li.reusable-search__result-container, .entity-result"
      ) {
        return [];
      }
      if (selector === "a[href*='/in/']") {
        return [profileLink];
      }
      if (selector === "a[href], button, [role='button']") {
        return [];
      }
      return [];
    };

    const scan = scanLinkedInCandidatesInPage(5);
    expect(scan.candidates).toEqual([
      {
        targetName: "Gianna Satriano",
        targetUrl: "https://www.linkedin.com/in/gianna-satriano-a467a0228/",
        headline: "Software Engineering Recruiter Cincinnati, Ohio",
      },
    ]);
    expect(scan.diagnostics).toMatchObject({
      totalCards: 1,
      totalProfileLinks: 1,
      acceptedCandidates: 1,
    });
  });
});
