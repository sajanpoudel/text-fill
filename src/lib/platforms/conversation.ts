import type { FieldContext, PlatformExtractor } from "./base.ts";
import { extractCleanText, normalizeText } from "../dom/walker.ts";

const MAX_THREAD_CONTEXT_CHARS = 3200;

const UI_NOISE_TERMS = [
  "message",
  "messages",
  "send",
  "cancel",
  "close",
  "reply",
  "comment",
  "post",
  "thread",
  "tweet",
  "write a message",
  "write a reply",
  "write a comment",
  "search",
  "filter",
  "to",
  "cc",
  "bcc",
  "subject",
  "draft",
];

type ConversationExtractorConfig = {
  key: string;
  defaultFieldType: string;
  composeBoundarySelectors: string[];
  threadRootSelectors: string[];
  audienceRootSelectors?: string[];
  audienceSelectors?: string[];
  captureRole?: boolean;
};

const DEFAULT_AUDIENCE_SELECTORS = [
  'input[aria-label*="To" i]',
  'textarea[aria-label*="To" i]',
  '[aria-label*="recipient" i]',
  '[aria-label*="conversation" i]',
  '[aria-label*="messages" i]',
  'header h1',
  'header h2',
  'header h3',
  'header [role="heading"]',
  '[role="heading"]',
  '[data-testid*="conversation"]',
  '[dir="auto"]',
  'h1',
  'h2',
  'h3',
  'a[href*="/in/"]',
];

function safeClosest(node: Element | null | undefined, selector: string): Element | null {
  if (!node?.closest) return null;
  try {
    return node.closest(selector);
  } catch {
    return null;
  }
}

function safeMatches(node: Element | null | undefined, selector: string): boolean {
  if (!node || typeof (node as Element).matches !== "function") return false;
  try {
    return (node as Element).matches(selector);
  } catch {
    return false;
  }
}

function safeQuerySelector(root: ParentNode | null | undefined, selector: string): Element | null {
  if (!root?.querySelector) return null;
  try {
    return root.querySelector(selector);
  } catch {
    return null;
  }
}

function safeQuerySelectorAll(
  root: ParentNode | null | undefined,
  selector: string
): Element[] {
  if (!root?.querySelectorAll) return [];
  try {
    return Array.from(root.querySelectorAll(selector));
  } catch {
    return [];
  }
}

function readElementText(el: Element): string {
  const maybeValue = typeof (el as HTMLInputElement).value === "string"
    ? (el as HTMLInputElement).value
    : "";
  const maybeInnerText =
    typeof (el as HTMLElement).innerText === "string"
      ? (el as HTMLElement).innerText
      : "";
  const maybeTextContent = typeof el.textContent === "string" ? el.textContent : "";
  return normalizeText(maybeInnerText || maybeTextContent || maybeValue);
}

function findClosestMatch(field: Element, selectors: string[]): Element | null {
  for (const selector of selectors) {
    const match = safeClosest(field, selector);
    if (match) return match;
  }
  return null;
}

function findBestRoot(
  field: Element,
  composeBoundary: Element,
  selectors: string[]
): Element | null {
  for (const selector of selectors) {
    if (safeMatches(composeBoundary, selector)) return composeBoundary;
    const composeClosest = safeClosest(composeBoundary, selector);
    if (composeClosest) return composeClosest;
    const fieldClosest = safeClosest(field, selector);
    if (fieldClosest) return fieldClosest;
  }

  if (typeof document !== "undefined") {
    for (const selector of selectors) {
      const docMatch = safeQuerySelector(document, selector);
      if (docMatch) return docMatch;
    }
  }

  return null;
}

function isUiNoise(text: string): boolean {
  const lower = text.toLowerCase();
  return UI_NOISE_TERMS.some((term) => lower === term || lower.includes(term));
}

function looksLikePerson(text: string): boolean {
  const words = text.split(/\s+/).filter(Boolean);
  return (
    words.length >= 1 &&
    words.length <= 4 &&
    words.every((word) => /^[A-Z][A-Za-z'.-]+$/.test(word))
  );
}

function looksLikeEmail(text: string): boolean {
  return /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text);
}

function collectTextCandidates(root: Element | null, selectors: string[]): string[] {
  if (!root) return [];

  const seen = new Set<string>();
  const candidates: string[] = [];

  for (const selector of selectors) {
    for (const el of safeQuerySelectorAll(root, selector)) {
      const text = readElementText(el);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      candidates.push(text);
    }
    if (candidates.length >= 12) break;
  }

  return candidates;
}

function pickAudienceCandidate(candidates: string[]): string | null {
  const normalized = candidates
    .map((candidate) => normalizeText(candidate))
    .filter((candidate) => candidate.length >= 2 && candidate.length <= 80)
    .filter((candidate) => !isUiNoise(candidate));

  for (const candidate of normalized) {
    if (looksLikePerson(candidate)) return candidate;
  }

  for (const candidate of normalized) {
    if (looksLikeEmail(candidate)) return candidate;
  }

  return normalized[0] ?? null;
}

function pickSupportingLine(
  candidates: string[],
  audience: string | null
): string | null {
  if (!audience) return null;

  for (const candidate of candidates) {
    const text = normalizeText(candidate);
    if (!text || text.length < 3 || text.length > 160) continue;
    if (text === audience) continue;
    if (text.includes(audience) || audience.includes(text)) continue;
    if (isUiNoise(text)) continue;
    return text;
  }

  return null;
}

function inferFieldType(field: Element, fallback: string): string {
  if (fallback === "[EMAIL_BODY]") return fallback;

  const attrs = [
    field.getAttribute?.("aria-label") ?? "",
    field.getAttribute?.("data-placeholder") ?? "",
    field.getAttribute?.("placeholder") ?? "",
    field.getAttribute?.("name") ?? "",
    field.getAttribute?.("id") ?? "",
  ]
    .join(" ")
    .toLowerCase();

  if (attrs.includes("comment") || attrs.includes("reply")) return "[COMMENT]";
  if (
    attrs.includes("post") ||
    attrs.includes("tweet") ||
    attrs.includes("thread")
  ) {
    return "[POST_COMPOSE]";
  }

  return fallback;
}

function buildConversationFieldContext(
  field: Element,
  composeBoundary: Element,
  config: ConversationExtractorConfig
): FieldContext {
  const audienceRoot = findBestRoot(
    field,
    composeBoundary,
    config.audienceRootSelectors ?? config.composeBoundarySelectors
  ) ?? composeBoundary;
  const audienceCandidates = collectTextCandidates(
    audienceRoot,
    config.audienceSelectors ?? DEFAULT_AUDIENCE_SELECTORS
  );
  const recipientName = pickAudienceCandidate(audienceCandidates);
  const recipientRole = config.captureRole
    ? pickSupportingLine(audienceCandidates, recipientName)
    : null;

  const threadRoot =
    findBestRoot(field, composeBoundary, config.threadRootSelectors) ??
    composeBoundary;
  const extraContext = extractCleanText(threadRoot, MAX_THREAD_CONTEXT_CHARS) || null;

  return {
    fieldType: inferFieldType(field, config.defaultFieldType),
    recipientName,
    recipientRole,
    profileContext: null,
    extraContext,
    charLimit: null,
  };
}

function makeConversationExtractor(
  config: ConversationExtractorConfig
): PlatformExtractor {
  return {
    key: config.key,

    getComposeBoundary(field) {
      return findClosestMatch(field, config.composeBoundarySelectors) ?? field.parentElement ?? field;
    },

    extractFieldContext(field, _dialogRoot, composeBoundary) {
      return buildConversationFieldContext(field, composeBoundary, config);
    },
  };
}

const MESSENGER_BOUNDARIES = [
  '[role="dialog"]',
  '[role="main"]',
  '[aria-label*="Conversation" i]',
  "section",
  "article",
];

const FACEBOOK_BOUNDARIES = [
  '[role="dialog"]',
  '[data-pagelet*="Chat"]',
  '[aria-label*="Conversation" i]',
  '[role="complementary"]',
  '[role="main"]',
  "section",
  "article",
];

const SLACK_BOUNDARIES = [
  '[data-qa="message_input"]',
  '[role="main"]',
  "section",
];

const DISCORD_BOUNDARIES = [
  '[aria-label*="Messages" i]',
  '[role="main"]',
  "section",
];

const EMAIL_BOUNDARIES = [
  '[role="dialog"]',
  '[role="main"]',
  "section",
  "article",
  "form",
];

const SOCIAL_THREAD_BOUNDARIES = [
  '[role="dialog"]',
  "article",
  "main",
  "section",
];

export const messengerExtractor = makeConversationExtractor({
  key: "messenger",
  defaultFieldType: "[DM_MESSAGE]",
  composeBoundarySelectors: MESSENGER_BOUNDARIES,
  threadRootSelectors: ['[role="main"]', ...MESSENGER_BOUNDARIES],
  captureRole: true,
});

export const facebookExtractor = makeConversationExtractor({
  key: "facebook",
  defaultFieldType: "[DM_MESSAGE]",
  composeBoundarySelectors: FACEBOOK_BOUNDARIES,
  threadRootSelectors: ['[role="main"]', ...FACEBOOK_BOUNDARIES],
  captureRole: true,
});

export const instagramExtractor = makeConversationExtractor({
  key: "instagram",
  defaultFieldType: "[COMMENT]",
  composeBoundarySelectors: SOCIAL_THREAD_BOUNDARIES,
  threadRootSelectors: ["article", "main", "section"],
});

export const threadsExtractor = makeConversationExtractor({
  key: "threads",
  defaultFieldType: "[POST_COMPOSE]",
  composeBoundarySelectors: SOCIAL_THREAD_BOUNDARIES,
  threadRootSelectors: ["main", "article", "section"],
});

export const twitterExtractor = makeConversationExtractor({
  key: "twitter",
  defaultFieldType: "[POST_COMPOSE]",
  composeBoundarySelectors: SOCIAL_THREAD_BOUNDARIES,
  threadRootSelectors: ["main", "article", "section"],
});

export const redditExtractor = makeConversationExtractor({
  key: "reddit",
  defaultFieldType: "[COMMENT]",
  composeBoundarySelectors: SOCIAL_THREAD_BOUNDARIES,
  threadRootSelectors: ["main", "article", "section"],
});

export const youtubeExtractor = makeConversationExtractor({
  key: "youtube",
  defaultFieldType: "[COMMENT]",
  composeBoundarySelectors: SOCIAL_THREAD_BOUNDARIES,
  threadRootSelectors: ["main", "article", "section"],
});

export const slackExtractor = makeConversationExtractor({
  key: "slack",
  defaultFieldType: "[DM_MESSAGE]",
  composeBoundarySelectors: SLACK_BOUNDARIES,
  threadRootSelectors: ['[role="main"]', ...SLACK_BOUNDARIES],
  captureRole: true,
});

export const discordExtractor = makeConversationExtractor({
  key: "discord",
  defaultFieldType: "[DM_MESSAGE]",
  composeBoundarySelectors: DISCORD_BOUNDARIES,
  threadRootSelectors: ['[role="main"]', ...DISCORD_BOUNDARIES],
  captureRole: true,
});

export const gmailExtractor = makeConversationExtractor({
  key: "gmail",
  defaultFieldType: "[EMAIL_BODY]",
  composeBoundarySelectors: ['[role="dialog"]', "td.Ar.Au", "form"],
  threadRootSelectors: ['[role="main"]', "main", "section", "article"],
  audienceRootSelectors: ['[role="dialog"]', "form"],
});

export const outlookExtractor = makeConversationExtractor({
  key: "outlook",
  defaultFieldType: "[EMAIL_BODY]",
  composeBoundarySelectors: EMAIL_BOUNDARIES,
  threadRootSelectors: ['[role="main"]', "main", "section", "article"],
  audienceRootSelectors: ['[role="dialog"]', "form", '[role="main"]'],
});
