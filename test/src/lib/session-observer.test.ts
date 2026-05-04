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

  test("classifies heavily edited text between 15 and 50 percent change", () => {
    // Construct a case where roughly 30% of chars change — squarely in the heavily_edited band.
    const base = "This is a generated message about software engineering careers.";
    const modified = "This is a generated message about software design principles.";
    expect(helpers.classifyOutcome(base, modified)).toBe("heavily_edited");
  });

  test("editFraction uses trigram similarity path for texts longer than 1500 chars", () => {
    const longBase = "word ".repeat(320); // ~1600 chars
    const longModified = "word ".repeat(160) + "other ".repeat(160); // half replaced
    const fraction = helpers.editFraction(longBase, longModified);
    expect(fraction).toBeGreaterThan(0);
    expect(fraction).toBeLessThanOrEqual(1);
  });

  test("charDelta returns a positive value when text expands", () => {
    expect(
      helpers.charDelta("Short text", "This is a much longer expanded text")
    ).toBeGreaterThan(0);
  });
});
