import { describe, expect, test } from "vitest";
import {
  formatSavedSettingsContext,
  parseStructuredSettingsContext,
  shouldIncludeJobApplicationArtifacts,
} from "../../../src/lib/agent-user-context.ts";

describe("agent-user-context", () => {
  test("parses structured settings context JSON", () => {
    expect(
      parseStructuredSettingsContext(
        JSON.stringify({
          work: "Backend engineer",
          social: "Enjoys writing online",
          always: "Keep the tone concise",
        })
      )
    ).toEqual({
      work: "Backend engineer",
      social: "Enjoys writing online",
      always: "Keep the tone concise",
    });
  });

  test("formats structured settings context into labeled sections", () => {
    expect(
      formatSavedSettingsContext(
        JSON.stringify({
          work: "Backend engineer",
          social: "Enjoys writing online",
          always: "Keep the tone concise",
        })
      )
    ).toBe(
      [
        "Saved Settings Context:",
        "=== Work Context ===",
        "Backend engineer",
        "",
        "=== Social Context ===",
        "Enjoys writing online",
        "",
        "=== Always Context ===",
        "Keep the tone concise",
      ].join("\n")
    );
  });

  test("falls back to a general block for legacy plain-text context", () => {
    expect(formatSavedSettingsContext("Experienced software engineer")).toBe(
      "Saved Settings Context:\n=== General Context ===\nExperienced software engineer"
    );
  });

  test("includes job application artifacts for a greenhouse application flow", () => {
    expect(
      shouldIncludeJobApplicationArtifacts({
        goal: "Apply to this role and upload my resume",
        platformHint: "greenhouse",
        pageUrl: "https://boards.greenhouse.io/example/jobs/123",
        pageContext: "Application form with work authorization and cover letter fields.",
      })
    ).toBe(true);
  });

  test("includes job application artifacts for a linkedin easy apply flow", () => {
    expect(
      shouldIncludeJobApplicationArtifacts({
        goal: "Continue this application",
        platformHint: "linkedin",
        pageUrl: "https://www.linkedin.com/jobs/view/1234567890/",
        pageContext: "Easy Apply modal with resume upload and work authorization questions.",
      })
    ).toBe(true);
  });

  test("excludes job application artifacts for linkedin networking", () => {
    expect(
      shouldIncludeJobApplicationArtifacts({
        goal: "Connect with this person and write a short note",
        platformHint: "linkedin",
        pageUrl: "https://www.linkedin.com/in/example-person/",
        pageContext: "LinkedIn profile page for a software engineer.",
      })
    ).toBe(false);
  });

  test("excludes job application artifacts on communication surfaces", () => {
    expect(
      shouldIncludeJobApplicationArtifacts({
        goal: "Help me reply to this Slack message",
        platformHint: "slack",
        pageUrl: "https://example.slack.com/client/T123/C456",
        pageContext: "Direct message thread with my teammate.",
      })
    ).toBe(false);
  });

  test("includes job application artifacts on custom careers pages with strong application intent", () => {
    expect(
      shouldIncludeJobApplicationArtifacts({
        goal: "Upload my resume and complete this application",
        pageUrl: "https://careers.example.com/apply/backend-engineer",
        pageContext: "Candidate profile form with employer questions and a resume upload input.",
      })
    ).toBe(true);
  });

  test("does not include job application artifacts for generic resume editing tasks", () => {
    expect(
      shouldIncludeJobApplicationArtifacts({
        goal: "Help me edit my resume for a friend",
        pageUrl: "https://docs.example.com/resume-draft",
        pageContext: "A blank document editor with some pasted bullet points.",
      })
    ).toBe(false);
  });
});
