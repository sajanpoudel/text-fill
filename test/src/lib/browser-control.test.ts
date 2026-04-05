import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  executeLinkedInConnectFromMoreMenuInPage,
  executeLinkedInConnectPrimaryActionInPage,
  executeLinkedInFillAndSendConnectDialogInPage,
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
  clicked = false;
  dispatched: string[] = [];
  value = "";
  focused = false;
  private selectorMap = new Map<string, FakeElement | null>();
  private selectorAllMap = new Map<string, FakeElement[]>();

  constructor(textContent = "") {
    this.textContent = textContent;
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

describe("browser control helpers", () => {
  beforeAll(() => {
    (globalThis as any).Event = FakeEvent;
    (globalThis as any).MouseEvent = FakeEvent;
    (globalThis as any).PointerEvent = FakeEvent;
    (globalThis as any).InputEvent = FakeEvent;
    (globalThis as any).HTMLTextAreaElement = FakeTextAreaElement;
  });

  beforeEach(() => {
    (globalThis as any).document = {
      body: new FakeElement("body"),
      querySelector: () => null,
      querySelectorAll: () => [],
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
