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

type ObservationRootResolution = {
  root: ParentNode;
  source: "dialog" | "main" | "body";
  candidateCount: number;
  descriptor: string;
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

function describeElementForDebug(el: HTMLElement | null): string {
  if (!el) return "null";
  const tag = el.tagName.toLowerCase();
  const id = normalizePageText(el.getAttribute("id"));
  const className = normalizePageText(el.getAttribute("class"));
  const parts = [tag];
  if (id) parts.push(`#${id}`);
  if (className) {
    parts.push(
      `.${className
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 3)
        .join(".")}`
    );
  }
  return parts.join("");
}

function resolveObservationRoot(
  scope: BrowserObservationScope
): ObservationRootResolution {
  const dialogCandidates = Array.from(
    document.querySelectorAll<HTMLElement>("dialog, [role='dialog']")
  );
  const mainCandidates = Array.from(
    document.querySelectorAll<HTMLElement>("main, article, [role='main']")
  );
  const scoreRootCandidate = (el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    const area = Math.max(0, rect.width) * Math.max(0, rect.height);
    const childCount = el.children.length;
    const interactiveCount = el.querySelectorAll(
      "button, [role='button'], a[href], input:not([type='hidden']), textarea, select, [role='textbox'], [contenteditable='true']"
    ).length;
    const textLength = normalizePageText(el.innerText || el.textContent).length;
    const dialogBoost =
      el.tagName === "DIALOG" || el.getAttribute("role") === "dialog"
        ? 1_000_000
        : 0;
    return (
      dialogBoost +
      area +
      childCount * 100 +
      interactiveCount * 1_000 +
      Math.min(textLength, 8_000)
    );
  };
  const pickBestCandidate = (candidates: HTMLElement[]): HTMLElement | null => {
    if (candidates.length === 0) return null;
    const visibleCandidates = candidates.filter((candidate) =>
      isPageElementVisible(candidate)
    );
    const pool = visibleCandidates.length > 0 ? visibleCandidates : candidates;
    return [...pool].sort(
      (left, right) => scoreRootCandidate(right) - scoreRootCandidate(left)
    )[0] ?? null;
  };
  const dialog = pickBestCandidate(dialogCandidates);
  const main = pickBestCandidate(mainCandidates);

  switch (scope) {
    case "dialog":
      if (dialog) {
        return {
          root: dialog,
          source: "dialog",
          candidateCount: dialogCandidates.length,
          descriptor: describeElementForDebug(dialog),
        };
      }
      if (main) {
        return {
          root: main,
          source: "main",
          candidateCount: mainCandidates.length,
          descriptor: describeElementForDebug(main),
        };
      }
      return {
        root: document.body,
        source: "body",
        candidateCount: 0,
        descriptor: describeElementForDebug(document.body),
      };
    case "viewport":
      return {
        root: document.body,
        source: "body",
        candidateCount: 0,
        descriptor: describeElementForDebug(document.body),
      };
    case "main":
    default:
      if (main) {
        return {
          root: main,
          source: "main",
          candidateCount: mainCandidates.length,
          descriptor: describeElementForDebug(main),
        };
      }
      if (dialog) {
        return {
          root: dialog,
          source: "dialog",
          candidateCount: dialogCandidates.length,
          descriptor: describeElementForDebug(dialog),
        };
      }
      return {
        root: document.body,
        source: "body",
        candidateCount: 0,
        descriptor: describeElementForDebug(document.body),
      };
  }
}

function getObservationRoot(scope: BrowserObservationScope): ParentNode {
  return resolveObservationRoot(scope).root;
}

function debugScan(event: string, payload: Record<string, unknown>) {
  try {
    console.debug(`[TFA Scan] ${event}`, payload);
  } catch {
    // no-op
  }
}

function isBackgroundTabLayoutUnavailable(): boolean {
  return (
    document.visibilityState === "hidden" ||
    window.innerWidth === 0 ||
    window.innerHeight === 0
  );
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
  if (el.getAttribute("hidden") !== null || el.getAttribute("aria-hidden") === "true") {
    return false;
  }
  const rect = el.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) {
    return true;
  }
  if (!isBackgroundTabLayoutUnavailable()) {
    return false;
  }

  const text =
    normalizePageText(el.getAttribute("aria-label")) ||
    normalizePageText(el.getAttribute("title")) ||
    normalizePageText(el.textContent);
  const interactive =
    el.matches(
      "button, a[href], input:not([type='hidden']), textarea, select, [role='button'], [role='menuitem'], [role='textbox'], [contenteditable='true']"
    ) || !!el.querySelector("button, a[href], [role='button'], [role='menuitem']");

  return interactive || text.length > 0;
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
  const resolvedRoot = resolveObservationRoot(scope);
  const root = resolvedRoot.root;
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

  const limited = elements.slice(0, 80);
  debugScan("snapshot_interactives", {
    scope,
    rootSource: resolvedRoot.source,
    root: resolvedRoot.descriptor,
    rootCandidateCount: resolvedRoot.candidateCount,
    matchedCount: limited.length,
    sample: limited.slice(0, 8).map((entry) => ({
      tag: entry.tag,
      label: entry.label,
      text: entry.text,
      selector: entry.selector,
      href: entry.href,
    })),
  });
  return limited;
}

export function executeGetAccessibilityTreeInPage(
  scope: BrowserObservationScope = "main"
): AccessibilityNodeSnapshot | null {
  const resolvedRoot = resolveObservationRoot(scope);
  const root = resolvedRoot.root;
  if (!(root instanceof HTMLElement)) {
    debugScan("get_accessibility_tree", {
      scope,
      rootSource: resolvedRoot.source,
      root: resolvedRoot.descriptor,
      rootCandidateCount: resolvedRoot.candidateCount,
      treeRoot: null,
      childCount: 0,
    });
    return null;
  }
  const tree = walkAccessibilitySubtree(root, scope);
  debugScan("get_accessibility_tree", {
    scope,
    rootSource: resolvedRoot.source,
    root: resolvedRoot.descriptor,
    rootCandidateCount: resolvedRoot.candidateCount,
    treeRoot: tree?.tag ?? null,
    childCount: Array.isArray(tree?.children) ? tree.children.length : 0,
  });
  return tree;
}

export function executeExtractStructuredDataSnapshotInPage(
  scope: BrowserObservationScope = "main"
): StructuredDataSnapshot {
  const resolvedRoot = resolveObservationRoot(scope);
  const root = resolvedRoot.root;
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

  const snapshot = {
    text: normalizePageText(textSource).slice(0, 6000),
    headings,
    fields,
    interactives: executeSnapshotInteractivesInPage(scope),
  };
  debugScan("extract_structured", {
    scope,
    rootSource: resolvedRoot.source,
    root: resolvedRoot.descriptor,
    rootCandidateCount: resolvedRoot.candidateCount,
    headingCount: snapshot.headings.length,
    fieldCount: snapshot.fields.length,
    textLength: snapshot.text.length,
  });
  return snapshot;
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

export function isLinkedInSendWithoutNoteText(
  text: string | null | undefined
): boolean {
  return /send without a note/i.test(text ?? "");
}

export function isLinkedInFinalSendText(
  text: string | null | undefined
): boolean {
  const normalized = normalizeControlText(text);
  return (
    /send invitation|send now|send/i.test(normalized) &&
    !/send without a note/i.test(normalized) &&
    !/cancel/i.test(normalized)
  );
}

export type LinkedInConnectWorkflowState =
  | "sent"
  | "already_connected"
  | "already_pending"
  | "no_connect_control"
  | "menu_connect_not_found"
  | "dialog_not_found"
  | "note_editor_not_found"
  | "send_not_found";

export type LinkedInConnectWorkflowResult = {
  state: LinkedInConnectWorkflowState;
  debug: {
    primaryButtons: string[];
    menuOptions: string[];
    dialogButtons: string[];
    resolutionPath?: string[];
  };
};

export type LinkedInPrimaryActionProbeResult = {
  ready: boolean;
  labels: string[];
};

export type LinkedInDomHints = {
  preferredLabels?: string[];
  avoidedLabels?: string[];
};

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
  const getControlText = (el: HTMLElement | null) => {
    const candidates = [
      el?.innerText,
      el?.textContent,
      el?.getAttribute("aria-label"),
      el?.getAttribute("title"),
    ];
    for (const candidate of candidates) {
      const normalized = normalize(candidate);
      if (normalized) return normalized;
    }
    return "";
  };

  const buttons = Array.from(
    document.querySelectorAll<HTMLElement>("button, [role='button']")
  );
  const directConnect = buttons.find((button) => {
    const text = getControlText(button);
    return (
      text === "connect" ||
      text.startsWith("connect") ||
      text.includes("invite") ||
      text.includes("connect")
    );
  });
  if (click(directConnect ?? null)) return "clicked_connect";

  const moreButton = buttons.find((button) => {
    const text = getControlText(button);
    return (
      text === "more" ||
      text.startsWith("more") ||
      text.includes("more actions")
    );
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
  const getControlText = (el: HTMLElement | null) => {
    const candidates = [
      el?.innerText,
      el?.textContent,
      el?.getAttribute("aria-label"),
      el?.getAttribute("title"),
    ];
    for (const candidate of candidates) {
      const normalized = normalize(candidate);
      if (normalized) return normalized;
    }
    return "";
  };

  const options = Array.from(
    document.querySelectorAll<HTMLElement>(
      "[role='menuitem'], button, [role='button']"
    )
  );
  const connectOption = options.find((option) => {
    const text = getControlText(option);
    return (
      text === "connect" ||
      text.includes("connect") ||
      text.includes("invite")
    );
  });
  return click(connectOption ?? null);
}

export async function executeWaitForLinkedInPrimaryActionsInPage(
  timeoutMs = 7_000,
  hints: LinkedInDomHints = {}
): Promise<LinkedInPrimaryActionProbeResult> {
  const wait = (durationMs: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, durationMs));
  const deadline = Date.now() + Math.max(500, timeoutMs);
  const normalize = (text: string | null | undefined) =>
    (text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  const getControlText = (el: HTMLElement | null) => {
    const candidates = [
      el?.innerText,
      el?.textContent,
      el?.getAttribute("aria-label"),
      el?.getAttribute("title"),
    ];
    for (const candidate of candidates) {
      const normalized = normalize(candidate);
      if (normalized) return normalized;
    }
    return "";
  };
  const preferredLabels = new Set(
    (hints.preferredLabels ?? []).map((label) => normalize(label))
  );
  const avoidedLabels = new Set(
    (hints.avoidedLabels ?? []).map((label) => normalize(label))
  );
  const navLabels = new Set([
    "skip to main content",
    "close jump menu",
    "home",
    "jobs",
    "messaging",
    "notifications",
    "me",
    "for business",
    "try premium for free",
    "advertise",
    "learning",
  ]);
  const bandSizePx = 120;
  const findInviteAnchor = (root: ParentNode = document) =>
    Array.from(
      root.querySelectorAll<HTMLElement>(
        "a[href*='/preload/custom-invite/'], a[href*='linkedin.com/preload/custom-invite/']"
      )
    )
      .filter((element) => !element.closest("[data-tfa-ui]"))
      .find((element) => {
        const label = getControlText(element);
        return label.includes("connect") || label.includes("invite");
      }) ?? null;
  const scoreLabel = (label: string) => {
    let score = 0;
    if (
      label.includes("connect") ||
      label.includes("invite") ||
      label.includes("message") ||
      label.includes("more") ||
      label.includes("follow") ||
      label.includes("pending") ||
      label.includes("inmail")
    ) {
      score += 3;
    }
    if (preferredLabels.has(label)) score += 2;
    if (avoidedLabels.has(label) || navLabels.has(label)) score -= 4;
    return score;
  };
  const collectCandidateActionNodes = (root: ParentNode) => {
    const extended = Array.from(
      root.querySelectorAll<HTMLElement>(
        [
          "button",
          "[role='button']",
          "[role='menuitem']",
          "a[role='button']",
          "a.artdeco-button",
          "a[href*='/preload/custom-invite/']",
          "a[href*='/messaging/compose/']",
          "a[aria-label*='connect' i]",
          "a[aria-label*='invite' i]",
          "a[aria-label*='message' i]",
          "a[aria-label*='follow' i]",
          "a[aria-label*='more' i]",
          "a[title*='connect' i]",
          "a[title*='invite' i]",
          "a[title*='message' i]",
          "a[title*='follow' i]",
          "a[title*='more' i]",
        ].join(", ")
      )
    );
    if (extended.length > 0) return extended;

    const legacy = Array.from(
      root.querySelectorAll<HTMLElement>(
        "button, [role='button'], [role='menuitem'], a[role='button'], a.artdeco-button"
      )
    );
    if (legacy.length > 0) return legacy;

    return Array.from(
      root.querySelectorAll<HTMLElement>(
        "button, [role='button'], [role='menuitem']"
      )
    );
  };
  const collectLabels = (root: ParentNode = document) =>
    collectCandidateActionNodes(root)
      .filter((element) => !element.closest("[data-tfa-ui]"))
      .map((element) => getControlText(element))
      .filter(Boolean);
  const pickBestActionBand = (elements: HTMLElement[]) => {
    const bands = new Map<
      number,
      { top: number; elements: HTMLElement[]; labels: string[]; score: number }
    >();
    for (const element of elements) {
      const rect = element.getBoundingClientRect();
      const top = Number.isFinite(rect.top) ? rect.top : 0;
      const bandKey = Math.max(0, Math.floor(top / bandSizePx));
      const label = getControlText(element);
      const existing = bands.get(bandKey) ?? {
        top,
        elements: [],
        labels: [],
        score: 0,
      };
      existing.top = Math.min(existing.top, top);
      existing.elements.push(element);
      if (label) {
        existing.labels.push(label);
        existing.score += scoreLabel(label);
      }
      bands.set(bandKey, existing);
    }
    const ranked = [...bands.values()].sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (right.elements.length !== left.elements.length) {
        return right.elements.length - left.elements.length;
      }
      return left.top - right.top;
    });
    return ranked[0] ?? null;
  };
  const collectPriorityLabels = () => {
    const mainRoot =
      document.querySelector<HTMLElement>("main, article, [role='main']") ??
      document.body;
    const directInviteAnchor = findInviteAnchor(mainRoot) ?? findInviteAnchor(document);
    if (directInviteAnchor) {
      const inviteLabel = getControlText(directInviteAnchor);
      if (inviteLabel) {
        return [inviteLabel];
      }
    }
    const mainElements = collectCandidateActionNodes(mainRoot);
    const bestMainBand = pickBestActionBand(mainElements);
    const mainLabels = bestMainBand
      ? bestMainBand.labels
      : collectLabels(mainRoot);
    const prioritizedMain = mainLabels.filter((label) => scoreLabel(label) > 0);
    if (prioritizedMain.length > 0) {
      return prioritizedMain.slice(0, 12);
    }
    const pageElements = collectCandidateActionNodes(document);
    const bestPageBand = pickBestActionBand(pageElements);
    const pageLabels = bestPageBand ? bestPageBand.labels : collectLabels(document);
    const prioritizedPage = pageLabels.filter((label) => scoreLabel(label) > 0);
    if (prioritizedPage.length > 0) {
      return prioritizedPage.slice(0, 12);
    }
    return pageLabels.slice(0, 12);
  };

  for (;;) {
    const labels = collectPriorityLabels();
    const ready = labels.some((label) => scoreLabel(label) > 0);
    if (ready) {
      return { ready: true, labels };
    }
    if (Date.now() >= deadline) {
      return { ready: false, labels };
    }
    await wait(150);
  }
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
  const getControlText = (el: HTMLElement | null) => {
    const candidates = [
      el?.innerText,
      el?.textContent,
      el?.getAttribute("aria-label"),
      el?.getAttribute("title"),
    ];
    for (const candidate of candidates) {
      const normalized = normalize(candidate);
      if (normalized) return normalized;
    }
    return "";
  };

  const dialog =
    document.querySelector<HTMLElement>("[role='dialog']") ?? document.body;
  if (!dialog) return "no_dialog";

  if (message) {
    const addNoteButton = Array.from(
      dialog.querySelectorAll<HTMLElement>("button, [role='button']")
    ).find((button) => /add a note/i.test(getControlText(button)));
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
    const text = getControlText(button);
    return (
      /send invitation|send without a note|send now|send/i.test(text) &&
      !/cancel/i.test(text)
    );
  });
  return click(sendButton ?? null) ? "sent" : "send_not_found";
}

/**
 * Self-contained MAIN-world helper that executes the full LinkedIn
 * `Connect` flow in one page context to avoid menu/dialog race conditions
 * across multiple injected scripts.
 */
export async function executeLinkedInConnectWorkflowInPage(
  message: string,
  hints: LinkedInDomHints = {}
): Promise<LinkedInConnectWorkflowResult> {
  const wait = (durationMs: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, durationMs));
  const normalize = (text: string | null | undefined) =>
    (text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  const getControlText = (el: HTMLElement | null) => {
    const candidates = [
      el?.innerText,
      el?.textContent,
      el?.getAttribute("aria-label"),
      el?.getAttribute("title"),
    ];
    for (const candidate of candidates) {
      const normalized = normalize(candidate);
      if (normalized) return normalized;
    }
    return "";
  };
  const getSemanticText = (el: HTMLElement | null) => {
    if (!el) return "";
    const direct = getControlText(el);
    if (direct) return direct;

    const descendant = el.querySelector<HTMLElement>(
      "[aria-label], [title], .artdeco-button__text, p, span"
    );
    return getControlText(descendant);
  };
  const preferredLabels = new Set(
    (hints.preferredLabels ?? []).map((label) => normalize(label))
  );
  const avoidedLabels = new Set(
    (hints.avoidedLabels ?? []).map((label) => normalize(label))
  );
  const navLabels = new Set([
    "skip to main content",
    "close jump menu",
    "home",
    "jobs",
    "messaging",
    "notifications",
    "me",
    "for business",
    "try premium for free",
    "advertise",
    "learning",
  ]);
  const bandSizePx = 120;
  const findInviteAnchor = (root: ParentNode = document) =>
    Array.from(
      root.querySelectorAll<HTMLElement>(
        "a[href*='/preload/custom-invite/'], a[href*='linkedin.com/preload/custom-invite/']"
      )
    )
      .filter((element) => !element.closest("[data-tfa-ui]"))
      .filter(isVisible)
      .find((element) => {
        const label = getSemanticText(element);
        return label.includes("connect") || label.includes("invite");
      }) ?? null;
  const scoreLabel = (label: string) => {
    let score = 0;
    if (
      label.includes("connect") ||
      label.includes("invite") ||
      label.includes("message") ||
      label.includes("more") ||
      label.includes("follow") ||
      label.includes("pending") ||
      label.includes("inmail")
    ) {
      score += 3;
    }
    if (preferredLabels.has(label)) score += 2;
    if (avoidedLabels.has(label) || navLabels.has(label)) score -= 4;
    return score;
  };
  const collectCandidateActionNodes = (root: ParentNode) => {
    const extended = Array.from(
      root.querySelectorAll<HTMLElement>(
        [
          "button",
          "[role='button']",
          "[role='menuitem']",
          "a[role='button']",
          "a.artdeco-button",
          "a[href*='/preload/custom-invite/']",
          "a[href*='/messaging/compose/']",
          "a[aria-label*='connect' i]",
          "a[aria-label*='invite' i]",
          "a[aria-label*='message' i]",
          "a[aria-label*='follow' i]",
          "a[aria-label*='more' i]",
          "a[title*='connect' i]",
          "a[title*='invite' i]",
          "a[title*='message' i]",
          "a[title*='follow' i]",
          "a[title*='more' i]",
        ].join(", ")
      )
    );
    if (extended.length > 0) return extended;

    const legacy = Array.from(
      root.querySelectorAll<HTMLElement>(
        "button, [role='button'], [role='menuitem'], a[role='button'], a.artdeco-button"
      )
    );
    if (legacy.length > 0) return legacy;

    return Array.from(
      root.querySelectorAll<HTMLElement>(
        "button, [role='button'], [role='menuitem']"
      )
    );
  };
  const isVisible = (el: HTMLElement | null) => {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.opacity === "0"
    ) {
      return false;
    }
    if (
      el.getAttribute("hidden") !== null ||
      el.getAttribute("aria-hidden") === "true"
    ) {
      return false;
    }
    if (rect.width > 0 && rect.height > 0) {
      return true;
    }
    if (!isBackgroundTabLayoutUnavailable()) {
      return false;
    }
    return !!(
      getControlText(el) ||
      el.matches(
        "button, a[href], input:not([type='hidden']), textarea, select, [role='button'], [role='menuitem'], [role='textbox'], [tabindex], [contenteditable='true']"
      ) ||
      el.querySelectorAll("button, [role='button'], [role='menuitem']").length > 0 ||
      el.querySelectorAll("textarea, [contenteditable='true']").length > 0
    );
  };
  const resolveClickableTarget = (el: HTMLElement | null) => {
    if (!el) return null;
    const nested = el.querySelector<HTMLElement>(
      [
        "[aria-label]",
        "[title]",
        "button",
        "a[href]",
        "[role='button']",
        "[tabindex]:not([tabindex='-1'])",
        "[contenteditable='true']",
      ].join(", ")
    );
    if (nested && nested !== el) {
      return nested;
    }
    if (
      el.matches(
        "button, a[href], [role='button'], [role='menuitem'], [tabindex]"
      )
    ) {
      return el;
    }
    return el;
  };
  const click = (el: HTMLElement | null) => {
    const target = resolveClickableTarget(el);
    if (!target) return false;
    target.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    target.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true })
    );
    target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    target.click();
    return true;
  };
  const fillField = (el: HTMLElement, text: string) => {
    if (el.tagName === "TEXTAREA") {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      )?.set;
      setter?.call(el as HTMLTextAreaElement, text);
      el.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          data: text,
          inputType: "insertText",
        })
      );
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }

    el.focus();
    el.textContent = text;
    el.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        data: text,
        inputType: "insertText",
      })
    );
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  };
  const collectActionElements = (root: ParentNode = document) =>
    collectCandidateActionNodes(root)
      .filter((element) => !element.closest("[data-tfa-ui]"))
      .filter(isVisible);
  const collectTexts = (elements: HTMLElement[]) =>
    elements.map((element) => getSemanticText(element)).filter(Boolean).slice(0, 20);
  const pickBestActionBand = (elements: HTMLElement[]) => {
    const bands = new Map<
      number,
      { top: number; elements: HTMLElement[]; labels: string[]; score: number }
    >();
    for (const element of elements) {
      const rect = element.getBoundingClientRect();
      const top = Number.isFinite(rect.top) ? rect.top : 0;
      const bandKey = Math.max(0, Math.floor(top / bandSizePx));
      const label = getSemanticText(element);
      const existing = bands.get(bandKey) ?? {
        top,
        elements: [],
        labels: [],
        score: 0,
      };
      existing.top = Math.min(existing.top, top);
      existing.elements.push(element);
      if (label) {
        existing.labels.push(label);
        existing.score += scoreLabel(label);
      }
      bands.set(bandKey, existing);
    }
    const ranked = [...bands.values()].sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (right.elements.length !== left.elements.length) {
        return right.elements.length - left.elements.length;
      }
      return left.top - right.top;
    });
    return ranked[0] ?? null;
  };
  const collectPrimaryActionElements = () => {
    const mainRoot =
      document.querySelector<HTMLElement>("main, article, [role='main']") ??
      document.body;
    const mainElements = collectActionElements(mainRoot);
    const bestMainBand = pickBestActionBand(mainElements);
    if (bestMainBand && bestMainBand.score > 0) {
      return bestMainBand.elements;
    }
    const prioritizedMain = mainElements.filter(
      (element) => scoreLabel(getSemanticText(element)) > 0
    );
    if (prioritizedMain.length > 0) {
      return prioritizedMain;
    }
    const pageElements = collectActionElements(document);
    const bestPageBand = pickBestActionBand(pageElements);
    if (bestPageBand && bestPageBand.score > 0) {
      return bestPageBand.elements;
    }
    const prioritizedPage = pageElements.filter(
      (element) => scoreLabel(getSemanticText(element)) > 0
    );
    if (prioritizedPage.length > 0) {
      return prioritizedPage;
    }
    return mainElements.length > 0 ? mainElements : pageElements;
  };
  const findDirectConnect = (elements: HTMLElement[]) =>
    elements.find((element) => {
      const text = getSemanticText(element);
      return (
        (text === "connect" ||
          text.startsWith("connect") ||
          text === "invite" ||
          text.startsWith("invite") ||
          text.includes("invite to connect")) &&
        !text.includes("remove your connection") &&
        !text.includes("disconnect")
      );
    });
  const findMoreButton = (elements: HTMLElement[]) =>
    elements.find((element) => {
      const text = getSemanticText(element);
      return (
        text === "more" ||
        text.startsWith("more") ||
        text.includes("more actions")
      );
    });
  const collectDirectConnectCandidates = (elements: HTMLElement[]) =>
    elements.filter((element) => {
      const text = getSemanticText(element);
      return (
        (text === "connect" ||
          text.startsWith("connect") ||
          text === "invite" ||
          text.startsWith("invite") ||
          text.includes("invite to connect")) &&
        !text.includes("remove your connection") &&
        !text.includes("disconnect")
      );
    });
  const collectMoreCandidates = (elements: HTMLElement[]) =>
    elements.filter((element) => {
      const text = getSemanticText(element);
      return (
        text === "more" ||
        text.startsWith("more") ||
        text.includes("more actions")
      );
    });
  const findAddNoteButton = (elements: HTMLElement[]) =>
    elements.find((element) => isLinkedInAddNoteText(getSemanticText(element)));
  const findSendButton = (elements: HTMLElement[]) =>
    elements.find((element) => isLinkedInSendText(getSemanticText(element)));
  const findFinalSendButton = (elements: HTMLElement[]) =>
    elements.find((element) => isLinkedInFinalSendText(getSemanticText(element)));
  const findEditor = (root: ParentNode = document) =>
    Array.from(
      root.querySelectorAll<HTMLElement>("textarea, [contenteditable='true']")
    ).find(isVisible) ?? null;
  const isInviteContainer = (el: HTMLElement | null) => {
    if (!el) return false;
    const role = normalize(el.getAttribute("role"));
    const id = normalize(el.getAttribute("id"));
    const className = normalize(el.getAttribute("class"));
    const modalId = normalize(el.getAttribute("data-test-modal-id"));
    return (
      el.tagName === "DIALOG" ||
      role === "dialog" ||
      id === "artdeco-modal-outlet" ||
      modalId === "send-invite-modal" ||
      className.includes("artdeco-modal") ||
      className.includes("artdeco-modal-overlay") ||
      className.includes("send-invite")
    );
  };
  const findInviteContainerFrom = (start: HTMLElement | null) => {
    let current: HTMLElement | null = start;
    while (current) {
      if (isInviteContainer(current)) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  };
  const findInviteHeading = () =>
    Array.from(document.querySelectorAll<HTMLElement>("h1, h2, h3, label, p, span"))
      .filter(isVisible)
      .find((element) => {
        const text = getSemanticText(element);
        return (
          text.includes("add a note to your invitation") ||
          text.includes("personalize your invitation") ||
          text.includes("send without a note")
        );
      }) ?? null;
  const findDialogLikeRoot = (): ParentNode | null => {
    const rootSelectors = [
      "[role='dialog'], dialog, .artdeco-modal",
      "[data-test-modal-id='send-invite-modal']",
      "#artdeco-modal-outlet",
      ".artdeco-modal-overlay",
      ".send-invite",
    ];
    for (const selector of rootSelectors) {
      const directRoot = findVisibleRoot(selector);
      if (directRoot) {
        return directRoot;
      }
    }

    const editor = findEditor(document);
    const editorRoot = findInviteContainerFrom(editor);
    if (editorRoot) {
      return editorRoot;
    }

    const inviteHeading = findInviteHeading();
    const headingRoot = findInviteContainerFrom(inviteHeading);
    if (headingRoot) {
      return headingRoot;
    }

    const globalButtons = collectActionElements();
    const actionRoot =
      findInviteContainerFrom(findAddNoteButton(globalButtons) ?? null) ??
      findInviteContainerFrom(findSendButton(globalButtons) ?? null) ??
      findInviteContainerFrom(findFinalSendButton(globalButtons) ?? null);
    if (actionRoot) {
      return actionRoot;
    }

    return null;
  };
  const waitFor = async <T extends ParentNode>(
    predicate: () => T | null,
    timeoutMs: number,
    intervalMs: number
  ): Promise<T | null> => {
    const startedAt = Date.now();
    for (;;) {
      const result = predicate();
      if (result) return result;
      if (Date.now() - startedAt >= timeoutMs) return null;
      await wait(intervalMs);
    }
  };
  const findVisibleRoot = (selector: string) =>
    Array.from(document.querySelectorAll<HTMLElement>(selector))
      .filter(isVisible)
      .at(-1) ?? null;
  const hasPendingMarker = (elements: HTMLElement[]) =>
    elements.some((element) => /pending|invitation sent/i.test(getSemanticText(element)));
  const hasConnectedMarker = (elements: HTMLElement[]) =>
    elements.some((element) => {
      const text = getSemanticText(element);
      return /message|following|inmail/i.test(text);
    });

  const debug = {
    primaryButtons: [] as string[],
    menuOptions: [] as string[],
    dialogButtons: [] as string[],
    resolutionPath: [] as string[],
  };

  let primaryButtons = collectPrimaryActionElements();
  debug.primaryButtons = collectTexts(primaryButtons);
  const requiresNote = message.trim().length > 0;

  const waitForDialogOpen = async () =>
    waitFor(findDialogLikeRoot, 2_000, 120);

  let dialogRoot: ParentNode | null = findDialogLikeRoot();
  if (dialogRoot) {
    debug.resolutionPath.push("existing_dialog");
  }

  if (!dialogRoot) {
    const mainRoot =
      document.querySelector<HTMLElement>("main, article, [role='main']") ??
      document.body;
    const directInviteAnchor = findInviteAnchor(mainRoot) ?? findInviteAnchor(document);
    if (directInviteAnchor) {
      const inviteLabel = getSemanticText(directInviteAnchor);
      if (inviteLabel) {
        debug.primaryButtons = [inviteLabel, ...debug.primaryButtons].slice(0, 20);
      }
      debug.resolutionPath.push("try_direct_invite_anchor");
      click(directInviteAnchor);
      dialogRoot = await waitForDialogOpen();
      if (dialogRoot) {
        debug.resolutionPath.push("direct_invite_anchor");
      }
    }
  }

  const directConnectCandidates = collectDirectConnectCandidates(primaryButtons);
  if (!dialogRoot) {
    for (let index = 0; index < directConnectCandidates.length; index += 1) {
      const candidate = directConnectCandidates[index];
      debug.resolutionPath.push(`try_direct_connect_${index + 1}`);
      click(candidate);
      dialogRoot = await waitForDialogOpen();
      if (dialogRoot) {
        debug.resolutionPath.push("direct_connect");
        break;
      }
      await wait(250);
    }
  }

  if (!dialogRoot) {
    const moreButtons = collectMoreCandidates(primaryButtons);
    if (directConnectCandidates.length === 0 && moreButtons.length === 0) {
      if (hasPendingMarker(primaryButtons)) {
        return { state: "already_pending", debug };
      }
      if (hasConnectedMarker(primaryButtons)) {
        return { state: "already_connected", debug };
      }
      return { state: "no_connect_control", debug };
    }

    let sawMenuConnectOption = false;
    for (let moreIndex = 0; moreIndex < moreButtons.length; moreIndex += 1) {
      const moreButton = moreButtons[moreIndex];
      debug.resolutionPath.push(`try_more_${moreIndex + 1}`);
      click(moreButton);
      const menuRoot = await waitFor(
        () => findVisibleRoot("[role='menu']"),
        2_500,
        120
      );
      if (!menuRoot) {
        await wait(200);
        continue;
      }

      const menuOptions = collectActionElements(menuRoot);
      debug.menuOptions = collectTexts(menuOptions);
      const connectOptions = collectDirectConnectCandidates(menuOptions);
      if (connectOptions.length === 0) {
        if (hasPendingMarker(menuOptions)) {
          return { state: "already_pending", debug };
        }
        if (hasConnectedMarker(menuOptions)) {
          return { state: "already_connected", debug };
        }
        await wait(200);
        continue;
      }

      sawMenuConnectOption = true;
      for (let connectIndex = 0; connectIndex < connectOptions.length; connectIndex += 1) {
        const connectOption = connectOptions[connectIndex];
        debug.resolutionPath.push(
          `try_menu_connect_${moreIndex + 1}_${connectIndex + 1}`
        );
        click(connectOption);
        dialogRoot = await waitForDialogOpen();
        if (dialogRoot) {
          debug.resolutionPath.push("clicked_menu_connect");
          break;
        }
        await wait(250);
      }

      if (dialogRoot) {
        break;
      }
    }

    if (!dialogRoot && directConnectCandidates.length === 0 && !sawMenuConnectOption) {
      return { state: "menu_connect_not_found", debug };
    }
  }

  if (!dialogRoot) {
    debug.dialogButtons = collectTexts(collectActionElements());
    return { state: "dialog_not_found", debug };
  }
  let dialogButtons = collectActionElements(dialogRoot);
  debug.dialogButtons = collectTexts(dialogButtons);
  let editor = findEditor(dialogRoot);

  if (requiresNote) {
    if (!editor) {
      const addNoteButton = findAddNoteButton(dialogButtons);
      if (addNoteButton) {
        debug.resolutionPath.push("clicked_add_note");
        click(addNoteButton);
        const reopenedDialogRoot =
          (await waitFor(findDialogLikeRoot, 3_000, 120)) ?? dialogRoot;
        dialogButtons = collectActionElements(reopenedDialogRoot);
        debug.dialogButtons = collectTexts(dialogButtons);
        editor =
          (await waitFor(
            () => {
              const activeDialogRoot = findDialogLikeRoot() ?? reopenedDialogRoot;
              return findEditor(activeDialogRoot);
            },
            3_000,
            120
          )) ?? null;
      }
    }

    if (!editor) {
      return { state: "note_editor_not_found", debug };
    }

    fillField(editor, message);
    await wait(200);
  }

  const finalDialogRoot = findDialogLikeRoot() ?? document;
  dialogButtons = collectActionElements(finalDialogRoot);
  debug.dialogButtons = collectTexts(dialogButtons);
  const sendButton = requiresNote
    ? findFinalSendButton(dialogButtons)
    : findSendButton(dialogButtons);
  if (!sendButton) {
    if (requiresNote && !editor) {
      return { state: "note_editor_not_found", debug };
    }
    if (!editor && !findAddNoteButton(dialogButtons)) {
      return { state: "dialog_not_found", debug };
    }
    return { state: "send_not_found", debug };
  }

  debug.resolutionPath.push("clicked_send");
  click(sendButton);
  await wait(400);
  return { state: "sent", debug };
}
