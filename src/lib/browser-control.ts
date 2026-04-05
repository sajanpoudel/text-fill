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

import type {
  AccessibilityNodeSnapshot,
  BrowserObservationScope,
  InteractiveElementSnapshot,
  StructuredDataSnapshot,
  StructuredFieldSnapshot,
} from "./browser-observation.ts";

export type TextVerificationResult = {
  matched: boolean;
  text: string;
};

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

/**
 * Self-contained existence check for selector-based polling.
 */
export function executeElementExistsInPage(selector: string): boolean {
  return !!document.querySelector(selector);
}

/**
 * Self-contained selector-based click helper for `chrome.scripting.executeScript`.
 */
export function executeClickElementBySelectorInPage(selector: string): boolean {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) return false;
  el.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
  el.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true }));
  el.dispatchEvent(
    new MouseEvent("mousedown", { bubbles: true, cancelable: true })
  );
  el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  el.click();
  return true;
}

/**
 * Self-contained selector-based text input helper for `executeScript`.
 */
export function executeTypeIntoFieldBySelectorInPage(
  selector: string,
  text: string
): boolean {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) return false;

  if (
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLInputElement
  ) {
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
    return true;
  }

  if (el.isContentEditable) {
    el.focus();
    el.textContent = text;
    el.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: text,
      })
    );
    return true;
  }

  return false;
}

export function executeInsertTextBySelectorInPage(
  selector: string,
  text: string,
  platform?: string
): boolean {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) return false;

  const finalText =
    platform === "linkedin" && text.length > 3000 ? text.slice(0, 3000) : text;

  if (
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLInputElement
  ) {
    const setter =
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")
        ?.set ??
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(el, finalText);
    el.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: finalText,
      })
    );
    el.dispatchEvent(new Event("change", { bubbles: true }));
    try {
      el.setSelectionRange(finalText.length, finalText.length);
    } catch {
      // ignore readonly or unsupported field types
    }
    return true;
  }

  if (el.isContentEditable || el.getAttribute("contenteditable") === "true") {
    const target =
      el.querySelector<HTMLElement>(".ql-editor") ??
      (el.classList.contains("ql-editor") ? el : el);
    const targetDoc = target.ownerDocument ?? document;
    const targetWin = targetDoc.defaultView ?? window;
    target.focus();

    const selection = targetWin.getSelection?.();
    const selectAllRange = targetDoc.createRange?.();
    if (selectAllRange && selection) {
      selectAllRange.selectNodeContents(target);
      selection.removeAllRanges();
      selection.addRange(selectAllRange);
    }

    let inserted = false;
    if (typeof targetDoc.execCommand === "function") {
      inserted = targetDoc.execCommand("insertText", false, finalText);
      if (!inserted) {
        const html = finalText
          .split("\n\n")
          .map((paragraph) => {
            if (!paragraph.trim()) return "<div><br></div>";
            return `<div>${paragraph
              .split("\n")
              .map((line) =>
                line
                  .replace(/&/g, "&amp;")
                  .replace(/</g, "&lt;")
                  .replace(/>/g, "&gt;")
              )
              .join("<br>")}</div>`;
          })
          .join("<div><br></div>");
        inserted = targetDoc.execCommand("insertHTML", false, html);
      }
    }

    if (!inserted) {
      target.textContent = finalText;
    }

    target.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: finalText,
      })
    );
    target.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: finalText,
      })
    );
    target.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  return false;
}

export function executePressKeyInPage(
  key: string,
  modifiers: string[] = [],
  selector?: string
): boolean {
  const target = selector
    ? document.querySelector<HTMLElement>(selector)
    : ((document.activeElement as HTMLElement | null) ?? document.body);
  if (!target) return false;

  target.focus?.();
  const normalizedModifiers = new Set(
    modifiers.map((modifier) => modifier.trim().toLowerCase())
  );
  const eventInit = {
    bubbles: true,
    cancelable: true,
    key,
    ctrlKey:
      normalizedModifiers.has("control") || normalizedModifiers.has("ctrl"),
    metaKey: normalizedModifiers.has("meta") || normalizedModifiers.has("cmd"),
    shiftKey: normalizedModifiers.has("shift"),
    altKey: normalizedModifiers.has("alt") || normalizedModifiers.has("option"),
  };

  target.dispatchEvent(new KeyboardEvent("keydown", eventInit));
  target.dispatchEvent(new KeyboardEvent("keypress", eventInit));
  target.dispatchEvent(new KeyboardEvent("keyup", eventInit));
  return true;
}

export function executeScrollInPage(
  direction: "up" | "down",
  amount = Math.max(240, Math.round(window.innerHeight * 0.8)),
  selector?: string
): { deltaY: number; position: number | null } {
  const signedAmount = direction === "down" ? Math.abs(amount) : -Math.abs(amount);
  const target = selector ? document.querySelector<HTMLElement>(selector) : null;

  if (target) {
    const scrollContainer = target as HTMLElement & {
      scrollTop?: number;
      scrollBy?: (options: { top: number; left?: number; behavior?: ScrollBehavior }) => void;
    };
    if (typeof scrollContainer.scrollBy === "function") {
      scrollContainer.scrollBy({ top: signedAmount, behavior: "auto" });
    } else {
      scrollContainer.scrollTop = (scrollContainer.scrollTop ?? 0) + signedAmount;
    }
    return {
      deltaY: signedAmount,
      position:
        typeof scrollContainer.scrollTop === "number"
          ? scrollContainer.scrollTop
          : null,
    };
  }

  if (typeof window.scrollBy === "function") {
    window.scrollBy({ top: signedAmount, behavior: "auto" });
  }
  const position =
    typeof window.scrollY === "number"
      ? window.scrollY
      : typeof window.pageYOffset === "number"
        ? window.pageYOffset
        : null;
  return { deltaY: signedAmount, position };
}

function getObservationRoot(scope: BrowserObservationScope): ParentNode {
  const dialog =
    document.querySelector<HTMLElement>("dialog, [role='dialog']") ?? null;
  const main =
    document.querySelector<HTMLElement>("main, article, [role='main']") ?? null;

  switch (scope) {
    case "dialog":
      return dialog ?? main ?? document.body;
    case "viewport":
      return document.body;
    case "main":
    default:
      return main ?? dialog ?? document.body;
  }
}

function isPageElementVisible(el: Element | null): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  const style = window.getComputedStyle(el);
  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    style.opacity === "0"
  ) {
    return false;
  }
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function isInViewport(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  return (
    rect.bottom >= 0 &&
    rect.right >= 0 &&
    rect.top <= window.innerHeight &&
    rect.left <= window.innerWidth
  );
}

function normalizePageText(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function getPageElementLabel(el: Element): string | null {
  const ariaLabel = normalizePageText(el.getAttribute("aria-label"));
  if (ariaLabel) return ariaLabel;

  const labelledBy = normalizePageText(el.getAttribute("aria-labelledby"));
  if (labelledBy) {
    const parts = labelledBy
      .split(/\s+/)
      .map((id) => normalizePageText(document.getElementById(id)?.textContent))
      .filter(Boolean);
    if (parts.length > 0) return parts.join(" ");
  }

  const title = normalizePageText(el.getAttribute("title"));
  if (title) return title;

  const placeholder = normalizePageText(el.getAttribute("placeholder"));
  if (placeholder) return placeholder;

  const id = normalizePageText(el.getAttribute("id"));
  if (id) {
    const label = document.querySelector(`label[for="${id}"]`);
    const labelText = normalizePageText(label?.textContent);
    if (labelText) return labelText;
  }

  return null;
}

export function createSelectorForElement(el: Element): string {
  const id = normalizePageText(el.getAttribute("id"));
  if (id && !/\s/.test(id)) return `#${id}`;

  const dataTestId = normalizePageText(el.getAttribute("data-testid"));
  if (dataTestId) return `[data-testid="${dataTestId}"]`;

  const name = normalizePageText(el.getAttribute("name"));
  if (name) return `${el.tagName.toLowerCase()}[name="${name}"]`;

  const ariaLabel = normalizePageText(el.getAttribute("aria-label"));
  if (ariaLabel) {
    return `${el.tagName.toLowerCase()}[aria-label="${ariaLabel}"]`;
  }

  const segments: string[] = [];
  let current: Element | null = el;
  let depth = 0;

  while (current && current !== document.body && depth < 4) {
    const tag = current.tagName.toLowerCase();
    const currentTagName = current.tagName;
    const siblings = current.parentElement
      ? Array.from(current.parentElement.children).filter(
          (sibling) => sibling.tagName === currentTagName
        )
      : [current];
    const nth = Math.max(1, siblings.indexOf(current) + 1);
    segments.unshift(`${tag}:nth-of-type(${nth})`);
    current = current.parentElement;
    depth += 1;
  }

  return segments.join(" > ") || el.tagName.toLowerCase();
}

function snapshotInteractiveElement(
  el: HTMLElement,
  index: number
): InteractiveElementSnapshot {
  const href =
    normalizePageText(el.getAttribute("href")) ||
    normalizePageText((el as HTMLElement & { href?: string }).href) ||
    null;
  return {
    id: `interactive-${index + 1}`,
    selector: createSelectorForElement(el),
    tag: el.tagName.toLowerCase(),
    role: normalizePageText(el.getAttribute("role")) || null,
    type:
      el instanceof HTMLInputElement
        ? normalizePageText(el.type) || "text"
        : null,
    href,
    label: getPageElementLabel(el),
    text: normalizePageText(el.innerText || el.textContent) || null,
    disabled:
      el.hasAttribute("disabled") ||
      el.getAttribute("aria-disabled") === "true",
  };
}

function shouldIncludeElementForScope(
  el: HTMLElement,
  scope: BrowserObservationScope
): boolean {
  if (!isPageElementVisible(el)) return false;
  if (el.closest("[data-tfa-ui]")) return false;
  if (scope === "viewport") {
    return isInViewport(el);
  }
  return true;
}

function readStructuredFieldValue(
  el: HTMLElement
): string | boolean | string[] | null {
  if (el instanceof HTMLInputElement) {
    const type = (el.type || "text").toLowerCase();
    if (type === "checkbox" || type === "radio") return !!el.checked;
    return normalizePageText(el.value) || null;
  }
  if (el instanceof HTMLTextAreaElement) {
    return normalizePageText(el.value) || null;
  }
  if (el instanceof HTMLSelectElement) {
    if (el.multiple) {
      return Array.from(el.selectedOptions)
        .map((option) => normalizePageText(option.textContent || option.value))
        .filter(Boolean);
    }
    return normalizePageText(el.value || el.selectedOptions[0]?.textContent) || null;
  }
  if (el.isContentEditable) {
    return normalizePageText(el.innerText || el.textContent) || null;
  }
  return normalizePageText(el.innerText || el.textContent) || null;
}

function snapshotStructuredField(el: HTMLElement): StructuredFieldSnapshot {
  return {
    selector: createSelectorForElement(el),
    tag: el.tagName.toLowerCase(),
    type:
      el instanceof HTMLInputElement
        ? normalizePageText(el.type) || "text"
        : el instanceof HTMLSelectElement
          ? "select"
          : el.isContentEditable
            ? "contenteditable"
            : null,
    label: getPageElementLabel(el),
    value: readStructuredFieldValue(el),
  };
}

function getDirectTextContent(el: Element): string | null {
  let text = "";
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? "";
    }
  }
  const normalized = normalizePageText(text);
  return normalized || null;
}

function walkAccessibilitySubtree(
  root: Element,
  scope: BrowserObservationScope,
  maxDepth = 6
): AccessibilityNodeSnapshot | null {
  if (!shouldIncludeElementForScope(root as HTMLElement, scope)) {
    return null;
  }

  const node: AccessibilityNodeSnapshot = {
    tag: root.tagName.toLowerCase(),
    role: normalizePageText(root.getAttribute("role")) || null,
    label: getPageElementLabel(root),
    text: getDirectTextContent(root),
    children: [],
  };

  if (maxDepth <= 0) return node;

  for (const child of Array.from(root.children)) {
    const childNode = walkAccessibilitySubtree(child, scope, maxDepth - 1);
    if (childNode) {
      node.children.push(childNode);
    }
  }

  return node;
}

export function executeSnapshotInteractivesInPage(
  scope: BrowserObservationScope = "main"
): InteractiveElementSnapshot[] {
  const root = getObservationRoot(scope);
  const interactiveSelectors = [
    "button",
    "[role='button']",
    "a[href]",
    "input:not([type='hidden'])",
    "textarea",
    "select",
    "[role='textbox']",
    "[contenteditable='true']",
  ].join(", ");

  const seenSelectors = new Set<string>();
  const elements = Array.from(root.querySelectorAll<HTMLElement>(interactiveSelectors))
    .filter((el) => shouldIncludeElementForScope(el, scope))
    .map((el, index) => snapshotInteractiveElement(el, index))
    .filter((entry) => {
      if (seenSelectors.has(entry.selector)) return false;
      seenSelectors.add(entry.selector);
      return true;
    });

  return elements.slice(0, 80);
}

export function executeGetAccessibilityTreeInPage(
  scope: BrowserObservationScope = "main"
): AccessibilityNodeSnapshot | null {
  const root = getObservationRoot(scope);
  if (!(root instanceof HTMLElement)) {
    return null;
  }
  return walkAccessibilitySubtree(root, scope);
}

export function executeExtractStructuredDataSnapshotInPage(
  scope: BrowserObservationScope = "main"
): StructuredDataSnapshot {
  const root = getObservationRoot(scope);
  const textSource =
    root instanceof HTMLElement
      ? root.innerText || root.textContent || ""
      : document.body.innerText || document.body.textContent || "";
  const headings = Array.from(
    root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, [role='heading']")
  )
    .filter((el) => shouldIncludeElementForScope(el, scope))
    .map((el) => normalizePageText(el.innerText || el.textContent))
    .filter(Boolean)
    .slice(0, 12);
  const fieldSelectors = [
    "input:not([type='hidden'])",
    "textarea",
    "select",
    "[contenteditable='true']",
    "[role='textbox']",
  ].join(", ");
  const fields = Array.from(root.querySelectorAll<HTMLElement>(fieldSelectors))
    .filter((el) => shouldIncludeElementForScope(el, scope))
    .map((el) => snapshotStructuredField(el))
    .slice(0, 80);

  return {
    text: normalizePageText(textSource).slice(0, 6000),
    headings,
    fields,
    interactives: executeSnapshotInteractivesInPage(scope),
  };
}

export function executeExtractTextInPage(
  selector?: string,
  scope: BrowserObservationScope = "main",
  maxLength = 6000
): string {
  const root = selector
    ? document.querySelector<HTMLElement>(selector)
    : getObservationRoot(scope);
  const textSource =
    root instanceof HTMLElement
      ? root.innerText || root.textContent || ""
      : document.body.innerText || document.body.textContent || "";
  return normalizePageText(textSource).slice(0, Math.max(0, maxLength));
}

export function executeVerifyTextInPage(
  expectedText: string,
  selector?: string,
  scope: BrowserObservationScope = "main",
  caseSensitive = false,
  maxLength = 6000
): TextVerificationResult {
  const text = executeExtractTextInPage(selector, scope, maxLength);
  const normalize = (value: string) =>
    value.replace(/\s+/g, " ").trim();
  const haystack = normalize(text);
  const needle = normalize(expectedText);
  if (!needle) {
    return { matched: false, text };
  }

  const matched = caseSensitive
    ? haystack.includes(needle)
    : haystack.toLowerCase().includes(needle.toLowerCase());
  return { matched, text };
}

export function executeSetFieldValueBySelectorInPage(
  selector: string,
  value: string | boolean | string[]
): boolean {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) return false;

  if (el instanceof HTMLInputElement) {
    const type = (el.type || "text").toLowerCase();
    if (type === "checkbox" || type === "radio") {
      el.checked = Boolean(value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }

    const nextValue = Array.isArray(value) ? value.join(", ") : String(value);
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    setter?.call(el, nextValue);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  if (el instanceof HTMLTextAreaElement) {
    const nextValue = Array.isArray(value) ? value.join("\n") : String(value);
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    )?.set;
    setter?.call(el, nextValue);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  if (el instanceof HTMLSelectElement) {
    const values = Array.isArray(value) ? value.map(String) : [String(value)];
    for (const option of Array.from(el.options)) {
      option.selected = values.includes(option.value) || values.includes(option.text);
    }
    if (!el.multiple) {
      const first = Array.from(el.options).find((option) => option.selected);
      if (first) {
        el.value = first.value;
      }
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  if (el.isContentEditable) {
    const nextValue = Array.isArray(value) ? value.join(", ") : String(value);
    el.focus();
    el.textContent = nextValue;
    el.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: nextValue,
      })
    );
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  return false;
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
