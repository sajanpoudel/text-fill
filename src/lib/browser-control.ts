/**
 * browser-control.ts — Tier 1 content-script browser automation utilities.
 *
 * Runs in the ISOLATED world (content script context).
 * For MAIN-world injection see the executeScript paths in background.ts.
 *
 * These helpers dispatch the full pointer + mouse event sequence that
 * React / Vue / Svelte apps expect. A bare `.click()` misses `pointerover`
 * and `mousedown` events that many frameworks rely on.
 */

/**
 * Dispatches a full pointer + mouse event sequence on `el`, matching what
 * a real user click produces. Works reliably with React event delegation
 * and synthetic event systems (Lexical, Quill, ProseMirror).
 */
export function syntheticClick(el: Element): void {
  el.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
  el.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true }));
  el.dispatchEvent(
    new MouseEvent("mousedown", { bubbles: true, cancelable: true })
  );
  el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  (el as HTMLElement).click(); // belt-and-suspenders for non-React listeners
}

/**
 * Sets `text` on a native `<textarea>` or `<input>` using the native
 * property setter (bypasses React's synthetic event batching) then
 * dispatches `input` + `change` events so React / Vue state updates.
 *
 * For contenteditable fields, use insertText from insert-text.ts instead.
 */
export function syntheticTypeText(el: Element, text: string): void {
  const setter =
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")
      ?.set ??
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(el, text);
  el.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: text,
    })
  );
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

export function normalizeControlText(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function isLinkedInConnectText(text: string | null | undefined): boolean {
  const normalized = normalizeControlText(text);
  return normalized === "connect" || normalized.startsWith("connect");
}

export function isLinkedInMoreText(text: string | null | undefined): boolean {
  const normalized = normalizeControlText(text);
  return normalized === "more" || normalized.startsWith("more");
}

export function isLinkedInAddNoteText(text: string | null | undefined): boolean {
  return /add a note/i.test(text ?? "");
}

export function isLinkedInSendText(text: string | null | undefined): boolean {
  const normalized = normalizeControlText(text);
  return (
    /send invitation|send without a note|send/i.test(normalized) &&
    !/cancel/i.test(normalized)
  );
}

/**
 * Self-contained MAIN-world helper for `chrome.scripting.executeScript`.
 * Do not reference outer-scope variables from inside this function.
 */
export function executeLinkedInConnectPrimaryActionInPage():
  | "clicked_connect"
  | "opened_more"
  | "not_found" {
  const click = (el: HTMLElement | null) => {
    if (!el) return false;
    el.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    el.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true })
    );
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    el.click();
    return true;
  };
  const normalize = (text: string | null | undefined) =>
    (text ?? "").replace(/\s+/g, " ").trim().toLowerCase();

  const buttons = Array.from(
    document.querySelectorAll<HTMLElement>("button, [role='button']")
  );
  const directConnect = buttons.find((button) => {
    const text = normalize(button.textContent);
    return text === "connect" || text.startsWith("connect");
  });
  if (click(directConnect ?? null)) return "clicked_connect";

  const moreButton = buttons.find((button) => {
    const text = normalize(button.textContent);
    return text === "more" || text.startsWith("more");
  });
  if (click(moreButton ?? null)) return "opened_more";

  return "not_found";
}

/**
 * Self-contained MAIN-world helper for `chrome.scripting.executeScript`.
 */
export function executeLinkedInConnectFromMoreMenuInPage(): boolean {
  const click = (el: HTMLElement | null) => {
    if (!el) return false;
    el.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true })
    );
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    el.click();
    return true;
  };
  const normalize = (text: string | null | undefined) =>
    (text ?? "").replace(/\s+/g, " ").trim().toLowerCase();

  const options = Array.from(
    document.querySelectorAll<HTMLElement>(
      "[role='menuitem'], button, [role='button']"
    )
  );
  const connectOption = options.find((option) => {
    const text = normalize(option.textContent);
    return text === "connect" || text.includes("connect");
  });
  return click(connectOption ?? null);
}

/**
 * Self-contained MAIN-world helper for `chrome.scripting.executeScript`.
 */
export function executeLinkedInFillAndSendConnectDialogInPage(
  message: string
): "no_dialog" | "note_opened" | "sent" | "send_not_found" {
  const click = (el: HTMLElement | null) => {
    if (!el) return false;
    el.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true })
    );
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    el.click();
    return true;
  };
  const normalize = (text: string | null | undefined) =>
    (text ?? "").replace(/\s+/g, " ").trim().toLowerCase();

  const dialog =
    document.querySelector<HTMLElement>("[role='dialog']") ?? document.body;
  if (!dialog) return "no_dialog";

  if (message) {
    const addNoteButton = Array.from(
      dialog.querySelectorAll<HTMLElement>("button, [role='button']")
    ).find((button) => /add a note/i.test(button.textContent ?? ""));
    const textarea =
      dialog.querySelector<HTMLTextAreaElement>("textarea") ??
      dialog.querySelector<HTMLElement>("[contenteditable='true']");

    if (!textarea && addNoteButton) {
      click(addNoteButton);
      return "note_opened";
    }

    if (textarea instanceof HTMLTextAreaElement) {
      textarea.focus();
      textarea.value = message;
      textarea.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          data: message,
          inputType: "insertText",
        })
      );
    } else if (textarea) {
      textarea.focus();
      textarea.textContent = message;
      textarea.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          data: message,
          inputType: "insertText",
        })
      );
    }
  }

  const sendButton = Array.from(
    dialog.querySelectorAll<HTMLElement>("button, [role='button']")
  ).find((button) => {
    const text = normalize(button.textContent);
    return (
      /send invitation|send without a note|send/i.test(text) &&
      !/cancel/i.test(text)
    );
  });
  return click(sendButton ?? null) ? "sent" : "send_not_found";
}
