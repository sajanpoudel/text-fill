import {
  useState,
  useRef,
  useEffect,
} from "react";
import { createPortal } from "react-dom";
import { insertText } from "../../src/lib/insert-text.ts";
import { sessionObserver, getFieldText } from "../../src/lib/session-observer.ts";
import { extractPageContext } from "../../src/lib/context.ts";
import { loadContexts, saveContexts } from "./ContextFAB.tsx";
import { isPageDark } from "../../src/lib/dom/theme.ts";
import type { PlatformKey } from "../../src/lib/platform.ts";

interface Props {
  field: Element;
  platform: PlatformKey;
  anchorRect: DOMRect;
  activeContextCount: number;
  instruction: string;
  onInstructionChange: (v: string) => void;
  onClose: () => void;
  onGenerate: (opts: { instruction: string; pageContext?: string; fieldMaxLength?: number; tone?: number; domain?: string }) => void;
  showToast: (message: string, type?: "success" | "error" | "info") => void;
}

const MODAL_W = 280;

function setupFocusProtection(
  instructionInput: HTMLElement,
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

const TONE_LABELS: Record<number, string> = {
  1: "Casual",
  2: "Informal",
  3: "Balanced",
  4: "Professional",
  5: "Formal",
};

const DOMAINS = ["general", "sales", "legal", "technical", "academic"] as const;
type Domain = typeof DOMAINS[number];

export function GenerateModal({ field, platform, anchorRect, activeContextCount, instruction, onInstructionChange, onClose, onGenerate, showToast }: Props) {
  const [tone, setTone] = useState(3);
  const [domain, setDomain] = useState<Domain>("general");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const isDark = isPageDark();
  const hasContent = getFieldValue(field).trim().length > 10;

  // ── Colours ──────────────────────────────────────────────────────────────────
  const bg       = isDark ? "#0A0A0A" : "#ffffff";
  const border   = isDark ? "#333333" : "#e5e5e5";
  const text     = isDark ? "#ffffff" : "#000000";
  const textSub  = isDark ? "#888888" : "#666666";
  const textMuted = isDark ? "#555555" : "#999999";
  const divider  = isDark ? "#222222" : "#f0f0f0";
  const hoverBg  = isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.04)";

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
      try { input.focus(); } catch { /* ignore site focus traps */ }
    };

    const raf = requestAnimationFrame(safeFocus);
    const timer = setTimeout(safeFocus, 30);

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      cleanup();
    };
  }, [field]);

  // Outside click: mousedown bubble phase + contains
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const escHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    setTimeout(() => {
      document.addEventListener("mousedown", handler);
      document.addEventListener("keydown", escHandler);
    }, 50);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", escHandler);
    };
  }, [onClose]);

  // Position
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;
  const MODAL_H_EST = hasContent ? 280 : 230;
  let left = anchorRect.right - MODAL_W;
  let top = anchorRect.bottom + 6;
  if (left < 8) left = 8;
  if (left + MODAL_W > viewportW - 8) left = viewportW - MODAL_W - 8;
  if (top + MODAL_H_EST > viewportH - 8) top = Math.max(8, anchorRect.top - MODAL_H_EST - 6);
  const maxModalH = viewportH - Math.max(top, 8) - 8;

  async function runAction(action: string) {
    if (action === "generate") {
      const pageContext = extractPageContext(field);
      const fieldMaxLength = detectFieldMaxLength(field);
      onGenerate({ instruction, pageContext, fieldMaxLength, tone, domain });
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

      sessionObserver.onGenerationStart(field);
      const response = await chrome.runtime.sendMessage({
        type: "GENERATE",
        action,
        payload,
      });

      if (response?.error) throw new Error(response.error);
      if (response?.text) {
        let safeText: string = response.text;
        if (fieldMaxLength && fieldMaxLength > 0 && safeText.length > fieldMaxLength) {
          safeText = safeText.slice(0, fieldMaxLength).replace(/\s+\S*$/, "").trim();
        }
        onClose();
        showToast("✓ Text inserted");
        setTimeout(() => {
          insertText(field, safeText, platform);
          setTimeout(() => {
            sessionObserver.onGenerationComplete(field, getFieldText(field));
          }, 120);
        }, 80);
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

  const stopDown = (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); };

  const mountNode =
    (field instanceof Element ? field.closest("dialog") : null) ??
    document.body ??
    document.documentElement;
  if (!mountNode) return null;

  return createPortal(
    <div
      ref={modalRef}
      data-tfa-ui="modal"
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: "fixed",
        zIndex: 2147483647,
        top: Math.max(top, 8),
        left: Math.max(left, 8),
        width: MODAL_W,
        maxHeight: maxModalH,
        background: bg,
        border: `1px solid ${border}`,
        borderRadius: 8,
        boxShadow: `0 8px 30px rgba(0,0,0,${isDark ? "0.6" : "0.15"}), 0 0 0 1px ${border}`,
        fontFamily: `system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`,
        fontSize: 13,
        overflow: "hidden",
        pointerEvents: "auto",
        userSelect: "text",
        WebkitUserSelect: "text",
      }}
    >
      {/* ── Instruction textarea with integrated Send button ── */}
      <div style={{ position: "relative", borderBottom: `1px solid ${divider}` }}>
        <textarea
          ref={inputRef}
          value={instruction}
          rows={2}
          onChange={(e) => onInstructionChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); runAction("generate"); }
            if (e.key === "Escape") onClose();
          }}
          placeholder="Instruction… (Enter to generate)"
          style={{
            display: "block",
            width: "100%",
            boxSizing: "border-box",
            padding: "14px 44px 14px 14px",
            fontSize: 14,
            fontWeight: 500,
            lineHeight: 1.5,
            border: "none",
            background: "transparent",
            color: text,
            resize: "none",
            outline: "none",
            fontFamily: "inherit",
            letterSpacing: "-0.2px",
          }}
        />
        <button
          type="button"
          onClick={() => runAction("generate")}
          onMouseDown={stopDown}
          disabled={loading}
          style={{
            position: "absolute",
            right: 8,
            bottom: 8,
            width: 30,
            height: 30,
            borderRadius: 4,
            background: isDark ? "#ffffff" : "#000000",
            color: isDark ? "#000000" : "#ffffff",
            border: "none",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: loading ? "wait" : "pointer",
            opacity: loading ? 0.5 : 1,
            transition: "opacity 0.2s",
          }}
        >
          {loading ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M21 12a9 9 0 1 1-6.219-8.56" style={{ animation: "tfa-spin 0.85s linear infinite", transformOrigin: "center" }} />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="19" x2="12" y2="5" />
              <polyline points="5 12 12 5 19 12" />
            </svg>
          )}
        </button>
      </div>

      {/* ── Secondary content actions (if existing content) ── */}
      {hasContent && (
        <div style={{ padding: "10px 14px 4px", display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
          {(["rewrite", "shorten", "expand"] as const).map((action) => (
            <button
              key={action}
              type="button"
              onClick={() => runAction(action)}
              onMouseDown={stopDown}
              disabled={loading}
              style={{
                padding: "6px 0",
                border: `1px solid ${border}`,
                borderRadius: 4,
                background: "transparent",
                color: textSub,
                fontSize: 12,
                fontWeight: 600,
                fontFamily: "inherit",
                cursor: loading ? "wait" : "pointer",
                opacity: loading ? 0.5 : 1,
                textAlign: "center",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = hoverBg)}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              {action === "rewrite" ? "Rewrite" : action === "shorten" ? "Shorter" : "Expand"}
            </button>
          ))}
        </div>
      )}

      {/* ── Settings: tone + domain ── */}
      <div style={{ padding: hasContent ? "10px 14px 14px" : "14px", display: "flex", flexDirection: "column", gap: 14 }}>
        {/* Tone Segmented Control */}
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, userSelect: "none" }}>
            <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", color: textMuted, letterSpacing: "0.5px" }}>Tone</span>
            <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", color: textSub }}>{TONE_LABELS[tone]}</span>
          </div>
          <div style={{ display: "flex", gap: 2 }}>
            {[1, 2, 3, 4, 5].map((t) => (
              <button
                key={t}
                type="button"
                onMouseDown={stopDown}
                onClick={() => setTone(t)}
                style={{
                  flex: 1,
                  height: 24,
                  border: `1px solid ${border}`,
                  background: tone === t ? text : "transparent",
                  color: tone === t ? bg : textMuted,
                  borderRadius: 2,
                  cursor: "pointer",
                  fontSize: 11,
                  fontWeight: 700,
                  transition: "background 0.1s, color 0.1s",
                }}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        {/* Domain chips */}
        <div>
          <div style={{ marginBottom: 6, fontSize: 10, fontWeight: 700, textTransform: "uppercase", color: textMuted, letterSpacing: "0.5px", userSelect: "none" }}>
            Domain
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {DOMAINS.map((d) => (
              <button
                key={d}
                type="button"
                onPointerDown={stopDown}
                onMouseDown={stopDown}
                onClick={() => setDomain(d)}
                style={{
                  padding: "4px 8px",
                  borderRadius: 4,
                  fontSize: 11,
                  fontFamily: "inherit",
                  border: domain === d ? "none" : `1px solid ${border}`,
                  background: domain === d ? (isDark ? "#fff" : "#000") : "transparent",
                  color: domain === d ? (isDark ? "#000" : "#fff") : textSub,
                  cursor: "pointer",
                  fontWeight: 600,
                  userSelect: "none",
                  transition: "all 0.1s",
                }}
              >
                {d.charAt(0).toUpperCase() + d.slice(1)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Footer ── */}
      <div style={{
        borderTop: `1px solid ${divider}`,
        padding: "8px 14px",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
      }}>
        {platform !== "canvas" ? (
          <button
            type="button"
            onClick={captureContext}
            onMouseDown={stopDown}
            style={{ background: "none", border: "none", padding: "4px 0", fontSize: 11, fontWeight: 600, color: textSub, cursor: "pointer", fontFamily: "inherit" }}
            onMouseEnter={(e) => (e.currentTarget.style.color = text)}
            onMouseLeave={(e) => (e.currentTarget.style.color = textSub)}
          >
            {activeContextCount > 0 ? `+ Context (${activeContextCount})` : "+ Add context"}
          </button>
        ) : <span />}
        <button
          type="button"
          onClick={openSettings}
          onMouseDown={stopDown}
          style={{ background: "none", border: "none", padding: "4px 0", fontSize: 11, fontWeight: 600, color: textSub, cursor: "pointer", fontFamily: "inherit" }}
          onMouseEnter={(e) => (e.currentTarget.style.color = text)}
          onMouseLeave={(e) => (e.currentTarget.style.color = textSub)}
        >
          Settings
        </button>
      </div>

      {/* ── Error ── */}
      {error && (
        <div style={{ fontSize: 12, fontWeight: 600, color: "#000", background: "#f0f0f0", borderTop: `1px solid ${border}`, padding: "8px 14px" }}>
          {error}
        </div>
      )}
      <style>{`@keyframes tfa-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>,
    mountNode
  );
}
