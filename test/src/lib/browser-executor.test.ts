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
  isContentEditable = false;

  dispatchEvent(_event: FakeEvent) {
    return true;
  }

  click() {
    this.clicked = true;
  }

  focus() {}
}

class FakeTextAreaElement extends FakeElement {}
class FakeInputElement extends FakeElement {}

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
    (globalThis as any).Event = FakeEvent;
    (globalThis as any).MouseEvent = FakeEvent;
    (globalThis as any).PointerEvent = FakeEvent;
    (globalThis as any).InputEvent = FakeEvent;
    (globalThis as any).HTMLTextAreaElement = FakeTextAreaElement;
    (globalThis as any).HTMLInputElement = FakeInputElement;
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
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    (globalThis as any).document = {
      querySelector: () => null,
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
});
