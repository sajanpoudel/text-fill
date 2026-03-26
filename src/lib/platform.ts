// Platform detection and text field utilities
// Matches the full feature set of the original contentScript.js

import { convertElementToMarkdown } from "dom-to-semantic-markdown";

export type PlatformKey =
  | "gmail"
  | "linkedin"
  | "messenger"
  | "facebook"
  | "twitter"
  | "threads"
  | "instagram"
  | "youtube"
  | "reddit"
  | "slack"
  | "discord"
  | "canvas"
  | "general";

function isBlankLikeUrl(href: string): boolean {
  return href === "about:blank" || href.startsWith("about:srcdoc");
}

export function getLocationSnapshot(): {
  hostname: string;
  pathname: string;
  href: string;
  title: string;
} {
  let hostname = "";
  let pathname = "";
  let href = "";
  let title = "";

  try {
    hostname = window.location.hostname ?? "";
    pathname = window.location.pathname ?? "";
    href = window.location.href ?? "";
    title = document.title ?? "";
  } catch {
    // Ignore and fall back to top frame below when possible.
  }

  if (!hostname || isBlankLikeUrl(href)) {
    try {
      if (window.top && window.top !== window) {
        hostname = window.top.location.hostname ?? hostname;
        pathname = window.top.location.pathname ?? pathname;
        href = window.top.location.href ?? href;
        title = window.top.document.title ?? title;
      }
    } catch {
      // Cross-origin or inaccessible top frame — keep current values.
    }
  }

  return { hostname, pathname, href, title };
}

export function getHostDocument(): Document {
  try {
    const href = window.location.href ?? "";
    if (isBlankLikeUrl(href) && window.top && window.top !== window) {
      return window.top.document;
    }
  } catch {
    // Ignore and fall back to current document.
  }
  return document;
}

export function detectPlatformKey(hostname: string): PlatformKey {
  const normalized = (hostname || getLocationSnapshot().hostname || "").toLowerCase();
  if (normalized.includes("mail.google.com")) return "gmail";
  if (normalized.includes("linkedin.com")) return "linkedin";
  if (normalized.includes("messenger.com")) return "messenger";
  if (normalized.includes("facebook.com")) return "facebook";
  if (normalized.includes("twitter.com") || normalized.includes("x.com"))
    return "twitter";
  if (normalized.includes("threads.net")) return "threads";
  if (normalized.includes("instagram.com")) return "instagram";
  if (normalized.includes("youtube.com")) return "youtube";
  if (normalized.includes("reddit.com")) return "reddit";
  if (normalized.includes("slack.com")) return "slack";
  if (normalized.includes("discord.com")) return "discord";
  if (normalized.includes("instructure.com") || normalized.includes("canvas"))
    return "canvas";
  return "general";
}

// ── Platform-specific selectors ───────────────────────────────────────────────
// Ported from contentScript.js PLATFORM_SELECTORS

export const PLATFORM_SELECTORS: Record<string, string[]> = {
  gmail: [
    'div[aria-label*="Message Body"]',
    'div[contenteditable="true"][aria-label*="Compose"]',
    'div[g_editable="true"]',
    'div[role="textbox"][aria-label*="Message"]',
    'div.editable[role="textbox"]',
  ],
  linkedin: [
    "div.msg-form__contenteditable",
    "div.msg-form__msg-content-container",
    'div.ql-editor[contenteditable="true"]',
    'div[data-placeholder*="Add a comment"]',
    'div[data-placeholder*="comment"]',
    'div[aria-label*="Add a comment"]',
    'div[aria-label*="Text editor"]',
    'div.comments-comment-box__form-container [contenteditable="true"]',
    'div.comments-comment-texteditor [contenteditable="true"]',
    'div.feed-shared-update-v2__comments-container [contenteditable="true"]',
    'div[data-placeholder*="Start a post"]',
    'div[aria-label*="Start a post"]',
    'div.share-creation-state__text-editor [contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"]',
  ],
  messenger: [
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"][data-lexical-editor="true"]',
    'div[role="textbox"][data-lexical-editor="true"]',
    'div[aria-label*="Message"][contenteditable="true"]',
    'div[aria-label*="Aa"][contenteditable="true"]',
  ],
  facebook: [
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"][data-lexical-editor="true"]',
    'div[aria-label*="Message"]',
    'div[aria-label*="Write a comment"]',
    'div[aria-label*="Write a reply"]',
    'div[aria-label*="Write a public comment"]',
    'div.notranslate[contenteditable="true"]',
  ],
  twitter: [
    'div[data-testid="tweetTextarea_0"]',
    'div[aria-label*="Post text"]',
    'div[aria-label*="Tweet text"]',
    'div.DraftEditor-root [contenteditable="true"]',
  ],
  threads: [
    'div[contenteditable="true"][role="textbox"]',
    'div[aria-label*="Start a thread"]',
  ],
  instagram: [
    'textarea[aria-label*="Add a comment"]',
    'div[contenteditable="true"][role="textbox"]',
  ],
  youtube: [
    'div#contenteditable-root[contenteditable="true"]',
    'div[aria-label*="Add a comment"]',
    'yt-formatted-string[contenteditable="true"]',
  ],
  reddit: [
    'div[data-testid="comment-submission-form-richtext"] [contenteditable="true"]',
    'div.public-DraftEditor-content[contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"]',
  ],
  discord: [
    'div[role="textbox"][contenteditable="true"]',
    'div[class*="textArea"] [contenteditable="true"]',
  ],
  slack: [
    'div[data-qa="message_input"] [contenteditable="true"]',
    'div.ql-editor[contenteditable="true"]',
    'div[role="textbox"][contenteditable="true"]',
  ],
  general: [
    'textarea:not([readonly]):not([disabled])',
    'input[type="text"]:not([readonly]):not([disabled])',
    'input[type="email"]:not([readonly]):not([disabled])',
    'input:not([type]):not([readonly]):not([disabled])',
    '[contenteditable="true"]:not([aria-readonly="true"])',
    '[contenteditable=""]:not([aria-readonly="true"])',
    '[role="textbox"]:not([aria-readonly="true"])',
    'div.ql-editor',
  ],
};

const MAX_FOREGROUND_CONTEXT_CHARS = 2600;
const MAX_BACKGROUND_CONTEXT_CHARS = 1800;
const MAX_DIALOG_CONTEXT_CHARS = 900;
const MAX_PAGE_CONTEXT_CHARS = 6000;

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function extractSectionText(
  element: Element | null,
  maxChars = Infinity
): string {
  if (!element) return "";

  const source =
    element instanceof HTMLElement ? element.innerText : element.textContent ?? "";
  if (!source) return "";

  const normalized = source
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return normalized.slice(0, maxChars);
}

/**
 * Convert a DOM element to LLM-friendly semantic markdown.
 * Strips our own extension UI and obvious noise before converting,
 * then falls back to plain innerText if the library throws.
 */
function domToMarkdown(element: Element | null, maxChars = Infinity): string {
  if (!element) return "";
  try {
    const clone = element.cloneNode(true) as Element;
    // Strip extension UI, scripts, styles, and aria-hidden noise from the snapshot
    clone.querySelectorAll(
      "[data-tfa-ui], script, style, noscript, [aria-hidden='true'], [role='presentation']"
    ).forEach((el) => el.remove());
    const md = convertElementToMarkdown(clone, { refifyUrls: false });
    return md.replace(/\n{3,}/g, "\n\n").trim().slice(0, maxChars);
  } catch {
    return extractSectionText(element, maxChars);
  }
}

function dedupeSection(primary: string, secondary: string): string {
  const primarySnippet = normalizeText(primary).slice(0, 220);
  if (!primarySnippet || primarySnippet.length < 80) return secondary;
  if (!secondary.includes(primarySnippet)) return secondary;
  return normalizeText(secondary.replace(primarySnippet, " "));
}

function pickPersonLikeCandidate(candidates: string[]): string {
  for (const candidate of candidates) {
    const text = normalizeText(candidate);
    if (!text) continue;
    if (text.length < 3 || text.length > 80) continue;

    const lower = text.toLowerCase();
    if (
      [
        "message",
        "connect",
        "follow",
        "premium",
        "linkedin",
        "add a note",
        "write with ai",
        "cancel",
        "send",
      ].some((term) => lower === term || lower.includes(term))
    ) {
      continue;
    }

    const words = text.split(/\s+/).filter(Boolean);
    if (
      words.length >= 1 &&
      words.length <= 4 &&
      words.every((word) => /^[A-Z][A-Za-z'.-]+$/.test(word))
    ) {
      return text;
    }
  }

  return "";
}

/** Returns a context tag describing the LinkedIn field type, or null if unknown. */
function detectLinkedInFieldType(field: Element): string | null {
  const el = field as HTMLElement;

  // InMail subject: <input name="subject"> inside a dialog
  if (el.getAttribute?.("name") === "subject" && field.closest('[role="dialog"]')) {
    return "[INMAIL_SUBJECT]";
  }

  // InMail body: contenteditable inside a dialog that also has input[name="subject"]
  const dialog = field.closest('[role="dialog"]');
  if (dialog && dialog.querySelector('input[name="subject"]')) {
    return "[INMAIL_MESSAGE]";
  }

  // DM thread (bubbles or full message thread view)
  if (field.closest(".msg-thread, .msg-overlay-conversation-bubble, .msg-conversation-card")) {
    return "[DM_MESSAGE]";
  }

  // Comment box
  if (
    field.closest(".comments-comment-box") ||
    field.closest("[class*='comments-comment']") ||
    field.closest(".feed-shared-update-v2__comments-container")
  ) {
    return "[COMMENT]";
  }

  // Post compose
  if (
    field.closest(".share-creation-state") ||
    field.closest("[class*='share-creation']") ||
    el.getAttribute?.("data-placeholder")?.toLowerCase().includes("start a post")
  ) {
    return "[POST_COMPOSE]";
  }

  return null;
}

function extractLinkedInProfileInfo(): {
  name: string;
  headline: string;
  employer: string;
  profileRoot: HTMLElement | null;
} | null {
  if (!window.location.hostname.includes("linkedin.com")) return null;

  const profileRoot =
    document.querySelector<HTMLElement>("main") ?? document.body;

  const name =
    document.querySelector<HTMLElement>("h1.text-heading-xlarge")?.innerText?.trim() ??
    profileRoot.querySelector<HTMLElement>("h1")?.innerText?.trim() ??
    "";

  const headline =
    document.querySelector<HTMLElement>(".text-body-medium.break-words")?.innerText?.trim() ??
    document.querySelector<HTMLElement>("[class*='top-card-layout__headline']")?.innerText?.trim() ??
    "";

  const atMatch = headline.match(
    /(?:at|@)\s+([A-Z][A-Za-z0-9&,.()' -]+?)(?:\s*[\|\u00b7\u2022]|$)/
  );
  const pipeMatch = headline.match(
    /^([A-Z][A-Za-z0-9&,.()' -]+?)\s*[\|\u00b7\u2022]/
  );
  const employer =
    atMatch?.[1]?.trim() ??
    pipeMatch?.[1]?.trim() ??
    document
      .querySelector<HTMLElement>("[class*='top-card__employer']")
      ?.innerText?.trim() ??
    "";

  if (!name && !headline) return null;

  return {
    name,
    headline,
    employer,
    profileRoot,
  };
}

function extractLinkedInCounterparty(field: Element, composeBoundary: Element | null): {
  name: string;
  headline?: string;
} | null {
  const conversationRoot =
    composeBoundary?.closest(
      ".msg-overlay-conversation-bubble, .msg-thread, .msg-conversation-card"
    ) ??
    field.closest(
      ".msg-overlay-conversation-bubble, .msg-thread, .msg-conversation-card"
    ) ??
    composeBoundary;

  if (!conversationRoot) return null;

  const headerRoot =
    conversationRoot.querySelector(
      "header, [class*='msg-thread__header'], [class*='conversation-header'], [class*='msg-overlay-conversation-bubble-header']"
    ) ?? conversationRoot;

  const nameCandidates: string[] = [];
  [
    ".msg-thread__link-to-profile",
    "[class*='msg-thread__name']",
    "[class*='participant-name']",
    "a[href*='/in/']",
    "h1",
    "h2",
    "h3",
  ].forEach((selector) => {
    headerRoot.querySelectorAll<HTMLElement>(selector).forEach((el) => {
      const text = normalizeText(el.innerText || el.textContent || "");
      if (text) nameCandidates.push(text);
    });
  });

  const name = pickPersonLikeCandidate(nameCandidates);
  if (!name) return null;

  const headerText = extractSectionText(headerRoot, 240);
  const headline = headerText && !headerText.includes(name) ? headerText : "";

  return {
    name,
    headline: headline || undefined,
  };
}

function buildStructuredPageContext(parts: Array<string | null | undefined>): string {
  return parts.filter(Boolean).join("\n\n").slice(0, MAX_PAGE_CONTEXT_CHARS);
}

function isElementVisible(el: Element | null): boolean {
  if (!el || !(el instanceof Element)) return false;
  const style = window.getComputedStyle(el as HTMLElement);
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

function inferRoleHint(sourceText: string, platform: PlatformKey): string {
  const text = sourceText.toLowerCase();
  if (
    ["messenger", "facebook", "instagram", "threads", "discord"].includes(
      platform
    )
  ) {
    return "social";
  }
  if (["slack", "linkedin", "gmail"].includes(platform)) {
    if (/\b(recruiter|hiring manager|interviewer|talent|sourcer)\b/i.test(text)) {
      return "hiring";
    }
    if (/\b(manager|director|vp|lead|founder|ceo|cto|coworker|colleague)\b/i.test(text)) {
      return "work";
    }
  }
  return "";
}

function extractCounterpartyContext(
  field: Element,
  composeBoundary: Element | null,
  platform: PlatformKey
): { name: string; roleHint?: string } | null {
  if (platform === "linkedin") {
    const counterparty = extractLinkedInCounterparty(field, composeBoundary);
    if (counterparty?.name) {
      return {
        name: counterparty.name,
        roleHint: counterparty.headline
          ? inferRoleHint(counterparty.headline, platform)
          : undefined,
      };
    }
  }

  const hostDoc = getHostDocument();
  const root =
    composeBoundary ??
    field.closest("section, article, [role='main'], [role='dialog'], form, div") ??
    hostDoc.body;
  if (!root) return null;

  const selectors = [
    'input[aria-label*="To"]',
    'textarea[aria-label*="To"]',
    '[aria-label*="recipient"]',
    '[aria-label*="Recipient"]',
    '[aria-current="page"] h1',
    '[aria-current="page"] h2',
    '[aria-current="page"] h3',
    'header h1',
    'header h2',
    'header h3',
    'header [role="heading"]',
    '[data-testid*="conversation"]',
    '[class*="recipient"]',
    '[class*="participant"]',
    '[class*="conversation"] h1',
    '[class*="conversation"] h2',
    '[class*="conversation"] h3',
    'h1',
    'h2',
    'h3',
    'a[href*="/in/"]',
    '[dir="auto"]',
  ];

  const raw: string[] = [];
  for (const selector of selectors) {
    root.querySelectorAll(selector).forEach((el) => {
      if (!isElementVisible(el)) return;
      const text = normalizeText(
        (el as HTMLElement).innerText || el.textContent || ""
      );
      if (!text || text.length < 2 || text.length > 80) return;
      raw.push(text);
    });
    if (raw.length >= 8) break;
  }

  const candidate = pickPersonLikeCandidate(raw);
  if (!candidate) return null;

  const roleHint = inferRoleHint(
    `${candidate} ${root.textContent || ""}`,
    platform
  );

  return {
    name: candidate,
    roleHint: roleHint || undefined,
  };
}

// ── Field filters ─────────────────────────────────────────────────────────────

/** Returns true if the field is visible in the viewport with non-zero size */
export function isVisibleField(field: Element): boolean {
  const el = field as HTMLElement;
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  const rects = el.getClientRects();
  if (!rects.length) return false;
  const r = rects[0];
  return r.width > 0 && r.height > 0;
}

/** Returns true if this field is a search/filter input (skip these) */
export function isSearchField(field: Element): boolean {
  const el = field as HTMLElement;
  const attrs = [
    el.getAttribute("placeholder") ?? "",
    el.getAttribute("name") ?? "",
    el.getAttribute("id") ?? "",
    el.getAttribute("aria-label") ?? "",
    el.getAttribute("type") ?? "",
    el.getAttribute("role") ?? "",
  ].map((s) => s.toLowerCase());

  const searchTerms = ["search", "filter", "find", "lookup", "query"];
  return searchTerms.some((t) => attrs.some((a) => a.includes(t)));
}

/** Returns true if this field is for personal info (email, phone, password, etc.) */
export function isPersonalInfoField(field: Element): boolean {
  const el = field as HTMLInputElement;
  const type = (el.type ?? "").toLowerCase();
  if (["password", "hidden", "submit", "button", "reset", "checkbox", "radio", "file", "range", "color"].includes(type)) return true;

  const attrs = [
    el.getAttribute("autocomplete") ?? "",
    el.getAttribute("name") ?? "",
    el.getAttribute("id") ?? "",
    el.getAttribute("placeholder") ?? "",
    el.getAttribute("aria-label") ?? "",
  ].map((s) => s.toLowerCase());

  const personalTerms = [
    "email", "phone", "tel", "mobile", "address", "zip", "postal", "city",
    "state", "country", "birth", "dob", "age", "ssn", "social", "credit",
    "card", "cvv", "expire", "salary", "rate", "price", "amount", "quantity",
    "username", "login", "sign-in", "signin",
  ];
  return personalTerms.some((t) => attrs.some((a) => a.includes(t)));
}

/** Returns true if this looks like a real text field we should handle */
function isValidTextField(field: Element): boolean {
  if (!isVisibleField(field)) return false;
  if (isSearchField(field)) return false;
  // Only filter personal info on input elements (not contenteditable)
  if (field instanceof HTMLInputElement && isPersonalInfoField(field)) return false;
  return true;
}

// ── Find all relevant text fields on the page ─────────────────────────────────

export function findTextFields(platform: PlatformKey): Element[] {
  const selectors = [
    ...(PLATFORM_SELECTORS[platform] ?? []),
    ...PLATFORM_SELECTORS.general,
  ];
  const seen = new Set<Element>();
  const results: Element[] = [];
  for (const sel of selectors) {
    try {
      document.querySelectorAll(sel).forEach((el) => {
        if (!seen.has(el) && isValidTextField(el)) {
          seen.add(el);
          results.push(el);
        }
      });
    } catch {
      // Invalid selector — skip
    }
  }
  return results;
}

// ── Compose boundary ──────────────────────────────────────────────────────────

/** Find the tightest compose container to avoid reading other messages/threads */
export function getComposeBoundary(field: Element): Element {
  // Gmail: only the active compose/reply window
  const { hostname } = getLocationSnapshot();
  if (hostname.includes("mail.google.com")) {
    return (
      field.closest('[role="dialog"]') ??
      field.closest("td.Ar.Au") ??
      field.closest("form") ??
      field.parentElement ??
      field
    );
  }

  // LinkedIn: only the active message/comment editor
  if (hostname.includes("linkedin.com")) {
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

  if (hostname.includes("messenger.com")) {
    return (
      field.closest('[role="dialog"]') ??
      field.closest('[role="main"]') ??
      field.closest('[aria-label*="Conversation"]') ??
      field.closest("section") ??
      field.closest("article") ??
      field.parentElement ??
      field
    );
  }

  if (hostname.includes("facebook.com")) {
    return (
      field.closest('[role="dialog"]') ??
      field.closest('[data-pagelet*="Chat"]') ??
      field.closest('[aria-label*="Conversation"]') ??
      field.closest('[role="complementary"]') ??
      field.closest('[role="main"]') ??
      field.closest("section") ??
      field.closest("article") ??
      field.parentElement ??
      field
    );
  }

  if (hostname.includes("slack.com")) {
    return (
      field.closest('[data-qa="message_input"]') ??
      field.closest('[role="main"]') ??
      field.closest("section") ??
      field.parentElement ??
      field
    );
  }

  if (hostname.includes("discord.com")) {
    return (
      field.closest('[aria-label*="Messages"]') ??
      field.closest('[role="main"]') ??
      field.closest("section") ??
      field.parentElement ??
      field
    );
  }

  return field.closest("form") ?? field.parentElement ?? field;
}

// ── Page context extraction ───────────────────────────────────────────────────

export function extractPageContext(field: Element): string {
  const { hostname, pathname, href: url, title: snapshotTitle } =
    getLocationSnapshot();
  const title = snapshotTitle?.trim() || "";
  const platform = detectPlatformKey(hostname);
  const hostDoc = getHostDocument();

  const composeBoundary = getComposeBoundary(field);
  const mainRoot =
    hostDoc.querySelector<HTMLElement>("main, article, [role='main']") ??
    hostDoc.body;
  const dialogRoot =
    field.closest<HTMLElement>("dialog, [role='dialog']");

  if (
    platform === "messenger" ||
    platform === "facebook" ||
    platform === "slack" ||
    platform === "discord"
  ) {
    const counterparty = extractCounterpartyContext(field, composeBoundary, platform);
    const threadRoot =
      composeBoundary ??
      field.closest("section, article, [role='main'], [role='dialog'], div");
    const threadContext = domToMarkdown(
      threadRoot,
      MAX_FOREGROUND_CONTEXT_CHARS + 600
    );

    return buildStructuredPageContext([
      title ? `Page: ${title}` : "",
      url ? `URL: ${url}` : "",
      counterparty?.name
        ? `Audience: ${counterparty.name}${
            counterparty.roleHint ? ` (${counterparty.roleHint})` : ""
          }`
        : "",
      threadContext ? `Thread context:\n${threadContext}` : "",
    ]);
  }

  if (hostname.includes("linkedin.com")) {
    const fieldEl = field instanceof HTMLElement ? field : null;
    const fieldTypeTag = detectLinkedInFieldType(field);

    // ── Connection note detection (must run BEFORE profile check) ────────────
    // LinkedIn's connection note textarea does NOT use the HTML maxlength
    // attribute — the 300-char limit is enforced purely in JavaScript, so
    // field.getAttribute("maxlength") returns null. Instead we walk ancestors
    // and look for (a) modal-like containers with "add a note" text, or (b)
    // the "X/300" character counter element LinkedIn renders next to the field.
    const fieldMaxLen = parseInt(fieldEl?.getAttribute("maxlength") ?? "0") || 0;

    let isConnectionNote = fieldMaxLen === 300;

    if (!isConnectionNote) {
      // Check the field's associated <label> (LinkedIn uses for="custom-message"
      // with visually-hidden text "Please limit personal note to 300 characters.").
      const fieldId = (field as HTMLElement).id;
      if (fieldId) {
        const labelEl = document.querySelector<HTMLElement>(`label[for="${fieldId}"]`);
        if (labelEl) {
          const lt = (labelEl.textContent ?? "").toLowerCase();
          if (lt.includes("300") || lt.includes("personal note") || lt.includes("invitation")) {
            isConnectionNote = true;
          }
        }
      }
    }

    if (!isConnectionNote) {
      // Check inside the closest role="dialog" directly — LinkedIn's connect modal
      // is a dialog and its textContent includes "add a note to your invitation"
      // and the "0/300" counter. No textLen limit here since dialog scope is tight.
      const dialogEl = field.closest('[role="dialog"]');
      if (dialogEl) {
        const dt = (dialogEl.textContent ?? "").toLowerCase();
        isConnectionNote =
          dt.includes("add a note to your invitation") ||
          dt.includes("note to your invitation") ||
          (dt.includes("add a note") && dt.includes("invitation")) ||
          (dt.includes("personal note") && dt.includes("invitation")) ||
          /\b\d+\/300\b/.test(dt);
      }
    }

    if (!isConnectionNote) {
      // Fallback: Walk up the DOM. Stop at <body>. Limit depth to avoid full-page scans.
      let ancestor: Element | null = field.parentElement;
      for (let depth = 0; depth < 20 && ancestor && ancestor !== document.body; depth++) {
        const text = (ancestor.textContent ?? "").toLowerCase();
        const textLen = text.length;

        // Only inspect focused containers (< 3000 chars of text) to avoid
        // false-positives from page-level ancestors that contain unrelated content.
        if (textLen < 3000) {
          if (
            text.includes("add a note to your invitation") ||
            text.includes("note to your invitation") ||
            (text.includes("add a note") && text.includes("invitation")) ||
            (text.includes("personal note") && text.includes("invitation")) ||
            // LinkedIn renders "0/300" or "443/300" as a character counter
            /\b\d+\/300\b/.test(text)
          ) {
            isConnectionNote = true;
            break;
          }
        }
        ancestor = ancestor.parentElement;
      }
    }

    // ── Profile + counterparty context ───────────────────────────────────────
    const counterparty = extractCounterpartyContext(field, composeBoundary, platform);
    const profile = pathname.includes("/in/") ? extractLinkedInProfileInfo() : null;

    if (isConnectionNote) {
      // Return immediately with the 300-char constraint marker.
      // Include profile info for personalization if we're on a profile page.
      const profileSummary = profile
        ? domToMarkdown(profile.profileRoot, MAX_FOREGROUND_CONTEXT_CHARS)
        : "";
      const audienceLine = profile?.name
        ? `Audience: ${profile.name}${profile.headline ? ` - ${profile.headline}` : ""}${profile.employer ? ` @ ${profile.employer}` : ""}`
        : counterparty?.name
          ? `Audience: ${counterparty.name}${counterparty.roleHint ? ` (${counterparty.roleHint})` : ""}`
          : "";
      return buildStructuredPageContext([
        "[CONNECT_NOTE_300]",
        title ? `Page: ${title}` : "",
        url ? `URL: ${url}` : "",
        audienceLine,
        profileSummary ? `Profile context:\n${profileSummary}` : "",
      ]);
    }

    if (profile) {
      const profileSummary = domToMarkdown(
        profile.profileRoot,
        MAX_FOREGROUND_CONTEXT_CHARS
      );
      const dialogText =
        dialogRoot && dialogRoot !== profile.profileRoot
          ? domToMarkdown(dialogRoot, MAX_DIALOG_CONTEXT_CHARS)
          : "";

      return buildStructuredPageContext([
        fieldTypeTag,
        title ? `Page: ${title}` : "",
        url ? `URL: ${url}` : "",
        profile.name
          ? `Audience: ${profile.name}${
              profile.headline ? ` - ${profile.headline}` : ""
            }${profile.employer ? ` @ ${profile.employer}` : ""}`
          : "",
        profileSummary ? `Foreground context:\n${profileSummary}` : "",
        dialogText ? `Active dialog:\n${dialogText}` : "",
      ]);
    }

    if (counterparty?.name) {
      const foregroundRoot = composeBoundary ?? field.closest("section, article, form, div");
      const foregroundContext = domToMarkdown(
        foregroundRoot,
        MAX_FOREGROUND_CONTEXT_CHARS
      );
      let backgroundContext = domToMarkdown(
        mainRoot,
        MAX_BACKGROUND_CONTEXT_CHARS
      );
      backgroundContext = dedupeSection(foregroundContext, backgroundContext);

      return buildStructuredPageContext([
        fieldTypeTag,
        title ? `Page: ${title}` : "",
        url ? `URL: ${url}` : "",
        `Audience: ${counterparty.name}${
          counterparty.roleHint ? ` (${counterparty.roleHint})` : ""
        }`,
        foregroundContext ? `Foreground context:\n${foregroundContext}` : "",
        backgroundContext ? `Background context:\n${backgroundContext}` : "",
      ]);
    }

    // LinkedIn fallback — no profile/counterparty detected but we know the field type
    if (fieldTypeTag) {
      const foregroundCtx = domToMarkdown(composeBoundary, MAX_FOREGROUND_CONTEXT_CHARS);
      return buildStructuredPageContext([
        fieldTypeTag,
        title ? `Page: ${title}` : "",
        url ? `URL: ${url}` : "",
        foregroundCtx ? `Foreground context:\n${foregroundCtx}` : "",
      ]);
    }
  }

  const foregroundRoot =
    composeBoundary ?? field.closest("section, form, article, [role='main'], div");
  const foregroundContext = domToMarkdown(
    foregroundRoot,
    MAX_FOREGROUND_CONTEXT_CHARS
  );
  let backgroundContext = domToMarkdown(
    mainRoot,
    MAX_BACKGROUND_CONTEXT_CHARS
  );
  backgroundContext = dedupeSection(foregroundContext, backgroundContext);

  return buildStructuredPageContext([
    title ? `Page: ${title}` : "",
    url ? `URL: ${url}` : "",
    foregroundContext ? `Foreground context:\n${foregroundContext}` : "",
    backgroundContext ? `Background context:\n${backgroundContext}` : "",
  ]);
}
