import {
  useState,
  useRef,
  useEffect,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { insertText } from "../../src/lib/insert-text";
import { extractPageContext } from "../../src/lib/platform";
import { loadContexts, saveContexts } from "./ContextFAB.tsx";
import type { PlatformKey } from "../../src/lib/platform";

interface Props {
  field: Element;
  platform: PlatformKey;
  anchorRect: DOMRect;
  activeContextCount: number;
  onClose: () => void;
  onGenerate: (opts: { instruction: string; pageContext?: string; fieldMaxLength?: number }) => void;
  showToast: (message: string, type?: "success" | "error" | "info") => void;
}

const MODAL_W = 224;

function setupFocusProtection(
  instructionInput: HTMLInputElement,
  modal: HTMLDivElement,
  trapContainer: HTMLElement | null
) {
  const onFocusIn = (e: FocusEvent) => {
    const target = e.target as Node | null;
    if (target && modal.contains(target)) {
      e.stopImmediatePropagation();
    }
  };

  const onFocusOut = (e: FocusEvent) => {
    const nextTarget = e.relatedTarget as Node | null;
    if (nextTarget && modal.contains(nextTarget)) {
      e.stopImmediatePropagation();
    }
  };

  const onPointerDown = (e: PointerEvent) => {
    const target = e.target as Node | null;
    if (target && modal.contains(target)) {
      e.stopImmediatePropagation();
    }
  };

  window.addEventListener("focusin", onFocusIn, true);
  window.addEventListener("focusout", onFocusOut, true);
  window.addEventListener("pointerdown", onPointerDown, true);

  const restorations: Array<[HTMLElement, "inert" | "aria-hidden", string]> = [];
  let el = modal.parentElement;
  while (el && el !== document.documentElement) {
    if (el.hasAttribute("inert")) {
      el.removeAttribute("inert");
      restorations.push([el, "inert", ""]);
    }
    if (el.getAttribute("aria-hidden") === "true") {
      el.removeAttribute("aria-hidden");
      restorations.push([el, "aria-hidden", "true"]);
    }
    el = el.parentElement;
  }

  const inertedElements: HTMLElement[] = [];
  if (trapContainer) {
    const FOCUSABLE =
      "input, textarea, button, a[href], select, [tabindex], [contenteditable]";
    Array.from(trapContainer.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter((node) => !modal.contains(node) && !node.hasAttribute("inert"))
      .forEach((node) => {
        node.setAttribute("inert", "");
        inertedElements.push(node);
      });
  }

  const originalFocus = HTMLElement.prototype.focus;
  let blockUntil = 0;
  const activateBlock = () => {
    blockUntil = Date.now() + 600;
  };

  instructionInput.addEventListener("mousedown", activateBlock, true);

  const focusOverride = function focusOverride(
    this: HTMLElement,
    opts?: FocusOptions
  ) {
    if (!modal.isConnected) {
      HTMLElement.prototype.focus = originalFocus;
      return originalFocus.call(this, opts);
    }
    if (modal.contains(this)) {
      return originalFocus.call(this, opts);
    }
    if (Date.now() < blockUntil) {
      return;
    }
    return originalFocus.call(this, opts);
  };
  let focusPatched = false;
  try {
    HTMLElement.prototype.focus = focusOverride;
    focusPatched = true;
  } catch {
    focusPatched = false;
  }

  return () => {
    window.removeEventListener("focusin", onFocusIn, true);
    window.removeEventListener("focusout", onFocusOut, true);
    window.removeEventListener("pointerdown", onPointerDown, true);
    instructionInput.removeEventListener("mousedown", activateBlock, true);
    if (focusPatched && HTMLElement.prototype.focus === focusOverride) {
      HTMLElement.prototype.focus = originalFocus;
    }
    inertedElements.forEach((node) => node.removeAttribute("inert"));
    restorations.forEach(([node, attr, value]) => node.setAttribute(attr, value));
  };
}

function isPageDark(): boolean {
  try {
    const bg = window.getComputedStyle(document.body).backgroundColor;
    const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return window.matchMedia("(prefers-color-scheme: dark)").matches;
    const luma = (0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3]) / 255;
    return luma < 0.5;
  } catch {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  }
}

function getFieldValue(field: Element): string {
  if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
    return field.value;
  }
  return (field as HTMLElement).innerText ?? "";
}

function detectFieldMaxLength(field: Element): number | undefined {
  if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
    const v = parseInt(field.getAttribute("maxlength") ?? "0") || 0;
    if (v > 0) return v;
  }
  const fieldId = (field as HTMLElement).id;
  if (fieldId) {
    const labelEl = document.querySelector<HTMLElement>(`label[for="${fieldId}"]`);
    if (labelEl) {
      const m = (labelEl.textContent ?? "").match(/\blimit\b[^.]*?\bto\s+(\d+)\s+characters/i);
      if (m) {
        const max = parseInt(m[1]);
        if (max > 0 && max <= 2000) return max;
      }
    }
  }
  const dialogEl = field.closest('[role="dialog"]');
  if (dialogEl) {
    for (const el of Array.from(dialogEl.querySelectorAll("span,small,div,p"))) {
      if (el === field || el.contains(field as Node)) continue;
      const t = (el.textContent ?? "").trim();
      const m = t.match(/^\d+\/(\d+)$/);
      if (m) {
        const max = parseInt(m[1]);
        if (max > 0 && max <= 2000) return max;
      }
    }
  }
  let container: Element | null = field.parentElement;
  for (let i = 0; i < 8 && container && container !== document.body; i++) {
    for (const el of Array.from(container.querySelectorAll("span,small,div,p"))) {
      if (el === field || el.contains(field as Node)) continue;
      const t = (el.textContent ?? "").trim();
      const m = t.match(/^\d+\/(\d+)$/);
      if (m) {
        const max = parseInt(m[1]);
        if (max > 0 && max <= 2000) return max;
      }
    }
    container = container.parentElement;
  }
  return undefined;
}

export function GenerateModal({ field, platform, anchorRect, activeContextCount, onClose, onGenerate, showToast }: Props) {
  const [instruction, setInstruction] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const dark = isPageDark();

  const hasContent = getFieldValue(field).trim().length > 10;

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 30);
  }, []);

  useEffect(() => {
    const input = inputRef.current;
    const modal = modalRef.current;
    if (!input || !modal) return;

    const nativeDialog =
      field instanceof Element ? field.closest("dialog") : null;
    const roleDialog =
      field instanceof Element
        ? field.closest('[role="dialog"]')
        : null;
    const trapContainer = (nativeDialog || roleDialog) as HTMLElement | null;

    let cleanup = () => {};
    try {
      cleanup = setupFocusProtection(input, modal, trapContainer);
    } catch {
      cleanup = () => {};
    }

    const safeFocus = () => {
      try {
        input.focus();
      } catch {
        // Ignore site-specific focus traps.
      }
    };

    const raf = requestAnimationFrame(safeFocus);
    const timer = setTimeout(safeFocus, 30);

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      cleanup();
    };
  }, [field]);

  // Close on outside click — use composedPath() to handle shadow DOM retargeting
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      // composedPath() traverses shadow boundaries; check if modal is in the path
      const path = e.composedPath ? e.composedPath() : [];
      const isInsideModal = modalRef.current && (path.includes(modalRef.current) || path.some((el) => el === modalRef.current));
      if (!isInsideModal) {
        onClose();
      }
    };
    const escHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    setTimeout(() => {
      document.addEventListener("click", handler, true);
      document.addEventListener("keydown", escHandler);
    }, 50);
    return () => {
      document.removeEventListener("click", handler, true);
      document.removeEventListener("keydown", escHandler);
    };
  }, [onClose]);

  // Calculate position (fixed, viewport-relative)
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;
  const MODAL_H_EST = hasContent ? 260 : 180;
  let left = anchorRect.right - MODAL_W;
  let top = anchorRect.bottom + 6;
  if (left < 8) left = 8;
  if (left + MODAL_W > viewportW - 8) left = viewportW - MODAL_W - 8;
  if (top + MODAL_H_EST > viewportH - 8) top = Math.max(8, anchorRect.top - MODAL_H_EST - 6);

  async function runAction(action: string) {
    // For "generate", hand off to FieldButton so the modal closes immediately
    // and the icon shows the spinner — same UX as double-click.
    if (action === "generate") {
      const pageContext = extractPageContext(field);
      const fieldMaxLength = detectFieldMaxLength(field);
      onGenerate({ instruction, pageContext, fieldMaxLength });
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const existingText = getFieldValue(field).slice(0, 2000);
      const pageContext = extractPageContext(field);

      const fieldMaxLength = detectFieldMaxLength(field);

      const payload =
        action === "generate"
          ? { instruction, pageContext, platform, fieldMaxLength }
          : { existingText, instruction: instruction || undefined, platform, fieldMaxLength };

      const response = await chrome.runtime.sendMessage({
        type: "GENERATE",
        action,
        payload,
      });

      if (response?.error) throw new Error(response.error);
      if (response?.text) {
        // Client-side hard truncation — final safety net in case server truncation
        // or fieldMaxLength detection missed the limit.
        let safeText: string = response.text;
        if (fieldMaxLength && fieldMaxLength > 0 && safeText.length > fieldMaxLength) {
          safeText = safeText.slice(0, fieldMaxLength).replace(/\s+\S*$/, "").trim();
        }
        // Close the modal BEFORE inserting so the focus-protection cleanup runs first.
        // That cleanup removes `inert` from LinkedIn's fields and restores the
        // patched HTMLElement.prototype.focus — without this, execCommand fails
        // because the target is inerted, causing Quill to reset the text seconds later.
        onClose();
        showToast("✓ Text inserted");
        setTimeout(() => insertText(field, safeText, platform), 80);
      }
    } catch (err: any) {
      const msg = err.message ?? "Generation failed";
      setError(msg);
      showToast(msg, "error");
    } finally {
      setLoading(false);
    }
  }

  async function captureContext() {
    try {
      const main = document.querySelector<HTMLElement>("main, article, [role='main']") || document.body;
      const text = (main.innerText ?? "")
        .replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 4000);
      if (!text) { showToast("No usable page content found", "error"); return; }
      const url = window.location.href;
      const hostname = window.location.hostname;
      const title = document.title || hostname;
      const id = `ctx_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const entry = { id, title, url, hostname, text, time: Date.now(), active: true };
      const current = await loadContexts();
      const idx = current.findIndex((c) => c.url === url);
      const next = [...current];
      if (idx >= 0) { next[idx] = entry; } else { next.push(entry); }
      await saveContexts(next);
      showToast(`📋 Context saved: ${(title || hostname).slice(0, 35)}`, "info");
      onClose();
    } catch {
      showToast("Failed to capture context", "error");
    }
  }

  function openSettings() {
    try { chrome.runtime.sendMessage({ type: "OPEN_SETTINGS" }); } catch { /* invalidated */ }
    onClose();
  }

  // ── Styles (using inline styles to avoid shadow DOM CSS leakage) ──────────

  const modalStyle: React.CSSProperties = {
    position: "fixed",
    zIndex: 2147483647,
    top: Math.max(top, 8),
    left: Math.max(left, 8),
    width: MODAL_W,
    background: dark ? "#1c1c1e" : "#ffffff",
    border: `1px solid ${dark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.1)"}`,
    borderRadius: 12,
    boxShadow: "0 4px 6px rgba(0,0,0,0.05), 0 10px 30px rgba(0,0,0,0.14)",
    overflow: "hidden",
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
    fontSize: 13,
    pointerEvents: "auto",
    userSelect: "text",
    WebkitUserSelect: "text",
  };

  const inputStyle: React.CSSProperties = {
    width: "100%",
    border: "none",
    borderBottom: `1px solid ${dark ? "rgba(255,255,255,0.08)" : "#f0f0f0"}`,
    padding: "10px 12px",
    fontSize: 13,
    fontFamily: "inherit",
    color: dark ? "#f0f0f0" : "#111",
    background: dark ? "#2c2c2e" : "#fafafa",
    outline: "none",
    boxSizing: "border-box",
    borderRadius: 0,
    cursor: "text",
    userSelect: "text",
  };

  const sepStyle: React.CSSProperties = {
    height: 1,
    background: dark ? "rgba(255,255,255,0.07)" : "#f0f0f0",
    margin: "2px 0",
    flexShrink: 0,
  };

  function makeBtn(variant: "primary" | "secondary" | "settings" | "default") {
    return {
      display: "flex",
      alignItems: "center",
      gap: 8,
      width: "100%",
      padding: "9px 12px",
      border: "none",
      background: "transparent",
      fontSize: variant === "secondary" || variant === "settings" ? 12 : 13,
      fontFamily: "inherit",
      color: dark
        ? variant === "primary" ? "#60a5fa"
          : variant === "settings" ? "#666"
          : "#ccc"
        : variant === "primary" ? "#1d4ed8"
          : variant === "settings" ? "#888"
          : "#333",
      fontWeight: variant === "primary" ? 600 : 400,
      cursor: "pointer",
      textAlign: "left" as const,
      transition: "background 0.1s",
      userSelect: "none" as const,
      WebkitUserSelect: "none" as const,
    };
  }

  function BtnHover({ style, hoverBg, onClick, disabled, children }: {
    style: React.CSSProperties;
    hoverBg: string;
    onClick: () => void;
    disabled?: boolean;
    children: React.ReactNode;
  }) {
    const [hovered, setHovered] = useState(false);
    const swallowPointer = (e: ReactPointerEvent | ReactMouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };
    return (
      <button
        type="button"
        style={{ ...style, background: hovered ? hoverBg : "transparent", opacity: disabled ? 0.5 : 1 }}
        onClick={onClick}
        onPointerDown={swallowPointer}
        onMouseDown={swallowPointer}
        disabled={disabled}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {children}
      </button>
    );
  }

  const hoverBgDefault = dark ? "rgba(255,255,255,0.07)" : "#f5f5f5";
  const hoverBgPrimary = dark ? "rgba(96,165,250,0.12)" : "#eff6ff";

  const mountNode =
    (field instanceof Element ? field.closest("dialog") : null) ??
    document.body ??
    document.documentElement;
  if (!mountNode) return null;

  return createPortal(
    <div ref={modalRef} data-tfa-ui="modal" style={modalStyle}>
      {/* Instruction input */}
      <input
        ref={inputRef}
        type="text"
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            runAction("generate");
          }
          if (e.key === "Escape") onClose();
        }}
        placeholder="Optional instruction..."
        style={{
          ...inputStyle,
          ...(instruction
            ? { background: dark ? "#333" : "#fff", borderBottomColor: dark ? "rgba(255,255,255,0.14)" : "#e0e0e0" }
            : {}),
        }}
      />

      {/* Action buttons */}
      <div style={{ display: "flex", flexDirection: "column" }}>
        {/* Generate */}
        <BtnHover style={makeBtn("primary")} hoverBg={hoverBgPrimary} onClick={() => runAction("generate")} disabled={loading}>
          <span>{loading ? "Generating…" : "Generate"}</span>
        </BtnHover>

        {/* Content-dependent actions */}
        {hasContent && (
          <>
            <BtnHover style={makeBtn("default")} hoverBg={hoverBgDefault} onClick={() => runAction("rewrite")} disabled={loading}>
              <span>Rewrite &amp; improve</span>
            </BtnHover>
            <BtnHover style={makeBtn("default")} hoverBg={hoverBgDefault} onClick={() => runAction("shorten")} disabled={loading}>
              <span>Make shorter</span>
            </BtnHover>
            <BtnHover style={makeBtn("default")} hoverBg={hoverBgDefault} onClick={() => runAction("expand")} disabled={loading}>
              <span>Expand</span>
            </BtnHover>
          </>
        )}

        {/* Separator */}
        <div style={sepStyle} />

        {/* Capture context — hide on canvas (academic mode) */}
        {platform !== "canvas" && (
          <BtnHover style={makeBtn("secondary")} hoverBg={hoverBgDefault} onClick={captureContext}>
            <span>
              {activeContextCount > 0
                ? `Add page · ${activeContextCount} active`
                : "Add page to context"}
            </span>
          </BtnHover>
        )}

        {/* Separator */}
        <div style={sepStyle} />

        {/* Settings */}
        <BtnHover style={makeBtn("settings")} hoverBg={hoverBgDefault} onClick={openSettings}>
          <span>Settings</span>
        </BtnHover>
      </div>

      {/* Error */}
      {error && (
        <div style={{
          padding: "8px 12px",
          fontSize: 12,
          color: "#dc2626",
          background: "#fee2e2",
          borderTop: "1px solid #fecaca",
        }}>
          {error}
        </div>
      )}
    </div>,
    mountNode
  );
}
