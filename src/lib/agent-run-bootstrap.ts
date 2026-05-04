import { extractCleanText } from "./dom/walker.ts";
import { scanLinkedInCandidatesInPage } from "./candidate-scan.ts";
import type { PlatformKey } from "./platform.ts";
import type {
  LocalCompanionBrowserWorkItem,
  LocalCompanionCandidateScanItem,
  LocalCompanionStructuredExtraction,
} from "./local-agent-protocol.ts";

export type AgentRunBootstrapContext = {
  pageUrl: string;
  pageContext?: string;
  scannedCandidates?: LocalCompanionCandidateScanItem[];
  workItems?: LocalCompanionBrowserWorkItem[];
  nextPageUrl?: string | null;
  structured?: LocalCompanionStructuredExtraction | null;
};

function buildGenericPageContext(): string | undefined {
  const mainRoot =
    document.querySelector<HTMLElement>("main, article, [role='main']") ??
    document.body;
  const visibleText = extractCleanText(mainRoot, 1800).trim();
  const parts = [
    document.title?.trim() ? `Page: ${document.title.trim()}` : null,
    location.href ? `URL: ${location.href}` : null,
    visibleText ? `Visible context:\n${visibleText}` : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function buildLinkedInProfileStructuredExtraction():
  | LocalCompanionStructuredExtraction
  | null {
  const mainRoot =
    document.querySelector<HTMLElement>("main") ?? document.body;
  const title =
    mainRoot.querySelector<HTMLElement>("h1")?.innerText?.trim() ??
    "";
  const headline =
    mainRoot.querySelector<HTMLElement>(
      ".text-body-medium, .text-body-large, h2"
    )?.innerText?.trim() ?? "";
  const summary = extractCleanText(mainRoot, 1400).trim();

  if (!title && !headline && !summary) {
    return null;
  }

  return {
    data: {
      ...(title ? { title, name: title } : {}),
      ...(headline ? { headline } : {}),
      ...(summary ? { summary } : {}),
    },
    ...(title ? { headings: [title] } : {}),
    ...(summary ? { text: summary } : {}),
  };
}

function buildGenericWorkItems(maxResults = 8): LocalCompanionBrowserWorkItem[] | undefined {
  const mainRoot =
    document.querySelector<HTMLElement>("main, article, [role='main']") ??
    document.body;
  if (!mainRoot) return undefined;

  const currentUrl = location.href;
  const seenUrls = new Set<string>();
  const items: LocalCompanionBrowserWorkItem[] = [];

  const anchors = Array.from(mainRoot.querySelectorAll<HTMLAnchorElement>("a[href]"));
  for (const anchor of anchors) {
    if (items.length >= maxResults) break;
    const href = anchor.getAttribute("href");
    if (!href) continue;

    let targetUrl: string;
    try {
      const parsed = new URL(href, location.href);
      if (!/^https?:$/i.test(parsed.protocol)) continue;
      parsed.hash = "";
      targetUrl = parsed.toString();
    } catch {
      continue;
    }

    if (targetUrl === currentUrl || seenUrls.has(targetUrl)) continue;
    if (
      anchor.closest("header, nav, footer, aside, [role='navigation'], [role='banner'], [role='contentinfo']")
    ) {
      continue;
    }

    const rect = anchor.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const text = (anchor.innerText || anchor.textContent || "").replace(/\s+/g, " ").trim();
    if (text.length < 4 || text.length > 140) continue;
    if (/^(home|about|settings|help|privacy|terms|log out|logout)$/i.test(text)) {
      continue;
    }

    const container =
      anchor.closest<HTMLElement>("article, li, tr, [role='listitem'], section") ??
      anchor.parentElement;
    const containerText =
      container && container !== mainRoot
        ? extractCleanText(container, 600).trim()
        : "";

    if (!containerText || containerText.length < 20) {
      continue;
    }

    seenUrls.add(targetUrl);
    items.push({
      title: `Handle ${text}`,
      pageUrl: targetUrl,
      targetUrl,
      targetName: text,
      itemContext: containerText,
      sourceType: "page_link",
    });
  }

  const likelyListPage = /search|results|jobs|people|directory|list|find/i.test(
    `${document.title ?? ""} ${location.href}`
  );
  if (items.length >= 3) {
    return items;
  }
  return likelyListPage && items.length > 1 ? items : undefined;
}

export function buildAgentRunBootstrapContext(
  platform: PlatformKey
): AgentRunBootstrapContext {
  const pageUrl = location.href;
  const pageContext = buildGenericPageContext();

  if (
    platform === "linkedin" &&
    /linkedin\.com\/search\/results\/people/i.test(pageUrl)
  ) {
    const scan = scanLinkedInCandidatesInPage(20);
    const workItems =
      scan.candidates.length > 1
        ? scan.candidates.map((candidate) => ({
            title: `Handle ${candidate.targetName}`,
            pageUrl: candidate.targetUrl,
            targetUrl: candidate.targetUrl,
            targetName: candidate.targetName,
            itemContext: [
              `Target: ${candidate.targetName}`,
              ...(candidate.headline ? [`Headline: ${candidate.headline}`] : []),
              `Target URL: ${candidate.targetUrl}`,
            ].join("\n"),
            sourceType: "scanned_candidate",
          }))
        : undefined;
    return {
      pageUrl,
      pageContext,
      scannedCandidates: scan.candidates,
      workItems,
      nextPageUrl: scan.nextPageUrl,
    };
  }

  if (platform === "linkedin" && /linkedin\.com\/in\//i.test(pageUrl)) {
    return {
      pageUrl,
      pageContext,
      structured: buildLinkedInProfileStructuredExtraction(),
    };
  }

  return {
    pageUrl,
    pageContext,
    workItems: buildGenericWorkItems(),
  };
}
