import { beforeEach, describe, expect, test } from "vitest";
import { isSearchField } from "../../../src/lib/platform.ts";

type FakeFieldOptions = {
  attrs?: Record<string, string>;
  dialog?: boolean;
  typeahead?: boolean;
};

function makeFakeField(options: FakeFieldOptions = {}): Element {
  const attrs = options.attrs ?? {};
  return {
    getAttribute(name: string) {
      return attrs[name] ?? null;
    },
    closest(selector: string) {
      if (selector === '[role="dialog"]') return options.dialog ? ({}) as Element : null;
      if (
        selector.includes(".artdeco-typeahead") ||
        selector.includes("[class*='typeahead']") ||
        selector.includes("form[role='search']")
      ) {
        return options.typeahead ? ({}) as Element : null;
      }
      return null;
    },
    matches() {
      return false;
    },
  } as unknown as Element;
}

describe("isSearchField", () => {
  beforeEach(() => {
    (globalThis as any).window = {
      location: {
        hostname: "www.linkedin.com",
        pathname: "/search/results/people/",
        href: "https://www.linkedin.com/search/results/people/",
      },
      top: null,
    };
    (globalThis as any).document = { title: "" };
  });

  test("treats LinkedIn typeahead search inputs as search fields", () => {
    const field = makeFakeField({
      attrs: {
        placeholder: "I'm looking for…",
        "data-testid": "typeahead-input",
        "aria-autocomplete": "list",
      },
      typeahead: true,
    });

    expect(isSearchField(field)).toBe(true);
  });

  test("does not classify LinkedIn connection-note textareas as search fields", () => {
    const field = makeFakeField({
      attrs: {
        name: "message",
        placeholder: "Add a note",
      },
      dialog: true,
    });

    expect(isSearchField(field)).toBe(false);
  });
});
