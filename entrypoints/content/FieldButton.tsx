import { useState, useEffect, useRef, useCallback } from "react";
import {
  autoUpdate,
  computePosition,
  flip,
  offset,
  shift,
  type Placement,
} from "@floating-ui/dom";
import { GenerateModal } from "./GenerateModal.tsx";
import { getVisibleFieldAnchor } from "../../src/lib/platform.ts";
import { extractPageContext } from "../../src/lib/context.ts";
import type { PlatformKey } from "../../src/lib/platform.ts";
import { insertText } from "../../src/lib/insert-text.ts";

interface Props {
  field: Element;
  platform: PlatformKey;
  activeContextCount: number;
  showToast: (message: string, type?: "success" | "error" | "info") => void;
}

const DOUBLE_CLICK_MS = 280;
const BUTTON_SIZE = 28;

function getPreferredPlacement(_field: Element): Placement {
  // Always anchor to the top-right corner of the field (inside).
  // Negative mainAxis offset in the middleware pushes the button down into the field,
  // matching the reference extension's: top = rect.top + 6, left = rect.right - 32.
  return "top-end";
}

function isRenderableField(field: Element): boolean {
  return getVisibleFieldAnchor(field) !== null;
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
  const [instruction, setInstruction] = useState("");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [logoBroken, setLogoBroken] = useState(false);
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
    setFloating(null);
    setAnchorRect(getVisibleFieldAnchor(field)?.getBoundingClientRect() ?? null);
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
        const reference = getVisibleFieldAnchor(field);
        if (
          cancelled ||
          !button.isConnected ||
          !document.contains(button) ||
          !reference
        ) {
          if (!cancelled) setFloating(null);
          return;
        }

        const placement = getPreferredPlacement(field);
        const { x, y } = await computePosition(reference, button, {
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
          ],
        });

        if (
          cancelled ||
          !button.isConnected ||
          !document.contains(button) ||
          !reference
        ) {
          return;
        }

        // floating-ui's referenceHidden strategy triggers incorrectly on sites
        // like LinkedIn where fields are inside overflow containers (modals/dialogs)
        // even when the field is clearly visible. Use a direct viewport check instead.
        const rect = reference.getBoundingClientRect();
        const inViewport =
          rect.bottom > 0 &&
          rect.top < window.innerHeight &&
          rect.right > 0 &&
          rect.left < window.innerWidth &&
          rect.width > 0 &&
          rect.height > 0;
        setFloating({ x, y, visible: inViewport });
        setAnchorRect(makeAnchorRect(x, y));
      } catch {
        if (cancelled) return;
        setFloating(null);
        setAnchorRect(getVisibleFieldAnchor(field)?.getBoundingClientRect() ?? null);
      }
    };

    let cleanup = () => {};
    try {
      const reference = getVisibleFieldAnchor(field);
      if (!reference) {
        setFloating(null);
        return () => {};
      }
      cleanup = autoUpdate(reference, button, () => {
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
  // Always inserts directly into the field without a preview step.
  const handleGenerate = useCallback(async (opts: {
    instruction: string;
    pageContext?: string;
    fieldMaxLength?: number;
    tone?: number;
    domain?: string;
  }) => {
    setShowModal(false);
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
        setTimeout(() => insertText(field, response.text, platform), 80);
        setSuccess(true);
        showToast("✓ Text inserted");
        setTimeout(() => setSuccess(false), 1500);
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
      if (!loading) void handleGenerate({ instruction: "" });
    };
    field.addEventListener("tfa-quick-generate", handler);
    return () => field.removeEventListener("tfa-quick-generate", handler);
  }, [field, loading, handleGenerate]);

  const handleClick = useCallback(() => {
    if (loading) return;
    clickCount.current += 1;
    if (clickTimer.current) clearTimeout(clickTimer.current);

    clickTimer.current = setTimeout(() => {
      const count = clickCount.current;
      clickCount.current = 0;

      if (count >= 2) {
        // Double-click: generate and insert directly (no modal)
        void handleGenerate({ instruction: "" });
      } else {
        // Single click: open modal for optional instruction + tone/domain settings
        setShowModal(true);
      }
    }, DOUBLE_CLICK_MS);
  }, [loading, handleGenerate]);

  const isVisible = floating?.visible ?? false;
  const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;

  const btnStyle: React.CSSProperties = {
    position: "fixed",
    top: floating?.y ?? -9999,
    left: floating?.x ?? -9999,
    zIndex: 2147483647,
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    padding: 0,
    border: `1px solid ${isDark ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.1)"}`,
    borderRadius: "50%",
    background: isDark ? "rgba(12,12,12,0.97)" : "rgba(255,255,255,0.97)",
    cursor: loading ? "wait" : "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxShadow: isDark
      ? "0 1px 4px rgba(0,0,0,0.5), 0 0 0 0.5px rgba(255,255,255,0.05)"
      : "0 1px 4px rgba(0,0,0,0.10), 0 0 0 0.5px rgba(0,0,0,0.06)",
    overflow: "hidden",
    transition: "transform 0.12s ease, opacity 0.12s ease",
    pointerEvents: isVisible ? "auto" : "none",
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
            e.currentTarget.style.transform = "scale(1.1)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = "scale(1)";
          }}
        >
          {!logoBroken ? (
            <img
              src={logoUrl}
              alt="Text Fill"
              onError={() => setLogoBroken(true)}
              style={{
                width: BUTTON_SIZE,
                height: BUTTON_SIZE,
                objectFit: "cover",
                borderRadius: "50%",
                display: "block",
              }}
            />
          ) : (
            <span
              style={{
                width: BUTTON_SIZE,
                height: BUTTON_SIZE,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: "50%",
                fontSize: 11,
                lineHeight: 1,
                fontWeight: 700,
                color: isDark ? "#f0f0f0" : "#0a0a0a",
                fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
              }}
            >
              TF
            </span>
          )}

          {loading && (
            <div style={{
              position: "absolute",
              top: 0, left: 0,
              width: BUTTON_SIZE, height: BUTTON_SIZE,
              borderRadius: "50%",
              background: isDark ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.55)",
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
              background: "rgba(22,163,74,0.9)",
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
              background: isDark ? "#f0f0f0" : "#0a0a0a",
              border: "2px solid #fff",
              borderRadius: 5,
              pointerEvents: "none",
              zIndex: 1,
              fontSize: 7,
              fontWeight: 700,
              color: isDark ? "#0a0a0a" : "#fff",
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

      {showModal && anchorRect && (
        <GenerateModal
          field={field}
          platform={platform}
          anchorRect={anchorRect}
          activeContextCount={activeContextCount}
          instruction={instruction}
          onInstructionChange={setInstruction}
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
