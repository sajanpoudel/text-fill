export type LinkedInRecipientProfile = {
  name: string;
  headline: string | null;
  url: string | null;
  recentPosts: string[];
};

function normalizeText(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : null;
}

export function coalesceLinkedInRecipientProfile(args: {
  observedProfile: LinkedInRecipientProfile | null | undefined;
  fallbackTargetName?: string | null;
}): LinkedInRecipientProfile | null {
  const observed = args.observedProfile;
  if (
    observed &&
    (normalizeText(observed.name) ||
      normalizeText(observed.headline) ||
      observed.recentPosts.length > 0)
  ) {
    return {
      name: normalizeText(observed.name) ?? "",
      headline: normalizeText(observed.headline),
      url: normalizeText(observed.url),
      recentPosts: observed.recentPosts.filter(Boolean),
    };
  }

  const fallbackName = normalizeText(args.fallbackTargetName);
  if (!fallbackName) {
    return null;
  }

  return {
    name: fallbackName,
    headline: null,
    url: null,
    recentPosts: [],
  };
}

export function buildLinkedInConnectPageContext(args: {
  recipientProfile: LinkedInRecipientProfile | null;
  fallbackTargetName?: string | null;
}): string {
  const recipientName =
    normalizeText(args.recipientProfile?.name) ??
    normalizeText(args.fallbackTargetName) ??
    "this person";
  const recipientHeadline = normalizeText(args.recipientProfile?.headline);

  return [
    "[CONNECT_NOTE_300]",
    `Audience: ${recipientName}${recipientHeadline ? ` — ${recipientHeadline}` : ""}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function deriveLinkedInProfileVanityName(
  profileUrl: string | null | undefined
): string | null {
  if (typeof profileUrl !== "string" || !profileUrl.trim()) return null;
  try {
    const url = new URL(profileUrl);
    const match = url.pathname.match(/^\/in\/([^/?#]+)/i);
    if (!match?.[1]) return null;
    const vanity = decodeURIComponent(match[1]).trim();
    return vanity || null;
  } catch {
    return null;
  }
}

export function buildLinkedInCustomInviteUrl(
  profileUrl: string | null | undefined
): string | null {
  const vanityName = deriveLinkedInProfileVanityName(profileUrl);
  if (!vanityName) return null;
  return `https://www.linkedin.com/preload/custom-invite/?vanityName=${encodeURIComponent(vanityName)}`;
}
