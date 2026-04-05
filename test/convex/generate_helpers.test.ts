import { describe, expect, test } from "vitest";
import { buildPrompt, deriveContextType } from "../../convex/generate";

describe("generate helpers", () => {
  test("buildPrompt injects recipient context for non-academic platforms", () => {
    const { user } = buildPrompt({
      instruction: "Write a note",
      action: "generate",
      pageContext: "Audience: Jane Doe",
      memoryContext: "- User currently works at Acme.",
      proceduralContext: "Keep it short.",
      episodicContext: "- outcome: accepted",
      recipientContext: "Name: Jane Doe\nHeadline: Engineering Manager",
      platform: "linkedin",
    });

    expect(user).toContain("=== Recipient Context (transient) ===");
    expect(user).toContain("Name: Jane Doe");
  });

  test("buildPrompt omits recipient context in canvas mode", () => {
    const { user } = buildPrompt({
      instruction: "Answer the question",
      action: "generate",
      pageContext: "Assignment prompt",
      memoryContext: "- User currently works at Acme.",
      recipientContext: "Name: Jane Doe",
      platform: "canvas",
    });

    expect(user).not.toContain("Recipient Context");
    expect(user).not.toContain("Known Facts");
  });

  test("deriveContextType detects linkedin contexts", () => {
    expect(deriveContextType("[CONNECT_NOTE_300]\nAudience: Jane", 300, "linkedin")).toBe(
      "connection_req"
    );
    expect(deriveContextType("[INMAIL_MESSAGE]", undefined, "linkedin")).toBe(
      "inmail"
    );
    expect(deriveContextType("[DM_MESSAGE]", undefined, "linkedin")).toBe("dm");
    expect(deriveContextType("[COMMENT]", undefined, "linkedin")).toBe("comment");
    expect(deriveContextType("[POST_COMPOSE]", undefined, "linkedin")).toBe("post");
  });
});
