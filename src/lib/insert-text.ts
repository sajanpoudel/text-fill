// Inserts text into any field type — contenteditable or native input/textarea
// Always REPLACES all existing content (not insert-at-cursor).
// Migrated and fixed from contentScript.js.

const LINKEDIN_CHAR_LIMIT = 3000;

export function insertText(field: Element, text: string, platform?: string): void {
  // Google Docs: canvas-based rendering — clipboard + paste is the only reliable approach
  if (platform === "googledocs" || window.location.hostname === "docs.google.com") {
    void _insertGoogleDocs(text);
    return;
  }

  // Enforce LinkedIn general character limit (connection note limit is enforced server-side)
  const finalText =
    platform === "linkedin" && text.length > LINKEDIN_CHAR_LIMIT
      ? text.slice(0, LINKEDIN_CHAR_LIMIT)
      : text;

  if (
    field instanceof HTMLInputElement ||
    field instanceof HTMLTextAreaElement
  ) {
    _replaceNativeInput(field, finalText);
  } else if ((field as HTMLElement).isContentEditable) {
    _replaceContentEditable(field as HTMLElement, finalText);
  }
}

// Google Docs uses canvas for rendering — text can only be inserted via clipboard paste.
async function _insertGoogleDocs(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    // Focus the editor surface
    const editor = document.querySelector<HTMLElement>(
      ".kix-editor-main-container, .docs-editor-container, .kix-appview-editor"
    );
    if (editor) {
      editor.click();
      editor.focus();
    }
    // Ctrl+A to select all existing content, then Ctrl+V to paste replacement
    const fireKey = (key: string, code: string, ctrlKey: boolean) => {
      const target = document.activeElement ?? document.body;
      target.dispatchEvent(
        new KeyboardEvent("keydown", { key, code, ctrlKey, bubbles: true, cancelable: true })
      );
    };
    fireKey("a", "KeyA", true);
    await new Promise<void>((r) => setTimeout(r, 30));
    fireKey("v", "KeyV", true);
  } catch {
    // Clipboard write may fail if permission is denied — silent fallback.
  }
}

function _replaceNativeInput(
  el: HTMLInputElement | HTMLTextAreaElement,
  text: string
): void {
  // Use native setter so React / Vue / Angular pick up the change
  const proto =
    el instanceof HTMLInputElement
      ? HTMLInputElement.prototype
      : HTMLTextAreaElement.prototype;
  const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;

  if (nativeSetter) {
    nativeSetter.call(el, text);
  } else {
    el.value = text;
  }

  el.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: text }));
  el.dispatchEvent(new Event("change", { bubbles: true }));

  // Move cursor to end
  try { el.setSelectionRange(text.length, text.length); } catch { /* read-only / type mismatch */ }

  // LinkedIn needs a form-level input event to enable the Send button
  const form = el.closest("form, .msg-form");
  if (form) form.dispatchEvent(new Event("input", { bubbles: true }));
}

function _replaceContentEditable(el: HTMLElement, text: string): void {
  // LinkedIn (and others) use Quill: the detected field is often an outer wrapper
  // but the real editable is the inner .ql-editor. Insert into that directly.
  const qlEditor =
    el.querySelector<HTMLElement>(".ql-editor") ??
    (el.classList.contains("ql-editor") ? el : null);
  const target = qlEditor ?? el;

  const targetDoc = target.ownerDocument ?? document;
  const targetWin = targetDoc.defaultView ?? window;

  // The extension modal's focus-protection adds `inert` to elements inside
  // LinkedIn's dialog (including the message field) to trap focus. Remove it
  // before focusing so execCommand can operate on the element.
  const hadInert = target.hasAttribute("inert");
  if (hadInert) target.removeAttribute("inert");

  target.focus();

  const sel = targetWin.getSelection();
  const range = targetDoc.createRange();

  // Select ALL existing content so replacement starts clean
  range.selectNodeContents(target);
  sel?.removeAllRanges();
  sel?.addRange(range);

  function escapeLine(line: string): string {
    return line
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  let inserted = false;

  if (!text.includes("\n")) {
    // Single-line: execCommand("insertText") is the safest path for all editors.
    inserted =
      typeof targetDoc.execCommand === "function" &&
      targetDoc.execCommand("insertText", false, text);
  } else if (qlEditor) {
    // Multi-line in Quill (LinkedIn, Slack):
    // Chrome fires execCommand("insertText") through the editing pipeline including
    // the beforeinput event. Quill intercepts beforeinput and treats each \n as a
    // paragraph separator, creating proper <p> blocks. This is the correct approach
    // (used by the original extension) and preserves all paragraph formatting.
    inserted =
      typeof targetDoc.execCommand === "function" &&
      targetDoc.execCommand("insertText", false, text);
  } else {
    // Multi-line in non-Quill editors (Outlook, Gmail, etc.).
    // These editors use <div> blocks. execCommand("insertHTML") with <div> elements
    // inserts through the editor's own pipeline so formatting is preserved.
    const html = text
      .split("\n\n")
      .map((para) => {
        if (!para.trim()) return "<div><br></div>";
        const inner = para.split("\n").map(escapeLine).join("<br>");
        return `<div>${inner}</div>`;
      })
      .join("<div><br></div>");
    inserted =
      typeof targetDoc.execCommand === "function" &&
      targetDoc.execCommand("insertHTML", false, html);
  }

  if (!inserted) {
    // Last-resort fallback: direct DOM manipulation with <p> elements.
    // Quill picks this up via MutationObserver; other editors use it as a failsafe.
    target.innerHTML = "";
    for (const para of text.split("\n\n")) {
      const p = targetDoc.createElement("p");
      if (!para.trim()) {
        p.innerHTML = "<br>";
      } else {
        p.innerHTML = para.split("\n").map(escapeLine).join("<br>");
      }
      target.appendChild(p);
    }
  }

  // Move cursor to end
  const endRange = targetDoc.createRange();
  endRange.selectNodeContents(target);
  endRange.collapse(false);
  sel?.removeAllRanges();
  sel?.addRange(endRange);

  // Fire events so frameworks (React/Quill/Vue) update their state.
  // Order matches the reference extension: beforeinput → input → change → keydown/up → blur → (50ms) → focus.
  target.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: text }));
  target.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: text }));
  target.dispatchEvent(new Event("change", { bubbles: true }));
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Unidentified" }));
  target.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Unidentified" }));
  target.dispatchEvent(new Event("blur", { bubbles: true }));

  // Re-focus after a tick and fire LinkedIn's form-level input to enable the Send button
  setTimeout(() => {
    try {
      target.focus();
      target.dispatchEvent(new Event("focus", { bubbles: true }));
      const form = target.closest("form, .msg-form");
      if (form) form.dispatchEvent(new Event("input", { bubbles: true }));
    } catch { /* ok */ }
  }, 50);
}
