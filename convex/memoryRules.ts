export type MemoryLike = {
  text: string;
  tags?: string[];
  platform?: string;
};

const GENERIC_ORG_TAGS = new Set([
  "work",
  "social",
  "personal",
  "persona",
  "previous employer",
  "previous employment",
  "future employment",
  "new role",
  "current role",
  "communication style",
  "networking",
  "building",
  "values",
  "dialogue",
  "familiarity",
  "engineer",
  "onboarding",
]);

const PLACEHOLDER_RE = /\[[^\]]+\]|<[^>]+>|{{[^}]+}}/;
const TITLE_CASE_ENTITY_RE =
  /\b[A-Z][A-Za-z0-9&.'-]+(?:\s+[A-Z][A-Za-z0-9&.'-]+){0,3}\b/;

const GENERIC_MEMORY_PATTERNS = [
  /\bfamiliar with the recipient'?s work\b/i,
  /\bfamiliar with (?:their|the) work\b/i,
  /\binterested in connecting\b/i,
  /\bvalues and dialogue\b/i,
  /\bconnecting through\b/i,
  /\blook forward to crossing paths\b/i,
  /\bintroduce (?:myself|themself|themselves)\b/i,
  /\brecipient\b/i,
];

const PERSONA_SIGNAL_RE =
  /\b(?:concise|direct|warm|friendly|casual|formal|playful|dry|blunt|structured|brief|detailed|thoughtful|empathetic|uses|avoids|prefers|likes to write|writes in)\b/i;

const WORK_SIGNAL_RE =
  /\b(?:engineer|developer|designer|recruiter|founder|manager|leader|student|intern|advisor|operator|role|title|career|company|employer|worked|joining|onboarding|experience|background|skill|project)\b/i;

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function cleanupEntity(value: string): string {
  return collapseWhitespace(value)
    .replace(/^(?:the)\s+/i, "")
    .replace(/\s+(?:team|company)$/i, "")
    .replace(/[.,;:!?]+$/g, "")
    .trim();
}

function normalizeKey(value: string): string {
  return cleanupEntity(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function extractLikelyOrganizationTag(tags: string[] = []): string | null {
  for (const rawTag of tags) {
    const tag = rawTag.trim();
    if (!tag) continue;
    const lower = tag.toLowerCase();
    if (GENERIC_ORG_TAGS.has(lower)) continue;
    if (PLACEHOLDER_RE.test(tag)) continue;
    if (
      tag.includes(".") ||
      /[A-Z]/.test(tag) ||
      /^[A-Z0-9&][A-Za-z0-9&.,'() -]{1,60}$/.test(tag)
    ) {
      return cleanupEntity(tag);
    }
  }
  return null;
}

function extractMatch(text: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const captured = match?.[1];
    if (!captured) continue;
    const cleaned = cleanupEntity(captured);
    if (cleaned && !PLACEHOLDER_RE.test(cleaned)) {
      return cleaned;
    }
  }
  return null;
}

function extractPastEmployer(text: string, tags: string[] = []): string | null {
  const fromText = extractMatch(text, [
    /(?:previously worked|worked previously|has experience|had experience|spent time)\s+(?:at|with)\s+([A-Z][A-Za-z0-9&.,'() -]{1,80})/i,
    /background(?:\s+in\s+[a-z ]+)?\s+at\s+([A-Z][A-Za-z0-9&.,'() -]{1,80})/i,
    /(?:worked|was)\s+at\s+([A-Z][A-Za-z0-9&.,'() -]{1,80})/i,
    /time at\s+([A-Z][A-Za-z0-9&.,'() -]{1,80})/i,
  ]);
  if (fromText) return fromText;

  const lowerTags = tags.map((tag) => tag.toLowerCase());
  if (
    lowerTags.includes("previous employer") ||
    lowerTags.includes("previous employment")
  ) {
    return extractLikelyOrganizationTag(tags);
  }
  return null;
}

function extractFutureEmployer(text: string, tags: string[] = []): string | null {
  const fromText = extractMatch(text, [
    /will be joining\s+(?:the\s+)?([A-Z][A-Za-z0-9&.,'() -]{1,80}?)(?:\s+team)?(?:\s+in\b|[.!?]|$)/i,
    /is joining\s+(?:the\s+)?([A-Z][A-Za-z0-9&.,'() -]{1,80}?)(?:\s+team)?(?:\s+in\b|[.!?]|$)/i,
    /joining\s+(?:the\s+)?([A-Z][A-Za-z0-9&.,'() -]{1,80}?)(?:\s+team)?(?:\s+in\b|[.!?]|$)/i,
    /onboarding(?:\s+as\s+.+?)?\s+at\s+([A-Z][A-Za-z0-9&.,'() -]{1,80})/i,
    /starting(?:\s+.+?)?\s+at\s+([A-Z][A-Za-z0-9&.,'() -]{1,80})/i,
  ]);
  if (fromText) return fromText;

  const lowerTags = tags.map((tag) => tag.toLowerCase());
  if (
    lowerTags.includes("future employment") ||
    lowerTags.includes("new role")
  ) {
    return extractLikelyOrganizationTag(tags);
  }
  return null;
}

function extractCurrentEmployer(text: string, tags: string[] = []): string | null {
  const fromText = extractMatch(text, [
    /works\s+at\s+([A-Z][A-Za-z0-9&.,'() -]{1,80})/i,
    /is\s+(?:an?\s+)?[A-Za-z ,/-]{2,50}\s+at\s+([A-Z][A-Za-z0-9&.,'() -]{1,80})/i,
  ]);
  if (fromText) return fromText;

  const lowerTags = tags.map((tag) => tag.toLowerCase());
  if (lowerTags.includes("current role")) {
    return extractLikelyOrganizationTag(tags);
  }
  return null;
}

export function sanitizeMemoryText(text: string): string | null {
  const cleaned = collapseWhitespace(text).replace(/[.,;:!?]+$/g, "").trim();
  if (!cleaned || cleaned.length < 3) return null;
  if (PLACEHOLDER_RE.test(cleaned)) return null;
  return `${cleaned}.`;
}

export function normalizeMemoryText(text: string): string {
  return collapseWhitespace(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function inferMemoryIdentity(memory: MemoryLike): string | null {
  const text = sanitizeMemoryText(memory.text);
  if (!text) return null;

  const platform = (memory.platform ?? "").toLowerCase();
  const tags = memory.tags ?? [];

  if (platform === "work") {
    const pastEmployer = extractPastEmployer(text, tags);
    if (pastEmployer) {
      return `work:past-employer:${normalizeKey(pastEmployer)}`;
    }

    const futureEmployer = extractFutureEmployer(text, tags);
    if (futureEmployer) {
      return `work:future-employer:${normalizeKey(futureEmployer)}`;
    }

    const currentEmployer = extractCurrentEmployer(text, tags);
    if (currentEmployer) {
      return `work:current-employer:${normalizeKey(currentEmployer)}`;
    }
  }

  return null;
}

export function getMemoryFingerprint(memory: MemoryLike): string {
  return inferMemoryIdentity(memory) ?? normalizeMemoryText(memory.text);
}

export function canonicalizeMemoryText(memory: MemoryLike): string | null {
  const text = sanitizeMemoryText(memory.text);
  if (!text) return null;

  const tags = memory.tags ?? [];
  const category = (memory.platform ?? "").toLowerCase();

  if (category === "work") {
    const futureEmployer = extractFutureEmployer(text, tags);
    if (futureEmployer) {
      return `User will be joining ${futureEmployer}.`;
    }

    const pastEmployer = extractPastEmployer(text, tags);
    if (pastEmployer) {
      return `User previously worked at ${pastEmployer}.`;
    }
  }

  return text;
}

export function isLowSignalMemory(memory: MemoryLike): boolean {
  const text = sanitizeMemoryText(memory.text);
  if (!text) return true;

  const lower = text.toLowerCase();
  const category = (memory.platform ?? "").toLowerCase();
  const normalized = normalizeMemoryText(text);
  const tokenCount = normalized ? normalized.split(" ").length : 0;
  const tags = memory.tags ?? [];

  if (tokenCount < 2) return true;
  if (GENERIC_MEMORY_PATTERNS.some((pattern) => pattern.test(text))) return true;

  if (category === "persona") {
    if (!PERSONA_SIGNAL_RE.test(text)) return true;
    if (
      /\b(?:values|dialogue|connection|networking|authenticity|genuine)\b/i.test(
        text
      ) &&
      !/\b(?:concise|direct|warm|friendly|formal|casual|structured|brief|detailed)\b/i.test(
        text
      )
    ) {
      return true;
    }
  }

  if (category === "social") {
    if (
      /\b(?:familiar with|followed|admires|recipient|their work|networking)\b/i.test(
        text
      )
    ) {
      return true;
    }
  }

  if (category === "work") {
    const identity = inferMemoryIdentity(memory);
    const hasNamedEntity = TITLE_CASE_ENTITY_RE.test(text);
    const hasWorkSignal = WORK_SIGNAL_RE.test(text);
    if (!identity && !hasNamedEntity && !hasWorkSignal) return true;
  }

  const joinedTags = tags.join(" ").toLowerCase();
  if (
    /\b(?:networking|familiarity|dialogue|values)\b/.test(joinedTags) &&
    category !== "persona"
  ) {
    return true;
  }

  return false;
}

export function scoreMemoryText(text: string): number {
  const cleaned = sanitizeMemoryText(text) ?? collapseWhitespace(text);
  const lower = cleaned.toLowerCase();
  return (
    normalizeMemoryText(cleaned).split(" ").filter(Boolean).length +
    (/\b(?:at|with)\s+[A-Z]/.test(cleaned) ? 3 : 0) +
    (/\b(?:previously worked|will be joining|works at|joining|onboarding)\b/i.test(cleaned) ? 3 : 0) +
    (/\d/.test(cleaned) ? 1 : 0) +
    (PLACEHOLDER_RE.test(cleaned) ? -10 : 0) +
    (lower.includes("background in building at") ? -1 : 0)
  );
}
