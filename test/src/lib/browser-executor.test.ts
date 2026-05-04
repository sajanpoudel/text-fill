import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import {
  ChromeBrowserExecutor,
  normalizeBrowserCommand,
} from "../../../src/lib/browser-executor.ts";

class FakeEvent {
  constructor(public type: string) {}
}

class FakeElement {
  clicked = false;
  declare value: string;
  textContent = "";
  innerText = "";
  isContentEditable = false;
  tagName = "DIV";
  disabled = false;
  checked = false;
  type = "text";
  scrollTop = 0;
  children: FakeElement[] = [];
  childNodes: Array<{ nodeType: number; textContent?: string }> = [];
  computedStyle = {
    display: "block",
    visibility: "visible",
    opacity: "1",
  };
  rect = {
    width: 100,
    height: 20,
    top: 0,
    left: 0,
    right: 100,
    bottom: 20,
  };
  private attributes = new Map<string, string>();
  private selectorMap = new Map<string, FakeElement | null>();
  private selectorAllMap = new Map<string, FakeElement[]>();

  constructor(textContent = "") {
    this.textContent = textContent;
    this.innerText = textContent;
  }

  dispatchEvent(_event: FakeEvent) {
    return true;
  }

  click() {
    this.clicked = true;
  }

  focus() {}

  scrollBy(options: { top?: number } | number) {
    const top =
      typeof options === "number" ? options : Number(options.top ?? 0);
    this.scrollTop += top;
  }

  getBoundingClientRect() {
    return this.rect;
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string) {
    return this.attributes.has(name);
  }

  closest() {
    return null;
  }

  setQuerySelector(selector: string, value: FakeElement | null) {
    this.selectorMap.set(selector, value);
  }

  setQuerySelectorAll(selector: string, value: FakeElement[]) {
    this.selectorAllMap.set(selector, value);
  }

  querySelector<T>(selector: string): T | null {
    return (this.selectorMap.get(selector) ?? null) as T | null;
  }

  querySelectorAll<T>(selector: string): T[] {
    return (this.selectorAllMap.get(selector) ?? []) as T[];
  }
}

class FakeTextAreaElement extends FakeElement {}
class FakeInputElement extends FakeElement {}
class FakeSelectElement extends FakeElement {
  multiple = false;
  options: Array<{ value: string; text: string; selected: boolean }> = [];
  selectedOptions: Array<{ value: string; textContent?: string }> = [];
}

type UpdatedListener = (
  tabId: number,
  info: chrome.tabs.OnUpdatedInfo
) => void;

function makeTab(
  id: number,
  url: string | undefined,
  status: chrome.tabs.Tab["status"] = "complete",
  active = false
): chrome.tabs.Tab {
  return {
    id,
    url,
    active,
    status,
    index: 0,
    pinned: false,
    highlighted: false,
    windowId: 1,
    incognito: false,
    selected: active,
    discarded: false,
    autoDiscardable: true,
    frozen: false,
    groupId: -1,
  };
}

function createFakeBrowserApi() {
  const listeners = new Set<UpdatedListener>();
  const tabs = new Map<number, chrome.tabs.Tab>();
  let nextTabId = 1;

  const api = {
    tabs: {
      create: vi.fn(async ({ url, active }: chrome.tabs.CreateProperties) => {
        const tab = makeTab(nextTabId++, url, "loading", !!active);
        tabs.set(tab.id!, tab);
        return tab;
      }),
      get: vi.fn(async (tabId: number) => {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error(`Missing tab ${tabId}`);
        return tab;
      }),
      update: vi.fn(
        async (tabId: number, properties: chrome.tabs.UpdateProperties) => {
          const tab = tabs.get(tabId);
          if (!tab) throw new Error(`Missing tab ${tabId}`);
          const updated = {
            ...tab,
            url: properties.url ?? tab.url,
            status: properties.url ? "loading" : tab.status,
          };
          tabs.set(tabId, updated);
          return updated;
        }
      ),
      remove: vi.fn(async (tabId: number) => {
        tabs.delete(tabId);
      }),
      captureVisibleTab: vi.fn(
        async (_windowId?: number, _options?: chrome.extensionTypes.ImageDetails) =>
          "data:image/png;base64,abc123"
      ),
      onUpdated: {
        addListener: vi.fn((listener: UpdatedListener) => {
          listeners.add(listener);
        }),
        removeListener: vi.fn((listener: UpdatedListener) => {
          listeners.delete(listener);
        }),
      },
    },
    scripting: {
      executeScript: vi.fn(async (options: any) => [
        {
          result: options.func(...(options.args ?? [])),
        },
      ]),
    },
    emitUpdated(tabId: number, info: chrome.tabs.OnUpdatedInfo) {
      const current = tabs.get(tabId);
      if (current) {
        tabs.set(tabId, { ...current, ...info });
      }
      for (const listener of listeners) listener(tabId, info);
    },
    setTab(tabId: number, tab: chrome.tabs.Tab) {
      tabs.set(tabId, tab);
    },
  };

  return api;
}

describe("browser executor", () => {
  beforeAll(() => {
    (globalThis as any).Node = { TEXT_NODE: 3 };
    (globalThis as any).Event = FakeEvent;
    (globalThis as any).MouseEvent = FakeEvent;
    (globalThis as any).PointerEvent = FakeEvent;
    (globalThis as any).InputEvent = FakeEvent;
    (globalThis as any).KeyboardEvent = FakeEvent;
    (globalThis as any).Element = FakeElement;
    (globalThis as any).HTMLElement = FakeElement;
    (globalThis as any).HTMLTextAreaElement = FakeTextAreaElement;
    (globalThis as any).HTMLInputElement = FakeInputElement;
    (globalThis as any).HTMLSelectElement = FakeSelectElement;
    (globalThis as any).window = {
      innerHeight: 800,
      innerWidth: 1200,
      scrollY: 0,
      pageYOffset: 0,
      scrollBy: ({ top }: { top?: number }) => {
        const delta = Number(top ?? 0);
        (globalThis as any).window.scrollY += delta;
        (globalThis as any).window.pageYOffset += delta;
      },
      getComputedStyle: (el: FakeElement) => el.computedStyle,
    };
    (globalThis as any).location = {
      href: "https://www.linkedin.com/search/results/people/?keywords=recruiter",
    };
    Object.defineProperty(FakeTextAreaElement.prototype, "value", {
      get() {
        return (this as FakeTextAreaElement & { _value?: string })._value ?? "";
      },
      set(next: string) {
        (this as FakeTextAreaElement & { _value?: string })._value = next;
      },
    });
    Object.defineProperty(FakeInputElement.prototype, "value", {
      get() {
        return (this as FakeInputElement & { _value?: string })._value ?? "";
      },
      set(next: string) {
        (this as FakeInputElement & { _value?: string })._value = next;
      },
    });
    Object.defineProperty(FakeSelectElement.prototype, "value", {
      get() {
        return (this as FakeSelectElement & { _value?: string })._value ?? "";
      },
      set(next: string) {
        (this as FakeSelectElement & { _value?: string })._value = next;
      },
    });
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    (globalThis as any).document = {
      body: new FakeElement("body"),
      querySelector: () => null,
      querySelectorAll: () => [],
      getElementById: () => null,
    };
  });

  test("normalizes browser command defaults", () => {
    expect(normalizeBrowserCommand({ kind: "open_tab", url: "https://x.com" }))
      .toEqual({
        kind: "open_tab",
        url: "https://x.com",
        active: false,
      });

    expect(
      normalizeBrowserCommand({
        kind: "wait_for_element",
        tabId: 1,
        selector: ".cta",
      })
    ).toMatchObject({
      kind: "wait_for_element",
      tabId: 1,
      selector: ".cta",
      timeoutMs: 5000,
      intervalMs: 200,
      world: "ISOLATED",
    });

    expect(
      normalizeBrowserCommand({
        kind: "press_key",
        tabId: 1,
        key: "Enter",
      })
    ).toMatchObject({
      kind: "press_key",
      tabId: 1,
      key: "Enter",
      modifiers: [],
      world: "ISOLATED",
    });

    expect(
      normalizeBrowserCommand({
        kind: "scroll",
        tabId: 1,
        direction: "down",
      })
    ).toMatchObject({
      kind: "scroll",
      tabId: 1,
      direction: "down",
      amount: 640,
      world: "ISOLATED",
    });

    expect(
      normalizeBrowserCommand({
        kind: "verify_text",
        tabId: 1,
        expectedText: "done",
      })
    ).toMatchObject({
      kind: "verify_text",
      tabId: 1,
      expectedText: "done",
      scope: "main",
      caseSensitive: false,
      maxLength: 6000,
      world: "ISOLATED",
    });

    expect(
      normalizeBrowserCommand({
        kind: "insert_text",
        tabId: 1,
        selector: "#composer",
        text: "Hello draft",
      })
    ).toMatchObject({
      kind: "insert_text",
      tabId: 1,
      selector: "#composer",
      text: "Hello draft",
      world: "ISOLATED",
    });
  });

  test("opens and closes tabs through the executor", async () => {
    const api = createFakeBrowserApi();
    const executor = new ChromeBrowserExecutor(api as any);

    const opened = await executor.execute({
      kind: "open_tab",
      url: "https://example.com",
    });
    expect(opened).toMatchObject({
      kind: "open_tab",
      url: "https://example.com",
    });

    await executor.execute({
      kind: "close_tab",
      tabId: opened.tabId,
    });
    expect(api.tabs.remove).toHaveBeenCalledWith(opened.tabId);
  });

  test("waits for tab completion via tab update events", async () => {
    const api = createFakeBrowserApi();
    const executor = new ChromeBrowserExecutor(api as any);
    const opened = await executor.execute({
      kind: "open_tab",
      url: "https://example.com",
    });

    const waitPromise = executor.execute({
      kind: "wait_for_tab_complete",
      tabId: opened.tabId,
      timeoutMs: 100,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    api.emitUpdated(opened.tabId, { status: "complete" });

    await expect(waitPromise).resolves.toEqual({
      kind: "wait_for_tab_complete",
      tabId: opened.tabId,
      status: "complete",
    });
  });

  test("polls for url and selector-based actions", async () => {
    const api = createFakeBrowserApi();
    const executor = new ChromeBrowserExecutor(api as any);
    const opened = await executor.execute({
      kind: "open_tab",
      url: "https://example.com/start",
    });

    let reads = 0;
    api.tabs.get.mockImplementation(async (tabId: number) => {
      const current =
        reads++ > 0
          ? makeTab(tabId, "https://example.com/done")
          : makeTab(tabId, "https://example.com/start");
      api.setTab(tabId, current);
      return current;
    });

    await expect(
      executor.execute({
        kind: "wait_for_url",
        tabId: opened.tabId,
        urlIncludes: "/done",
        timeoutMs: 50,
        intervalMs: 0,
      })
    ).resolves.toMatchObject({
      kind: "wait_for_url",
      tabId: opened.tabId,
      url: "https://example.com/done",
    });

    const button = new FakeElement();
    const textarea = new FakeTextAreaElement();
    (globalThis as any).document.querySelector = (selector: string) => {
      if (selector === ".cta") return button;
      if (selector === "textarea") return textarea;
      return null;
    };

    await expect(
      executor.execute({
        kind: "wait_for_element",
        tabId: opened.tabId,
        selector: ".cta",
        timeoutMs: 50,
        intervalMs: 0,
      })
    ).resolves.toMatchObject({
      kind: "wait_for_element",
      tabId: opened.tabId,
      selector: ".cta",
      found: true,
    });

    await expect(
      executor.execute({
        kind: "click",
        tabId: opened.tabId,
        selector: ".cta",
      })
    ).resolves.toMatchObject({
      kind: "click",
      tabId: opened.tabId,
      selector: ".cta",
      clicked: true,
    });
    expect(button.clicked).toBe(true);

    await expect(
      executor.execute({
        kind: "type",
        tabId: opened.tabId,
        selector: "textarea",
        text: "Hello there",
      })
    ).resolves.toMatchObject({
      kind: "type",
      tabId: opened.tabId,
      selector: "textarea",
      typed: true,
    });
    expect(textarea.value).toBe("Hello there");
  });

  test("supports semantic observation commands and field setting", async () => {
    const api = createFakeBrowserApi();
    const executor = new ChromeBrowserExecutor(api as any);
    const activeTab = makeTab(9, "https://example.com/page", "complete", true);
    api.setTab(9, activeTab);

    const main = new FakeElement("Visible text");
    main.tagName = "MAIN";
    main.childNodes = [{ nodeType: 3, textContent: "Visible text" }];

    const button = new FakeElement("Apply");
    button.tagName = "A";
    button.setAttribute("aria-label", "Apply now");
    button.setAttribute("href", "https://www.linkedin.com/in/example-recruiter/");

    const input = new FakeInputElement();
    input.tagName = "INPUT";
    input.type = "email";
    input.setAttribute("placeholder", "Email");
    input.setAttribute("name", "email");
    input.value = "recruiter@example.com";

    main.children = [button, input];
    main.setQuerySelectorAll(
      "button, [role='button'], a[href], input:not([type='hidden']), textarea, select, [role='textbox'], [contenteditable='true']",
      [button, input]
    );
    main.setQuerySelectorAll(
      "input:not([type='hidden']), textarea, select, [contenteditable='true'], [role='textbox']",
      [input]
    );
    main.setQuerySelectorAll("h1, h2, h3, h4, [role='heading']", []);

    (globalThis as any).document.body = main;
    (globalThis as any).document.activeElement = input;
    (globalThis as any).document.querySelector = (selector: string) => {
      if (selector === "main, article, [role='main']") return main;
      if (selector === "dialog, [role='dialog']") return null;
      if (selector === "#panel") return main;
      if (selector === "#composer") return input;
      if (selector === "#toggle") return input;
      return null;
    };

    const snapshot = await executor.execute({
      kind: "snapshot_interactives",
      tabId: 9,
      scope: "main",
    });
    expect(snapshot.kind).toBe("snapshot_interactives");
    expect(snapshot.elements).toHaveLength(2);
    expect(snapshot.elements[0]?.href).toBe(
      "https://www.linkedin.com/in/example-recruiter/"
    );

    const accessibility = await executor.execute({
      kind: "get_accessibility_tree",
      tabId: 9,
    });
    expect(accessibility.tree).toMatchObject({ tag: "main" });

    const extracted = await executor.execute({
      kind: "extract_structured",
      tabId: 9,
      schema: JSON.stringify({
        type: "object",
        properties: {
          email: { type: "string" },
          summary: { type: "string" },
        },
      }),
    });
    expect(extracted.result.data.email).toBe("recruiter@example.com");
    expect(extracted.result.data.summary).toBe("Visible text");

    input.type = "checkbox";
    expect(
      await executor.execute({
        kind: "set_field_value",
        tabId: 9,
        selector: "#toggle",
        value: true,
      })
    ).toEqual({
      kind: "set_field_value",
      tabId: 9,
      selector: "#toggle",
      set: true,
    });
    expect(input.checked).toBe(true);

    await expect(
      executor.execute({
        kind: "insert_text",
        tabId: 9,
        selector: "#composer",
        text: "Approved draft",
      })
    ).resolves.toEqual({
      kind: "insert_text",
      tabId: 9,
      selector: "#composer",
      inserted: true,
    });
    expect(input.value).toBe("Approved draft");

    await expect(
      executor.execute({
        kind: "press_key",
        tabId: 9,
        key: "Enter",
        modifiers: ["Shift"],
        selector: "#toggle",
      })
    ).resolves.toEqual({
      kind: "press_key",
      tabId: 9,
      key: "Enter",
      pressed: true,
    });

    await expect(
      executor.execute({
        kind: "scroll",
        tabId: 9,
        direction: "down",
        amount: 120,
      })
    ).resolves.toEqual({
      kind: "scroll",
      tabId: 9,
      deltaY: 120,
      position: 120,
    });

    await expect(
      executor.execute({
        kind: "extract_text",
        tabId: 9,
        scope: "main",
        maxLength: 12,
      })
    ).resolves.toEqual({
      kind: "extract_text",
      tabId: 9,
      scope: "main",
      text: "Visible text",
    });

    await expect(
      executor.execute({
        kind: "verify_text",
        tabId: 9,
        expectedText: "visible text",
        scope: "main",
      })
    ).resolves.toEqual({
      kind: "verify_text",
      tabId: 9,
      expectedText: "visible text",
      matched: true,
      text: "Visible text",
    });

    await expect(
      executor.execute({
        kind: "take_screenshot",
        tabId: 9,
      })
    ).resolves.toEqual({
      kind: "take_screenshot",
      tabId: 9,
      imageDataUrl: "data:image/png;base64,abc123",
    });

    const card = new FakeElement();
    const connect = new FakeElement("Connect");
    const profileLink = new FakeElement();
    (profileLink as any).href = "https://www.linkedin.com/in/example-recruiter/";
    const name = new FakeElement("Example Recruiter");
    card.setQuerySelectorAll("button, [role='button']", [connect]);
    card.setQuerySelector("a[href*='/in/']", profileLink);
    card.setQuerySelector(
      ".entity-result__title-text a span[aria-hidden='true'], .entity-result__title-line a span[aria-hidden='true']",
      name
    );

    const nextPage = new FakeElement("Next");
    (nextPage as any).href =
      "https://www.linkedin.com/search/results/people/?keywords=recruiter&page=2";
    nextPage.setAttribute(
      "href",
      "https://www.linkedin.com/search/results/people/?keywords=recruiter&page=2"
    );

    (globalThis as any).document.querySelectorAll = (selector: string) => {
      if (
        selector ===
        "[data-chameleon-result-urn], .reusable-search__result-container, li.reusable-search__result-container, .entity-result"
      ) {
        return [card];
      }
      if (selector === "a[href*='/in/']") {
        return [profileLink];
      }
      if (selector === "a[href], button, [role='button']") {
        return [nextPage];
      }
      return [];
    };

    await expect(
      executor.execute({
        kind: "scan_candidates",
        tabId: 9,
        platform: "linkedin",
        maxResults: 3,
      })
    ).resolves.toEqual({
      kind: "scan_candidates",
      tabId: 9,
      platform: "linkedin",
      scan: {
        platform: "linkedin",
        pageType: "people_search",
        candidates: [
          {
            targetName: "Example Recruiter",
            targetUrl: "https://www.linkedin.com/in/example-recruiter/",
          },
        ],
        nextPageUrl:
          "https://www.linkedin.com/search/results/people/?keywords=recruiter&page=2",
        diagnostics: {
          totalCards: 1,
          totalProfileLinks: 1,
          cardsWithConnectSignal: 1,
          acceptedCandidates: 1,
        },
      },
    });
  });

  test("tolerates a null structured snapshot from executeScript", async () => {
    const api = createFakeBrowserApi();
    const executor = new ChromeBrowserExecutor(api as any);
    api.setTab(21, makeTab(21, "https://example.com", "complete", true));
    api.scripting.executeScript.mockResolvedValueOnce([{ result: null }]);

    await expect(
      executor.execute({
        kind: "extract_structured",
        tabId: 21,
        scope: "main",
        schema: JSON.stringify({
          type: "object",
          properties: {
            title: { type: "string" },
            summary: { type: "string" },
          },
        }),
      })
    ).resolves.toEqual({
      kind: "extract_structured",
      tabId: 21,
      scope: "main",
      result: {
        data: {
          title: null,
          summary: null,
        },
        matchedFields: [],
        unmatchedFields: ["title", "summary"],
        headings: [],
        text: "",
      },
    });
  });

  test("runs arbitrary page scripts through the unified executor", async () => {
    const api = createFakeBrowserApi();
    const executor = new ChromeBrowserExecutor(api as any);
    const opened = await executor.execute({
      kind: "open_tab",
      url: "https://example.com",
    });

    const result = await executor.execute({
      kind: "run_script",
      tabId: opened.tabId,
      func: (prefix: string, suffix: string) => `${prefix}-${suffix}`,
      args: ["agent", "executor"],
    });

    expect(result).toEqual({
      kind: "run_script",
      tabId: opened.tabId,
      result: "agent-executor",
    });
  });

  test("retries transient frame-removal errors when injecting scripts", async () => {
    const api = createFakeBrowserApi();
    const executor = new ChromeBrowserExecutor(api as any);
    api.setTab(31, makeTab(31, "https://www.linkedin.com/in/example/", "complete", false));

    api.scripting.executeScript
      .mockRejectedValueOnce(new Error("Frame with ID 0 was removed."))
      .mockResolvedValueOnce([{ result: "recovered" }]);

    const result = await executor.execute({
      kind: "run_script",
      tabId: 31,
      func: () => "ignored",
    });

    expect(result).toEqual({
      kind: "run_script",
      tabId: 31,
      result: "recovered",
    });
    expect(api.scripting.executeScript).toHaveBeenCalledTimes(2);
  });
});
