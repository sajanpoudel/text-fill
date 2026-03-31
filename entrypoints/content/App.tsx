import {
  Component,
  useState,
  useEffect,
  useCallback,
  useRef,
  type ErrorInfo,
  type ReactNode,
} from "react";
import {
  detectPlatformKey,
  detectLinkedInFieldType,
  findTextFields,
  getVisibleFieldAnchor,
  getLocationSnapshot,
  isSearchField,
  isPersonalInfoField,
  querySelectorDeep,
} from "../../src/lib/platform.ts";
import { FieldButton } from "./FieldButton.tsx";
import { ContextFAB, loadContexts } from "./ContextFAB.tsx";
import type { CapturedContext } from "./ContextFAB.tsx";
import type { PlatformKey } from "../../src/lib/platform.ts";

// ── Toast ─────────────────────────────────────────────────────────────────────

type ToastType = "success" | "error" | "info";

interface ToastState {
  message: string;
  type: ToastType;
  id: number;
}

const SHOW_LINKEDIN_DEBUG = false;

const EXCLUDED_INPUT_TYPES = new Set([
  "password",
  "hidden",
  "submit",
  "button",
  "reset",
  "checkbox",
  "radio",
  "file",
]);

function isSupportedInput(
  node: Element
): node is HTMLInputElement | HTMLTextAreaElement {
  if (node instanceof HTMLTextAreaElement) return true;
  if (!(node instanceof HTMLInputElement)) return false;
  return !EXCLUDED_INPUT_TYPES.has(node.type);
}

function isEditableHost(node: HTMLElement): boolean {
  if (isSupportedInput(node)) return true;

  const contentEditable = node.getAttribute("contenteditable");
  if (contentEditable !== null && contentEditable.toLowerCase() !== "false") {
    return true;
  }

  const role = node.getAttribute("role")?.toLowerCase();
  if (role === "textbox") return true;

  if (
    node.classList.contains("ql-editor") ||
    node.classList.contains("public-DraftEditor-content") ||
    node.hasAttribute("data-lexical-editor")
  ) {
    return true;
  }

  return false;
}

function isFieldInViewport(field: Element): boolean {
  const anchor = getVisibleFieldAnchor(field);
  if (!anchor) return false;
  const rect = anchor.getBoundingClientRect();
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom >= 0 &&
    rect.right >= 0 &&
    rect.top <= window.innerHeight &&
    rect.left <= window.innerWidth
  );
}

function looksLikeComposeField(field: Element): boolean {
  const el = field as HTMLElement;
  const attrs = [
    el.getAttribute("placeholder") ?? "",
    el.getAttribute("data-placeholder") ?? "",
    el.getAttribute("aria-label") ?? "",
    el.getAttribute("name") ?? "",
    el.getAttribute("id") ?? "",
    el.getAttribute("role") ?? "",
    el.getAttribute("data-testid") ?? "",
    el.className ?? "",
  ]
    .join(" ")
    .toLowerCase();

  const hints = [
    "message",
    "compose",
    "reply",
    "comment",
    "post",
    "chat",
    "note",
    "description",
    "bio",
    "summary",
    "write",
    "thread",
  ];

  if (field instanceof HTMLTextAreaElement) return true;
  return hints.some((hint) => attrs.includes(hint));
}

function findLinkedInEditableDescendant(node: HTMLElement): Element | null {
  if (
    !node.shadowRoot &&
    !node.matches(
      ".msg-form__msg-content-container, .msg-form__container, .comments-comment-box__form-container, .comments-comment-texteditor, .share-creation-state__text-editor, .feed-shared-update-v2__comments-container"
    )
  ) {
    return null;
  }

  return (
    querySelectorDeep(
      '.msg-form__contenteditable[contenteditable="true"], div.ql-editor[contenteditable="true"], div[contenteditable="true"][role="textbox"], textarea.connect-button-send-invite__custom-message, textarea[name="message"]',
      node
    ) ?? null
  );
}

function isLikelyLinkedInRecipientField(field: Element): boolean {
  if (detectLinkedInFieldType(field)) return false;

  const el = field as HTMLElement;
  const attrs = [
    el.getAttribute("placeholder") ?? "",
    el.getAttribute("data-placeholder") ?? "",
    el.getAttribute("aria-label") ?? "",
    el.getAttribute("name") ?? "",
    el.getAttribute("id") ?? "",
    el.getAttribute("role") ?? "",
    el.getAttribute("autocomplete") ?? "",
    el.className ?? "",
  ]
    .join(" ")
    .toLowerCase();

  if (
    ["recipient", "recipients", "invitee", "invitees", "people", "connections"].some(
      (term) => attrs.includes(term)
    )
  ) {
    return true;
  }

  if (
    (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) &&
    (attrs.includes("search") || attrs.includes("combobox") || attrs.includes("typeahead"))
  ) {
    return true;
  }

  return !!el.closest(
    ".msg-connections-typeahead, .artdeco-typeahead, [class*='typeahead'], [class*='recipient'], [class*='invitee']"
  );
}

function isLinkedInPrimaryComposeField(field: Element): boolean {
  const el = field as HTMLElement;
  const attrs = [
    el.getAttribute("aria-label") ?? "",
    el.getAttribute("data-placeholder") ?? "",
    el.getAttribute("placeholder") ?? "",
    el.className ?? "",
  ]
    .join(" ")
    .toLowerCase();

  return (
    el.matches?.(".msg-form__contenteditable") ||
    !!field.closest(".msg-form__msg-content-container") ||
    attrs.includes("write a message")
  );
}

function scoreField(
  field: Element,
  activeElement: Element | null,
  focusedField: Element | null,
  hoveredField: Element | null
): number {
  const rect = field.getBoundingClientRect();
  let score = 0;

  if (field === activeElement) score += 2500;
  if (field === focusedField) score += 2200;
  if (field === hoveredField) score += 1600;
  if (field.closest("dialog, [role='dialog'], .modal, [data-modal]")) score += 320;
  if (looksLikeComposeField(field)) score += 180;

  score += Math.min(rect.width, 720) / 5;
  score += Math.min(rect.height, 240) / 3;

  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  score -= Math.abs(centerX - window.innerWidth / 2) / 40;
  score -= Math.abs(centerY - window.innerHeight / 2) / 40;

  return score;
}

function Toast({ toast }: { toast: ToastState | null }) {
  if (!toast) return null;

  const bg =
    toast.type === "success"
      ? "rgba(16,185,129,0.95)"
      : toast.type === "error"
      ? "rgba(220,38,38,0.95)"
      : "rgba(59,130,246,0.95)";

  return (
    <div
      style={{
        position: "fixed",
        bottom: 20,
        right: 20,
        zIndex: 2147483647,
        background: bg,
        color: "#fff",
        padding: "10px 16px",
        borderRadius: 8,
        fontSize: 13,
        fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
        fontWeight: 500,
        boxShadow: "0 4px 16px rgba(0,0,0,0.22)",
        pointerEvents: "none",
        maxWidth: 280,
        lineHeight: 1.4,
        animation: "tfa-fadein 0.2s ease",
      }}
    >
      {toast.message}
    </div>
  );
}

function formatFieldDebugLabel(field: Element): string {
  const el = field as HTMLElement;
  const classBits = Array.from(el.classList).slice(0, 3).join(".");
  const label =
    el.getAttribute("aria-label") ??
    el.getAttribute("data-placeholder") ??
    el.getAttribute("placeholder") ??
    el.getAttribute("name") ??
    el.getAttribute("id") ??
    "";

  const tagName = el.tagName.toLowerCase();
  const classPart = classBits ? `.${classBits}` : "";
  return `${tagName}${classPart}${label ? ` — ${label}` : ""}`;
}

interface FieldDebugPanelProps {
  platform: PlatformKey;
  fields: Element[];
  primaryField: Element | null;
  currentActiveElement: Element | null;
  focusedField: Element | null;
  hoveredField: Element | null;
}

function FieldDebugPanel({
  platform,
  fields,
  primaryField,
  currentActiveElement,
  focusedField,
  hoveredField,
}: FieldDebugPanelProps) {
  if (!SHOW_LINKEDIN_DEBUG || platform !== "linkedin") return null;

  return (
    <div
      data-tfa-ui="debug"
      style={{
        position: "fixed",
        left: 12,
        bottom: 12,
        zIndex: 2147483647,
        width: 360,
        maxHeight: 260,
        overflowY: "auto",
        background: "rgba(15,23,42,0.94)",
        color: "#e2e8f0",
        border: "1px solid rgba(148,163,184,0.28)",
        borderRadius: 10,
        boxShadow: "0 8px 24px rgba(15,23,42,0.32)",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 11,
        lineHeight: 1.45,
        padding: 10,
        pointerEvents: "auto",
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: 6 }}>
        Text Fill Debug · LinkedIn · {fields.length} field{fields.length === 1 ? "" : "s"}
      </div>
      {fields.length === 0 ? (
        <div style={{ color: "#fca5a5" }}>
          No visible editable fields detected.
        </div>
      ) : (
        fields.map((field, index) => {
          const typed = detectLinkedInFieldType(field) ?? "-";
          const score = Math.round(
            scoreField(field, currentActiveElement, focusedField, hoveredField)
          );
          const flags = [
            field === primaryField ? "PRIMARY" : "",
            field === currentActiveElement ? "ACTIVE" : "",
            field === focusedField ? "FOCUSED" : "",
            field === hoveredField ? "HOVER" : "",
            isLinkedInPrimaryComposeField(field) ? "COMPOSE" : "",
            isLikelyLinkedInRecipientField(field) ? "RECIPIENT" : "",
            isSearchField(field) ? "SEARCH" : "",
          ].filter(Boolean);

          return (
            <div
              key={`${formatFieldDebugLabel(field)}_${index}`}
              style={{
                padding: "6px 0",
                borderTop: index === 0 ? "none" : "1px solid rgba(148,163,184,0.16)",
              }}
            >
              <div style={{ color: "#93c5fd", fontWeight: 600 }}>
                #{index + 1} {formatFieldDebugLabel(field)}
              </div>
              <div>
                type={typed} score={score}
              </div>
              <div style={{ color: flags.includes("RECIPIENT") ? "#fca5a5" : "#a7f3d0" }}>
                {flags.length ? flags.join(" · ") : "NO_FLAGS"}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

function FieldDebugOutlines({
  platform,
  fields,
  primaryField,
}: {
  platform: PlatformKey;
  fields: Element[];
  primaryField: Element | null;
}) {
  if (!SHOW_LINKEDIN_DEBUG || platform !== "linkedin") return null;

  return (
    <>
      {fields.map((field, index) => {
        const anchor = getVisibleFieldAnchor(field);
        if (!anchor) return null;
        const rect = anchor.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;

        const type = detectLinkedInFieldType(field) ?? "UNCLASSIFIED";
        const isPrimary = field === primaryField;

        return (
          <div
            key={`outline_${formatFieldDebugLabel(field)}_${index}`}
            data-tfa-ui="field-debug"
            style={{
              position: "fixed",
              top: Math.max(rect.top, 0),
              left: Math.max(rect.left, 0),
              width: Math.max(rect.width, 0),
              height: Math.max(rect.height, 0),
              border: isPrimary
                ? "2px solid rgba(59,130,246,0.95)"
                : "2px solid rgba(251,191,36,0.92)",
              background: isPrimary
                ? "rgba(59,130,246,0.08)"
                : "rgba(251,191,36,0.07)",
              borderRadius: 8,
              boxSizing: "border-box",
              pointerEvents: "none",
              zIndex: 2147483645,
            }}
          >
            <div
              style={{
                position: "absolute",
                top: -22,
                left: 0,
                padding: "2px 6px",
                borderRadius: 999,
                background: isPrimary
                  ? "rgba(30,64,175,0.96)"
                  : "rgba(146,64,14,0.96)",
                color: "#fff",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: 10,
                fontWeight: 700,
                lineHeight: 1.2,
                whiteSpace: "nowrap",
              }}
            >
              #{index + 1} {type}
              {isPrimary ? " PRIMARY" : ""}
            </div>
          </div>
        );
      })}
    </>
  );
}

interface FieldUiBoundaryProps {
  children: ReactNode;
  resetToken: Element | null;
  onError: () => void;
}

interface FieldUiBoundaryState {
  hasError: boolean;
}

function isInvalidatedError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return msg.includes("Extension context invalidated");
}

class FabBoundary extends Component<{ children: ReactNode }, { dead: boolean }> {
  state = { dead: false };
  static getDerivedStateFromError(): { dead: boolean } { return { dead: true }; }
  componentDidCatch(error: unknown) {
    if (!isInvalidatedError(error)) console.error("[TextFill] FAB crashed", error);
  }
  render() { return this.state.dead ? null : this.props.children; }
}

class FieldUiBoundary extends Component<
  FieldUiBoundaryProps,
  FieldUiBoundaryState
> {
  state: FieldUiBoundaryState = { hasError: false };

  static getDerivedStateFromError(): FieldUiBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    if (!isInvalidatedError(error)) {
      console.error("Text Fill inline UI crashed", error, info.componentStack);
    }
    this.props.onError();
  }

  componentDidUpdate(prevProps: FieldUiBoundaryProps) {
    if (
      this.state.hasError &&
      prevProps.resetToken !== this.props.resetToken
    ) {
      try {
        if (!chrome.runtime?.id) return; // don't retry with an invalidated context
      } catch { return; }
      this.setState({ hasError: false });
    }
  }

  render() {
    if (this.state.hasError) return null;
    return this.props.children;
  }
}

// ── Extension invalidation flag ───────────────────────────────────────────────
// Set synchronously when ctx.onInvalidated() fires (see index.ts).
// Checked at the top of every render to short-circuit before any chrome API is called.
let _contextInvalidated = false;
export function markContextInvalidated() { _contextInvalidated = true; }

// ── ContentApp ────────────────────────────────────────────────────────────────

export function ContentApp() {
  if (_contextInvalidated) return null;
  const [focusedField, setFocusedField] = useState<Element | null>(null);
  const [hoveredField, setHoveredField] = useState<Element | null>(null);
  const [discoveredFields, setDiscoveredFields] = useState<Element[]>([]);
  const [platform, setPlatform] = useState<PlatformKey>("general");
  const [contexts, setContexts] = useState<CapturedContext[]>([]);
  const [toast, setToast] = useState<ToastState | null>(null);

  const showToast = useCallback((message: string, type: ToastType = "success") => {
    const id = Date.now();
    setToast({ message, type, id });
    setTimeout(() => setToast((t) => (t?.id === id ? null : t)), 2500);
  }, []);

  const resolveEditableRoot = useCallback((target: Element | null): Element | null => {
    if (!target) return null;
    const isLinkedIn = getLocationSnapshot().hostname.includes("linkedin.com");
    let node: HTMLElement | null =
      target instanceof HTMLElement ? target : target.parentElement;

    while (node) {
      if (node.closest?.("[data-tfa-ui]")) return null;

      if (isEditableHost(node)) {
        if (isSearchField(node)) return null;
        if (node instanceof HTMLInputElement && isPersonalInfoField(node)) return null;
        return node;
      }

      if (isLinkedIn) {
        const descendant = findLinkedInEditableDescendant(node);
        if (
          descendant &&
          !isSearchField(descendant) &&
          !(descendant instanceof HTMLInputElement && isPersonalInfoField(descendant))
        ) {
          return descendant;
        }
      }

      if (node.parentElement) {
        node = node.parentElement;
        continue;
      }

      const root = node.getRootNode();
      if (root instanceof ShadowRoot) {
        node = root.host instanceof HTMLElement ? root.host : null;
        continue;
      }

      node = null;
    }

    return null;
  }, []);

  const resolveEditableFromEvent = useCallback(
    (event: Event): Element | null => {
      const path = typeof event.composedPath === "function" ? event.composedPath() : [];

      for (const item of path) {
        if (item instanceof Element) {
          const resolved = resolveEditableRoot(item);
          if (resolved) return resolved;
        } else if (item instanceof ShadowRoot) {
          const resolved = resolveEditableRoot(item.host);
          if (resolved) return resolved;
        }
      }

      return resolveEditableRoot(event.target as Element | null);
    },
    [resolveEditableRoot]
  );

  // Init: detect platform + load contexts from storage
  useEffect(() => {
    const key = detectPlatformKey(getLocationSnapshot().hostname);
    setPlatform(key);

    loadContexts().then(setContexts).catch(() => setContexts([]));

    const active =
      document.activeElement instanceof Element
        ? resolveEditableRoot(document.activeElement)
        : null;
    setFocusedField(active);
  }, [resolveEditableRoot]);

  // Listen for storage changes to contexts
  useEffect(() => {
    const handler = (changes: Record<string, chrome.storage.StorageChange>) => {
      if ("capturedContexts" in changes) {
        const next = changes.capturedContexts.newValue;
        setContexts(Array.isArray(next) ? next : []);
      }
    };
    try {
      chrome.storage.onChanged.addListener(handler);
      return () => { try { chrome.storage.onChanged.removeListener(handler); } catch { /* invalidated */ } };
    } catch {
      return () => {};
    }
  }, []);

  useEffect(() => {
    const handler = (message: { type?: string; message?: string }) => {
      if (message?.type === "MEMORY_UPDATED" && typeof message.message === "string") {
        showToast(message.message, "info");
      }
    };
    try {
      chrome.runtime.onMessage.addListener(handler);
      return () => { try { chrome.runtime.onMessage.removeListener(handler); } catch { /* invalidated */ } };
    } catch {
      return () => {};
    }
  }, [showToast]);

  useEffect(() => {
    if (!document.body) return;

    let rafId = 0;
    const refreshDiscoveredFields = () => {
      rafId = 0;
      const nextPlatform = detectPlatformKey(getLocationSnapshot().hostname);
      setPlatform(nextPlatform);
      const unique = new Set<Element>();
      const next: Element[] = [];

      const pushField = (candidate: Element | null) => {
        const root = resolveEditableRoot(candidate);
        if (!root || unique.has(root)) return;
        unique.add(root);
        next.push(root);
      };

      for (const field of findTextFields(nextPlatform)) pushField(field);

      if (document.activeElement instanceof Element) {
        pushField(document.activeElement);
      }

      setDiscoveredFields(next);
    };

    const scheduleRefresh = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(refreshDiscoveredFields);
    };

    refreshDiscoveredFields();

    const observer = new MutationObserver((mutations) => {
      scheduleRefresh();
      // Fields that animate in (e.g. clicking "Reply", opening a dialog) have
      // zero dimensions right after insertion. Schedule delayed re-scans so we
      // catch them after the CSS transition has settled.
      const hasNewNodes = mutations.some((m) => m.addedNodes.length > 0);
      if (hasNewNodes) {
        setTimeout(refreshDiscoveredFields, 350);
        setTimeout(refreshDiscoveredFields, 900);
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "class",
        "style",
        "hidden",
        "aria-hidden",
        "contenteditable",
        "role",
        "disabled",
        "readonly",
      ],
    });

    const onVisibilityChange = () => {
      if (!document.hidden) scheduleRefresh();
    };

    // SPA navigation: LinkedIn changes the URL via pushState without a full
    // page reload. The MutationObserver fires but the RAF refresh runs before
    // CSS transitions finish, so new fields have zero dimensions and are missed.
    // Fix: poll for URL changes and re-scan after transitions have time to settle.
    let lastHref = location.href;
    const onNavigation = () => {
      scheduleRefresh();
      // Delayed re-scans so fields that animate in are caught after transitions
      setTimeout(refreshDiscoveredFields, 300);
      setTimeout(refreshDiscoveredFields, 800);
      setTimeout(refreshDiscoveredFields, 1600);
    };
    const navPollInterval = setInterval(() => {
      if (location.href !== lastHref) {
        lastHref = location.href;
        onNavigation();
      }
    }, 600);
    const onPopState = () => onNavigation();
    window.addEventListener("popstate", onPopState);

    // A click on the page may reveal a new compose field (Reply, Comment, etc.)
    // Schedule a delayed re-scan so we catch fields that animate in after the click.
    const onPageClick = (e: MouseEvent) => {
      if ((e.target as Element)?.closest?.("[data-tfa-ui]")) return;
      setTimeout(refreshDiscoveredFields, 300);
      setTimeout(refreshDiscoveredFields, 800);
    };

    document.addEventListener("input", scheduleRefresh, true);
    document.addEventListener("click", onPageClick, true);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("resize", scheduleRefresh, { passive: true });

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      observer.disconnect();
      clearInterval(navPollInterval);
      window.removeEventListener("popstate", onPopState);
      document.removeEventListener("input", scheduleRefresh, true);
      document.removeEventListener("click", onPageClick, true);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("resize", scheduleRefresh);
    };
  }, [platform, resolveEditableRoot]);

  useEffect(() => {
    const onFocusin = (e: FocusEvent) => {
      setPlatform(detectPlatformKey(getLocationSnapshot().hostname));
      setFocusedField(resolveEditableFromEvent(e));
    };

    const onFocusout = (e: FocusEvent) => {
      const nextTarget = e.relatedTarget as Element | null;
      if (nextTarget?.closest?.("[data-tfa-ui]")) return;
      requestAnimationFrame(() => {
        const active = document.activeElement instanceof Element
          ? resolveEditableRoot(document.activeElement)
          : null;
        setFocusedField(active);
      });
    };

    const onPointerOver = (e: PointerEvent) => {
      if (focusedField) return;
      const target = e.target as Element | null;
      if (target?.closest?.("[data-tfa-ui]")) return;
      setHoveredField(resolveEditableFromEvent(e));
    };

    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (target?.closest?.("[data-tfa-ui]")) return;
      if (resolveEditableFromEvent(e)) return;
      requestAnimationFrame(() => {
        const active = document.activeElement instanceof Element
          ? resolveEditableRoot(document.activeElement)
          : null;
        if (!active) {
          setFocusedField(null);
          setHoveredField(null);
        }
      });
    };

    document.addEventListener("focusin", onFocusin, true);
    document.addEventListener("focusout", onFocusout, true);
    document.addEventListener("pointerover", onPointerOver, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("focusin", onFocusin, true);
      document.removeEventListener("focusout", onFocusout, true);
      document.removeEventListener("pointerover", onPointerOver, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [focusedField, resolveEditableFromEvent, resolveEditableRoot]);

  const activeContextCount = contexts.filter((c) => c.active).length;
  const currentActiveElement =
    document.activeElement instanceof Element
      ? resolveEditableRoot(document.activeElement)
      : null;

  // Track active field in a ref so the keyboard shortcut handler can read it without stale closures
  const activeFieldRef = useRef<Element | null>(null);

  // Alt+Shift+G: quick-generate on the currently active field
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.altKey && e.shiftKey && (e.key === "g" || e.key === "G")) {
        e.preventDefault();
        e.stopPropagation();
        const field = activeFieldRef.current;
        if (field) field.dispatchEvent(new CustomEvent("tfa-quick-generate", { bubbles: false }));
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, []);

  const candidateFields: Element[] = [];
  const seenFields = new Set<Element>();
  const pushCandidate = (candidate: Element | null) => {
    const root = resolveEditableRoot(candidate);
    if (!root || seenFields.has(root) || !isFieldInViewport(root)) return;
    seenFields.add(root);
    candidateFields.push(root);
  };

  pushCandidate(currentActiveElement);
  pushCandidate(focusedField);
  pushCandidate(hoveredField);
  discoveredFields.forEach(pushCandidate);

  const rankedFields =
    platform === "linkedin"
      ? (() => {
          const primaryComposeFields = candidateFields.filter(
            (field) => isLinkedInPrimaryComposeField(field)
          );
          if (primaryComposeFields.length) return primaryComposeFields;

          const typedFields = candidateFields.filter(
            (field) => detectLinkedInFieldType(field) !== null
          );
          if (typedFields.length) return typedFields;

          const nonRecipientFields = candidateFields.filter(
            (field) => !isLikelyLinkedInRecipientField(field)
          );
          return nonRecipientFields.length ? nonRecipientFields : candidateFields;
        })()
      : candidateFields;

  const sortedFields = [...candidateFields].sort(
    (a, b) =>
      scoreField(b, currentActiveElement, focusedField, hoveredField) -
      scoreField(a, currentActiveElement, focusedField, hoveredField)
  );
  const primaryField =
    [...rankedFields].sort(
      (a, b) =>
        scoreField(b, currentActiveElement, focusedField, hoveredField) -
        scoreField(a, currentActiveElement, focusedField, hoveredField)
    )[0] ?? null;
  activeFieldRef.current = primaryField;
  const showFab = window.top === window;

  // Stop rendering entirely if the extension context has been invalidated.
  // This prevents chrome.* API calls from throwing during any scheduled re-render
  // that races with WXT's onInvalidated cleanup.
  try { if (!chrome.runtime?.id) return null; } catch { return null; }

  return (
    <div
      data-tfa-ui="layer"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 2147483646,
        pointerEvents: "none",
        background: "transparent",
      }}
    >
      <FieldDebugOutlines
        platform={platform}
        fields={sortedFields}
        primaryField={primaryField}
      />
      {sortedFields.map((field, index) => (
        <FieldUiBoundary
          key={`${formatFieldDebugLabel(field)}_${index}`}
          resetToken={field}
          onError={() =>
            showToast("Inline button reset after a page-specific DOM error", "error")
          }
        >
          <FieldButton
            field={field}
            platform={platform}
            activeContextCount={activeContextCount}
            showToast={showToast}
          />
        </FieldUiBoundary>
      ))}
      <FabBoundary>
        <ContextFAB
          visible={showFab}
          contexts={contexts}
          onContextsChange={setContexts}
          showToast={showToast}
        />
      </FabBoundary>
      <FieldDebugPanel
        platform={platform}
        fields={sortedFields}
        primaryField={primaryField}
        currentActiveElement={currentActiveElement}
        focusedField={focusedField}
        hoveredField={hoveredField}
      />
      <Toast toast={toast} />
      <style>{`
        @keyframes tfa-fadein {
          from { opacity: 0; transform: translateY(6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes tfa-spin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
