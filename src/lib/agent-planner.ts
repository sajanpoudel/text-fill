import type { InteractiveElementSnapshot } from "./browser-observation.ts";
import type { CandidateScanItem } from "./candidate-scan.ts";

export type PlannerStructuredExtraction = {
  data?: Record<string, unknown>;
  matchedFields?: string[];
  unmatchedFields?: string[];
  headings?: string[];
  text?: string;
};

export type PlannerFieldTarget = {
  selector: string;
  platform?: string;
  fieldType?: string;
  charLimit?: number;
};

export type PlannerContextStep = {
  stepIndex: number;
  role: string;
  content: string;
};

export type PlannerBatchItem = {
  targetUrl: string;
  targetName: string;
  generatedText?: string;
  targetHeadline?: string;
};

export type LinkedInProfileObservation = {
  targetUrl: string;
  targetName?: string | null;
  headline?: string | null;
  summary?: string | null;
};

export type LinkedInConnectDraftResult = {
  items: PlannerBatchItem[];
  source: "model" | "heuristic";
};

export type BootstrapPlannerObservation = {
  goal: string;
  platformHint?: string;
  pageUrl?: string;
  interactiveSummary?: string;
  accessibilitySummary?: string;
  interactiveElements?: InteractiveElementSnapshot[];
  structured?: PlannerStructuredExtraction | null;
};

export type PlannerContextSnapshot = {
  goal: string;
  platformHint?: string;
  latestSummary?: string;
  recentSteps: PlannerContextStep[];
};

export type PlannerConnectBatchPayload = {
  actionType: "create_task_batch";
  batchType: "linkedin_connect";
  dailyLimit: number;
  items: PlannerBatchItem[];
};

export type PlannerDraftInsertPayload = {
  actionType: "insert_draft";
  generatedText: string;
  fieldTarget: PlannerFieldTarget;
  verifyText: string;
  targetName?: string;
  pageUrl?: string;
};

export type PlannerDecision =
  | {
      kind: "request_approval";
      strategicPlan: string;
      tacticalPlan: string;
      approvalKind: "connect";
      title: string;
      reason: string;
      generatedText?: string;
      payload: PlannerConnectBatchPayload;
    }
  | {
      kind: "request_approval";
      strategicPlan: string;
      tacticalPlan: string;
      approvalKind: "draft_insert";
      title: string;
      reason: string;
      generatedText?: string;
      payload: PlannerDraftInsertPayload;
    }
  | {
      kind: "complete";
      strategicPlan: string;
      tacticalPlan: string;
      summary: string;
    };

export type LinkedInSearchCollectionDecision =
  | PlannerDecision
  | {
      kind: "collect_more";
      strategicPlan: string;
      tacticalPlan: string;
      requestedCount: number;
      accumulatedItems: PlannerBatchItem[];
      nextPageUrl: string;
    };

type LinkedInOutreachFocus = {
  requiresRecruitingRole: boolean;
  specialtyMatchers: string[];
};

const DIRECT_DRAFT_PLATFORM_SET = new Set([
  "gmail",
  "outlook",
  "messenger",
  "facebook",
  "twitter",
  "threads",
  "instagram",
  "youtube",
  "reddit",
  "slack",
  "discord",
  "canvas",
  "linkedin",
]);

export function inferPlannerPlatformFromUrl(
  pageUrl: string | undefined
): string | undefined {
  const raw = normalizeText(pageUrl);
  if (!raw) return undefined;

  try {
    const url = new URL(raw);
    const hostname = url.hostname.toLowerCase();
    if (/(\.|^)linkedin\.com$/.test(hostname)) return "linkedin";
    if (/(\.|^)mail\.google\.com$/.test(hostname)) return "gmail";
    if (/(\.|^)outlook\.office\.com$/.test(hostname) || /(\.|^)outlook\.live\.com$/.test(hostname)) {
      return "outlook";
    }
    if (/(\.|^)slack\.com$/.test(hostname)) return "slack";
    if (/(\.|^)discord\.com$/.test(hostname)) return "discord";
    if (/(\.|^)messenger\.com$/.test(hostname)) return "messenger";
    if (/(\.|^)facebook\.com$/.test(hostname)) return "facebook";
    if (/(\.|^)x\.com$/.test(hostname) || /(\.|^)twitter\.com$/.test(hostname)) {
      return "twitter";
    }
    if (/(\.|^)threads\.net$/.test(hostname)) return "threads";
    if (/(\.|^)instagram\.com$/.test(hostname)) return "instagram";
    if (/(\.|^)youtube\.com$/.test(hostname)) return "youtube";
    if (/(\.|^)reddit\.com$/.test(hostname)) return "reddit";
    if (/(\.|^)instructure\.com$/.test(hostname) || hostname.startsWith("canvas.")) {
      return "canvas";
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function extractAudienceNameFromPlannerContext(
  context: string | undefined
): string | undefined {
  if (!context) return undefined;
  const match = context.match(/^Audience:\s*(.+)$/m);
  if (!match?.[1]) return undefined;
  return match[1].split(/\s+—\s+/)[0].trim() || undefined;
}

type ScoredCandidateScanItem = CandidateScanItem & {
  matchScore: number;
  originalIndex: number;
};

const LINKEDIN_RECRUITING_ROLE_MATCHERS = [
  "recruit",
  "sourc",
  "talent",
  "staffing",
  "hiring",
];

const LINKEDIN_SPECIALTY_GROUPS = [
  {
    triggers: [
      "software",
      "engineering",
      "technical",
      "tech",
      "developer",
      "backend",
      "front end",
      "frontend",
      "full stack",
      "full-stack",
      "platform",
      "infrastructure",
    ],
    matchers: [
      "software",
      "engineering",
      "technical",
      "tech",
      "developer",
      "backend",
      "front end",
      "frontend",
      "full stack",
      "full-stack",
      "platform",
      "infrastructure",
      "swe",
    ],
  },
  {
    triggers: [
      "data",
      "analytics",
      "machine learning",
      "ml",
      "ai",
      "artificial intelligence",
    ],
    matchers: [
      "data",
      "analytics",
      "machine learning",
      "ml",
      " ai ",
      "artificial intelligence",
      "genai",
    ],
  },
  {
    triggers: ["product", "design", "designer", "ux", "ui"],
    matchers: ["product", "design", "designer", "ux", "ui"],
  },
] as const;

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function clampCount(value: number, fallback: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.round(value)));
}

function normalizeForMatching(value: string): string {
  return ` ${value.trim().toLowerCase().replace(/\s+/g, " ")} `;
}

function buildLinkedInOutreachFocus(goal: string): LinkedInOutreachFocus {
  const normalizedGoal = normalizeForMatching(goal);
  const specialtyMatchers = LINKEDIN_SPECIALTY_GROUPS.flatMap((group) =>
    group.triggers.some((trigger) => normalizedGoal.includes(` ${trigger} `))
      ? group.matchers
      : []
  );

  return {
    requiresRecruitingRole: LINKEDIN_RECRUITING_ROLE_MATCHERS.some((matcher) =>
      normalizedGoal.includes(matcher)
    ),
    specialtyMatchers: Array.from(new Set(specialtyMatchers)),
  };
}

function matchesLinkedInOutreachFocus(args: {
  goal: string;
  headline?: string | null;
}): boolean {
  const headline = normalizeText(args.headline);
  if (!headline) {
    return true;
  }

  const focus = buildLinkedInOutreachFocus(args.goal);
  const normalizedHeadline = normalizeForMatching(headline);

  if (
    focus.requiresRecruitingRole &&
    !LINKEDIN_RECRUITING_ROLE_MATCHERS.some((matcher) =>
      normalizedHeadline.includes(matcher)
    )
  ) {
    return false;
  }

  if (
    focus.specialtyMatchers.length > 0 &&
    !focus.specialtyMatchers.some((matcher) =>
      normalizedHeadline.includes(` ${matcher} `)
    )
  ) {
    return false;
  }

  return true;
}

function scoreLinkedInOutreachMatch(args: {
  goal: string;
  headline?: string | null;
}): number {
  const headline = normalizeText(args.headline);
  if (!headline) {
    return 0;
  }

  const focus = buildLinkedInOutreachFocus(args.goal);
  const normalizedHeadline = normalizeForMatching(headline);
  let score = 0;

  if (
    LINKEDIN_RECRUITING_ROLE_MATCHERS.some((matcher) =>
      normalizedHeadline.includes(matcher)
    )
  ) {
    score += focus.requiresRecruitingRole ? 4 : 1;
  } else if (focus.requiresRecruitingRole) {
    return -1;
  }

  if (focus.specialtyMatchers.length > 0) {
    const specialtyHits = focus.specialtyMatchers.filter((matcher) =>
      normalizedHeadline.includes(` ${matcher} `)
    ).length;
    if (specialtyHits === 0) {
      return -1;
    }
    score += specialtyHits * 2;
  }

  return score;
}

function buildPlannerBatchItem(args: {
  targetName: string;
  targetUrl: string;
  targetHeadline?: string | null;
}): PlannerBatchItem {
  const targetHeadline = normalizeText(args.targetHeadline);
  const generatedText = buildHeuristicLinkedInConnectNote(
    args.targetName,
    targetHeadline
  );
  return {
    targetUrl: args.targetUrl,
    targetName: args.targetName,
    generatedText,
    ...(targetHeadline ? { targetHeadline } : {}),
  };
}

function inferTargetName(observation: BootstrapPlannerObservation): string | null {
  const structured = observation.structured?.data;
  return (
    normalizeText(structured?.title) ??
    normalizeText(structured?.name) ??
    observation.structured?.headings?.map(normalizeText).find(Boolean) ??
    inferLinkedInProfileNameFromUrl(observation.pageUrl) ??
    null
  );
}

function inferTargetHeadline(observation: BootstrapPlannerObservation): string | null {
  const structured = observation.structured?.data;
  return (
    normalizeText(structured?.headline) ??
    normalizeText(structured?.summary) ??
    normalizeText(observation.structured?.text) ??
    null
  );
}

function inferLinkedInProfileNameFromUrl(
  pageUrl: string | undefined
): string | null {
  const raw = normalizeText(pageUrl);
  if (!raw) return null;

  try {
    const url = new URL(raw);
    if (!/(\.|^)linkedin\.com$/i.test(url.hostname)) return null;
    const match = url.pathname.match(/^\/in\/([^/?#]+)\/?$/i);
    if (!match?.[1]) return null;

    const tokens = match[1]
      .split("-")
      .map((token) => token.trim())
      .filter(Boolean)
      .filter((token, index, all) => {
        if (index < all.length - 1) return true;
        return !/\d/.test(token);
      })
      .map((token) => token.replace(/[^a-z]/gi, ""))
      .filter(Boolean);

    if (tokens.length === 0) return null;

    return tokens
      .slice(0, 4)
      .map((token) => token.charAt(0).toUpperCase() + token.slice(1).toLowerCase())
      .join(" ");
  } catch {
    return null;
  }
}

export function isLinkedInConnectIntent(goal: string): boolean {
  return /\b(connect|connection requests?|invite|outreach|reach out)\b/i.test(goal);
}

export function isLinkedInProfileContext(
  platformHint: string | undefined,
  pageUrl: string | undefined
): boolean {
  const platform = platformHint ?? inferPlannerPlatformFromUrl(pageUrl);
  return (
    platform === "linkedin" &&
    typeof pageUrl === "string" &&
    /linkedin\.com\/in\//i.test(pageUrl)
  );
}

export function isLinkedInSearchResultsContext(
  platformHint: string | undefined,
  pageUrl: string | undefined
): boolean {
  const platform = platformHint ?? inferPlannerPlatformFromUrl(pageUrl);
  return (
    platform === "linkedin" &&
    typeof pageUrl === "string" &&
    /linkedin\.com\/search\/results\/people/i.test(pageUrl)
  );
}

export function parseRequestedConnectCount(
  goal: string,
  fallback = 5,
  max = 20
): number {
  const numericMatch = goal.match(/\b(\d{1,3})\b/);
  if (!numericMatch) return fallback;
  return clampCount(Number(numericMatch[1]), fallback, max);
}

export function supportsDirectDraftPlatform(
  platformHint: string | undefined,
  pageUrl?: string
): boolean {
  const platform = platformHint ?? inferPlannerPlatformFromUrl(pageUrl);
  return Boolean(platform && DIRECT_DRAFT_PLATFORM_SET.has(platform));
}

export function shouldUseConversationDraftFlow(args: {
  goal: string;
  platformHint?: string;
  pageContext?: string;
  fieldTarget?: PlannerFieldTarget;
  pageUrl?: string;
}): boolean {
  if (!supportsDirectDraftPlatform(args.platformHint, args.pageUrl)) {
    return false;
  }
  if (!args.fieldTarget?.selector || !args.pageContext?.trim()) {
    return false;
  }
  if (
    isLinkedInConnectIntent(args.goal) &&
    (isLinkedInProfileContext(args.platformHint, args.pageUrl) ||
      isLinkedInSearchResultsContext(args.platformHint, args.pageUrl))
  ) {
    return false;
  }
  return true;
}

export function normalizeConversationDraft(
  text: string,
  maxLength: number
): string {
  const normalized = text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function buildDraftVerificationText(
  generatedText: string,
  maxLength = 120
): string {
  const normalized = generatedText.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return normalized.slice(0, maxLength).trimEnd();
}

function getConversationPlatformInstructions(platformHint: string | undefined): string {
  switch (platformHint) {
    case "gmail":
    case "outlook":
      return "Draft a concise, well-structured email reply with natural paragraph breaks.";
    case "slack":
      return "Draft a concise Slack-style work message: clear, direct, and practical.";
    case "discord":
      return "Draft a conversational Discord message that matches the thread tone.";
    case "messenger":
    case "facebook":
    case "instagram":
      return "Draft a natural direct message that sounds human and conversational.";
    case "twitter":
    case "threads":
    case "reddit":
    case "youtube":
      return "Draft a concise reply that fits a public conversation thread and sounds authentic.";
    case "canvas":
      return "Draft a clear response that fits the course discussion or assignment context.";
    case "linkedin":
      return "Draft a professional but human message or comment that uses the page context heavily.";
    default:
      return "Draft a concise reply that fits the current conversation context.";
  }
}

export function buildConversationDraftPrompt(args: {
  goal: string;
  platformHint?: string;
  pageContext: string;
  charLimit?: number | null;
}): { system: string; user: string } {
  const maxLength =
    typeof args.charLimit === "number" && Number.isFinite(args.charLimit)
      ? Math.max(1, Math.min(3000, Math.round(args.charLimit)))
      : 800;
  return {
    system: [
      "You write the exact text to insert into the user's current compose field.",
      getConversationPlatformInstructions(args.platformHint),
      `Keep the draft at or under ${maxLength} characters.`,
      "Use only the provided goal and page context.",
      "Write only the draft text. Do not add quotes, markdown, bullet points, or meta commentary.",
      "If the context is thin, stay brief and avoid inventing facts.",
    ].join(" "),
    user: [
      `Goal:\n${args.goal.trim()}`,
      `Page context:\n${args.pageContext.trim()}`,
    ].join("\n\n"),
  };
}

export function deriveConversationDraftDecision(args: {
  goal: string;
  platformHint?: string;
  pageUrl?: string;
  pageContext: string;
  fieldTarget: PlannerFieldTarget;
  generatedText: string;
}): PlannerDecision {
  const targetName = extractAudienceNameFromPlannerContext(args.pageContext);
  const targetLabel = targetName ?? "the current conversation";
  return {
    kind: "request_approval",
    strategicPlan:
      "Use the captured compose/thread context to prepare one approval-gated draft insertion into the current field instead of queueing an irreversible platform action.",
    tacticalPlan:
      `Prepare a context-aware draft for ${targetLabel} and wait for approval before inserting it into the active compose field.`,
    approvalKind: "draft_insert",
    title: targetName
      ? `Insert approved draft for ${targetName}`
      : "Insert approved draft into the current compose field",
    reason:
      "Autofilling the current compose field changes on-page state and should be reviewed before insertion.",
    generatedText: args.generatedText,
    payload: {
      actionType: "insert_draft",
      generatedText: args.generatedText,
      fieldTarget: args.fieldTarget,
      verifyText: buildDraftVerificationText(args.generatedText),
      ...(targetName ? { targetName } : {}),
      ...(args.pageUrl ? { pageUrl: args.pageUrl } : {}),
    },
  };
}

export function shouldCheckpointPlannerSummary(args: {
  currentStepIndex: number;
  lastSummarizedAtStep: number;
  interval?: number;
}): boolean {
  const interval = clampCount(args.interval ?? 5, 5, 20);
  return args.currentStepIndex - args.lastSummarizedAtStep >= interval;
}

function normalizeLinkedInProfileUrl(value: string | null | undefined): string | null {
  const raw = normalizeText(value);
  if (!raw) return null;

  try {
    const url = new URL(raw, "https://www.linkedin.com");
    if (!/(\.|^)linkedin\.com$/i.test(url.hostname)) {
      return null;
    }
    if (!/^\/in\/[^/?#]+\/?$/i.test(url.pathname)) {
      return null;
    }
    url.search = "";
    url.hash = "";
    const normalizedPath = url.pathname.replace(/\/+$/, "");
    return `${url.origin}${normalizedPath}/`;
  } catch {
    return null;
  }
}

function cleanLinkedInProfileName(value: string | null | undefined): string | null {
  const raw = normalizeText(value);
  if (!raw) return null;

  const normalized = raw
    .split(/\s*[|·•]\s*/)[0]
    .replace(/^view\s+/i, "")
    .replace(/['’]s profile$/i, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized || !/[A-Za-z]/.test(normalized)) {
    return null;
  }

  if (/^(connect|message|follow|more|linkedin|view profile)$/i.test(normalized)) {
    return null;
  }

  const wordCount = normalized.split(/\s+/).length;
  if (wordCount < 2 || wordCount > 6) {
    return null;
  }

  return normalized;
}

export function extractLinkedInSearchCandidates(
  interactiveElements: InteractiveElementSnapshot[] | undefined,
  requestedCount: number
): PlannerBatchItem[] {
  if (!Array.isArray(interactiveElements) || interactiveElements.length === 0) {
    return [];
  }

  const maxCount = clampCount(requestedCount, 5, 20);
  const candidates: PlannerBatchItem[] = [];
  const seenUrls = new Set<string>();

  for (const element of interactiveElements) {
    const targetUrl = normalizeLinkedInProfileUrl(element.href);
    if (!targetUrl || seenUrls.has(targetUrl)) continue;

    const targetName =
      cleanLinkedInProfileName(element.text) ??
      cleanLinkedInProfileName(element.label);
    if (!targetName) continue;

    seenUrls.add(targetUrl);
    candidates.push(buildPlannerBatchItem({ targetUrl, targetName }));

    if (candidates.length >= maxCount) {
      break;
    }
  }

  return candidates;
}

function normalizeLinkedInSearchResultsUrl(
  value: string | null | undefined
): string | null {
  const raw = normalizeText(value);
  if (!raw) return null;

  try {
    const url = new URL(raw, "https://www.linkedin.com");
    if (!/(\.|^)linkedin\.com$/i.test(url.hostname)) {
      return null;
    }
    if (!/^\/search\/results\/people\/?$/i.test(url.pathname)) {
      return null;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function mergePlannerBatchItems(
  existingItems: PlannerBatchItem[],
  newItems: PlannerBatchItem[],
  requestedCount: number
): PlannerBatchItem[] {
  const merged: PlannerBatchItem[] = [];
  const seenUrls = new Set<string>();

  for (const item of [...existingItems, ...newItems]) {
    if (seenUrls.has(item.targetUrl)) continue;
    seenUrls.add(item.targetUrl);
    merged.push(item);
    if (merged.length >= requestedCount) {
      break;
    }
  }

  return merged;
}

function plannerItemsFromScannedCandidates(
  scannedCandidates: CandidateScanItem[] | undefined,
  requestedCount: number,
  goal: string
): PlannerBatchItem[] {
  if (!Array.isArray(scannedCandidates) || scannedCandidates.length === 0) {
    return [];
  }

  const maxCount = clampCount(requestedCount, 5, 20);
  const items: PlannerBatchItem[] = [];
  const seenUrls = new Set<string>();
  const scoredCandidates: ScoredCandidateScanItem[] = scannedCandidates
    .map((candidate, originalIndex) => ({
      ...candidate,
      originalIndex,
      matchScore: scoreLinkedInOutreachMatch({
        goal,
        headline: candidate.headline,
      }),
    }))
    .sort((left, right) => {
      if (right.matchScore !== left.matchScore) {
        return right.matchScore - left.matchScore;
      }
      return left.originalIndex - right.originalIndex;
    });

  for (const candidate of scoredCandidates) {
    const targetUrl = normalizeLinkedInProfileUrl(candidate.targetUrl);
    if (!targetUrl || seenUrls.has(targetUrl)) continue;

    if (candidate.matchScore < 0) {
      continue;
    }

    if (!matchesLinkedInOutreachFocus({
      goal,
      headline: candidate.headline,
    })) {
      continue;
    }

    const targetName = cleanLinkedInProfileName(candidate.targetName);
    if (!targetName) continue;

    seenUrls.add(targetUrl);
    items.push(
      buildPlannerBatchItem({
        targetUrl,
        targetName,
        targetHeadline: candidate.headline,
      })
    );

    if (items.length >= maxCount) {
      break;
    }
  }

  return items;
}

export function extractLinkedInSearchNextPageUrl(
  interactiveElements: InteractiveElementSnapshot[] | undefined,
  currentPageUrl: string | undefined
): string | null {
  if (!Array.isArray(interactiveElements) || interactiveElements.length === 0) {
    return null;
  }

  const currentUrl = normalizeLinkedInSearchResultsUrl(currentPageUrl);

  for (const element of interactiveElements) {
    if (element.disabled) continue;
    const label = (normalizeText(element.text) ?? normalizeText(element.label) ?? "").toLowerCase();
    if (label !== "next" && label !== "next page") {
      continue;
    }

    const nextPageUrl = normalizeLinkedInSearchResultsUrl(element.href);
    if (!nextPageUrl) continue;
    if (currentUrl && nextPageUrl === currentUrl) continue;
    return nextPageUrl;
  }

  return null;
}

function buildLinkedInSearchApprovalDecision(args: {
  requestedCount: number;
  items: PlannerBatchItem[];
}): PlannerDecision {
  const previewNames = args.items
    .slice(0, 3)
    .map((item) => item.targetName)
    .join(", ");
  const countLabel =
    args.items.length >= args.requestedCount
      ? `${args.items.length}`
      : `${args.items.length} of ${args.requestedCount} requested`;

  return {
    kind: "request_approval",
    strategicPlan:
      "Use the collected LinkedIn people-search observations to hand off only the verified visible candidates into the deterministic executor.",
    tacticalPlan:
      `Prepare a ${countLabel}-item LinkedIn connection batch with pre-generated notes from the collected search results (${previewNames}${args.items.length > 3 ? ", and more" : ""}) and wait for explicit approval before queue handoff.`,
    approvalKind: "connect",
    title:
      args.items.length === 1
        ? `Queue LinkedIn connection request for ${args.items[0]?.targetName ?? "this profile"}`
        : `Queue ${countLabel} LinkedIn connection requests from search results`,
    reason:
      "Connection requests are irreversible platform actions and must be approved before queue handoff.",
    payload: {
      actionType: "create_task_batch",
      batchType: "linkedin_connect",
      dailyLimit: args.items.length,
      items: args.items,
    },
  };
}

export function planLinkedInSearchCollectionPass(args: {
  goal: string;
  pageUrl?: string;
  interactiveElements?: InteractiveElementSnapshot[];
  scannedCandidates?: CandidateScanItem[];
  nextPageUrl?: string | null;
  accumulatedItems?: PlannerBatchItem[];
}): LinkedInSearchCollectionDecision {
  const requestedCount = parseRequestedConnectCount(args.goal);
  const currentItems = Array.isArray(args.accumulatedItems) ? args.accumulatedItems : [];
  const scannedItems = plannerItemsFromScannedCandidates(
    args.scannedCandidates,
    requestedCount,
    args.goal
  );
  const newItems =
    scannedItems.length > 0
      ? scannedItems
      : extractLinkedInSearchCandidates(args.interactiveElements, requestedCount);
  const accumulatedItems = mergePlannerBatchItems(
    currentItems,
    newItems,
    requestedCount
  );

  if (accumulatedItems.length >= requestedCount) {
    return buildLinkedInSearchApprovalDecision({
      requestedCount,
      items: accumulatedItems,
    });
  }

  const nextPageUrl =
    normalizeLinkedInSearchResultsUrl(args.nextPageUrl) ??
    extractLinkedInSearchNextPageUrl(args.interactiveElements, args.pageUrl);
  if (nextPageUrl) {
    return {
      kind: "collect_more",
      strategicPlan:
        "Continue walking LinkedIn search results until enough distinct recruiter profiles have been collected or pagination ends.",
      tacticalPlan:
        `Collected ${accumulatedItems.length} of ${requestedCount} requested profiles so far. Navigate to the next LinkedIn search results page and continue collecting candidates before asking for approval.`,
      requestedCount,
      accumulatedItems,
      nextPageUrl,
    };
  }

  if (accumulatedItems.length > 0) {
    return buildLinkedInSearchApprovalDecision({
      requestedCount,
      items: accumulatedItems,
    });
  }

  return {
    kind: "complete",
    strategicPlan:
      "No high-confidence recruiter candidates were found on the visible LinkedIn search results, so the run should stop safely.",
    tacticalPlan:
      "Complete the run with a summary instead of creating an approval or deterministic queue handoff.",
    summary:
      "Completed the bootstrap observation pass for this LinkedIn search flow, but no usable recruiter profile targets were identified for approval.",
  };
}

export function buildHeuristicLinkedInConnectNote(
  targetName: string,
  targetHeadline?: string | null
): string {
  const firstName = targetName.trim().split(/\s+/)[0] ?? targetName.trim();
  const headline = normalizeText(targetHeadline);
  const headlineClause = headline
    ? ` Your work in ${headline.toLowerCase()} stood out to me.`
    : "";
  const note = `Hi ${firstName}, I came across your profile and wanted to connect.${headlineClause} I’d love to stay in touch.`;
  return note.slice(0, 300).trim();
}

export function enrichLinkedInSearchBatchItems(args: {
  items: PlannerBatchItem[];
  profileObservations: LinkedInProfileObservation[];
}): PlannerBatchItem[] {
  const observationsByUrl = new Map<string, LinkedInProfileObservation>();

  for (const observation of args.profileObservations) {
    const normalizedUrl = normalizeLinkedInProfileUrl(observation.targetUrl);
    if (!normalizedUrl) continue;
    observationsByUrl.set(normalizedUrl, observation);
  }

  return args.items.map((item) => {
    const observation = observationsByUrl.get(item.targetUrl);
    if (!observation) {
      return item;
    }

    const targetName =
      cleanLinkedInProfileName(observation.targetName) ?? item.targetName;
    const noteContext =
      normalizeText(observation.headline) ??
      normalizeText(observation.summary) ??
      null;

    return {
      ...item,
      targetName,
      generatedText: buildHeuristicLinkedInConnectNote(targetName, noteContext),
      ...(noteContext ? { targetHeadline: noteContext } : {}),
    };
  });
}

function clampLinkedInConnectNote(note: string): string {
  const normalized = note.replace(/\s+/g, " ").trim();
  if (normalized.length <= 300) {
    return normalized;
  }
  const truncated = normalized.slice(0, 300);
  return truncated.replace(/\s+\S*$/, "").trim() || truncated.trim();
}

function extractJsonObjectCandidate(value: string): string | null {
  const fencedMatch = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  const firstBrace = value.indexOf("{");
  const lastBrace = value.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return value.slice(firstBrace, lastBrace + 1);
  }

  const firstBracket = value.indexOf("[");
  const lastBracket = value.lastIndexOf("]");
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    return value.slice(firstBracket, lastBracket + 1);
  }

  return null;
}

export function buildLinkedInConnectDraftPrompt(args: {
  goal: string;
  items: PlannerBatchItem[];
}): { system: string; user: string } {
  const candidateLines = args.items.map((item, index) => {
    const headline = normalizeText(item.targetHeadline);
    return [
      `Candidate ${index + 1}:`,
      `- targetUrl: ${item.targetUrl}`,
      `- targetName: ${item.targetName}`,
      `- targetHeadline: ${headline ?? "unknown"}`,
      `- currentDraft: ${item.generatedText ?? "none"}`,
    ].join("\n");
  });

  return {
    system: [
      "You write concise LinkedIn connection notes.",
      "Return JSON only.",
      "Each note must be 300 characters or fewer.",
      "Use only the provided goal and candidate profile details.",
      "Write natural, specific notes. Avoid generic recruiter-template language.",
      'Return exactly this shape: {"drafts":[{"targetUrl":"...","generatedText":"..."}]}',
    ].join(" "),
    user: [
      `Goal:\n${args.goal.trim()}`,
      "Candidates:",
      ...candidateLines,
      "Requirements:",
      "- Keep every generatedText at or under 300 characters.",
      "- Preserve the provided targetUrl exactly.",
      "- If profile detail is limited, keep the note brief rather than inventing facts.",
    ].join("\n\n"),
  };
}

export function applyLinkedInConnectDrafts(args: {
  items: PlannerBatchItem[];
  responseText: string;
}): LinkedInConnectDraftResult {
  const jsonCandidate = extractJsonObjectCandidate(args.responseText);
  if (!jsonCandidate) {
    return { items: args.items, source: "heuristic" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonCandidate);
  } catch {
    return { items: args.items, source: "heuristic" };
  }

  const drafts =
    Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { drafts?: unknown[] })?.drafts)
        ? (parsed as { drafts: unknown[] }).drafts
        : null;
  if (!drafts || drafts.length === 0) {
    return { items: args.items, source: "heuristic" };
  }

  const draftsByUrl = new Map<string, string>();
  for (const draft of drafts) {
    const targetUrl = normalizeLinkedInProfileUrl(
      typeof draft === "object" && draft
        ? (draft as { targetUrl?: string }).targetUrl
        : null
    );
    const generatedText = clampLinkedInConnectNote(
      typeof draft === "object" && draft
        ? String((draft as { generatedText?: string }).generatedText ?? "")
        : ""
    );
    if (!targetUrl || !generatedText) continue;
    draftsByUrl.set(targetUrl, generatedText);
  }

  if (draftsByUrl.size === 0) {
    return { items: args.items, source: "heuristic" };
  }

  const items = args.items.map((item) => {
    const targetUrl = normalizeLinkedInProfileUrl(item.targetUrl) ?? item.targetUrl;
    const generatedText = draftsByUrl.get(targetUrl);
    if (!generatedText) {
      return item;
    }
    return {
      ...item,
      generatedText,
    };
  });

  return { items, source: "model" };
}

export function rankLinkedInPlannerBatchItemsForEnrichment(args: {
  goal: string;
  items: PlannerBatchItem[];
}): PlannerBatchItem[] {
  return [...args.items].sort((left, right) => {
    const rightScore = scoreLinkedInOutreachMatch({
      goal: args.goal,
      headline: right.targetHeadline,
    });
    const leftScore = scoreLinkedInOutreachMatch({
      goal: args.goal,
      headline: left.targetHeadline,
    });

    if (rightScore !== leftScore) {
      return rightScore - leftScore;
    }

    return 0;
  });
}

function formatPlannerStepForSummary(step: PlannerContextStep): string {
  const roleLabel = step.role.replace(/_/g, " ");
  return `${roleLabel}: ${truncate(step.content.trim(), 140)}`;
}

export function buildRollingPlannerSummary(
  snapshot: PlannerContextSnapshot
): string {
  const recentSteps = snapshot.recentSteps
    .map(formatPlannerStepForSummary)
    .filter(Boolean);
  const contextPrefix = snapshot.latestSummary
    ? `Earlier progress: ${truncate(snapshot.latestSummary.trim(), 220)}`
    : `Goal: ${truncate(snapshot.goal.trim(), 180)}`;

  if (recentSteps.length === 0) {
    return `${contextPrefix}. No new planner steps were recorded since the last summary.`;
  }

  return `${contextPrefix}. Recent progress: ${recentSteps.join(" | ")}`.trim();
}

export function deriveBootstrapPlannerDecision(
  observation: BootstrapPlannerObservation
): PlannerDecision {
  const goal = observation.goal.trim();
  const strategicBase =
    "Use the bootstrap page observations to decide whether the run can safely hand off to an existing deterministic executor or should stop with a summary.";

  if (
    isLinkedInConnectIntent(goal) &&
    isLinkedInSearchResultsContext(observation.platformHint, observation.pageUrl)
  ) {
    const decision = planLinkedInSearchCollectionPass({
      goal,
      pageUrl: observation.pageUrl,
      interactiveElements: observation.interactiveElements,
    });
    if (decision.kind !== "collect_more") {
      return decision;
    }
  }

  if (
    isLinkedInConnectIntent(goal) &&
    isLinkedInProfileContext(observation.platformHint, observation.pageUrl)
  ) {
    const targetName = inferTargetName(observation);
    if (targetName && observation.pageUrl) {
      const headline = inferTargetHeadline(observation);
      const generatedText = buildHeuristicLinkedInConnectNote(targetName, headline);
      return {
        kind: "request_approval",
        strategicPlan:
          `${strategicBase} This run is a LinkedIn profile connect flow, so the next safe milestone is approval for a single queued connection request.`,
        tacticalPlan:
          `Prepare a one-item LinkedIn connection batch for ${targetName} and wait for explicit approval before creating the deterministic queue handoff.`,
        approvalKind: "connect",
        title: `Queue LinkedIn connection request for ${targetName}`,
        reason:
          "Connection requests are irreversible platform actions and must be approved before queue handoff.",
        generatedText,
        payload: {
          actionType: "create_task_batch",
          batchType: "linkedin_connect",
          dailyLimit: 1,
          items: [
            {
              targetUrl: observation.pageUrl,
              targetName,
              generatedText,
            },
          ],
        },
      };
    }
  }

  return {
    kind: "complete",
    strategicPlan:
      `${strategicBase} The current bootstrap pass did not reach a high-confidence irreversible action, so the run should stop after summarizing what was observed.`,
    tacticalPlan:
      "Complete the run with an observation summary and wait for a later planner slice to add richer multi-platform tactics.",
    summary:
      "Completed the bootstrap observation pass and produced a safe summary. No approval-gated handoff was created for this run.",
  };
}
