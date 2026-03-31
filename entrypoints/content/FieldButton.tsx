import { useState, useEffect, useRef, useCallback } from "react";
import {
  autoUpdate,
  computePosition,
  flip,
  hide,
  offset,
  shift,
  type Placement,
} from "@floating-ui/dom";
import { GenerateModal } from "./GenerateModal.tsx";
import { SuggestionPreview } from "./SuggestionPreview.tsx";
import { extractPageContext } from "../../src/lib/platform";
import type { PlatformKey } from "../../src/lib/platform";
import { insertText } from "../../src/lib/insert-text";

interface Props {
  field: Element;
  platform: PlatformKey;
  activeContextCount: number;
  showToast: (message: string, type?: "success" | "error" | "info") => void;
}

const DOUBLE_CLICK_MS = 280;
const BUTTON_SIZE = 30;

function getPreferredPlacement(_field: Element): Placement {
  // Always anchor to the top-right corner of the field (inside).
  // Negative mainAxis offset in the middleware pushes the button down into the field,
  // matching the reference extension's: top = rect.top + 6, left = rect.right - 32.
  return "top-end";
}

function isRenderableField(field: Element): boolean {
  if (!document.contains(field)) return false;
  const el = field as HTMLElement;
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") {
    return false;
  }
  const rect = field.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function makeAnchorRect(x: number, y: number): DOMRect {
  if (typeof DOMRect === "function") {
    return new DOMRect(x, y, BUTTON_SIZE, BUTTON_SIZE);
  }
  return {
    x,
    y,
    top: y,
    left: x,
    right: x + BUTTON_SIZE,
    bottom: y + BUTTON_SIZE,
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    toJSON: () => ({}),
  } as DOMRect;
}

export function FieldButton({ field, platform, activeContextCount, showToast }: Props) {
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [floating, setFloating] = useState<{
    x: number;
    y: number;
    visible: boolean;
  } | null>(null);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clickCount = useRef(0);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const logoUrl = (() => { try { return chrome.runtime.getURL("logo.png"); } catch { return ""; } })();

  useEffect(() => {
    setShowModal(false);
    setLoading(false);
    setSuccess(false);
    setPreviewText(null);
    setFloating(null);
    setAnchorRect(
      isRenderableField(field) ? field.getBoundingClientRect() : null
    );
  }, [field]);

  useEffect(() => {
    return () => {
      if (clickTimer.current) clearTimeout(clickTimer.current);
    };
  }, []);

  useEffect(() => {
    const button = buttonRef.current;
    if (!button || showModal) return;

    let cancelled = false;

    const update = async () => {
      try {
        if (
          cancelled ||
          !button.isConnected ||
          !document.contains(button) ||
          !isRenderableField(field)
        ) {
          if (!cancelled) setFloating(null);
          return;
        }

        const placement = getPreferredPlacement(field);
        const { x, y, middlewareData } = await computePosition(field, button, {
          strategy: "fixed",
          placement,
          middleware: [
            // Negative mainAxis pushes the button DOWN from above the field's top edge
            // into the field's top-right corner — mirrors the reference extension's
            // positioning: top = field.top + 6, left = field.right - 32.
            offset({ mainAxis: -(BUTTON_SIZE + 6), crossAxis: -4 }),
            flip({
              padding: 8,
              fallbackPlacements: ["bottom-end", "top-start", "bottom-start"],
            }),
            shift({ padding: 8 }),
            hide({ strategy: "referenceHidden" }),
          ],
        });

        if (
          cancelled ||
          !button.isConnected ||
          !document.contains(button) ||
          !isRenderableField(field)
        ) {
          return;
        }

        const hidden = middlewareData.hide?.referenceHidden === true;
        setFloating({ x, y, visible: !hidden });
        setAnchorRect(makeAnchorRect(x, y));
      } catch {
        if (cancelled) return;
        setFloating(null);
        setAnchorRect(isRenderableField(field) ? field.getBoundingClientRect() : null);
      }
    };

    let cleanup = () => {};
    try {
      cleanup = autoUpdate(field, button, () => {
        void update();
      });
      void update();
    } catch {
      setFloating(null);
    }

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [field, showModal]);

  // Shared generate handler — used by click, double-click, keyboard shortcut, and modal.
  // insertDirectly: true → inserts immediately (double-click/keyboard)
  // insertDirectly: false/undefined → shows preview card (single-click/modal)
  const handleGenerate = useCallback(async (opts: {
    instruction: string;
    pageContext?: string;
    fieldMaxLength?: number;
    tone?: number;
    domain?: string;
    insertDirectly?: boolean;
  }) => {
    setShowModal(false);
    setPreviewText(null);
    setLoading(true);
    try {
      const pageContext = opts.pageContext ?? extractPageContext(field);
      const response = await chrome.runtime.sendMessage({
        type: "GENERATE",
        action: "generate",
        payload: {
          instruction: opts.instruction,
          pageContext,
          platform,
          fieldMaxLength: opts.fieldMaxLength,
          tone: opts.tone,
          domain: opts.domain,
        },
      });
      if (response?.error) throw new Error(response.error);
      if (response?.text) {
        if (opts.insertDirectly) {
          // Double-click / keyboard shortcut: insert directly, show success
          setTimeout(() => insertText(field, response.text, platform), 80);
          setSuccess(true);
          showToast("✓ Text inserted");
          setTimeout(() => setSuccess(false), 1500);
        } else {
          // Single-click / modal Generate: show preview card
          setPreviewText(response.text);
        }
      }
    } catch (err: any) {
      showToast(err?.message ?? "Generation failed", "error");
    } finally {
      setLoading(false);
    }
  }, [field, platform, showToast]);

  // Listen for Alt+Shift+G quick-generate custom event dispatched by App.tsx
  useEffect(() => {
    const handler = () => {
      if (!loading) void handleGenerate({ instruction: "", insertDirectly: true });
    };
    field.addEventListener("tfa-quick-generate", handler);
    return () => field.removeEventListener("tfa-quick-generate", handler);
  }, [field, loading, handleGenerate]);

  const handleClick = useCallback(() => {
    if (loading) return;
    // Clicking the icon while preview is showing dismisses the preview
    if (previewText !== null) {
      setPreviewText(null);
      return;
    }
    clickCount.current += 1;
    if (clickTimer.current) clearTimeout(clickTimer.current);

    clickTimer.current = setTimeout(async () => {
      const count = clickCount.current;
      clickCount.current = 0;

      if (count >= 2) {
        // Double-click: generate and insert directly (no preview)
        void handleGenerate({ instruction: "", insertDirectly: true });
      } else {
        // Single click: generate and show preview card
        void handleGenerate({ instruction: "" });
      }
    }, DOUBLE_CLICK_MS);
  }, [loading, handleGenerate, previewText]);

  const isVisible = floating?.visible ?? false;

  const btnStyle: React.CSSProperties = {
    position: "fixed",
    top: floating?.y ?? -9999,
    left: floating?.x ?? -9999,
    zIndex: 2147483647,
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    padding: 0,
    border: "1px solid rgba(148,163,184,0.28)",
    borderRadius: "50%",
    background: window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "rgba(15,23,42,0.94)"
      : "rgba(255,255,255,0.96)",
    cursor: loading ? "wait" : "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxShadow: "0 8px 24px rgba(15,23,42,0.18), 0 2px 8px rgba(15,23,42,0.12)",
    overflow: "visible",
    transition: "transform 0.15s ease, box-shadow 0.15s ease, opacity 0.15s ease",
    pointerEvents: isVisible ? "auto" : "none",
    backdropFilter: "blur(10px)",
    opacity: isVisible ? 1 : 0,
  };

  return (
    <>
      {!showModal && (
        <button
          ref={buttonRef}
          type="button"
          style={btnStyle}
          onClick={handleClick}
          onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
          disabled={loading}
          title="Click: generate · Double-click: instant insert · Alt+Shift+G: quick generate"
          onMouseEnter={(e) => {
            e.currentTarget.style.transform = "scale(1.12)";
            e.currentTarget.style.boxShadow = "0 10px 30px rgba(15,23,42,0.24), 0 4px 14px rgba(15,23,42,0.18)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = "scale(1)";
            e.currentTarget.style.boxShadow = "0 8px 24px rgba(15,23,42,0.18), 0 2px 8px rgba(15,23,42,0.12)";
          }}
        >
          <img
            src={logoUrl}
            alt="Text Fill"
            style={{
              width: BUTTON_SIZE,
              height: BUTTON_SIZE,
              objectFit: "cover",
              borderRadius: "50%",
              display: "block",
            }}
          />

          {loading && (
            <div style={{
              position: "absolute",
              top: 0, left: 0,
              width: BUTTON_SIZE, height: BUTTON_SIZE,
              borderRadius: "50%",
              background: "rgba(0,0,0,0.6)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}>
              <svg
                style={{ width: 16, height: 16, color: "white" }}
                viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              >
                <path
                  d="M21 12a9 9 0 1 1-6.219-8.56"
                  style={{ animation: "tfa-spin 0.85s linear infinite", transformOrigin: "center" }}
                />
              </svg>
            </div>
          )}

          {success && (
            <div style={{
              position: "absolute",
              top: 0, left: 0,
              width: BUTTON_SIZE, height: BUTTON_SIZE,
              borderRadius: "50%",
              background: "rgba(16,185,129,0.92)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}>
              <svg style={{ width: 16, height: 16, color: "white" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
          )}

          {activeContextCount > 0 && !loading && !success && (
            <div style={{
              position: "absolute",
              bottom: -2, right: -2,
              minWidth: 9, height: 9,
              background: "#3b82f6",
              border: "2px solid #fff",
              borderRadius: 5,
              pointerEvents: "none",
              zIndex: 1,
              fontSize: 7,
              fontWeight: 700,
              color: "#fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "0 1px",
              boxSizing: "border-box",
            }}>
              {activeContextCount > 1 ? String(activeContextCount) : ""}
            </div>
          )}
        </button>
      )}

      {/* Suggestion preview card (single-click generate result) */}
      {previewText !== null && (
        <SuggestionPreview
          text={previewText}
          field={field}
          onAccept={() => {
            const text = previewText;
            setPreviewText(null);
            setTimeout(() => insertText(field, text, platform), 80);
            setSuccess(true);
            showToast("✓ Text inserted");
            setTimeout(() => setSuccess(false), 1500);
          }}
          onDismiss={() => setPreviewText(null)}
          onOptions={() => {
            setPreviewText(null);
            setShowModal(true);
          }}
        />
      )}

      {showModal && anchorRect && (
        <GenerateModal
          field={field}
          platform={platform}
          anchorRect={anchorRect}
          activeContextCount={activeContextCount}
          onClose={() => setShowModal(false)}
          onGenerate={handleGenerate}
          showToast={showToast}
        />
      )}

      {/* Keyframe for spin animation */}
      <style>{`@keyframes tfa-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </>
  );
}
