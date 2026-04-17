type StructuredSettingsContext = Record<string, unknown> & {
  work?: string;
  social?: string;
  always?: string;
};

type JobApplicationFieldTarget = {
  platform?: string | null;
  fieldType?: string | null;
} | null;

type JobApplicationWorkItem = {
  pageUrl?: string | null;
  targetUrl?: string | null;
  itemGoal?: string | null;
  itemContext?: string | null;
  sourceType?: string | null;
} | null;

type JobApplicationStructuredHint = {
  text?: string | null;
  headings?: string[] | null;
  matchedFields?: string[] | null;
  unmatchedFields?: string[] | null;
} | null;

export interface JobApplicationContextScopeInput {
  goal?: string | null;
  platformHint?: string | null;
  pageUrl?: string | null;
  pageContext?: string | null;
  fieldTarget?: JobApplicationFieldTarget;
  workItems?: JobApplicationWorkItem[] | null;
  structured?: JobApplicationStructuredHint;
}

const JOB_APPLICATION_PLATFORM_KEYS = new Set([
  "greenhouse",
  "ashby",
  "workday",
  "lever",
]);

const COMMUNICATION_PLATFORM_KEYS = new Set([
  "gmail",
  "outlook",
  "slack",
  "discord",
  "messenger",
  "facebook",
  "twitter",
  "threads",
  "instagram",
  "reddit",
  "youtube",
]);

const JOB_APPLICATION_FIELD_TYPES = new Set([
  "[cover_letter]",
  "[why_interested]",
  "[experience]",
  "[skills]",
  "[additional_info]",
]);

const APPLICATION_INTENT_REGEX =
  /\b(apply|application|applying|cover letter|easy apply|autofill|prefill|work authorization|visa|sponsorship|eeo|equal employment opportunity|veteran status|disability status|demographics|security clearance|background check|salary expectation|compensation expectation|earliest start date)\b/i;

const APPLICATION_FORM_REGEX =
  /\b(application form|job application|employment application|required application fields?|employer questions?|professional links|work authorization|employment type|work modality|security clearance|application source|consents?|acknowledgments?|how did you hear about us|resume upload|cover letter|disability status|veteran status|demographics|candidate profile)\b/i;

const APPLICATION_PATH_REGEX =
  /\b(apply|application|candidate|careers?|positions?|opportunities?|myworkdayjobs|greenhouse|lever|ashby|jobvite|smartrecruiters|icims)\b/i;

function safeParseUrl(raw: string | null | undefined): URL | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed);
  } catch {
    return null;
  }
}

function detectPlatformKeyFromHostname(hostname: string | null | undefined): string {
  const normalized = String(hostname ?? "").trim().toLowerCase();
  if (!normalized) return "general";
  if (normalized.includes("mail.google.com")) return "gmail";
  if (
    normalized.includes("outlook.live.com") ||
    normalized.includes("outlook.office.com") ||
    normalized.includes("outlook.office365.com")
  ) {
    return "outlook";
  }
  if (normalized.includes("linkedin.com")) return "linkedin";
  if (normalized.includes("slack.com")) return "slack";
  if (normalized.includes("discord.com")) return "discord";
  if (normalized.includes("messenger.com")) return "messenger";
  if (normalized.includes("facebook.com")) return "facebook";
  if (normalized.includes("twitter.com") || normalized.includes("x.com")) return "twitter";
  if (normalized.includes("threads.net")) return "threads";
  if (normalized.includes("instagram.com")) return "instagram";
  if (normalized.includes("reddit.com")) return "reddit";
  if (normalized.includes("youtube.com")) return "youtube";
  if (normalized.includes("greenhouse.io")) return "greenhouse";
  if (normalized.includes("ashbyhq.com")) return "ashby";
  if (normalized.includes("myworkdayjobs.com") || normalized.includes("workday.com")) return "workday";
  if (normalized.includes("lever.co")) return "lever";
  return "general";
}

function isLinkedInJobsUrl(url: URL): boolean {
  return (
    detectPlatformKeyFromHostname(url.hostname) === "linkedin" &&
    /\/jobs(\/|$)/i.test(url.pathname)
  );
}

function normalizePlatformHint(platformHint: string | null | undefined): string {
  return String(platformHint ?? "").trim().toLowerCase();
}

function collectApplicationScopeUrls(
  input: JobApplicationContextScopeInput
): URL[] {
  const urls: URL[] = [];
  const seen = new Set<string>();

  const push = (raw: string | null | undefined) => {
    const parsed = safeParseUrl(raw);
    if (!parsed) return;
    const href = parsed.toString();
    if (seen.has(href)) return;
    seen.add(href);
    urls.push(parsed);
  };

  push(input.pageUrl);

  for (const item of input.workItems ?? []) {
    if (!item) continue;
    push(item.pageUrl);
    push(item.targetUrl);
  }

  return urls;
}

function collectApplicationScopeText(
  input: JobApplicationContextScopeInput
): string {
  const parts: string[] = [];

  if (typeof input.goal === "string" && input.goal.trim()) {
    parts.push(input.goal.trim());
  }
  if (typeof input.pageContext === "string" && input.pageContext.trim()) {
    parts.push(input.pageContext.trim());
  }
  if (typeof input.fieldTarget?.platform === "string" && input.fieldTarget.platform.trim()) {
    parts.push(input.fieldTarget.platform.trim());
  }
  if (typeof input.fieldTarget?.fieldType === "string" && input.fieldTarget.fieldType.trim()) {
    parts.push(input.fieldTarget.fieldType.trim());
  }
  if (Array.isArray(input.structured?.headings)) {
    parts.push(input.structured.headings.filter(Boolean).join("\n"));
  }
  if (Array.isArray(input.structured?.matchedFields)) {
    parts.push(input.structured.matchedFields.filter(Boolean).join("\n"));
  }
  if (Array.isArray(input.structured?.unmatchedFields)) {
    parts.push(input.structured.unmatchedFields.filter(Boolean).join("\n"));
  }
  if (typeof input.structured?.text === "string" && input.structured.text.trim()) {
    parts.push(input.structured.text.trim());
  }

  for (const item of input.workItems ?? []) {
    if (!item) continue;
    if (typeof item.itemGoal === "string" && item.itemGoal.trim()) {
      parts.push(item.itemGoal.trim());
    }
    if (typeof item.itemContext === "string" && item.itemContext.trim()) {
      parts.push(item.itemContext.trim());
    }
    if (typeof item.sourceType === "string" && item.sourceType.trim()) {
      parts.push(item.sourceType.trim());
    }
  }

  return parts.join("\n").trim();
}

export function shouldIncludeJobApplicationArtifacts(
  input: JobApplicationContextScopeInput
): boolean {
  const normalizedPlatformHint = normalizePlatformHint(input.platformHint);
  const normalizedFieldPlatform = normalizePlatformHint(input.fieldTarget?.platform);
  const normalizedFieldType = normalizePlatformHint(input.fieldTarget?.fieldType);
  const urls = collectApplicationScopeUrls(input);
  const combinedText = collectApplicationScopeText(input);

  const platformKeys = new Set<string>();
  if (normalizedPlatformHint) {
    platformKeys.add(normalizedPlatformHint);
  }
  if (normalizedFieldPlatform) {
    platformKeys.add(normalizedFieldPlatform);
  }
  for (const url of urls) {
    platformKeys.add(detectPlatformKeyFromHostname(url.hostname));
  }

  const hasCommunicationSurface = [...platformKeys].some((platformKey) =>
    COMMUNICATION_PLATFORM_KEYS.has(platformKey)
  );
  const hasKnownJobBoardSurface = [...platformKeys].some((platformKey) =>
    JOB_APPLICATION_PLATFORM_KEYS.has(platformKey)
  );
  const hasLinkedInJobsSurface =
    normalizedPlatformHint === "linkedin" &&
    urls.some((url) => isLinkedInJobsUrl(url));
  const hasApplicationPath = urls.some((url) =>
    APPLICATION_PATH_REGEX.test(url.hostname + url.pathname)
  );
  const hasApplicationIntent = APPLICATION_INTENT_REGEX.test(combinedText);
  const hasResumeUploadIntent =
    /\b(resume|cv|curriculum vitae)\b/i.test(combinedText) &&
    /\b(upload|attach|submit|file input|file upload|set_file_input_files)\b/i.test(
      combinedText
    );
  const hasApplicationFormSignal = APPLICATION_FORM_REGEX.test(combinedText);
  const hasJobApplicationFieldType = JOB_APPLICATION_FIELD_TYPES.has(
    normalizedFieldType
  );

  if (hasJobApplicationFieldType) {
    return true;
  }

  if (hasCommunicationSurface && !hasKnownJobBoardSurface && !hasLinkedInJobsSurface) {
    return false;
  }

  if (hasKnownJobBoardSurface || hasLinkedInJobsSurface || hasApplicationPath) {
    return (
      hasApplicationIntent ||
      hasResumeUploadIntent ||
      hasApplicationFormSignal ||
      Boolean(input.fieldTarget)
    );
  }

  return (hasApplicationIntent || hasResumeUploadIntent || hasApplicationFormSignal) &&
    !hasCommunicationSurface;
}

/**
 * Formats a saved job profile JSON string into a structured block for agent context.
 * The JSON includes personal info, links, work auth, EEO, consents, and resume text.
 */
export function formatJobProfileContext(raw: string | null | undefined): string | null {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return null;
  try {
    const jp = JSON.parse(trimmed);
    if (typeof jp !== "object" || jp === null) return null;

    const lines: string[] = ["=== Job Application Profile (structured JSON) ==="];
    lines.push(JSON.stringify(jp, null, 2));
    lines.push("");
    lines.push("=== Job Application Profile (human-readable) ===");

    // Personal
    const p = jp.personal ?? {};
    if (p.firstName || p.lastName) {
      lines.push(`Name: ${[p.firstName, p.lastName].filter(Boolean).join(" ")}${p.preferredName ? ` (preferred: ${p.preferredName})` : ""}`);
    }
    if (p.pronouns) lines.push(`Pronouns: ${p.pronouns}`);
    if (p.email) lines.push(`Email: ${p.email}`);
    if (p.phone) lines.push(`Phone: ${p.phone}`);
    const loc = [p.city, p.state, p.postalCode, p.country].filter(Boolean).join(", ");
    if (loc) lines.push(`Location: ${loc}`);

    // Links
    const l = jp.links ?? {};
    if (l.linkedin) lines.push(`LinkedIn: ${l.linkedin}`);
    if (l.github) lines.push(`GitHub: ${l.github}`);
    if (l.portfolio) lines.push(`Portfolio: ${l.portfolio}`);
    if (l.website) lines.push(`Website: ${l.website}`);

    // Work auth
    const w = jp.workAuth ?? {};
    if (w.country) lines.push(`Work authorization: ${w.country}`);
    if (w.employmentType) lines.push(`Employment type: ${w.employmentType}`);
    if (w.workModality) lines.push(`Work modality: ${w.workModality}`);
    const flags = [
      w.requireVisaNow && "requires visa now",
      w.futureVisaSupport && "needs future visa support",
      w.willingToRelocate && "willing to relocate",
      w.willingToTravel && "willing to travel",
    ].filter(Boolean);
    if (flags.length) lines.push(`Work preferences: ${flags.join(", ")}`);
    if (w.startDate) lines.push(`Earliest start date: ${w.startDate}`);
    if (w.salary) lines.push(`Compensation expectation: ${w.salary}`);
    if (w.clearance) lines.push(`Security clearance: ${w.clearance}`);

    // EEO
    const e = jp.eeo ?? {};
    if (e.source) lines.push(`Application source: ${e.source}`);
    if (e.gender) lines.push(`Gender: ${e.gender}`);
    if (e.veteranStatus) lines.push(`Veteran status: ${e.veteranStatus}`);
    if (e.disabilityStatus) lines.push(`Disability status: ${e.disabilityStatus}`);

    // Demographics
    const d = jp.demographics ?? {};
    if (d.ageRange) lines.push(`Age range: ${d.ageRange}`);
    if (d.race) lines.push(`Race: ${d.race}`);
    if (d.ethnicity) lines.push(`Ethnicity: ${d.ethnicity}`);
    if (d.militaryStatus) lines.push(`Military status: ${d.militaryStatus}`);

    // Consents
    const c = jp.consents ?? {};
    const consented = [
      c.privacyPolicy && "privacy policy",
      c.backgroundCheck && "background check",
      c.informationAccuracy && "information accuracy",
    ].filter(Boolean);
    if (consented.length) lines.push(`Pre-consented to: ${consented.join(", ")}`);

    // Resume snippet
    const r = jp.resume ?? {};
    if (r.fileName) lines.push(`Resume file: ${r.fileName}`);
    if (r.text) {
      lines.push(`Resume text (first 800 chars):\n${String(r.text).slice(0, 800)}`);
    }

    return lines.join("\n");
  } catch {
    return null;
  }
}

function normalizeSectionLabel(key: string): string {
  const normalized = key.replace(/[_-]+/g, " ").trim();
  if (!normalized) return "Additional Context";
  return normalized.replace(/\b\w/g, (char) => char.toUpperCase());
}

export function parseStructuredSettingsContext(
  raw: string | null | undefined
): StructuredSettingsContext | null {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

export function formatSavedSettingsContext(
  raw: string | null | undefined
): string | null {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return null;

  const parsed = parseStructuredSettingsContext(trimmed);
  if (!parsed) {
    return `Saved Settings Context:\n=== General Context ===\n${trimmed}`;
  }

  const preferredOrder = ["work", "social", "always"];
  const sections: string[] = [];
  const handledKeys = new Set<string>();

  for (const key of preferredOrder) {
    const value = parsed[key];
    if (typeof value !== "string" || !value.trim()) continue;
    sections.push(`=== ${normalizeSectionLabel(key)} Context ===\n${value.trim()}`);
    handledKeys.add(key);
  }

  for (const [key, value] of Object.entries(parsed)) {
    if (handledKeys.has(key)) continue;
    if (typeof value !== "string" || !value.trim()) continue;
    sections.push(`=== ${normalizeSectionLabel(key)} Context ===\n${value.trim()}`);
  }

  if (sections.length === 0) {
    return `Saved Settings Context:\n=== General Context ===\n${trimmed}`;
  }

  return `Saved Settings Context:\n${sections.join("\n\n")}`;
}
