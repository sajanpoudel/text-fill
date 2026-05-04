import { describe, expect, test } from "vitest";
import {
  buildLinkedInConnectPageContext,
  buildLinkedInCustomInviteUrl,
  coalesceLinkedInRecipientProfile,
  deriveLinkedInProfileVanityName,
} from "../../../src/lib/linkedin-recipient-profile.ts";

describe("linkedin recipient profile helpers", () => {
  test("keeps an observed profile when the task tab already exposes recipient data", () => {
    const profile = coalesceLinkedInRecipientProfile({
      observedProfile: {
        name: "Greffen George",
        headline: "AI Engineering Recruiter",
        url: "https://www.linkedin.com/in/greffen-george-94206b4a/",
        recentPosts: ["Hiring AI infrastructure engineers"],
      },
      fallbackTargetName: "Fallback Name",
    });

    expect(profile).toMatchObject({
      name: "Greffen George",
      headline: "AI Engineering Recruiter",
    });
  });

  test("falls back to the queued target name without requiring a second profile fetch", () => {
    const profile = coalesceLinkedInRecipientProfile({
      observedProfile: null,
      fallbackTargetName: "Greffen George",
    });

    expect(profile).toMatchObject({
      name: "Greffen George",
      headline: null,
      url: null,
    });
  });

  test("builds connect page context from the coalesced recipient profile", () => {
    const pageContext = buildLinkedInConnectPageContext({
      recipientProfile: {
        name: "Greffen George",
        headline: "AI Engineering Recruiter",
        url: null,
        recentPosts: [],
      },
    });

    expect(pageContext).toContain("[CONNECT_NOTE_300]");
    expect(pageContext).toContain("Audience: Greffen George — AI Engineering Recruiter");
  });

  test("derives a LinkedIn vanity name from a profile URL", () => {
    expect(
      deriveLinkedInProfileVanityName(
        "https://www.linkedin.com/in/ruchiva/?trk=public_profile"
      )
    ).toBe("ruchiva");
  });

  test("builds a LinkedIn custom invite fallback URL from a profile URL", () => {
    expect(
      buildLinkedInCustomInviteUrl("https://www.linkedin.com/in/ruchiva/")
    ).toBe(
      "https://www.linkedin.com/preload/custom-invite/?vanityName=ruchiva"
    );
  });
});
