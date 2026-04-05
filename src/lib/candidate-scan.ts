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
    const text = normalizeText(el.textContent).toLowerCase();
    if (text !== "connect" && !text.startsWith("connect ")) return false;
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
      .replace(/['’]s profile$/i, "")
      .trim();
    if (!normalized || !/[A-Za-z]/.test(normalized)) return null;
    const wordCount = normalized.split(/\s+/).length;
    if (wordCount < 2 || wordCount > 6) return null;
    return normalized;
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
  const cards = Array.from(
    document.querySelectorAll<HTMLElement>(
      "[data-chameleon-result-urn], .reusable-search__result-container, li.reusable-search__result-container"
    )
  );

  for (const card of cards) {
    const connectButton = Array.from(
      card.querySelectorAll<HTMLElement>("button, [role='button']")
    ).find((button) => isEnabledConnectButton(button));
    if (!connectButton) continue;

    const profileLink = card.querySelector<HTMLAnchorElement>("a[href*='/in/']");
    const targetUrl = profileLink?.href ? cleanProfileUrl(profileLink.href) : null;
    if (!targetUrl || seenUrls.has(targetUrl)) continue;

    const nameNode =
      card.querySelector<HTMLElement>(
        ".entity-result__title-text a span[aria-hidden='true'], .entity-result__title-line a span[aria-hidden='true']"
      ) ??
      card.querySelector<HTMLElement>(
        "a[href*='/in/'] span[aria-hidden='true'], .app-aware-link span[aria-hidden='true']"
      );
    const targetName = cleanName(nameNode?.innerText ?? nameNode?.textContent ?? "");
    if (!targetName) continue;

    const headlineNode = card.querySelector<HTMLElement>(
      ".entity-result__primary-subtitle, .entity-result__summary"
    );
    const headline = normalizeText(
      headlineNode?.innerText ?? headlineNode?.textContent ?? ""
    );

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

  return {
    platform: "linkedin",
    pageType: "people_search",
    candidates,
    nextPageUrl: findNextPageUrl(),
  };
}
