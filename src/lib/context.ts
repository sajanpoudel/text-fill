// Page context extractor — orchestrates DOM walking + platform-specific extraction.
// Imports from platform.ts (field utils) and platforms/index.ts, not the reverse.

import { getPlatformExtractor } from "./platforms/index.ts";
import { EMPTY_CONTEXT } from "./platforms/base.ts";
import { findContextBoundary, extractDomContext } from "./dom/walker.ts";
import { detectPlatformKey, getLocationSnapshot } from "./platform.ts";
import type { PlatformKey } from "./platform.ts";

const MAX_CONTEXT_CHARS = 6000;
const MAX_DOM_CHARS = 3000;

function buildContextString(parts: Array<string | null | undefined>): string {
  return parts
    .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    .join("\n\n")
    .slice(0, MAX_CONTEXT_CHARS);
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
  } = extractor?.extractFieldContext(field, dialogRoot, composeBoundary) ?? EMPTY_CONTEXT;

  // 2. Generic DOM context — semantic graph walk from the compose boundary
  const domContext = extractDomContext(composeBoundary, MAX_DOM_CHARS);

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
    domContext ? `Page context:\n${domContext}` : null,
  ]);

  // Debug: log what the LLM will receive as context
  console.debug(
    `[TFA Context] platform=${platform} field=${(field as HTMLElement).tagName?.toLowerCase()}`,
    `\n--- context (${result.length} chars) ---\n${result || "(empty)"}\n---`
  );

  return result;
}
