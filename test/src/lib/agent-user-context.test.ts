import { describe, expect, test } from "vitest";
import {
  formatSavedSettingsContext,
  parseStructuredSettingsContext,
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
});
