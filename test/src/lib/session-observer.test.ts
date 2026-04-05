import { beforeAll, describe, expect, test } from "vitest";

let helpers: Awaited<typeof import("../../../src/lib/session-observer.ts")>;

beforeAll(async () => {
  (globalThis as any).document = {
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  (globalThis as any).window = {
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  helpers = await import("../../../src/lib/session-observer.ts");
});

describe("session observer helpers", () => {
  test("classifies exact match as accepted", () => {
    expect(helpers.classifyOutcome("Hello there", "Hello there")).toBe(
      "accepted"
    );
  });

  test("classifies blank final text as abandoned", () => {
    expect(helpers.classifyOutcome("Hello there", "   ")).toBe("abandoned");
  });

  test("classifies light edits below 15 percent threshold", () => {
    expect(helpers.classifyOutcome("Hello there", "Hello there!")).toBe(
      "lightly_edited"
    );
  });

  test("classifies rewrites when most text changes", () => {
    expect(
      helpers.classifyOutcome("Hello there", "Different message entirely")
    ).toBe("rewritten");
  });

  test("editFraction and charDelta reflect shortening", () => {
    expect(
      helpers.editFraction(
        "A much longer generated sentence",
        "Short sentence"
      )
    ).toBeGreaterThan(0);
    expect(
      helpers.charDelta("A much longer generated sentence", "Short sentence")
    ).toBeLessThan(0);
  });

  test("chooseFinalText prefers the live blur snapshot over stale beforeinput text", () => {
    expect(
      helpers.chooseFinalText("Hello there", "Hello there!", "Hello there")
    ).toBe("Hello there!");
  });

  test("chooseFinalText can still use a settled normalized value when live text matches the AI baseline", () => {
    expect(
      helpers.chooseFinalText("Hello there", "Hello there", "Hello there\n")
    ).toBe("Hello there\n");
  });
});
