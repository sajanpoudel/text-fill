// Universal DOM-to-graph extractor.
// Uses only ARIA roles and semantic HTML — NO CSS class selectors.
// Platform-specific selectors live in src/lib/platforms/*.ts

import { convertElementToMarkdown } from "dom-to-semantic-markdown";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SemanticNode {
  tag: string;
  role: string | null;   // explicit ARIA role attribute
  label: string | null;  // aria-label, aria-labelledby, title, placeholder, or linked <label>
  text: string | null;   // direct text-node children only (not descendant text)
  children: SemanticNode[];
}

// ── Constants ─────────────────────────────────────────────────────────────────

// HTML tags that carry semantic meaning — shown in serialized output
const SEMANTIC_TAGS = new Set([
  "main", "nav", "header", "footer", "aside", "section", "article",
  "form", "dialog", "fieldset", "details", "summary",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "p", "ul", "ol", "li", "dl", "dt", "dd",
  "table", "thead", "tbody", "tr", "th", "td",
  "button", "a", "label", "input", "textarea", "select", "option",
  "blockquote", "pre", "code", "time", "figure", "figcaption",
]);

// Tags that never contain useful LLM context
const SKIP_TAGS = new Set([
  "script", "style", "noscript", "link", "meta",
  "svg", "canvas", "iframe", "template", "picture",
]);

// ARIA roles that define a semantic context boundary (tightest wins)
const BOUNDARY_ROLES = new Set([
  "dialog", "alertdialog", "main", "complementary",
  "form", "search", "article", "region",
]);

// HTML tags that act as context boundaries
const BOUNDARY_TAGS = new Set([
  "dialog", "main", "article", "form", "section", "aside",
]);

// ── Visibility ────────────────────────────────────────────────────────────────

export function isElementVisible(el: Element | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false;
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function isVisible(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return true;
  const style = window.getComputedStyle(el);
  return style.display !== "none" && style.visibility !== "hidden";
}

function shouldSkip(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (SKIP_TAGS.has(tag)) return true;
  if (el.hasAttribute("data-tfa-ui")) return true;
  return false;
}

// ── Node extraction ───────────────────────────────────────────────────────────

/**
 * Extracts a label from ARIA attributes or a linked <label> element.
 * Does not read child element text — attributes only.
 */
function getLabel(el: Element): string | null {
  const ariaLabel = el.getAttribute("aria-label")?.trim();
  if (ariaLabel) return ariaLabel;

  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const parts = labelledBy.split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim())
      .filter(Boolean);
    if (parts.length) return parts.join(" ");
  }

  const title = el.getAttribute("title")?.trim();
  if (title) return title;

  const placeholder = el.getAttribute("placeholder")?.trim();
  if (placeholder) return placeholder;

  const id = el.getAttribute("id");
  if (id) {
    try {
      const linked = document.querySelector<HTMLElement>(`label[for="${CSS.escape(id)}"]`);
      if (linked) return linked.textContent?.replace(/\s+/g, " ").trim() ?? null;
    } catch { /* invalid id */ }
  }

  return null;
}

/**
 * Returns only direct text-node children of an element, not descendant text.
 * Prevents double-counting text that already appears in child SemanticNodes.
 */
function getDirectText(el: Element): string | null {
  let text = "";
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? "";
    }
  }
  text = text.replace(/\s+/g, " ").trim();
  return text || null;
}

// ── Walker ────────────────────────────────────────────────────────────────────

interface Budget { remaining: number }

/**
 * Walks a DOM subtree and returns a SemanticNode tree.
 * Uses a character budget to prevent unbounded output.
 * Does NOT use CSS class names — only ARIA roles, semantic tags, and ARIA attributes.
 */
export function walkSubtree(
  root: Element,
  maxDepth = 8,
  budget: Budget = { remaining: 4000 },
): SemanticNode | null {
  if (!isVisible(root)) return null;
  if (shouldSkip(root)) return null;
  if (budget.remaining <= 0) return null;

  const tag = root.tagName.toLowerCase();
  const role = root.getAttribute("role") ?? null;
  const label = getLabel(root);
  const text = getDirectText(root);

  if (label) budget.remaining -= label.length;
  if (text) budget.remaining -= text.length;

  const node: SemanticNode = { tag, role, label, text, children: [] };

  if (maxDepth > 0 && budget.remaining > 0) {
    for (const child of Array.from(root.children)) {
      const childNode = walkSubtree(child, maxDepth - 1, budget);
      if (childNode) node.children.push(childNode);
      if (budget.remaining <= 0) break;
    }
  }

  return node;
}

// ── Boundary detection ────────────────────────────────────────────────────────

/**
 * Walks up the DOM from a field to find the tightest semantic context boundary.
 * Uses ONLY ARIA roles and semantic HTML tags — no CSS class names.
 * Stops at the tightest match: dialog > form/article/main > section.
 */
export function findContextBoundary(field: Element): Element {
  let best: Element = field.parentElement ?? field;
  let node: Element | null = field.parentElement;

  while (node && node !== document.documentElement) {
    const tag = node.tagName.toLowerCase();
    const role = node.getAttribute("role") ?? "";

    if (BOUNDARY_ROLES.has(role) || BOUNDARY_TAGS.has(tag)) {
      best = node;
      // Dialog is the tightest possible boundary — stop here
      if (role === "dialog" || role === "alertdialog" || tag === "dialog") break;
    }

    node = node.parentElement;
  }

  return best;
}

// ── Serializer ────────────────────────────────────────────────────────────────

const INDENT = "  ";

/**
 * Converts a SemanticNode tree to an indented, LLM-readable text representation.
 * Only emits lines that carry meaningful content.
 */
export function serializeGraph(node: SemanticNode, depth = 0): string {
  const lines: string[] = [];
  const pad = INDENT.repeat(depth);
  const tag = node.tag;
  const isSemantic = SEMANTIC_TAGS.has(tag);

  const parts: string[] = [];
  if (isSemantic) parts.push(`<${tag}>`);
  if (node.role && node.role !== "none" && node.role !== "presentation") {
    parts.push(`[${node.role}]`);
  }
  if (node.label) parts.push(`"${node.label.slice(0, 80)}"`);
  if (node.text) parts.push(`→ ${node.text.slice(0, 120)}`);

  const hasContent = isSemantic || node.role || node.label || node.text;
  if (hasContent && parts.length > 0) {
    lines.push(`${pad}${parts.join(" ")}`);
  }

  for (const child of node.children) {
    const childStr = serializeGraph(child, depth + (hasContent ? 1 : 0));
    if (childStr) lines.push(childStr);
  }

  return lines.filter(Boolean).join("\n");
}

// ── Text utilities ────────────────────────────────────────────────────────────

export function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function extractSectionText(element: Element | null, maxChars = Infinity): string {
  if (!element) return "";
  const source = element instanceof HTMLElement ? element.innerText : element.textContent ?? "";
  return source
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, maxChars);
}

/**
 * Converts a DOM element to LLM-friendly text.
 * Tries semantic markdown conversion first, falls back to innerText.
 * Strips extension UI and obvious noise before converting.
 */
export function extractCleanText(element: Element | null, maxChars = Infinity): string {
  if (!element) return "";
  try {
    const clone = element.cloneNode(true) as Element;
    clone.querySelectorAll(
      "[data-tfa-ui], script, style, noscript, [aria-hidden='true'], [role='presentation']"
    ).forEach((el) => el.remove());
    const md = convertElementToMarkdown(clone, { refifyUrls: false });
    return md.replace(/\n{3,}/g, "\n\n").trim().slice(0, maxChars);
  } catch {
    return extractSectionText(element, maxChars);
  }
}

/**
 * Convenience: walk from the given boundary element and serialize to text.
 */
export function extractDomContext(boundary: Element, maxChars = 3000): string {
  const tree = walkSubtree(boundary, 8, { remaining: maxChars });
  if (!tree) return "";
  return serializeGraph(tree);
}
