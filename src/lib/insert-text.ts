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
  // Focus so React/Vue/Angular event delegation picks up the change (double-click
  // lands on the icon button, not the field, so the field may not be focused).
  el.focus();

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
  let usedPaste = false;

  // ── Primary path for Quill editors (LinkedIn overlay, Slack, etc.) ─────────
  // A synthetic ClipboardEvent("paste") goes through Quill's full clipboard
  // pipeline: Quill reads the text, converts it to a delta, calls
  // updateContents(), and fires its internal `text-change` event — exactly what
  // Quill-based UIs need. execCommand and innerHTML bypass this pipeline.
  if (qlEditor) {
    try {
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      // Quill calls preventDefault() on the paste event when it accepts it.
      // dispatchEvent returns false when preventDefault was called.
      const quillAccepted = !target.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: dt,
        })
      );
      if (quillAccepted) {
        inserted = true;
        usedPaste = true;
      }
    } catch {
      inserted = false;
    }
  }

  // ── execCommand("insertText") ─────────────────────────────────────────────
  // Use insertText for ALL editors (Quill fallback + non-Quill).
  // insertText goes through the browser's full editing pipeline:
  //   beforeinput → DOM update → native input event → keyup
  // React/Vue/Angular pick up the NATIVE input event, so the Send button and
  // similar state updates happen automatically — no synthetic events needed.
  // For multi-line text, Chrome creates <div> paragraph blocks per \n in a
  // contenteditable, matching LinkedIn's own <div>-per-paragraph structure.
  if (!inserted) {
    inserted =
      typeof targetDoc.execCommand === "function" &&
      targetDoc.execCommand("insertText", false, text);
  }

  // ── execCommand("insertHTML") — fallback for non-Quill multi-line ─────────
  if (!inserted && !qlEditor && text.includes("\n")) {
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

  // ── Direct DOM (last resort) ──────────────────────────────────────────────
  let usedFallback = false;
  if (!inserted) {
    usedFallback = true;
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

  // ── Post-insertion events ─────────────────────────────────────────────────
  //
  // execCommand / paste paths: the browser already fired native beforeinput +
  // input events through the editing pipeline. React/Vue/Angular picked those
  // up. We must NOT fire `blur` here — on LinkedIn's messaging page a synthetic
  // blur triggers an onBlur React handler that can reset the Send button state.
  // A small async nudge (focus + form-level input) is enough to handle any edge
  // cases where the framework missed the native events.
  //
  // innerHTML fallback: browser never fires native input for direct DOM writes,
  // so we fire the full sequence. MutationObserver callbacks (Quill/ProseMirror)
  // are microtasks — setTimeout(0) lets them run before we fire input/blur.
  if (usedFallback) {
    setTimeout(() => {
      target.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: text }));
      target.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: text }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
      target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Unidentified" }));
      target.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Unidentified" }));
      target.dispatchEvent(new Event("blur", { bubbles: true }));
      setTimeout(() => {
        try {
          target.focus();
          target.dispatchEvent(new Event("focus", { bubbles: true }));
          const form = target.closest("form, .msg-form");
          if (form) form.dispatchEvent(new Event("input", { bubbles: true }));
        } catch { /* ok */ }
      }, 50);
    }, 0);
  } else {
    // execCommand or paste succeeded — browser already fired native events.
    // Just ensure focus is on the field so the cursor is visible and fire a
    // form-level input nudge for any framework that defers state reads.
    setTimeout(() => {
      try {
        target.focus();
        target.dispatchEvent(new Event("focus", { bubbles: true }));
        target.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: text }));
        const form = target.closest("form, .msg-form");
        if (form) form.dispatchEvent(new Event("input", { bubbles: true }));
      } catch { /* ok */ }
    }, 50);
  }
}
