export type CandidateScanItem = {
  targetName: string;
  targetUrl: string;
  headline?: string;
};

export type CandidateScanResult = {
  platform: "linkedin";
  pageType: "people_search";
  candidates: CandidateScanItem[];
  nextPageUrl: string | null;
  diagnostics?: {
    totalCards: number;
    totalProfileLinks: number;
    cardsWithConnectSignal: number;
    acceptedCandidates: number;
  };
};

export function scanLinkedInCandidatesInPage(
  maxResults = 20
): CandidateScanResult {
  function normalizeText(value: string | null | undefined): string {
    return (value ?? "").replace(/\s+/g, " ").trim();
  }

  function isVisibleElement(el: Element | null): el is HTMLElement {
    if (!(el instanceof HTMLElement)) return false;
    const style = window.getComputedStyle(el);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.opacity === "0"
    ) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isEnabledConnectButton(el: HTMLElement): boolean {
    if (!isVisibleElement(el)) return false;
    const text = (
      normalizeText(el.textContent) ||
      normalizeText(el.getAttribute("aria-label")) ||
      normalizeText(el.getAttribute("title"))
    ).toLowerCase();
    if (
      !text.includes("connect") ||
      text.includes("pending") ||
      text.includes("message") ||
      text.includes("follow")
    ) {
      return false;
    }
    return !(
      el.hasAttribute("disabled") ||
      el.getAttribute("aria-disabled") === "true"
    );
  }

  function cleanProfileUrl(rawUrl: string): string | null {
    try {
      const parsed = new URL(rawUrl, location.href);
      if (!/(\.|^)linkedin\.com$/i.test(parsed.hostname)) return null;
      if (!/^\/in\/[^/?#]+\/?$/i.test(parsed.pathname)) return null;
      parsed.search = "";
      parsed.hash = "";
      return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}/`;
    } catch {
      return null;
    }
  }

  function cleanName(rawName: string): string | null {
    const normalized = normalizeText(rawName)
      .split(/\s*[|·•]\s*/)[0]
      .replace(/^view\s+/i, "")
      .replace(/^connect with\s+/i, "")
      .replace(/['’]s profile$/i, "")
      .replace(/\s+1st$/i, "")
      .replace(/\s+2nd$/i, "")
      .replace(/\s+3rd$/i, "")
      .replace(/\s+\d+(?:st|nd|rd|th)$/i, "")
      .trim();
    if (!normalized || !/[A-Za-z]/.test(normalized)) return null;
    const wordCount = normalized.split(/\s+/).length;
    if (wordCount < 2 || wordCount > 6) return null;
    return normalized;
  }

  function inferNameFromProfileUrl(profileUrl: string): string | null {
    const normalizedUrl = cleanProfileUrl(profileUrl);
    if (!normalizedUrl) return null;

    try {
      const parsed = new URL(normalizedUrl);
      const match = parsed.pathname.match(/^\/in\/([^/?#]+)\/?$/i);
      if (!match?.[1]) return null;

      const tokens = match[1]
        .split("-")
        .map((token) => token.trim())
        .filter(Boolean)
        .filter((token, index, all) => {
          if (index < all.length - 1) return true;
          return !/\d/.test(token);
        })
        .map((token) => token.replace(/[^a-z]/gi, ""))
        .filter(Boolean);

      if (tokens.length < 2) return null;

      return cleanName(
        tokens
          .slice(0, 4)
          .map((token) => token.charAt(0).toUpperCase() + token.slice(1).toLowerCase())
          .join(" ")
      );
    } catch {
      return null;
    }
  }

  function extractCardProfileName(
    card: HTMLElement,
    profileLink: HTMLAnchorElement | null
  ): string | null {
    const selectorCandidates = [
      ".entity-result__title-text a span[aria-hidden='true'], .entity-result__title-line a span[aria-hidden='true']",
      "a[href*='/in/'] span[aria-hidden='true'], .app-aware-link span[aria-hidden='true']",
      ".entity-result__title-text a, .entity-result__title-line a",
      ".linked-area a[href*='/in/']",
      "a[href*='/in/']",
    ];

    for (const selector of selectorCandidates) {
      const node = card.querySelector<HTMLElement>(selector);
      const cleaned = cleanName(node?.innerText ?? node?.textContent ?? "");
      if (cleaned) return cleaned;
    }

    const linkDerived = cleanName(
      profileLink?.innerText ??
        profileLink?.textContent ??
        profileLink?.getAttribute("aria-label") ??
        profileLink?.getAttribute("title") ??
        ""
    );
    if (linkDerived) return linkDerived;

    return null;
  }

  function isLikelySearchResultCard(
    card: HTMLElement,
    profileLink: HTMLAnchorElement,
    headline: string | null,
    hasConnectSignal: boolean
  ): boolean {
    const classHint = normalizeText(card.getAttribute("class")).toLowerCase();
    const dataUrn = normalizeText(card.getAttribute("data-chameleon-result-urn"));
    if (
      dataUrn ||
      classHint.includes("entity-result") ||
      classHint.includes("reusable-search")
    ) {
      return true;
    }

    const cardText = normalizeText(card.innerText || card.textContent);
    const linkText = normalizeText(
      profileLink.innerText ||
        profileLink.textContent ||
        profileLink.getAttribute("aria-label") ||
        profileLink.getAttribute("title")
    );

    if (hasConnectSignal) {
      return true;
    }

    if (headline && cardText.length >= linkText.length + headline.length) {
      return true;
    }

    return cardText.length >= Math.max(60, linkText.length + 20);
  }

  function collectCandidateCards(): HTMLElement[] {
    const directCards = Array.from(
      document.querySelectorAll<HTMLElement>(
        "[data-chameleon-result-urn], .reusable-search__result-container, li.reusable-search__result-container, .entity-result"
      )
    );

    const derivedCards = Array.from(
      document.querySelectorAll<HTMLAnchorElement>("a[href*='/in/']")
    )
      .map((link) =>
        link.closest<HTMLElement>(
          "[data-chameleon-result-urn], .reusable-search__result-container, li.reusable-search__result-container, .entity-result, li, article"
        )
      )
      .filter((card): card is HTMLElement => !!card);

    const merged: HTMLElement[] = [];
    const seen = new Set<HTMLElement>();
    for (const card of [...directCards, ...derivedCards]) {
      if (seen.has(card)) continue;
      seen.add(card);
      merged.push(card);
    }
    return merged;
  }

  function isIgnoredProfileLink(link: HTMLAnchorElement): boolean {
    const ignoredAncestor = link.closest<HTMLElement>(
      "header, nav, aside, footer, [role='navigation'], [role='banner'], [role='contentinfo']"
    );
    if (ignoredAncestor) return true;
    return false;
  }

  function deriveHeadlineFromContainer(
    container: HTMLElement | null,
    targetName: string
  ): string | null {
    if (!container) return null;
    const explicitHeadline = normalizeText(
      container.querySelector<HTMLElement>(
        ".entity-result__primary-subtitle, .entity-result__summary, .t-14, .t-12"
      )?.innerText ??
        container.querySelector<HTMLElement>(
          ".entity-result__primary-subtitle, .entity-result__summary, .t-14, .t-12"
        )?.textContent ??
        ""
    );
    if (explicitHeadline) return explicitHeadline;

    const text = normalizeText(container.innerText || container.textContent || "");
    if (!text) return null;
    const stripped = normalizeText(
      text.replace(targetName, "").replace(/\s+/g, " ")
    );
    if (!stripped || stripped.length < 12) return null;
    return stripped.slice(0, 160);
  }

  function findNextPageUrl(): string | null {
    const currentUrl = (() => {
      try {
        return new URL(location.href);
      } catch {
        return null;
      }
    })();

    const controls = Array.from(
      document.querySelectorAll<HTMLElement>("a[href], button, [role='button']")
    );

    for (const control of controls) {
      if (!isVisibleElement(control)) continue;
      const label = (
        normalizeText(control.textContent) ||
        normalizeText(control.getAttribute("aria-label"))
      ).toLowerCase();
      if (label !== "next" && label !== "next page") continue;

      const href =
        control.getAttribute("href") ||
        (control as HTMLElement & { href?: string }).href ||
        "";
      const nextUrl = cleanSearchResultsUrl(href);
      if (!nextUrl) continue;
      if (currentUrl && nextUrl === currentUrl.toString()) continue;
      return nextUrl;
    }

    return null;
  }

  function cleanSearchResultsUrl(rawUrl: string): string | null {
    try {
      const parsed = new URL(rawUrl, location.href);
      if (!/(\.|^)linkedin\.com$/i.test(parsed.hostname)) return null;
      if (!/^\/search\/results\/people\/?$/i.test(parsed.pathname)) return null;
      parsed.hash = "";
      return parsed.toString();
    } catch {
      return null;
    }
  }

  const candidates: CandidateScanItem[] = [];
  const seenUrls = new Set<string>();
  const limit = Math.max(1, Math.min(50, Math.round(maxResults)));
  const cards = collectCandidateCards();
  const profileLinks = Array.from(
    document.querySelectorAll<HTMLAnchorElement>("a[href*='/in/']")
  );
  let cardsWithConnectSignal = 0;

  for (const card of cards) {
    const connectButton = Array.from(
      card.querySelectorAll<HTMLElement>("button, [role='button']")
    ).find((button) => isEnabledConnectButton(button));
    if (connectButton) {
      cardsWithConnectSignal += 1;
    }

    const profileLink = card.querySelector<HTMLAnchorElement>("a[href*='/in/']");
    const targetUrl = profileLink?.href ? cleanProfileUrl(profileLink.href) : null;
    if (!targetUrl || seenUrls.has(targetUrl)) continue;

    const targetName = extractCardProfileName(card, profileLink);
    if (!targetName) continue;

    const headlineNode = card.querySelector<HTMLElement>(
      ".entity-result__primary-subtitle, .entity-result__summary"
    );
    const headline = normalizeText(
      headlineNode?.innerText ?? headlineNode?.textContent ?? ""
    );
    if (
      !profileLink ||
      !isLikelySearchResultCard(card, profileLink, headline || null, !!connectButton)
    ) {
      continue;
    }

    seenUrls.add(targetUrl);
    candidates.push({
      targetName,
      targetUrl,
      ...(headline ? { headline } : {}),
    });

    if (candidates.length >= limit) {
      break;
    }
  }

  if (candidates.length < limit) {
    for (const profileLink of profileLinks) {
      if (!isVisibleElement(profileLink) || isIgnoredProfileLink(profileLink)) {
        continue;
      }

      const targetUrl = profileLink.href ? cleanProfileUrl(profileLink.href) : null;
      if (!targetUrl || seenUrls.has(targetUrl)) continue;

      const targetName =
        cleanName(
          profileLink.innerText ??
            profileLink.textContent ??
            profileLink.getAttribute("aria-label") ??
            profileLink.getAttribute("title") ??
            ""
        ) ?? inferNameFromProfileUrl(targetUrl);
      if (!targetName) continue;

      const container = profileLink.closest<HTMLElement>(
        "[data-chameleon-result-urn], .reusable-search__result-container, li, article, main div"
      );
      const surroundingText = normalizeText(
        container?.innerText ?? container?.textContent ?? ""
      );
      if (surroundingText && surroundingText.length < Math.max(40, targetName.length + 12)) {
        continue;
      }

      seenUrls.add(targetUrl);
      const headline = deriveHeadlineFromContainer(container, targetName);
      candidates.push({
        targetName,
        targetUrl,
        ...(headline ? { headline } : {}),
      });

      if (candidates.length >= limit) {
        break;
      }
    }
  }

  const result: CandidateScanResult = {
    platform: "linkedin",
    pageType: "people_search",
    candidates,
    nextPageUrl: findNextPageUrl(),
    diagnostics: {
      totalCards: cards.length,
      totalProfileLinks: profileLinks.length,
      cardsWithConnectSignal,
      acceptedCandidates: candidates.length,
    },
  };
  try {
    console.debug("[TFA Scan] linkedin_candidate_scan", result);
  } catch {
    // no-op
  }
  return result;
}
