// LinkedIn-specific context extractor.
// CSS class selectors for LinkedIn are isolated to this file.
// The generic dom/walker.ts remains class-name-free.

import type { FieldContext, PlatformExtractor } from "./base.ts";
import {
  extractCleanText,
  extractSectionText,
  normalizeText,
} from "../dom/walker.ts";

// ── Compose boundary ──────────────────────────────────────────────────────────

function getComposeBoundary(field: Element): Element {
  return (
    field.closest(".msg-overlay-conversation-bubble--is-active") ??
    field.closest(".msg-overlay-conversation-bubble") ??
    field.closest(".msg-thread") ??
    field.closest(".msg-conversation-card") ??
    field.closest(".msg-form__container") ??
    field.closest('[role="dialog"]') ??
    field.closest(".share-creation-state") ??
    field.closest(".comments-comment-box") ??
    field.closest(".feed-shared-update-v2__comments-container") ??
    field.closest("form") ??
    field.parentElement ??
    field
  );
}

// ── Field type detection ──────────────────────────────────────────────────────

function detectFieldType(field: Element): string | null {
  const el = field as HTMLElement;
  const labelText = [
    el.getAttribute?.("aria-label") ?? "",
    el.getAttribute?.("data-placeholder") ?? "",
    el.getAttribute?.("placeholder") ?? "",
  ].join(" ").toLowerCase();

  const dialog = field.closest('[role="dialog"]');

  if (
    el.matches?.("textarea.connect-button-send-invite__custom-message") ||
    (el.getAttribute?.("name") === "message" && dialog)
  ) return "[CONNECTION_NOTE_300]";

  if (el.getAttribute?.("name") === "subject" && dialog) return "[INMAIL_SUBJECT]";

  if (dialog?.querySelector('input[name="subject"]')) return "[INMAIL_MESSAGE]";

  if (
    el.matches?.(".msg-form__contenteditable") ||
    field.closest(".msg-form__msg-content-container") ||
    field.closest(".msg-thread, .msg-overlay-conversation-bubble, .msg-conversation-card")
  ) return "[DM_MESSAGE]";

  if (
    field.closest(".comments-comment-box") ||
    field.closest("[class*='comments-comment']") ||
    field.closest(".feed-shared-update-v2__comments-container")
  ) return "[COMMENT]";

  if (labelText.includes("start a post") || field.closest(".share-creation-state")) {
    return "[POST_COMPOSE]";
  }

  return null;
}

// ── Connection note detection ─────────────────────────────────────────────────

function detectConnectionNote(field: Element): boolean {
  const el = field as HTMLElement;

  if (parseInt(el.getAttribute?.("maxlength") ?? "0") === 300) return true;

  const id = el.id;
  if (id) {
    try {
      const label = document.querySelector<HTMLElement>(`label[for="${CSS.escape(id)}"]`);
      if (label) {
        const lt = (label.textContent ?? "").toLowerCase();
        if (lt.includes("300") || lt.includes("personal note") || lt.includes("invitation")) return true;
      }
    } catch { /* invalid id */ }
  }

  const dialog = field.closest('[role="dialog"]');
  if (dialog) {
    const dt = (dialog.textContent ?? "").toLowerCase();
    if (
      dt.includes("add a note to your invitation") ||
      dt.includes("note to your invitation") ||
      (dt.includes("add a note") && dt.includes("invitation")) ||
      /\b\d+\/300\b/.test(dt)
    ) return true;
  }

  let ancestor: Element | null = field.parentElement;
  for (let d = 0; d < 20 && ancestor && ancestor !== document.body; d++) {
    const text = (ancestor.textContent ?? "").toLowerCase();
    if (
      text.length < 3000 && (
        text.includes("add a note to your invitation") ||
        (text.includes("add a note") && text.includes("invitation")) ||
        /\b\d+\/300\b/.test(text)
      )
    ) return true;
    ancestor = ancestor.parentElement;
  }

  return false;
}

// ── Profile extraction ────────────────────────────────────────────────────────

/**
 * Parses the first Experience section entry to determine current role + company.
 * Reads LinkedIn's aria-hidden display spans rather than parsing the headline string
 * (which can contain multiple roles separated by pipes).
 */
function extractCurrentRole(expSection: Element): string | null {
  const firstEntry =
    expSection.querySelector("li.artdeco-list__item") ??
    expSection.querySelector("li.pvs-list__item--line-separated") ??
    expSection.querySelector("li");

  if (!firstEntry) return null;

  // LinkedIn 2024+: aria-hidden spans hold displayed text.
  // Pattern: [0] = title, [1] = "Company · Employment type", [2] = "Date – Present"
  const spans = Array.from(
    firstEntry.querySelectorAll<HTMLElement>("span[aria-hidden='true']")
  )
    .map((s) => s.innerText?.trim() ?? "")
    .filter((s) => s.length > 1 && s.length < 160);

  if (spans.length >= 2) {
    const title = spans[0];
    const company = spans[1].split("·")[0].trim();
    const isCurrent = spans.some((s) => /present/i.test(s));
    if (title && company) {
      return isCurrent ? `${title} at ${company} (current)` : `${title} at ${company}`;
    }
  }

  // Fallback: first two lines of innerText
  const lines = ((firstEntry as HTMLElement).innerText ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 1 && s.length < 120);

  if (lines.length >= 2) {
    const title = lines[0];
    const company = lines[1].split("·")[0].trim();
    if (title && company) return `${title} at ${company}`;
  }

  return null;
}

/**
 * Extracts structured profile text from LinkedIn's named page sections.
 * Section IDs (#about, #experience, etc.) are LinkedIn-specific CSS/HTML artifacts.
 */
function extractProfileSections(name: string, headline: string): string {
  const parts: string[] = [];

  if (name) parts.push(`Name: ${name}`);
  if (headline) parts.push(`Headline: ${headline}`);

  const aboutEl =
    document.querySelector("#about")?.closest("section") ??
    document.querySelector<HTMLElement>("[data-section='summary'], .pv-about-section");
  if (aboutEl) {
    const text = extractSectionText(aboutEl, 700).replace(/^About\s*/i, "").trim();
    if (text) parts.push(`About:\n${text}`);
  }

  const expEl =
    document.querySelector("#experience")?.closest("section") ??
    document.querySelector<HTMLElement>("[data-section='experience'], .experience-section");
  if (expEl) {
    const current = extractCurrentRole(expEl);
    if (current) parts.push(`Current role: ${current}`);
    const expText = extractSectionText(expEl, 600).replace(/^Experience\s*/i, "").trim();
    if (expText) parts.push(`Experience:\n${expText}`);
  }

  const eduEl =
    document.querySelector("#education")?.closest("section") ??
    document.querySelector<HTMLElement>("[data-section='education'], .education-section");
  if (eduEl) {
    const text = extractSectionText(eduEl, 400).replace(/^Education\s*/i, "").trim();
    if (text) parts.push(`Education:\n${text}`);
  }

  const actEl =
    document.querySelector("#recent-activity-top-card") ??
    document.querySelector("#activity")?.closest("section") ??
    document.querySelector<HTMLElement>(".pv-recent-activity-section");
  if (actEl) {
    const text = extractSectionText(actEl, 500)
      .replace(/^(Activity|Recent activity)\s*/i, "").trim();
    if (text) parts.push(`Recent activity:\n${text}`);
  }

  return parts.join("\n\n");
}

function extractTopCardSnapshot(): string {
  const main = document.querySelector<HTMLElement>("main");
  if (!main) return "";

  const firstSection =
    main.querySelector<HTMLElement>("section") ??
    main.firstElementChild;
  if (!firstSection) return "";

  return extractSectionText(firstSection, 650).trim();
}

/**
 * Extracts the profile shown on a LinkedIn /in/ profile page.
 * Name + headline from page headings; sections from named anchors.
 */
function extractPageProfile(): { name: string; headline: string; profileContext: string } | null {
  const profileRoot = document.querySelector<HTMLElement>("main") ?? document.body;
  const jsonLd = extractLinkedInJsonLd();

  const name =
    document.querySelector<HTMLElement>("h1.text-heading-xlarge")?.innerText?.trim() ??
    profileRoot.querySelector<HTMLElement>("h1")?.innerText?.trim() ??
    jsonLd?.name?.trim() ??
    "";

  const headline =
    document.querySelector<HTMLElement>(".text-body-medium.break-words")?.innerText?.trim() ??
    document.querySelector<HTMLElement>("[class*='top-card-layout__headline']")?.innerText?.trim() ??
    jsonLd?.headline?.trim() ??
    "";

  const sectionContext = extractProfileSections(name, headline);
  const topCardSnapshot = extractTopCardSnapshot();
  const profileExtras = [
    jsonLd?.recentPosts?.length
      ? `Recent posts: ${jsonLd.recentPosts.slice(0, 3).join(" | ")}`
      : null,
    topCardSnapshot &&
    !sectionContext.includes(topCardSnapshot.slice(0, 80))
      ? `Visible page snapshot:\n${topCardSnapshot}`
      : null,
  ]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join("\n\n");

  const profileContext = [sectionContext, profileExtras]
    .filter((part) => part.trim().length > 0)
    .join("\n\n");

  if (!name && !headline && !profileContext) return null;

  return {
    name,
    headline,
    profileContext,
  };
}

/**
 * Extracts the recipient's name and headline from inside a connect/InMail dialog.
 * The dialog shows the exact person being connected to — more reliable than the page.
 */
function extractDialogProfile(dialog: Element): { name: string; headline: string } | null {
  const card =
    dialog.querySelector("[class*='entity-lockup']") ??
    dialog.querySelector("[class*='artdeco-entity']") ??
    dialog;

  const nameEl =
    card.querySelector<HTMLElement>("[class*='entity-lockup__title']") ??
    card.querySelector<HTMLElement>("[class*='lockup__title']") ??
    dialog.querySelector<HTMLElement>("h2, h3");

  const headlineEl =
    card.querySelector<HTMLElement>("[class*='entity-lockup__subtitle']") ??
    card.querySelector<HTMLElement>("[class*='lockup__subtitle']") ??
    card.querySelector<HTMLElement>("[class*='headline']");

  const rawName = nameEl?.innerText?.trim() ?? "";
  const name = rawName.replace(/^(Connect with|Invite|Message)\s+/i, "").trim();
  const headline = headlineEl?.innerText?.trim() ?? "";

  return name.length > 1 ? { name, headline } : null;
}

/**
 * Extracts the name of the person being DM'd from the conversation thread header.
 * Only called when no dialog is present (pure DM threads).
 */
function extractDmCounterparty(
  field: Element,
  composeBoundary: Element,
): { name: string; headline?: string } | null {
  const conversationRoot =
    composeBoundary.closest(
      ".msg-overlay-conversation-bubble, .msg-thread, .msg-conversation-card"
    ) ??
    field.closest(
      ".msg-overlay-conversation-bubble, .msg-thread, .msg-conversation-card"
    );

  if (!conversationRoot) return null;

  const headerRoot =
    conversationRoot.querySelector(
      "header, [class*='msg-thread__header'], [class*='conversation-header'], [class*='msg-overlay-conversation-bubble-header']"
    ) ?? conversationRoot;

  const candidates: string[] = [];
  for (const sel of [
    ".msg-thread__link-to-profile",
    "[class*='msg-thread__name']",
    "[class*='participant-name']",
    "a[href*='/in/']",
    "h1", "h2", "h3",
  ]) {
    headerRoot.querySelectorAll<HTMLElement>(sel).forEach((el) => {
      const text = normalizeText(el.innerText || el.textContent || "");
      if (text) candidates.push(text);
    });
  }

  const name = pickPersonName(candidates);
  if (!name) return null;

  const headerText = extractSectionText(headerRoot as HTMLElement, 240);
  const headline = headerText && !headerText.includes(name) ? headerText : undefined;
  return { name, headline };
}

function extractCommentThreadContext(
  field: Element,
  composeBoundary: Element,
): string | null {
  const commentThreadRoot =
    field.closest(
      ".comments-comment-item, [class*='comments-comment-item'], [class*='comments-comment-list__comment-item'], li"
    ) ??
    composeBoundary.closest(
      ".comments-comment-item, [class*='comments-comment-item'], [class*='comments-comment-list__comment-item'], li"
    ) ??
    composeBoundary;

  const feedRoot =
    composeBoundary.closest(
      ".feed-shared-update-v2, [class*='feed-shared-update-v2'], [class*='occludable-update'], article, section, main"
    ) ??
    document.querySelector<HTMLElement>("main, article, [role='main']");

  const threadText = extractCleanText(commentThreadRoot, 900);
  const postText =
    feedRoot && feedRoot !== commentThreadRoot
      ? extractCleanText(feedRoot, 1500)
      : "";

  const parts: string[] = [];
  if (threadText) parts.push(`Active comment thread:\n${threadText}`);

  const normalizedThread = normalizeText(threadText);
  const normalizedPost = normalizeText(postText);
  const threadProbe =
    normalizedThread.length > 120
      ? normalizedThread.slice(0, 120)
      : normalizedThread;
  if (
    normalizedPost &&
    normalizedPost !== normalizedThread &&
    (!threadProbe || !normalizedPost.includes(threadProbe))
  ) {
    parts.push(`Attached post:\n${postText}`);
  }

  return parts.join("\n\n") || null;
}

function pickPersonName(candidates: string[]): string {
  for (const raw of candidates) {
    const text = normalizeText(raw);
    if (!text || text.length < 3 || text.length > 80) continue;
    const lower = text.toLowerCase();
    if (
      ["message", "connect", "follow", "premium", "linkedin", "add a note",
       "write with ai", "cancel", "send"].some((t) => lower === t || lower.includes(t))
    ) continue;
    const words = text.split(/\s+/).filter(Boolean);
    if (
      words.length >= 1 &&
      words.length <= 4 &&
      words.every((w) => /^[A-Z][A-Za-z'.-]+$/.test(w))
    ) return text;
  }
  return "";
}

// ── JSON-LD profile extraction (stable, SEO-published by LinkedIn) ────────────

export interface LinkedInJsonLdProfile {
  name: string;
  headline: string | null;
  url: string | null;
  recentPosts: string[];
}

/**
 * Parses Person + Article nodes from LinkedIn's JSON-LD SEO scripts.
 * More stable than CSS class selectors, which change every quarter.
 * Runs in the content script (ISOLATED world) when already on a profile page.
 */
export function extractLinkedInJsonLd(): LinkedInJsonLdProfile | null {
  for (const script of document.querySelectorAll<HTMLScriptElement>(
    'script[type="application/ld+json"]'
  )) {
    try {
      const data = JSON.parse(script.textContent ?? "");
      const graph: any[] = data["@graph"] ?? [data];
      const person = graph.find((n: any) => n["@type"] === "Person");
      if (!person) continue;
      return {
        name: (person.name as string) ?? "",
        headline:
          (person.description as string) ??
          (person.headline as string) ??
          null,
        url: (person.url as string) ?? null,
        recentPosts: graph
          .filter((n: any) => n["@type"] === "Article")
          .slice(0, 3)
          .map((a: any) => a.headline as string)
          .filter(Boolean),
      };
    } catch {
      // malformed JSON-LD block — try next script tag
    }
  }
  return null;
}

/**
 * Extracts the LinkedIn profile URL of the recipient visible in the current
 * page context. Works for:
 *   - /in/ profile pages      → current URL (stripped of query params)
 *   - DM / messaging threads  → link in the conversation header
 *   - InMail dialogs          → link inside the dialog card
 * Returns null when no profile URL can be determined.
 */
export function getLinkedInRecipientProfileUrl(): string | null {
  const origin = window.location.origin; // https://www.linkedin.com

  // Case 1: already on a profile page
  if (window.location.pathname.match(/^\/in\/[^/]+\/?$/)) {
    return origin + window.location.pathname.replace(/\/$/, "");
  }

  // Case 2: InMail / connect dialog contains a profile link
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
  if (dialog) {
    const link = dialog.querySelector<HTMLAnchorElement>('a[href*="/in/"]');
    if (link?.href) return cleanProfileUrl(link.href);
  }

  // Case 3: DM conversation header
  for (const sel of [
    ".msg-thread__header a[href*='/in/']",
    "[class*='msg-overlay-conversation-bubble-header'] a[href*='/in/']",
    "[class*='conversation-header'] a[href*='/in/']",
    ".msg-thread__link-to-profile",
  ]) {
    const link = document.querySelector<HTMLAnchorElement>(sel);
    if (link?.href) return cleanProfileUrl(link.href);
  }

  return null;
}

function cleanProfileUrl(href: string): string {
  // Keep only the /in/slug portion — drop query params and hash
  try {
    const u = new URL(href);
    const match = u.pathname.match(/^(\/in\/[^/]+)\/?/);
    if (match) return `${u.origin}${match[1]}`;
  } catch { /* invalid URL */ }
  return href.split("?")[0];
}

// ── Exported utilities ────────────────────────────────────────────────────────

/** Used by App.tsx to classify the active LinkedIn field for UI labeling. */
export function detectLinkedInFieldType(field: Element): string | null {
  return detectFieldType(field);
}

/**
 * LinkedIn search/typeahead inputs should not get the inline compose button.
 * They are valid page controls, but they are not write targets for the current
 * inline flow.
 */
export function isLinkedInSearchField(field: Element): boolean {
  if (detectFieldType(field)) return false;

  const el = field as HTMLElement;
  const attrs = [
    el.getAttribute?.("placeholder") ?? "",
    el.getAttribute?.("data-placeholder") ?? "",
    el.getAttribute?.("aria-label") ?? "",
    el.getAttribute?.("name") ?? "",
    el.getAttribute?.("id") ?? "",
    el.getAttribute?.("role") ?? "",
    el.getAttribute?.("autocomplete") ?? "",
    el.getAttribute?.("data-testid") ?? "",
    el.getAttribute?.("componentkey") ?? "",
    el.getAttribute?.("aria-autocomplete") ?? "",
  ]
    .join(" ")
    .toLowerCase();

  if (attrs.includes("typeahead-input")) return true;
  if (attrs.includes("searchresults_searchtyahinputref")) return true;
  if (attrs.includes("looking for")) return true;

  return (
    (el.getAttribute?.("aria-autocomplete") ?? "").toLowerCase() === "list" &&
    !!el.closest(
      ".artdeco-typeahead, .search-global-typeahead, [class*='typeahead'], form[role='search']"
    )
  );
}

/**
 * Returns LinkedIn-specific ancestor candidates for the floating button anchor.
 * Called by getVisibleFieldAnchor() when on linkedin.com so the button attaches
 * to the nearest meaningful compose container rather than a raw DOM parent.
 */
export function getLinkedInAnchorCandidates(field: Element): Array<Element | null> {
  return [
    field.closest(".msg-form__msg-content-container"),
    field.closest(".msg-form__container"),
    field.closest(".comments-comment-box__form-container"),
    field.closest(".comments-comment-texteditor"),
    field.closest(".share-creation-state__text-editor"),
    field.closest(".feed-shared-update-v2__comments-container"),
    field.closest('[role="dialog"]'),
  ];
}

// ── Search result scanning (batch operations) ─────────────────────────────────

export interface LinkedInSearchResult {
  name: string;
  headline: string;
  profileUrl: string;
}

/**
 * Scans the current LinkedIn search results page and returns person cards
 * that have a visible "Connect" button. Used to seed batch connection queues.
 */
export function scanLinkedInSearchResults(): LinkedInSearchResult[] {
  const results: LinkedInSearchResult[] = [];

  // LinkedIn renders search results inside list items; the exact class changes
  // quarterly so we use the stable data-chameleon-result-urn attribute first,
  // then fall back to structural selectors.
  const cards = Array.from(
    document.querySelectorAll<HTMLElement>(
      "[data-chameleon-result-urn], .reusable-search__result-container, li.reusable-search__result-container"
    )
  );

  for (const card of cards) {
    // Only include cards with a visible Connect button
    const connectBtn = Array.from(
      card.querySelectorAll<HTMLElement>("button, [role='button']")
    ).find((btn) => {
      const text = (btn.textContent ?? "").trim().toLowerCase();
      return text === "connect" || text.startsWith("connect");
    });
    if (!connectBtn) continue;

    const nameEl =
      card.querySelector<HTMLElement>(
        ".entity-result__title-text a span[aria-hidden='true'], .entity-result__title-line a span[aria-hidden='true']"
      ) ??
      card.querySelector<HTMLElement>(
        "a[href*='/in/'] span[aria-hidden='true'], .app-aware-link span[aria-hidden='true']"
      );
    const name = (nameEl?.innerText ?? nameEl?.textContent ?? "").trim();
    if (!name) continue;

    const headlineEl = card.querySelector<HTMLElement>(
      ".entity-result__primary-subtitle, .entity-result__summary"
    );
    const headline = (headlineEl?.innerText ?? headlineEl?.textContent ?? "").trim();

    const profileLink = card.querySelector<HTMLAnchorElement>("a[href*='/in/']");
    if (!profileLink?.href) continue;
    const profileUrl = cleanProfileUrl(profileLink.href);

    results.push({ name, headline, profileUrl });
  }

  return results;
}

// ── Extractor ─────────────────────────────────────────────────────────────────

export const linkedInExtractor: PlatformExtractor = {
  key: "linkedin",

  getComposeBoundary(field) {
    return getComposeBoundary(field);
  },

  extractFieldContext(field, dialogRoot, composeBoundary) {
    const isNote = detectConnectionNote(field);
    const fieldType = isNote ? "[CONNECTION_NOTE_300]" : detectFieldType(field);

    // Dialog card: most authoritative for connect/InMail (exact person shown in dialog)
    const dialogProfile = dialogRoot ? extractDialogProfile(dialogRoot) : null;

    // Page profile: for /in/ profile pages (full profile sections)
    const pageProfile = window.location.pathname.includes("/in/")
      ? extractPageProfile()
      : null;

    // DM counterparty: for message threads without a dialog
    const dmPerson =
      !dialogRoot ? extractDmCounterparty(field, composeBoundary) : null;

    const recipientName =
      dialogProfile?.name ?? pageProfile?.name ?? dmPerson?.name ?? null;
    const recipientRole =
      dialogProfile?.headline ?? pageProfile?.headline ?? dmPerson?.headline ?? null;

    const extraContext =
      fieldType === "[COMMENT]"
        ? extractCommentThreadContext(field, composeBoundary)
        : null;

    return {
      fieldType,
      recipientName,
      recipientRole,
      profileContext: pageProfile?.profileContext ?? null,
      extraContext,
      charLimit: isNote ? 300 : null,
    };
  },
};
