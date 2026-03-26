// Inserts text into any field type — contenteditable or native input/textarea
// Always REPLACES all existing content (not insert-at-cursor).
// Migrated and fixed from contentScript.js.

const LINKEDIN_CHAR_LIMIT = 3000;

export function insertText(field: Element, text: string, platform?: string): void {
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

  // Quill editors (LinkedIn, Slack, etc.) represent paragraphs as <p> DOM nodes.
  // document.execCommand("insertText") inserts a raw text node — HTML then collapses
  // \n\n to whitespace, so all paragraphs merge into one visible line.
  // Bypass execCommand for Quill and write <p> elements directly; Quill's
  // MutationObserver will pick up the DOM change and sync its internal delta.
  //
  // For non-Quill contenteditable (Gmail, etc.) execCommand is the safer path
  // because it fires React's synthetic event chain correctly.
  let inserted = false;
  if (!qlEditor) {
    inserted =
      typeof targetDoc.execCommand === "function" &&
      targetDoc.execCommand("insertText", false, text);
  }

  if (!inserted) {
    // Direct HTML paragraph insertion — works for Quill and as a fallback elsewhere.
    // Split on \n\n → separate <p> elements (paragraph breaks).
    // Split on \n   → <br> within the same <p> (line breaks).
    target.innerHTML = "";
    const paragraphs = text.split("\n\n");
    for (const para of paragraphs) {
      const p = targetDoc.createElement("p");
      if (!para.trim()) {
        p.innerHTML = "<br>"; // empty paragraph (Quill blank line)
      } else {
        const lines = para.split("\n").map((line) =>
          line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        );
        p.innerHTML = lines.join("<br>");
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
