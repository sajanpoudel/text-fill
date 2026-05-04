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
  executeLinkedInConnectWorkflowInPage,
  executeLinkedInFillAndSendConnectDialogInPage,
  executeWaitForLinkedInPrimaryActionsInPage,
  executePressKeyInPage,
  executeSetFieldValueBySelectorInPage,
  executeScrollInPage,
  executeSnapshotInteractivesInPage,
  executeTypeIntoFieldBySelectorInPage,
  executeVerifyTextInPage,
  isLinkedInAddNoteText,
  isLinkedInConnectText,
  isLinkedInFinalSendText,
  isLinkedInMoreText,
  isLinkedInSendText,
  isLinkedInSendWithoutNoteText,
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

  closest(_selector: string) {
    if (_selector === "[data-tfa-ui]") {
      let current: FakeElement | null = this;
      while (current) {
        if (current.getAttribute("data-tfa-ui") !== null) {
          return current;
        }
        current = current.parentElement;
      }
      return null;
    }
    return this.parentElement;
  }

  matches(selector: string) {
    const normalized = selector.trim().toLowerCase();
    if (normalized.includes("button") && this.tagName === "BUTTON") return true;
    if (normalized.includes("a[href]") && this.tagName === "A") return true;
    if (normalized.includes("textarea") && this.tagName === "TEXTAREA") return true;
    if (normalized.includes("select") && this.tagName === "SELECT") return true;
    if (
      normalized.includes("input:not([type='hidden'])") &&
      this.tagName === "INPUT" &&
      this.type !== "hidden"
    ) {
      return true;
    }
    if (
      normalized.includes("[role='button']") &&
      this.getAttribute("role") === "button"
    ) {
      return true;
    }
    if (
      normalized.includes("[role='menuitem']") &&
      this.getAttribute("role") === "menuitem"
    ) {
      return true;
    }
    if (
      normalized.includes("[role='textbox']") &&
      this.getAttribute("role") === "textbox"
    ) {
      return true;
    }
    if (
      normalized.includes("[tabindex]") &&
      this.getAttribute("tabindex") !== null
    ) {
      return true;
    }
    if (
      normalized.includes("[contenteditable='true']") &&
      this.getAttribute("contenteditable") === "true"
    ) {
      return true;
    }
    return false;
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
      getComputedStyle: (el: FakeElement) => el.computedStyle,
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
      visibilityState: "visible",
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
    expect(isLinkedInSendWithoutNoteText("Send without a note")).toBe(true);
    expect(isLinkedInFinalSendText("Send invitation")).toBe(true);
    expect(isLinkedInFinalSendText("Send without a note")).toBe(false);
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

  test("prefers the best visible main-region root over an earlier hidden candidate", () => {
    const hiddenArticle = new FakeElement("Hidden article");
    hiddenArticle.tagName = "ARTICLE";
    hiddenArticle.rect = {
      width: 0,
      height: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
    };

    const visibleMain = new FakeElement("Visible main root");
    visibleMain.tagName = "MAIN";

    const connectButton = new FakeElement("Connect");
    connectButton.tagName = "BUTTON";
    const heading = new FakeElement("Taylor Recruiter");
    heading.tagName = "H1";

    visibleMain.setQuerySelectorAll(
      "button, [role='button'], a[href], input:not([type='hidden']), textarea, select, [role='textbox'], [contenteditable='true']",
      [connectButton]
    );
    visibleMain.setQuerySelectorAll("h1, h2, h3, h4, [role='heading']", [heading]);
    visibleMain.setQuerySelectorAll(
      "input:not([type='hidden']), textarea, select, [contenteditable='true'], [role='textbox']",
      []
    );
    visibleMain.children = [heading, connectButton];
    visibleMain.childNodes = [{ nodeType: 3, textContent: "Visible profile summary" }];

    (globalThis as any).document.body = visibleMain;
    (globalThis as any).document.querySelectorAll = (selector: string) => {
      if (selector === "dialog, [role='dialog']") return [];
      if (selector === "main, article, [role='main']") {
        return [hiddenArticle, visibleMain];
      }
      return [];
    };

    const interactives = executeSnapshotInteractivesInPage("main");
    expect(interactives).toHaveLength(1);
    expect(interactives[0]?.tag).toBe("button");

    const tree = executeGetAccessibilityTreeInPage("main");
    expect(tree?.tag).toBe("main");
    expect(tree?.children.length).toBe(2);
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

  test("detects LinkedIn profile controls from aria-label text", () => {
    const more = new FakeElement("");
    more.setAttribute("aria-label", "More actions");
    (globalThis as any).document.querySelectorAll = () => [more];

    expect(executeLinkedInConnectPrimaryActionInPage()).toBe("opened_more");
    expect(more.clicked).toBe(true);
  });

  test("clicks connect from the LinkedIn more menu", () => {
    const connect = new FakeElement("Connect");
    (globalThis as any).document.querySelectorAll = () => [connect];

    expect(executeLinkedInConnectFromMoreMenuInPage()).toBe(true);
    expect(connect.clicked).toBe(true);
  });

  test("clicks connect from the LinkedIn more menu using aria-label invite text", () => {
    const connect = new FakeElement("");
    connect.setAttribute("aria-label", "Invite Gianna Satriano to connect");
    (globalThis as any).document.querySelectorAll = () => [connect];

    expect(executeLinkedInConnectFromMoreMenuInPage()).toBe(true);
    expect(connect.clicked).toBe(true);
  });

  test("waits until LinkedIn primary action controls are present", async () => {
    let calls = 0;
    const more = new FakeElement("");
    more.setAttribute("aria-label", "More actions");
    (globalThis as any).document.querySelectorAll = () => {
      calls += 1;
      return calls >= 3 ? [more] : [];
    };

    const result = await executeWaitForLinkedInPrimaryActionsInPage(600);

    expect(result.ready).toBe(true);
    expect(result.labels).toEqual(["more actions"]);
  });

  test("prefers main-profile action labels over LinkedIn global nav noise during preflight", async () => {
    const mainRoot = new FakeElement();
    const connect = new FakeElement("Connect");
    const message = new FakeElement("Message");
    const more = new FakeElement("More");
    mainRoot.setQuerySelectorAll(
      "button, [role='button'], [role='menuitem'], a[role='button'], a.artdeco-button",
      [connect, message, more]
    );

    (globalThis as any).document.querySelector = (selector: string) => {
      if (selector === "main, article, [role='main']") return mainRoot;
      return null;
    };
    (globalThis as any).document.querySelectorAll = (selector: string) => {
      if (
        selector ===
        "button, [role='button'], [role='menuitem'], a[role='button'], a.artdeco-button"
      ) {
        return [
          new FakeElement("Home"),
          new FakeElement("Jobs"),
          new FakeElement("Me"),
          new FakeElement("More"),
          connect,
          message,
          more,
        ];
      }
      return [];
    };

    const result = await executeWaitForLinkedInPrimaryActionsInPage(600);

    expect(result.ready).toBe(true);
    expect(result.labels.slice(0, 3)).toEqual(["connect", "message", "more"]);
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

  test("fills and sends the LinkedIn connect dialog when controls are labeled via aria-label", () => {
    const dialog = new FakeElement();
    const textarea = new FakeTextAreaElement();
    const addNote = new FakeElement("");
    addNote.setAttribute("aria-label", "Add a note");
    const send = new FakeElement("");
    send.setAttribute("aria-label", "Send invitation");
    dialog.setQuerySelector("textarea", textarea);
    dialog.setQuerySelector("[contenteditable='true']", null);
    dialog.setQuerySelectorAll("button, [role='button']", [addNote, send]);
    (globalThis as any).document.querySelector = () => dialog;

    const result = executeLinkedInFillAndSendConnectDialogInPage("Hello there");

    expect(result).toBe("sent");
    expect(textarea.value).toBe("Hello there");
    expect(send.clicked).toBe(true);
  });

  test("executes the LinkedIn more-menu connect workflow in one pass", async () => {
    let phase: "primary" | "menu" | "dialog" | "note" = "primary";

    const more = new FakeElement("");
    more.setAttribute("aria-label", "More actions");
    more.click = () => {
      more.clicked = true;
      phase = "menu";
    };

    const connectOption = new FakeElement("");
    connectOption.setAttribute("aria-label", "Invite Gianna Satriano to connect");
    connectOption.click = () => {
      connectOption.clicked = true;
      phase = "dialog";
    };
    const menuRoot = new FakeElement();
    menuRoot.setAttribute("role", "menu");
    menuRoot.setQuerySelectorAll("button, [role='button'], [role='menuitem']", [
      connectOption,
    ]);

    const addNote = new FakeElement("");
    addNote.setAttribute("aria-label", "Add a note");
    addNote.click = () => {
      addNote.clicked = true;
      phase = "note";
    };

    const send = new FakeElement("");
    send.setAttribute("aria-label", "Send invitation");

    const textarea = new FakeTextAreaElement();
    textarea.tagName = "TEXTAREA";
    const dialogRoot = new FakeElement();
    dialogRoot.setAttribute("role", "dialog");
    dialogRoot.querySelectorAll = <T,>(selector: string): T[] => {
      if (selector === "button, [role='button'], [role='menuitem']") {
        return [addNote, send] as T[];
      }
      if (selector === "textarea, [contenteditable='true']") {
        return (phase === "note" ? [textarea] : []) as T[];
      }
      return [] as T[];
    };

    (globalThis as any).document.querySelectorAll = (selector: string) => {
      if (selector === "button, [role='button'], [role='menuitem']") {
        if (phase === "primary") return [more];
        if (phase === "menu") return [connectOption];
        return [addNote, send];
      }
      if (selector === "[role='menu']") {
        return phase === "menu" ? [menuRoot] : [];
      }
      if (selector === "[role='dialog'], dialog, .artdeco-modal") {
        return phase === "dialog" || phase === "note" ? [dialogRoot] : [];
      }
      if (selector === "textarea, [contenteditable='true']") {
        return phase === "note" ? [textarea] : [];
      }
      return [];
    };

    const result = await executeLinkedInConnectWorkflowInPage("Hello there");

    expect(result.state).toBe("sent");
    expect(more.clicked).toBe(true);
    expect(connectOption.clicked).toBe(true);
    expect(addNote.clicked).toBe(true);
    expect(send.clicked).toBe(true);
    expect(textarea.value).toBe("Hello there");
    expect(result.debug.primaryButtons[0]).toBe("more actions");
    expect(result.debug.menuOptions[0]).toBe("invite gianna satriano to connect");
    expect(result.debug.dialogButtons[1]).toBe("send invitation");
  });

  test("detects the LinkedIn invite surface through artdeco modal outlet markup", async () => {
    let phase: "primary" | "dialog" = "primary";

    const connect = new FakeElement("Connect");
    connect.click = () => {
      connect.clicked = true;
      phase = "dialog";
    };

    const modalOutlet = new FakeElement();
    modalOutlet.setAttribute("id", "artdeco-modal-outlet");

    const modalOverlay = new FakeElement();
    modalOverlay.setAttribute("class", "artdeco-modal-overlay send-invite");
    modalOverlay.parentElement = modalOutlet;

    const heading = new FakeElement("Add a note to your invitation");
    heading.tagName = "H2";
    heading.parentElement = modalOverlay;

    const textarea = new FakeTextAreaElement();
    textarea.tagName = "TEXTAREA";
    textarea.parentElement = modalOverlay;

    const send = new FakeElement("");
    send.setAttribute("aria-label", "Send invitation");
    send.parentElement = modalOverlay;

    modalOverlay.querySelectorAll = <T,>(selector: string): T[] => {
      if (
        selector ===
          "button, [role='button'], [role='menuitem'], a[role='button'], a.artdeco-button" ||
        selector === "button, [role='button'], [role='menuitem']"
      ) {
        return [send] as T[];
      }
      if (selector === "textarea, [contenteditable='true']") {
        return [textarea] as T[];
      }
      return [] as T[];
    };

    (globalThis as any).document.querySelectorAll = (selector: string) => {
      if (selector === "button, [role='button'], [role='menuitem']") {
        return phase === "primary" ? [connect] : [send];
      }
      if (selector === "#artdeco-modal-outlet") {
        return phase === "dialog" ? [modalOutlet] : [];
      }
      if (
        selector === ".artdeco-modal-overlay" ||
        selector === ".send-invite" ||
        selector === "[role='dialog'], dialog, .artdeco-modal"
      ) {
        return phase === "dialog" ? [modalOutlet, modalOverlay] : [];
      }
      if (selector === "textarea, [contenteditable='true']") {
        return phase === "dialog" ? [textarea] : [];
      }
      if (selector === "h1, h2, h3, label, p, span") {
        return phase === "dialog" ? [heading] : [];
      }
      return [];
    };

    const result = await executeLinkedInConnectWorkflowInPage("Hello there");

    expect(result.state).toBe("sent");
    expect(connect.clicked).toBe(true);
    expect(send.clicked).toBe(true);
    expect(textarea.value).toBe("Hello there");
  });

  test("prefers the direct LinkedIn connect button over the more menu when both are present", async () => {
    let phase: "primary" | "dialog" | "note" = "primary";

    const connect = new FakeElement("Connect");
    connect.click = () => {
      connect.clicked = true;
      phase = "dialog";
    };

    const message = new FakeElement("Message");
    const more = new FakeElement("More");
    more.click = () => {
      more.clicked = true;
    };

    const addNote = new FakeElement("");
    addNote.setAttribute("aria-label", "Add a note");
    addNote.click = () => {
      addNote.clicked = true;
      phase = "note";
    };

    const send = new FakeElement("");
    send.setAttribute("aria-label", "Send invitation");

    const textarea = new FakeTextAreaElement();
    textarea.tagName = "TEXTAREA";

    const dialogRoot = new FakeElement();
    dialogRoot.setAttribute("role", "dialog");
    dialogRoot.querySelectorAll = <T,>(selector: string): T[] => {
      if (selector === "button, [role='button'], [role='menuitem']") {
        return [addNote, send] as T[];
      }
      if (selector === "textarea, [contenteditable='true']") {
        return (phase === "note" ? [textarea] : []) as T[];
      }
      return [] as T[];
    };

    (globalThis as any).document.querySelectorAll = (selector: string) => {
      if (selector === "button, [role='button'], [role='menuitem']") {
        if (phase === "primary") return [connect, message, more];
        return [addNote, send];
      }
      if (selector === "[role='dialog'], dialog, .artdeco-modal") {
        return phase === "dialog" || phase === "note" ? [dialogRoot] : [];
      }
      if (selector === "textarea, [contenteditable='true']") {
        return phase === "note" ? [textarea] : [];
      }
      return [];
    };

    const result = await executeLinkedInConnectWorkflowInPage("Hello there");

    expect(result.state).toBe("sent");
    expect(connect.clicked).toBe(true);
    expect(more.clicked).toBe(false);
    expect(addNote.clicked).toBe(true);
    expect(send.clicked).toBe(true);
    expect((result.debug.resolutionPath ?? []).includes("direct_connect")).toBe(
      true
    );
  });

  test("recognizes direct LinkedIn custom-invite anchors as connect controls", async () => {
    let phase: "primary" | "dialog" | "note" = "primary";

    const connectLink = new FakeElement("Connect");
    connectLink.tagName = "A";
    connectLink.setAttribute(
      "href",
      "/preload/custom-invite/?vanityName=ruchiva"
    );
    connectLink.setAttribute("aria-label", "Invite Ruchi Varshney to connect");
    connectLink.click = () => {
      connectLink.clicked = true;
      phase = "dialog";
    };

    const addNote = new FakeElement("");
    addNote.setAttribute("aria-label", "Add a note");
    addNote.click = () => {
      addNote.clicked = true;
      phase = "note";
    };

    const send = new FakeElement("");
    send.setAttribute("aria-label", "Send invitation");

    const textarea = new FakeTextAreaElement();
    textarea.tagName = "TEXTAREA";

    const dialogRoot = new FakeElement();
    dialogRoot.setAttribute("role", "dialog");
    dialogRoot.querySelectorAll = <T,>(selector: string): T[] => {
      if (
        selector.includes("button") ||
        selector.includes("[role='button']") ||
        selector.includes("[role='menuitem']") ||
        selector.includes("a[role='button']") ||
        selector.includes("a.artdeco-button")
      ) {
        return [addNote, send] as T[];
      }
      if (selector === "textarea, [contenteditable='true']") {
        return (phase === "note" ? [textarea] : []) as T[];
      }
      return [] as T[];
    };

    const mainRoot = new FakeElement();
    mainRoot.setQuerySelectorAll(
      "button, [role='button'], [role='menuitem'], a[role='button'], a.artdeco-button",
      []
    );
    mainRoot.querySelectorAll = <T,>(selector: string): T[] => {
      if (
        selector.includes("a[href*='/preload/custom-invite/']") ||
        selector.includes("a[href*='custom-invite'][aria-label]") ||
        selector.includes("a[href][aria-label]")
      ) {
        return [connectLink] as T[];
      }
      if (
        selector ===
          "button, [role='button'], [role='menuitem'], a[role='button'], a.artdeco-button" ||
        selector === "button, [role='button'], [role='menuitem']"
      ) {
        return [] as T[];
      }
      return [] as T[];
    };

    (globalThis as any).document.querySelector = (selector: string) => {
      if (selector === "main, article, [role='main']") return mainRoot;
      return null;
    };
    (globalThis as any).document.querySelectorAll = (selector: string) => {
      if (
        selector.includes("a[href*='/preload/custom-invite/']") ||
        selector.includes("a[href*='custom-invite'][aria-label]") ||
        selector.includes("a[href][aria-label]")
      ) {
        return phase === "primary" ? [connectLink] : [];
      }
      if (
        selector ===
          "button, [role='button'], [role='menuitem'], a[role='button'], a.artdeco-button" ||
        selector === "button, [role='button'], [role='menuitem']"
      ) {
        return phase === "primary" ? [] : [addNote, send];
      }
      if (selector === "[role='dialog'], dialog, .artdeco-modal") {
        return phase === "dialog" || phase === "note" ? [dialogRoot] : [];
      }
      if (selector === "textarea, [contenteditable='true']") {
        return phase === "note" ? [textarea] : [];
      }
      return [];
    };

    const result = await executeLinkedInConnectWorkflowInPage("Hello there");

    expect(result.state).toBe("sent");
    expect(connectLink.clicked).toBe(true);
    expect(addNote.clicked).toBe(true);
    expect(send.clicked).toBe(true);
    expect(
      (result.debug.primaryButtons ?? []).some(
        (label) => label.includes("invite") || label.includes("connect")
      )
    ).toBe(true);
    expect((result.debug.resolutionPath ?? []).includes("direct_invite_anchor")).toBe(
      true
    );
  });

  test("ignores non-action LinkedIn profile anchors during action preflight", async () => {
    const companyLink = new FakeElement("Meta");
    companyLink.tagName = "A";
    companyLink.setAttribute("href", "https://www.linkedin.com/company/meta/");
    companyLink.setAttribute("title", "Meta");

    const schoolLink = new FakeElement("Delhi University");
    schoolLink.tagName = "A";
    schoolLink.setAttribute("href", "https://www.linkedin.com/school/delhi-university/");
    schoolLink.setAttribute("title", "Delhi University");

    const connectLink = new FakeElement("Connect");
    connectLink.tagName = "A";
    connectLink.setAttribute(
      "href",
      "/preload/custom-invite/?vanityName=ruchiva"
    );
    connectLink.setAttribute("aria-label", "Invite Ruchi Varshney to connect");

    const follow = new FakeElement("Follow");
    const mainRoot = new FakeElement();
    mainRoot.querySelectorAll = <T,>(selector: string): T[] => {
      if (selector.includes("/preload/custom-invite/")) {
        return [connectLink] as T[];
      }
      if (selector.includes("a[title*='follow' i]")) {
        return [] as T[];
      }
      if (
        selector ===
          "button, [role='button'], [role='menuitem'], a[role='button'], a.artdeco-button" ||
        selector === "button, [role='button'], [role='menuitem']"
      ) {
        return [follow] as T[];
      }
      return [] as T[];
    };

    (globalThis as any).document.querySelector = (selector: string) => {
      if (selector === "main, article, [role='main']") return mainRoot;
      return null;
    };
    (globalThis as any).document.querySelectorAll = (selector: string) => {
      if (selector.includes("/preload/custom-invite/")) {
        return [connectLink];
      }
      if (selector.includes("a[title*='connect' i]")) {
        return [];
      }
      if (
        selector ===
          "button, [role='button'], [role='menuitem'], a[role='button'], a.artdeco-button" ||
        selector === "button, [role='button'], [role='menuitem']"
      ) {
        return [follow];
      }
      return [companyLink, schoolLink];
    };

    const result = await executeWaitForLinkedInPrimaryActionsInPage(600);

    expect(result.ready).toBe(true);
    expect(
      result.labels.some(
        (label) => label.includes("invite") || label.includes("connect")
      )
    ).toBe(true);
    expect(result.labels.some((label) => label.includes("meta"))).toBe(false);
    expect(result.labels.some((label) => label.includes("delhi"))).toBe(false);
  });

  test("prefers the profile action bar over LinkedIn nav buttons when choosing actions", async () => {
    let phase: "primary" | "dialog" | "note" = "primary";

    const mainRoot = new FakeElement();
    const connect = new FakeElement("Connect");
    connect.click = () => {
      connect.clicked = true;
      phase = "dialog";
    };
    const message = new FakeElement("Message");
    const more = new FakeElement("More");
    mainRoot.setQuerySelectorAll(
      "button, [role='button'], [role='menuitem'], a[role='button'], a.artdeco-button",
      [connect, message, more]
    );

    const headerHome = new FakeElement("Home");
    const headerJobs = new FakeElement("Jobs");
    const headerMe = new FakeElement("Me");
    const headerMore = new FakeElement("More");
    headerMore.click = () => {
      headerMore.clicked = true;
    };

    const addNote = new FakeElement("");
    addNote.setAttribute("aria-label", "Add a note");
    addNote.click = () => {
      addNote.clicked = true;
      phase = "note";
    };
    const send = new FakeElement("");
    send.setAttribute("aria-label", "Send invitation");
    const textarea = new FakeTextAreaElement();
    textarea.tagName = "TEXTAREA";

    const dialogRoot = new FakeElement();
    dialogRoot.setAttribute("role", "dialog");
    dialogRoot.querySelectorAll = <T,>(selector: string): T[] => {
      if (
        selector ===
          "button, [role='button'], [role='menuitem'], a[role='button'], a.artdeco-button" ||
        selector === "button, [role='button'], [role='menuitem']"
      ) {
        return [addNote, send] as T[];
      }
      if (selector === "textarea, [contenteditable='true']") {
        return (phase === "note" ? [textarea] : []) as T[];
      }
      return [] as T[];
    };

    (globalThis as any).document.querySelector = (selector: string) => {
      if (selector === "main, article, [role='main']") return mainRoot;
      return null;
    };
    (globalThis as any).document.querySelectorAll = (selector: string) => {
      if (
        selector ===
        "button, [role='button'], [role='menuitem'], a[role='button'], a.artdeco-button"
      ) {
        if (phase === "primary") {
          return [headerHome, headerJobs, headerMe, headerMore, connect, message, more];
        }
        return [addNote, send];
      }
      if (selector === "button, [role='button'], [role='menuitem']") {
        if (phase === "primary") {
          return [headerHome, headerJobs, headerMe, headerMore, connect, message, more];
        }
        return [addNote, send];
      }
      if (selector === "[role='dialog'], dialog, .artdeco-modal") {
        return phase === "dialog" || phase === "note" ? [dialogRoot] : [];
      }
      if (selector === "textarea, [contenteditable='true']") {
        return phase === "note" ? [textarea] : [];
      }
      return [];
    };

    const result = await executeLinkedInConnectWorkflowInPage("Hello there");

    expect(result.state).toBe("sent");
    expect(connect.clicked).toBe(true);
    expect(headerMore.clicked).toBe(false);
  });

  test("prefers the top profile action band over lower-page connect controls", async () => {
    let phase: "primary" | "dialog" | "note" = "primary";

    const topConnect = new FakeElement("Connect");
    topConnect.rect = { width: 100, height: 20, top: 40, left: 0, right: 100, bottom: 60 };
    topConnect.click = () => {
      topConnect.clicked = true;
      phase = "dialog";
    };
    const topMessage = new FakeElement("Message");
    topMessage.rect = { width: 100, height: 20, top: 40, left: 110, right: 210, bottom: 60 };
    const topMore = new FakeElement("More");
    topMore.rect = { width: 100, height: 20, top: 40, left: 220, right: 320, bottom: 60 };

    const lowerConnect = new FakeElement("Connect");
    lowerConnect.rect = { width: 100, height: 20, top: 680, left: 0, right: 100, bottom: 700 };
    lowerConnect.click = () => {
      lowerConnect.clicked = true;
    };

    const addNote = new FakeElement("");
    addNote.setAttribute("aria-label", "Add a note");
    addNote.click = () => {
      addNote.clicked = true;
      phase = "note";
    };
    const send = new FakeElement("");
    send.setAttribute("aria-label", "Send invitation");
    const textarea = new FakeTextAreaElement();
    textarea.tagName = "TEXTAREA";

    const dialogRoot = new FakeElement();
    dialogRoot.setAttribute("role", "dialog");
    dialogRoot.querySelectorAll = <T,>(selector: string): T[] => {
      if (
        selector ===
          "button, [role='button'], [role='menuitem'], a[role='button'], a.artdeco-button" ||
        selector === "button, [role='button'], [role='menuitem']"
      ) {
        return [addNote, send] as T[];
      }
      if (selector === "textarea, [contenteditable='true']") {
        return (phase === "note" ? [textarea] : []) as T[];
      }
      return [] as T[];
    };

    const mainRoot = new FakeElement();
    mainRoot.setQuerySelectorAll(
      "button, [role='button'], [role='menuitem'], a[role='button'], a.artdeco-button",
      [topConnect, topMessage, topMore, lowerConnect]
    );

    (globalThis as any).document.querySelector = (selector: string) => {
      if (selector === "main, article, [role='main']") return mainRoot;
      return null;
    };
    (globalThis as any).document.querySelectorAll = (selector: string) => {
      if (
        selector ===
          "button, [role='button'], [role='menuitem'], a[role='button'], a.artdeco-button" ||
        selector === "button, [role='button'], [role='menuitem']"
      ) {
        if (phase === "primary") {
          return [topConnect, topMessage, topMore, lowerConnect];
        }
        return [addNote, send];
      }
      if (selector === "[role='dialog'], dialog, .artdeco-modal") {
        return phase === "dialog" || phase === "note" ? [dialogRoot] : [];
      }
      if (selector === "textarea, [contenteditable='true']") {
        return phase === "note" ? [textarea] : [];
      }
      return [];
    };

    const result = await executeLinkedInConnectWorkflowInPage("Hello there");

    expect(result.state).toBe("sent");
    expect(topConnect.clicked).toBe(true);
    expect(lowerConnect.clicked).toBe(false);
  });

  test("falls back to the more menu when the first visible connect control does not open a dialog", async () => {
    let phase: "primary" | "menu" | "dialog" | "note" = "primary";

    const inertConnect = new FakeElement("Connect");
    inertConnect.rect = {
      width: 100,
      height: 20,
      top: 40,
      left: 0,
      right: 100,
      bottom: 60,
    };
    inertConnect.click = () => {
      inertConnect.clicked = true;
    };

    const more = new FakeElement("More");
    more.rect = {
      width: 100,
      height: 20,
      top: 40,
      left: 110,
      right: 210,
      bottom: 60,
    };
    more.click = () => {
      more.clicked = true;
      phase = "menu";
    };

    const menuConnect = new FakeElement("");
    menuConnect.setAttribute("aria-label", "Invite Ruchiva to connect");
    menuConnect.click = () => {
      menuConnect.clicked = true;
      phase = "dialog";
    };

    const menuRoot = new FakeElement();
    menuRoot.setAttribute("role", "menu");
    menuRoot.setQuerySelectorAll(
      "button, [role='button'], [role='menuitem'], a[role='button'], a.artdeco-button",
      [menuConnect]
    );

    const addNote = new FakeElement("");
    addNote.setAttribute("aria-label", "Add a note");
    addNote.click = () => {
      addNote.clicked = true;
      phase = "note";
    };
    const send = new FakeElement("");
    send.setAttribute("aria-label", "Send invitation");
    const textarea = new FakeTextAreaElement();
    textarea.tagName = "TEXTAREA";

    const dialogRoot = new FakeElement();
    dialogRoot.setAttribute("role", "dialog");
    dialogRoot.querySelectorAll = <T,>(selector: string): T[] => {
      if (
        selector ===
          "button, [role='button'], [role='menuitem'], a[role='button'], a.artdeco-button" ||
        selector === "button, [role='button'], [role='menuitem']"
      ) {
        return [addNote, send] as T[];
      }
      if (selector === "textarea, [contenteditable='true']") {
        return (phase === "note" ? [textarea] : []) as T[];
      }
      return [] as T[];
    };

    const mainRoot = new FakeElement();
    mainRoot.setQuerySelectorAll(
      "button, [role='button'], [role='menuitem'], a[role='button'], a.artdeco-button",
      [inertConnect, more]
    );

    (globalThis as any).document.querySelector = (selector: string) => {
      if (selector === "main, article, [role='main']") return mainRoot;
      return null;
    };
    (globalThis as any).document.querySelectorAll = (selector: string) => {
      if (
        selector ===
          "button, [role='button'], [role='menuitem'], a[role='button'], a.artdeco-button" ||
        selector === "button, [role='button'], [role='menuitem']"
      ) {
        if (phase === "primary") return [inertConnect, more];
        if (phase === "menu") return [menuConnect];
        return [addNote, send];
      }
      if (selector === "[role='menu']") {
        return phase === "menu" ? [menuRoot] : [];
      }
      if (selector === "[role='dialog'], dialog, .artdeco-modal") {
        return phase === "dialog" || phase === "note" ? [dialogRoot] : [];
      }
      if (selector === "textarea, [contenteditable='true']") {
        return phase === "note" ? [textarea] : [];
      }
      return [];
    };

    const result = await executeLinkedInConnectWorkflowInPage("Hello there");

    expect(result.state).toBe("sent");
    expect(inertConnect.clicked).toBe(true);
    expect(more.clicked).toBe(true);
    expect(menuConnect.clicked).toBe(true);
    expect(addNote.clicked).toBe(true);
    expect(send.clicked).toBe(true);
    const resolutionPath = result.debug.resolutionPath ?? [];
    expect(resolutionPath.includes("try_direct_connect_1")).toBe(true);
    expect(resolutionPath.includes("try_more_1")).toBe(true);
    expect(resolutionPath.includes("clicked_menu_connect")).toBe(true);
  });

  test("does not click send without note when a personalized note editor never appears", async () => {
    let phase: "primary" | "dialog" = "primary";

    const connect = new FakeElement("Connect");
    connect.click = () => {
      connect.clicked = true;
      phase = "dialog";
    };

    const addNote = new FakeElement("");
    addNote.setAttribute("aria-label", "Add a note");
    addNote.click = () => {
      addNote.clicked = true;
    };

    const sendWithoutNote = new FakeElement("");
    sendWithoutNote.setAttribute("aria-label", "Send without a note");

    const dialogRoot = new FakeElement();
    dialogRoot.setAttribute("role", "dialog");
    dialogRoot.querySelectorAll = <T,>(selector: string): T[] => {
      if (selector === "button, [role='button'], [role='menuitem']") {
        return [addNote, sendWithoutNote] as T[];
      }
      if (selector === "textarea, [contenteditable='true']") {
        return [] as T[];
      }
      return [] as T[];
    };

    (globalThis as any).document.querySelectorAll = (selector: string) => {
      if (selector === "button, [role='button'], [role='menuitem']") {
        return phase === "primary" ? [connect] : [addNote, sendWithoutNote];
      }
      if (selector === "[role='dialog'], dialog, .artdeco-modal") {
        return phase === "dialog" ? [dialogRoot] : [];
      }
      if (selector === "textarea, [contenteditable='true']") {
        return [];
      }
      return [];
    };

    const result = await executeLinkedInConnectWorkflowInPage("Hello there");

    expect(result.state).toBe("note_editor_not_found");
    expect(connect.clicked).toBe(true);
    expect(addNote.clicked).toBe(true);
    expect(sendWithoutNote.clicked).toBe(false);
  });

  test("handles an already-open LinkedIn invite dialog without needing profile action clicks", async () => {
    let phase: "dialog" | "note" = "dialog";

    const addNote = new FakeElement("");
    addNote.setAttribute("aria-label", "Add a note");
    addNote.click = () => {
      addNote.clicked = true;
      phase = "note";
    };
    const send = new FakeElement("");
    send.setAttribute("aria-label", "Send invitation");
    const textarea = new FakeTextAreaElement();
    textarea.tagName = "TEXTAREA";

    const dialogRoot = new FakeElement();
    dialogRoot.setAttribute("role", "dialog");
    dialogRoot.querySelectorAll = <T,>(selector: string): T[] => {
      if (
        selector ===
          "button, [role='button'], [role='menuitem'], a[role='button'], a.artdeco-button" ||
        selector === "button, [role='button'], [role='menuitem']"
      ) {
        return [addNote, send] as T[];
      }
      if (selector === "textarea, [contenteditable='true']") {
        return (phase === "note" ? [textarea] : []) as T[];
      }
      return [] as T[];
    };

    (globalThis as any).document.querySelectorAll = (selector: string) => {
      if (
        selector === "[role='dialog'], dialog, .artdeco-modal" ||
        selector === "#artdeco-modal-outlet" ||
        selector === ".artdeco-modal-overlay" ||
        selector === ".send-invite"
      ) {
        return [dialogRoot];
      }
      if (
        selector ===
          "button, [role='button'], [role='menuitem'], a[role='button'], a.artdeco-button" ||
        selector === "button, [role='button'], [role='menuitem']"
      ) {
        return [addNote, send];
      }
      if (selector === "textarea, [contenteditable='true']") {
        return phase === "note" ? [textarea] : [];
      }
      return [];
    };

    const result = await executeLinkedInConnectWorkflowInPage("Hello there");

    expect(result.state).toBe("sent");
    expect(addNote.clicked).toBe(true);
    expect(send.clicked).toBe(true);
    expect(textarea.value).toBe("Hello there");
    expect((result.debug.resolutionPath ?? []).includes("existing_dialog")).toBe(
      true
    );
  });

  test("ignores TextFill overlay controls during LinkedIn action probing", async () => {
    const overlayButton = new FakeElement("AI");
    overlayButton.setAttribute("data-tfa-ui", "agent-fab");
    const overlayParent = new FakeElement();
    overlayParent.setAttribute("data-tfa-ui", "root");
    overlayButton.parentElement = overlayParent;

    const connect = new FakeElement("Connect");
    const message = new FakeElement("Message");
    const more = new FakeElement("More");
    const mainRoot = new FakeElement();
    mainRoot.setQuerySelectorAll(
      "button, [role='button'], [role='menuitem'], a[role='button'], a.artdeco-button",
      [connect, message, more]
    );

    (globalThis as any).document.querySelector = (selector: string) => {
      if (selector === "main, article, [role='main']") return mainRoot;
      return null;
    };
    (globalThis as any).document.querySelectorAll = (selector: string) => {
      if (
        selector ===
          "button, [role='button'], [role='menuitem'], a[role='button'], a.artdeco-button" ||
        selector === "button, [role='button'], [role='menuitem']"
      ) {
        return [overlayButton, connect, message, more];
      }
      return [];
    };

    const result = await executeWaitForLinkedInPrimaryActionsInPage(600);

    expect(result.ready).toBe(true);
    expect(result.labels.slice(0, 3)).toEqual(["connect", "message", "more"]);
  });

  test("finds LinkedIn controls in a hidden background tab even when layout rects are zero", async () => {
    let phase: "primary" | "dialog" | "note" = "primary";

    const connect = new FakeElement("Connect");
    connect.rect = { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
    connect.click = () => {
      connect.clicked = true;
      phase = "dialog";
    };

    const addNote = new FakeElement("");
    addNote.setAttribute("aria-label", "Add a note");
    addNote.rect = { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
    addNote.click = () => {
      addNote.clicked = true;
      phase = "note";
    };

    const send = new FakeElement("");
    send.setAttribute("aria-label", "Send invitation");
    send.rect = { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };

    const textarea = new FakeTextAreaElement();
    textarea.tagName = "TEXTAREA";
    textarea.rect = { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };

    const dialogRoot = new FakeElement();
    dialogRoot.setAttribute("role", "dialog");
    dialogRoot.rect = { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
    dialogRoot.querySelectorAll = <T,>(selector: string): T[] => {
      if (selector === "button, [role='button'], [role='menuitem']") {
        return [addNote, send] as T[];
      }
      if (selector === "textarea, [contenteditable='true']") {
        return (phase === "note" ? [textarea] : []) as T[];
      }
      return [] as T[];
    };

    (globalThis as any).document.visibilityState = "hidden";
    (globalThis as any).window.innerWidth = 0;
    (globalThis as any).window.innerHeight = 0;
    (globalThis as any).document.querySelectorAll = (selector: string) => {
      if (selector === "button, [role='button'], [role='menuitem']") {
        return phase === "primary" ? [connect] : [addNote, send];
      }
      if (selector === "[role='dialog'], dialog, .artdeco-modal") {
        return phase === "dialog" || phase === "note" ? [dialogRoot] : [];
      }
      if (selector === "textarea, [contenteditable='true']") {
        return phase === "note" ? [textarea] : [];
      }
      return [];
    };

    const result = await executeLinkedInConnectWorkflowInPage("Hello there");

    expect(result.state).toBe("sent");
    expect(connect.clicked).toBe(true);
    expect(addNote.clicked).toBe(true);
    expect(send.clicked).toBe(true);
    expect(textarea.value).toBe("Hello there");
  }, 10_000);

  test("clicks the nested labeled connect control inside a LinkedIn menu item", async () => {
    let phase: "primary" | "menu" | "dialog" = "primary";

    const more = new FakeElement("");
    more.tagName = "BUTTON";
    more.setAttribute("aria-label", "More actions");
    more.click = () => {
      more.clicked = true;
      phase = "menu";
    };

    const menuRoot = new FakeElement();
    menuRoot.setAttribute("role", "menu");

    const connectMenuItem = new FakeElement("");
    connectMenuItem.setAttribute("role", "menuitem");
    connectMenuItem.setAttribute("tabindex", "-1");
    const connectInner = new FakeElement("");
    connectInner.setAttribute("aria-label", "Invite Greffen George to connect");
    connectInner.parentElement = connectMenuItem;
    connectInner.click = () => {
      connectInner.clicked = true;
      phase = "dialog";
    };
    connectMenuItem.setQuerySelector(
      "[aria-label], [title], .artdeco-button__text, p, span",
      connectInner
    );
    connectMenuItem.setQuerySelector(
      "[aria-label], [title], button, a[href], [role='button'], [tabindex]:not([tabindex='-1']), [contenteditable='true']",
      connectInner
    );
    menuRoot.setQuerySelectorAll(
      "button, [role='button'], [role='menuitem']",
      [connectMenuItem]
    );

    const dialogRoot = new FakeElement();
    dialogRoot.setAttribute("role", "dialog");

    (globalThis as any).document.querySelectorAll = (selector: string) => {
      if (selector === "button, [role='button'], [role='menuitem']") {
        if (phase === "primary") return [more];
        if (phase === "menu") return [more, connectMenuItem];
        return [more];
      }
      if (selector === "[role='menu']") {
        return phase === "menu" ? [menuRoot] : [];
      }
      if (selector === "[role='dialog'], dialog, .artdeco-modal") {
        return phase === "dialog" ? [dialogRoot] : [];
      }
      return [];
    };

    const result = await executeLinkedInConnectWorkflowInPage("Hello there");

    expect(result.state).toBe("note_editor_not_found");
    expect(connectInner.clicked).toBe(true);
    expect(result.debug.menuOptions[0]).toBe("invite greffen george to connect");
    const resolutionPath = result.debug.resolutionPath ?? [];
    expect(resolutionPath.includes("try_more_1")).toBe(true);
    expect(resolutionPath.includes("try_menu_connect_1_1")).toBe(true);
    expect(resolutionPath.includes("clicked_menu_connect")).toBe(true);
  });

  test("reports no connect control when no LinkedIn action is available", async () => {
    const message = new FakeElement("Message");
    (globalThis as any).document.querySelectorAll = (selector: string) => {
      if (selector === "button, [role='button'], [role='menuitem']") {
        return [message];
      }
      if (selector === "textarea, [contenteditable='true']") {
        return [];
      }
      return [];
    };

    const result = await executeLinkedInConnectWorkflowInPage("Hello there");

    expect(result.state).toBe("already_connected");
    expect(result.debug.primaryButtons[0]).toBe("message");
  });
});
