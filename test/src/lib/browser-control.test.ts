import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  executeClickElementBySelectorInPage,
  executeElementExistsInPage,
  executeExtractStructuredDataSnapshotInPage,
  executeExtractTextInPage,
  executeGetAccessibilityTreeInPage,
  executeInsertTextBySelectorInPage,
  executeLinkedInConnectFromMoreMenuInPage,
  executeLinkedInConnectPrimaryActionInPage,
  executeLinkedInFillAndSendConnectDialogInPage,
  executePressKeyInPage,
  executeSetFieldValueBySelectorInPage,
  executeScrollInPage,
  executeSnapshotInteractivesInPage,
  executeTypeIntoFieldBySelectorInPage,
  executeVerifyTextInPage,
  isLinkedInAddNoteText,
  isLinkedInConnectText,
  isLinkedInMoreText,
  isLinkedInSendText,
  normalizeControlText,
} from "../../../src/lib/browser-control.ts";

class FakeEvent {
  constructor(public type: string) {}
}

class FakeElement {
  textContent: string;
  innerText: string;
  clicked = false;
  dispatched: string[] = [];
  declare value: string;
  type = "text";
  disabled = false;
  checked = false;
  tagName = "DIV";
  focused = false;
  isContentEditable = false;
  scrollTop = 0;
  classList = {
    contains: (_value: string) => false,
  };
  children: FakeElement[] = [];
  childNodes: Array<{ nodeType: number; textContent?: string }> = [];
  parentElement: FakeElement | null = null;
  private attributes = new Map<string, string>();
  private selectorMap = new Map<string, FakeElement | null>();
  private selectorAllMap = new Map<string, FakeElement[]>();

  constructor(textContent = "") {
    this.textContent = textContent;
    this.innerText = textContent;
  }

  dispatchEvent(event: FakeEvent) {
    this.dispatched.push(event.type);
    return true;
  }

  click() {
    this.clicked = true;
  }

  focus() {
    this.focused = true;
  }

  scrollBy(options: { top?: number } | number) {
    const top =
      typeof options === "number" ? options : Number(options.top ?? 0);
    this.scrollTop += top;
  }

  getBoundingClientRect() {
    return { width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20 };
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

  closest(_selector: string) {
    return this.parentElement;
  }

  setQuerySelector(selector: string, value: FakeElement | null) {
    this.selectorMap.set(selector, value);
  }

  setQuerySelectorAll(selector: string, value: FakeElement[]) {
    this.selectorAllMap.set(selector, value);
  }

  querySelector<T>(_selector: string): T | null {
    return (this.selectorMap.get(_selector) ?? null) as T | null;
  }

  querySelectorAll<T>(_selector: string): T[] {
    return (this.selectorAllMap.get(_selector) ?? []) as T[];
  }
}

class FakeTextAreaElement extends FakeElement {}
class FakeInputElement extends FakeElement {}
class FakeSelectElement extends FakeElement {
  multiple = false;
  options: Array<{ value: string; text: string; selected: boolean }> = [];
  selectedOptions: Array<{ value: string; text: string }> = [];
}

describe("browser control helpers", () => {
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
      getComputedStyle: () => ({
        display: "block",
        visibility: "visible",
        opacity: "1",
      }),
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
  });

  beforeEach(() => {
    (globalThis as any).document = {
      body: new FakeElement("body"),
      querySelector: () => null,
      querySelectorAll: () => [],
      getElementById: () => null,
    };
  });

  test("normalizes and matches LinkedIn control labels", () => {
    expect(normalizeControlText("  Send   Invitation ")).toBe(
      "send invitation"
    );
    expect(isLinkedInConnectText("Connect")).toBe(true);
    expect(isLinkedInMoreText("More")).toBe(true);
    expect(isLinkedInAddNoteText("Add a note")).toBe(true);
    expect(isLinkedInSendText("Send invitation")).toBe(true);
    expect(isLinkedInSendText("Cancel")).toBe(false);
  });

  test("supports generic selector existence, click, and type helpers", () => {
    const button = new FakeElement("Click me");
    const textarea = new FakeTextAreaElement();
    (globalThis as any).document.querySelector = (selector: string) => {
      if (selector === ".cta") return button;
      if (selector === "textarea") return textarea;
      return null;
    };

    expect(executeElementExistsInPage(".cta")).toBe(true);
    expect(executeElementExistsInPage(".missing")).toBe(false);
    expect(executeClickElementBySelectorInPage(".cta")).toBe(true);
    expect(button.clicked).toBe(true);
    expect(executeTypeIntoFieldBySelectorInPage("textarea", "Hello")).toBe(
      true
    );
    expect(textarea.value).toBe("Hello");
  });

  test("inserts text into native and contenteditable fields", () => {
    const textarea = new FakeTextAreaElement();
    const editor = new FakeElement();
    editor.isContentEditable = true;

    (globalThis as any).document.querySelector = (selector: string) => {
      if (selector === "textarea") return textarea;
      if (selector === ".editor") return editor;
      return null;
    };

    expect(executeInsertTextBySelectorInPage("textarea", "Hello draft")).toBe(true);
    expect(textarea.value).toBe("Hello draft");

    expect(executeInsertTextBySelectorInPage(".editor", "Reply text")).toBe(true);
    expect(editor.textContent).toBe("Reply text");
  });

  test("supports key presses, scrolling, text extraction, and text verification", () => {
    const input = new FakeInputElement();
    input.tagName = "INPUT";
    input.type = "text";

    const panel = new FakeElement("Panel body text");
    panel.tagName = "SECTION";
    panel.scrollTop = 40;

    const main = new FakeElement("The invitation was sent successfully.");
    main.tagName = "MAIN";
    main.setQuerySelectorAll(
      "button, [role='button'], a[href], input:not([type='hidden']), textarea, select, [role='textbox'], [contenteditable='true']",
      []
    );
    (globalThis as any).document.body = main;
    (globalThis as any).document.activeElement = input;
    (globalThis as any).document.querySelector = (selector: string) => {
      if (selector === "#panel") return panel;
      if (selector === "#search") return input;
      if (selector === "dialog, [role='dialog']") return null;
      if (selector === "main, article, [role='main']") return main;
      return null;
    };

    expect(executePressKeyInPage("Enter", ["Shift"], "#search")).toBe(true);
    expect(input.focused).toBe(true);
    expect(input.dispatched).toEqual(["keydown", "keypress", "keyup"]);

    expect(executeScrollInPage("down", 120, "#panel")).toEqual({
      deltaY: 120,
      position: 160,
    });
    expect(panel.scrollTop).toBe(160);

    expect(executeScrollInPage("down", 200)).toEqual({
      deltaY: 200,
      position: 200,
    });

    expect(executeExtractTextInPage(undefined, "main", 20)).toBe(
      "The invitation was s"
    );
    expect(
      executeVerifyTextInPage("invitation was sent", undefined, "main")
    ).toEqual({
      matched: true,
      text: "The invitation was sent successfully.",
    });
  });

  test("sets checkbox and select values through the generic field setter", () => {
    const checkbox = new FakeInputElement();
    checkbox.tagName = "INPUT";
    checkbox.type = "checkbox";

    const select = new FakeSelectElement();
    select.tagName = "SELECT";
    select.options = [
      { value: "us", text: "United States", selected: false },
      { value: "ca", text: "Canada", selected: false },
    ];
    (globalThis as any).document.querySelector = (selector: string) => {
      if (selector === "#checkbox") return checkbox;
      if (selector === "#country") return select;
      return null;
    };

    expect(executeSetFieldValueBySelectorInPage("#checkbox", true)).toBe(true);
    expect(checkbox.checked).toBe(true);

    expect(executeSetFieldValueBySelectorInPage("#country", "ca")).toBe(true);
    expect(select.options[1]?.selected).toBe(true);
  });

  test("captures interactive snapshots, accessibility tree, and structured field snapshots", () => {
    const main = new FakeElement("Main root");
    main.tagName = "MAIN";

    const profileLink = new FakeElement("Taylor Recruiter");
    profileLink.tagName = "A";
    profileLink.setAttribute("aria-label", "Taylor Recruiter");
    profileLink.setAttribute("href", "https://www.linkedin.com/in/taylor-recruiter/");

    const input = new FakeInputElement();
    input.tagName = "INPUT";
    input.type = "email";
    input.setAttribute("name", "email");
    input.setAttribute("placeholder", "Email");
    input.value = "taylor@example.com";

    const heading = new FakeElement("Taylor Recruiter");
    heading.tagName = "H1";

    main.setQuerySelectorAll(
      "button, [role='button'], a[href], input:not([type='hidden']), textarea, select, [role='textbox'], [contenteditable='true']",
      [profileLink, input]
    );
    main.setQuerySelectorAll("h1, h2, h3, h4, [role='heading']", [heading]);
    main.setQuerySelectorAll(
      "input:not([type='hidden']), textarea, select, [contenteditable='true'], [role='textbox']",
      [input]
    );
    main.children = [heading, profileLink, input];
    main.childNodes = [{ nodeType: 3, textContent: "Direct summary" }];

    (globalThis as any).document.body = main;
    (globalThis as any).document.querySelector = (selector: string) => {
      if (selector === "dialog, [role='dialog']") return null;
      if (selector === "main, article, [role='main']") return main;
      return null;
    };

    const interactives = executeSnapshotInteractivesInPage("main");
    expect(interactives).toHaveLength(2);
    expect(interactives[0]).toMatchObject({
      tag: "a",
      label: "Taylor Recruiter",
      href: "https://www.linkedin.com/in/taylor-recruiter/",
    });

    const tree = executeGetAccessibilityTreeInPage("main");
    expect(tree).toMatchObject({
      tag: "main",
      text: "Direct summary",
    });
    expect(tree?.children.length).toBe(3);

    const snapshot = executeExtractStructuredDataSnapshotInPage("main");
    expect(snapshot.headings).toEqual(["Taylor Recruiter"]);
    expect(snapshot.fields[0]).toMatchObject({
      label: "Email",
      value: "taylor@example.com",
    });
    expect(snapshot.interactives).toHaveLength(2);
  });

  test("clicks the direct LinkedIn connect button before the more menu", () => {
    const connect = new FakeElement("Connect");
    const more = new FakeElement("More");
    (globalThis as any).document.querySelectorAll = () => [connect, more];

    const result = executeLinkedInConnectPrimaryActionInPage();

    expect(result).toBe("clicked_connect");
    expect(connect.clicked).toBe(true);
    expect(more.clicked).toBe(false);
  });

  test("falls back to the more menu when direct connect is unavailable", () => {
    const more = new FakeElement("More");
    (globalThis as any).document.querySelectorAll = () => [more];

    const result = executeLinkedInConnectPrimaryActionInPage();

    expect(result).toBe("opened_more");
    expect(more.clicked).toBe(true);
  });

  test("clicks connect from the LinkedIn more menu", () => {
    const connect = new FakeElement("Connect");
    (globalThis as any).document.querySelectorAll = () => [connect];

    expect(executeLinkedInConnectFromMoreMenuInPage()).toBe(true);
    expect(connect.clicked).toBe(true);
  });

  test("opens the note editor before filling the LinkedIn dialog", () => {
    const dialog = new FakeElement();
    const addNote = new FakeElement("Add a note");
    dialog.setQuerySelectorAll("button, [role='button']", [addNote]);
    dialog.setQuerySelector("textarea", null);
    dialog.setQuerySelector("[contenteditable='true']", null);
    (globalThis as any).document.querySelector = () => dialog;

    const result =
      executeLinkedInFillAndSendConnectDialogInPage("Hello there");

    expect(result).toBe("note_opened");
    expect(addNote.clicked).toBe(true);
  });

  test("fills and sends the LinkedIn connect dialog", () => {
    const dialog = new FakeElement();
    const textarea = new FakeTextAreaElement();
    const send = new FakeElement("Send invitation");
    dialog.setQuerySelector("textarea", textarea);
    dialog.setQuerySelector("[contenteditable='true']", null);
    dialog.setQuerySelectorAll("button, [role='button']", [send]);
    (globalThis as any).document.querySelector = () => dialog;

    const result =
      executeLinkedInFillAndSendConnectDialogInPage("Hello there");

    expect(result).toBe("sent");
    expect(textarea.focused).toBe(true);
    expect(textarea.value).toBe("Hello there");
    expect(send.clicked).toBe(true);
  });
});
