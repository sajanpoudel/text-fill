// Page context extractor — orchestrates DOM walking + platform-specific extraction.
// Imports from platform.ts (field utils) and platforms/index.ts, not the reverse.

import { getPlatformExtractor } from "./platforms/index.ts";
import { EMPTY_CONTEXT } from "./platforms/base.ts";
import {
  findContextBoundary,
  extractDomContext,
  extractCleanText,
  normalizeText,
} from "./dom/walker.ts";
import { detectPlatformKey, getLocationSnapshot } from "./platform.ts";
import type { PlatformKey } from "./platform.ts";

const MAX_CONTEXT_CHARS = 6000;
const MAX_DOM_CHARS = 3000;
const MAX_BACKGROUND_CHARS = 1800;

function buildContextString(parts: Array<string | null | undefined>): string {
  return parts
    .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    .join("\n\n")
    .slice(0, MAX_CONTEXT_CHARS);
}

function dedupeContext(
  reference: string | null | undefined,
  candidate: string | null | undefined
): string | null {
  if (!candidate?.trim()) return null;
  if (!reference?.trim()) return candidate;

  const normalizedReference = normalizeText(reference);
  const normalizedCandidate = normalizeText(candidate);
  if (!normalizedReference || !normalizedCandidate) return candidate;
  if (normalizedCandidate === normalizedReference) return null;

  const probe =
    normalizedReference.length > 120
      ? normalizedReference.slice(0, 120)
      : normalizedReference;

  return probe && normalizedCandidate.includes(probe) ? null : candidate;
}

export function extractAudienceNameFromContext(
  context: string | undefined
): string | undefined {
  if (!context) return undefined;
  const match = context.match(/^Audience:\s*(.+)$/m);
  if (!match?.[1]) return undefined;
  return match[1].split(/\s+—\s+/)[0].trim() || undefined;
}

/**
 * Generic recipient detection for platforms without a dedicated extractor.
 * Uses ARIA attributes and semantic HTML only — no CSS class names.
 */
function detectGenericRecipient(boundary: Element): string | null {
  // Prefer explicit recipient inputs
  for (const sel of [
    '[aria-label*="To" i]',
    '[aria-label*="recipient" i]',
    '[placeholder*="recipient" i]',
  ]) {
    const el = boundary.querySelector<HTMLInputElement>(sel);
    if (el?.value?.trim()) return el.value.trim();
  }

  // Fall back to the most prominent visible heading near the field
  for (const tag of ["h1", "h2", "h3", "[role='heading']"]) {
    const headings = Array.from(boundary.querySelectorAll<HTMLElement>(tag));
    for (const h of headings) {
      const text = h.innerText?.replace(/\s+/g, " ").trim() ?? "";
      if (text.length > 2 && text.length < 80) return text;
    }
  }

  return null;
}

/**
 * Extracts a structured page context string for the given field.
 *
 * Architecture (in order of priority):
 *  1. Platform extractor (if registered) → typed field context
 *     (field type tag, recipient name/role, LinkedIn profile sections)
 *  2. Generic DOM tree walker → structural page context
 *     (dialog structure, form labels, nearby text — no fixed CSS selectors)
 *  3. Both combined into a labeled block for the LLM.
 */
export function extractPageContext(field: Element): string {
  const { hostname, href: url, title: rawTitle } = getLocationSnapshot();
  const title = rawTitle?.trim() ?? "";
  const platform = detectPlatformKey(hostname) as PlatformKey;

  const dialogRoot = field.closest<HTMLElement>("dialog, [role='dialog']") ?? null;

  // 1. Platform extractor (provides field type + recipient + profile)
  const extractor = getPlatformExtractor(platform);
  const composeBoundary = extractor?.getComposeBoundary?.(field) ?? findContextBoundary(field);

  const {
    fieldType,
    recipientName,
    recipientRole,
    profileContext,
    extraContext,
  } = extractor?.extractFieldContext(field, dialogRoot, composeBoundary) ?? EMPTY_CONTEXT;

  // 2. Generic DOM context — semantic graph walk from the tight compose boundary
  const domContext = extractDomContext(composeBoundary, MAX_DOM_CHARS);
  const mainRoot =
    document.querySelector<HTMLElement>("main, article, [role='main']") ??
    composeBoundary;
  const backgroundContext =
    mainRoot !== composeBoundary
      ? extractCleanText(mainRoot, MAX_BACKGROUND_CHARS)
      : null;

  // 3. Generic recipient fallback (for platforms with no extractor)
  const recipient =
    recipientName ??
    (!extractor ? detectGenericRecipient(composeBoundary) : null);

  // 4. Assemble the context string
  const audienceLine = recipient
    ? `Audience: ${recipient}${recipientRole ? ` — ${recipientRole}` : ""}`
    : null;

  const result = buildContextString([
    fieldType,
    title ? `Page: ${title}` : null,
    url ? `URL: ${url}` : null,
    audienceLine,
    profileContext ? `Profile context:\n${profileContext}` : null,
    domContext ? `Foreground context:\n${domContext}` : null,
    dedupeContext(domContext, extraContext)
      ? `Thread context:\n${dedupeContext(domContext, extraContext)}`
      : null,
    dedupeContext(
      [domContext, extraContext].filter(Boolean).join("\n\n"),
      backgroundContext
    )
      ? `Background context:\n${dedupeContext(
          [domContext, extraContext].filter(Boolean).join("\n\n"),
          backgroundContext
        )}`
      : null,
  ]);

  // Debug: log what the LLM will receive as context
  console.debug(
    `[TFA Context] platform=${platform} field=${(field as HTMLElement).tagName?.toLowerCase()}`,
    `\n--- context (${result.length} chars) ---\n${result || "(empty)"}\n---`
  );

  return result;
}
