// Job board platform extractor — Greenhouse, Ashby, Workday, Lever.
// Extracts job title, company, and job description to give the LLM
// the context it needs to write cover letters and application answers.

import type { FieldContext, PlatformExtractor } from "./base.ts";
import { extractSectionText } from "../dom/walker.ts";

// ── Job context extraction ────────────────────────────────────────────────────

function extractJobTitle(): string | null {
  // Schema.org markup is the most reliable
  const schemaEl = document.querySelector<HTMLElement>(
    '[itemtype*="JobPosting"] [itemprop="title"]'
  );
  if (schemaEl?.innerText?.trim()) return schemaEl.innerText.trim();

  // Open Graph
  const ogTitle = document.querySelector<HTMLMetaElement>(
    'meta[property="og:title"]'
  )?.content?.trim();
  if (ogTitle && ogTitle.length < 120 && !ogTitle.toLowerCase().includes("careers at")) {
    return ogTitle;
  }

  // Common job-posting page heading selectors (ARIA + semantic, no fragile class names)
  for (const sel of [
    'h1[itemprop="title"]',
    'h1[data-testid*="job-title"]',
    'h1[data-testid*="jobTitle"]',
    'h2[itemprop="title"]',
  ]) {
    const el = document.querySelector<HTMLElement>(sel);
    const text = el?.innerText?.trim() ?? "";
    if (text && text.length < 120) return text;
  }

  // Parse "Job Application for {Title} at {Company}" page titles (Greenhouse)
  const titleMatch = document.title.match(
    /^(?:job application for\s+)?(.+?)\s+(?:at|@)\s+.+$/i
  );
  if (titleMatch?.[1] && titleMatch[1].length < 100) return titleMatch[1].trim();

  // Last resort: first h1 on the page that is short enough to be a title
  const h1Text = document.querySelector<HTMLElement>("h1")?.innerText?.trim() ?? "";
  if (h1Text && h1Text.length < 120) return h1Text;

  return null;
}

function extractCompanyName(): string | null {
  // Schema.org
  const schemaEl = document.querySelector<HTMLElement>(
    '[itemtype*="JobPosting"] [itemprop="hiringOrganization"] [itemprop="name"]'
  );
  if (schemaEl?.innerText?.trim()) return schemaEl.innerText.trim();

  // Open Graph site name
  const ogSite = document.querySelector<HTMLMetaElement>(
    'meta[property="og:site_name"]'
  )?.content?.trim();
  if (ogSite && ogSite.length < 80) return ogSite;

  // Parse "Job Application for {Title} at {Company}" (Greenhouse / Lever)
  const atMatch = document.title.match(
    /\bat\s+([^|–—\n]+?)(?:\s*[|–—]|$)/i
  );
  if (atMatch?.[1]) return atMatch[1].trim();

  // Parse "{Company} Careers" or "{Company} | {Role}" from page title
  const pipeParts = document.title.split(/\s*[|–—]\s*/);
  if (pipeParts.length >= 2) {
    // Last segment is often the company name
    const candidate = pipeParts[pipeParts.length - 1].trim();
    if (candidate.length > 1 && candidate.length < 80) return candidate;
  }

  return null;
}

const JOB_DESCRIPTION_SELECTORS = [
  '[itemprop="description"]',
  '[data-testid*="job-description"]',
  '[data-testid*="jobDescription"]',
  '[aria-label*="job description" i]',
  '#job-description',
  '#jobDescription',
] as const;

function extractJobDescription(): string | null {
  // Schema.org
  const schemaEl = document.querySelector<HTMLElement>(
    '[itemtype*="JobPosting"] [itemprop="description"]'
  );
  if (schemaEl) {
    const text = extractSectionText(schemaEl, 1200);
    if (text && text.length > 80) return text;
  }

  for (const sel of JOB_DESCRIPTION_SELECTORS) {
    const el = document.querySelector<HTMLElement>(sel);
    if (!el) continue;
    const text = extractSectionText(el, 1200);
    if (text && text.length > 80) return text;
  }

  return null;
}

// ── Application field type detection ─────────────────────────────────────────

function detectApplicationFieldType(field: Element): string | null {
  const el = field as HTMLElement;

  // Collect all label signals for this field
  const signals: string[] = [
    el.getAttribute("aria-label") ?? "",
    el.getAttribute("placeholder") ?? "",
    el.getAttribute("name") ?? "",
    el.getAttribute("id") ?? "",
  ];

  const id = el.id;
  if (id) {
    try {
      const labelEl = document.querySelector<HTMLElement>(
        `label[for="${CSS.escape(id)}"]`
      );
      if (labelEl) signals.push(labelEl.innerText ?? "");
    } catch { /* invalid id */ }
  }

  // Walk up to the nearest form group / question container for a header
  const container = el.closest(
    "fieldset, [role='group'], li, .field, .form-group, .question"
  );
  if (container) {
    const heading = container.querySelector<HTMLElement>(
      "legend, label, h3, h4, [role='heading']"
    );
    if (heading) signals.push(heading.innerText ?? "");
  }

  const combined = signals.join(" ").toLowerCase();

  if (combined.includes("cover letter") || combined.includes("coverletter")) {
    return "[COVER_LETTER]";
  }
  if (
    (combined.includes("why") && (
      combined.includes("company") ||
      combined.includes("role") ||
      combined.includes("position") ||
      combined.includes("want") ||
      combined.includes("interest")
    ))
  ) {
    return "[WHY_INTERESTED]";
  }
  if (combined.includes("experience") || combined.includes("background")) {
    return "[EXPERIENCE]";
  }
  if (combined.includes("strength") || combined.includes("skill")) {
    return "[SKILLS]";
  }
  if (
    combined.includes("additional") ||
    combined.includes("anything else") ||
    combined.includes("other info")
  ) {
    return "[ADDITIONAL_INFO]";
  }

  return null;
}

// ── Extractor factory ─────────────────────────────────────────────────────────

function makeJobBoardExtractor(platformKey: string): PlatformExtractor {
  return {
    key: platformKey,

    extractFieldContext(field, _dialogRoot, _composeBoundary): FieldContext {
      const jobTitle = extractJobTitle();
      const company = extractCompanyName();
      const jobDescription = extractJobDescription();
      const fieldType = detectApplicationFieldType(field);

      const profileParts: string[] = [];
      if (jobTitle) profileParts.push(`Job title: ${jobTitle}`);
      if (company) profileParts.push(`Company: ${company}`);
      if (jobDescription) profileParts.push(`Job description:\n${jobDescription}`);

      return {
        fieldType,
        recipientName: company ?? null,
        recipientRole: jobTitle ?? null,
        profileContext: profileParts.length > 0 ? profileParts.join("\n\n") : null,
        charLimit: null,
      };
    },
  };
}

export const greenhouseExtractor = makeJobBoardExtractor("greenhouse");
export const ashbyExtractor = makeJobBoardExtractor("ashby");
export const workdayExtractor = makeJobBoardExtractor("workday");
export const leverExtractor = makeJobBoardExtractor("lever");
