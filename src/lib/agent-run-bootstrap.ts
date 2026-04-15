import { extractCleanText } from "./dom/walker.ts";
import { scanLinkedInCandidatesInPage } from "./candidate-scan.ts";
import type { PlatformKey } from "./platform.ts";
import type {
  LocalCompanionCandidateScanItem,
  LocalCompanionStructuredExtraction,
} from "./local-agent-protocol.ts";

export type AgentRunBootstrapContext = {
  pageUrl: string;
  pageContext?: string;
  scannedCandidates?: LocalCompanionCandidateScanItem[];
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
    return {
      pageUrl,
      pageContext,
      scannedCandidates: scan.candidates,
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
  };
}
