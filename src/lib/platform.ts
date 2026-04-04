// Platform detection and text field utilities
// Matches the full feature set of the original contentScript.js

import { isElementVisible } from "./dom/walker.ts";
import { getLinkedInAnchorCandidates } from "./platforms/linkedin.ts";

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
  | "googledocs"
  | "greenhouse"
  | "ashby"
  | "workday"
  | "lever"
  | "outlook"
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

function getHostDocument(): Document {
  // Always query the current frame's document. Platform detection may still
  // fall back to the top window's location for about:blank frames, but field
  // discovery and context extraction must stay local once the content script
  // is injected into subframes.
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
  if (normalized === "docs.google.com") return "googledocs";
  if (normalized.includes("greenhouse.io")) return "greenhouse";
  if (normalized.includes("ashbyhq.com")) return "ashby";
  if (normalized.includes("myworkdayjobs.com") || normalized.includes("workday.com")) return "workday";
  if (normalized.includes("lever.co")) return "lever";
  if (
    normalized.includes("outlook.live.com") ||
    normalized.includes("outlook.office.com") ||
    normalized.includes("outlook.office365.com")
  ) return "outlook";
  return "general";
}

// ── Platform-specific selectors ───────────────────────────────────────────────
// Ported from contentScript.js PLATFORM_SELECTORS

const PLATFORM_SELECTORS: Record<string, string[]> = {
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
    // Connection note textarea (the "Add a note to your invitation" modal)
    'textarea.connect-button-send-invite__custom-message',
    'textarea[name="message"]',
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
  googledocs: [
    ".kix-editor-main-container",
    ".docs-editor",
    '[contenteditable="true"][class*="docs-texteventtarget"]',
  ],
  // ── Job boards ───────────────────────────────────────────────────────────────
  greenhouse: [
    'textarea#cover_letter_text',
    'textarea[name*="cover_letter"]',
    'textarea[name*="question"]',
    'div[id*="question"] textarea',
    'textarea:not([readonly]):not([disabled])',
    'input[type="text"]:not([readonly]):not([disabled])',
  ],
  ashby: [
    'div.ProseMirror[contenteditable="true"]',
    'div.tiptap[contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"]',
    'textarea:not([readonly]):not([disabled])',
    'input[type="text"]:not([readonly]):not([disabled])',
  ],
  workday: [
    'div[data-automation-id*="textInput"] input',
    'div[data-automation-id*="textArea"] textarea',
    'div[contenteditable="true"]',
    'textarea:not([readonly]):not([disabled])',
    'input[type="text"]:not([readonly]):not([disabled])',
  ],
  lever: [
    'textarea[name="comments"]',
    'textarea[name*="additionalInfo"]',
    'textarea[placeholder*="cover"]',
    'textarea:not([readonly]):not([disabled])',
    'input[type="text"]:not([readonly]):not([disabled])',
  ],
  // ── Email clients ────────────────────────────────────────────────────────────
  outlook: [
    'div[aria-label*="Message body"]',
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"][aria-multiline="true"]',
    'div[aria-label*="New message"]',
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

type DeepQueryRoot = Document | ShadowRoot | Element;

function collectOpenQueryRoots(root: DeepQueryRoot = getHostDocument()): DeepQueryRoot[] {
  const roots: DeepQueryRoot[] = [root];
  const queue: DeepQueryRoot[] = [root];
  const visitedShadowRoots = new Set<ShadowRoot>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;

    for (const el of Array.from(current.querySelectorAll("*"))) {
      if (!(el instanceof HTMLElement)) continue;
      const shadowRoot = el.shadowRoot;
      if (!shadowRoot || visitedShadowRoots.has(shadowRoot)) continue;

      visitedShadowRoots.add(shadowRoot);
      roots.push(shadowRoot);
      queue.push(shadowRoot);
    }
  }

  return roots;
}

export function querySelectorAllDeep(
  selector: string,
  root: DeepQueryRoot = getHostDocument()
): Element[] {
  const results: Element[] = [];
  const seen = new Set<Element>();

  for (const queryRoot of collectOpenQueryRoots(root)) {
    try {
      if (
        queryRoot instanceof Element &&
        queryRoot.matches(selector) &&
        !seen.has(queryRoot)
      ) {
        seen.add(queryRoot);
        results.push(queryRoot);
      }
    } catch {
      // Invalid selector — skip root-level self match.
    }

    try {
      queryRoot.querySelectorAll(selector).forEach((el) => {
        if (seen.has(el)) return;
        seen.add(el);
        results.push(el);
      });
    } catch {
      // Invalid selector — skip this query root.
    }
  }

  return results;
}

export function querySelectorDeep(
  selector: string,
  root: DeepQueryRoot = getHostDocument()
): Element | null {
  return querySelectorAllDeep(selector, root)[0] ?? null;
}

// ── Field filters ─────────────────────────────────────────────────────────────

/** Returns true if the field is visible in the viewport with non-zero size */
function isVisibleField(field: Element): boolean {
  const el = field as HTMLElement;
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  const rects = el.getClientRects();
  if (!rects.length) return false;
  const r = rects[0];
  return r.width > 0 && r.height > 0;
}

function isRenderableAnchor(el: Element | null): el is Element {
  if (!el || !(el instanceof Element)) return false;
  if (!isElementVisible(el)) return false;
  const rect = el.getBoundingClientRect();
  return (
    rect.bottom >= 0 &&
    rect.right >= 0 &&
    rect.top <= window.innerHeight &&
    rect.left <= window.innerWidth
  );
}

export function getVisibleFieldAnchor(field: Element): Element | null {
  if (!(field as Node).isConnected) return null;

  const candidates: Array<Element | null> = [field];

  if (getLocationSnapshot().hostname.includes("linkedin.com")) {
    candidates.push(...getLinkedInAnchorCandidates(field));
  }

  let node: Element | null = field;
  while (node) {
    const parent: HTMLElement | null = node.parentElement;
    if (parent) {
      if (parent !== document.body && parent !== document.documentElement) {
        candidates.push(parent);
      }
      node = parent;
      continue;
    }

    const root = node.getRootNode();
    if (root instanceof ShadowRoot) {
      candidates.push(root.host);
      node = root.host;
      continue;
    }

    node = null;
  }

  for (const candidate of candidates) {
    if (isRenderableAnchor(candidate)) return candidate;
  }

  return null;
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
  if (["password", "hidden", "submit", "button", "reset", "checkbox", "radio", "file", "range", "color", "number", "tel", "email", "date", "time", "datetime-local", "month", "week", "url"].includes(type)) return true;

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
    "name", "fname", "lname", "firstname", "lastname", "fullname",
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
    for (const el of querySelectorAllDeep(sel)) {
      if (el.closest?.("[data-tfa-ui]")) continue;
      if (!seen.has(el) && isValidTextField(el)) {
        seen.add(el);
        results.push(el);
      }
    }
  }
  return results;
}
