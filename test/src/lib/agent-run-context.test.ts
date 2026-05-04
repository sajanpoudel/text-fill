import { describe, expect, test, vi } from "vitest";

vi.mock("../../../src/lib/context.ts", () => ({
  extractPageContext: vi.fn(() => "Foreground context:\nDraft reply here"),
}));

vi.mock("../../../src/lib/platforms/index.ts", () => ({
  getPlatformExtractor: vi.fn(() => ({
    extractFieldContext: vi.fn(() => ({
      fieldType: "[EMAIL_BODY]",
      recipientName: "Taylor Recruiter",
      recipientRole: null,
      profileContext: null,
      extraContext: null,
      charLimit: 1200,
    })),
  })),
}));

import { buildAgentRunStartContext } from "../../../src/lib/agent-run-context.ts";

describe("agent run start context", () => {
  test("captures page context and a reusable field target", () => {
    (globalThis as any).document = { body: null };
    const field = {
      id: "composer",
      tagName: "TEXTAREA",
      parentElement: null,
      closest: () => null,
      getAttribute: (name: string) => (name === "id" ? "composer" : null),
    } as unknown as Element;

    const result = buildAgentRunStartContext(field, "gmail");

    expect(result).toEqual({
      pageContext: "Foreground context:\nDraft reply here",
      fieldTarget: {
        selector: "#composer",
        platform: "gmail",
        fieldType: "[EMAIL_BODY]",
        charLimit: 1200,
      },
    });
  });
});
