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

  test("deriveContextType maps [INMAIL_SUBJECT] to inmail", () => {
    expect(deriveContextType("[INMAIL_SUBJECT] Subject line here", undefined, "linkedin")).toBe(
      "inmail"
    );
  });

  test("deriveContextType returns undefined for non-LinkedIn platforms", () => {
    expect(deriveContextType("Some gmail context", undefined, "gmail")).toBeUndefined();
    expect(deriveContextType("Slack message body", undefined, "slack")).toBeUndefined();
    expect(deriveContextType("General text", undefined, "general")).toBeUndefined();
  });

  test("deriveContextType falls back to connection_req when fieldMaxLength is 300 on linkedin", () => {
    expect(deriveContextType("Plain context text", 300, "linkedin")).toBe("connection_req");
  });

  test("deriveContextType returns undefined for fieldMaxLength 300 on non-linkedin platform", () => {
    expect(deriveContextType("Plain context text", 300, "gmail")).toBeUndefined();
  });

  test("buildPrompt section ordering: Style Rules before Recent Patterns before Recipient Context", () => {
    const { user } = buildPrompt({
      instruction: "Write a note",
      action: "generate",
      pageContext: "Audience: Jane",
      memoryContext: "- Some fact.",
      proceduralContext: "Keep it concise.",
      episodicContext: "- outcome: accepted",
      recipientContext: "Name: Jane\nHeadline: Engineer",
      platform: "linkedin",
    });

    const styleIdx = user.indexOf("=== Your Style Rules ===");
    const patternsIdx = user.indexOf("=== Recent Patterns ===");
    const recipientIdx = user.indexOf("=== Recipient Context (transient) ===");

    expect(styleIdx).toBeGreaterThan(-1);
    expect(patternsIdx).toBeGreaterThan(-1);
    expect(recipientIdx).toBeGreaterThan(-1);
    expect(styleIdx).toBeLessThan(patternsIdx);
    expect(patternsIdx).toBeLessThan(recipientIdx);
  });

  test("buildPrompt omits Style Rules and Recent Patterns sections when those contexts are empty", () => {
    const { user } = buildPrompt({
      instruction: "Write a message",
      action: "generate",
      pageContext: "Audience: Bob",
      memoryContext: "",
      platform: "linkedin",
    });

    expect(user).not.toContain("=== Your Style Rules ===");
    expect(user).not.toContain("=== Recent Patterns ===");
  });

  test("buildPrompt injects existingText in Existing Content section", () => {
    const { user } = buildPrompt({
      instruction: "Rewrite this",
      action: "rewrite",
      pageContext: "Audience: Bob",
      memoryContext: "",
      existingText: "Original draft text here.",
      platform: "linkedin",
    });

    expect(user).toContain("=== Existing Content ===");
    expect(user).toContain("Original draft text here.");
  });
});
