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
import { sessionObserver, getFieldText } from "../../src/lib/session-observer.ts";

interface Props {
  field: Element;
  platform: PlatformKey;
  activeContextCount: number;
  showToast: (message: string, type?: "success" | "error" | "info") => void;
}

const DOUBLE_CLICK_MS = 280;
const BUTTON_SIZE = 28;

function getPreferredPlacement(_field: Element): Placement {
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

  const handleGenerate = useCallback(async (opts: {
    instruction: string;
    pageContext?: string;
    fieldMaxLength?: number;
    tone?: number;
    domain?: string;
  }) => {
    setShowModal(false);
    setLoading(true);
    // Snapshot pre-AI text before the network round-trip
    sessionObserver.onGenerationStart(field);
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
        setTimeout(() => {
          insertText(field, response.text, platform);
          setTimeout(() => {
            sessionObserver.onGenerationComplete(field, getFieldText(field));
          }, 120);
        }, 80);
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
        void handleGenerate({ instruction: "" });
      } else {
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
    border: `1px solid ${isDark ? "#333333" : "#e5e5e5"}`,
    borderRadius: "50%",
    background: isDark ? "#000000" : "#ffffff",
    cursor: loading ? "wait" : "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxShadow: isDark
      ? "0 2px 8px rgba(0,0,0,0.6)"
      : "0 2px 8px rgba(0,0,0,0.15)",
    overflow: "hidden",
    transition: "transform 0.15s ease, opacity 0.15s ease, box-shadow 0.15s ease",
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
            e.currentTarget.style.boxShadow = isDark
              ? "0 4px 12px rgba(0,0,0,0.8)"
              : "0 4px 12px rgba(0,0,0,0.2)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = "scale(1)";
            e.currentTarget.style.boxShadow = isDark
              ? "0 2px 8px rgba(0,0,0,0.6)"
              : "0 2px 8px rgba(0,0,0,0.15)";
          }}
        >
          {!logoBroken ? (
            <img
              src={logoUrl}
              alt="CheatResume"
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
                fontWeight: 800,
                color: isDark ? "#ffffff" : "#000000",
                fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
              }}
            >
              CR
            </span>
          )}

          {loading && (
            <div style={{
              position: "absolute",
              top: 0, left: 0,
              width: BUTTON_SIZE, height: BUTTON_SIZE,
              borderRadius: "50%",
              background: isDark ? "rgba(0,0,0,0.7)" : "rgba(255,255,255,0.7)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}>
              <svg
                style={{ width: 14, height: 14, color: isDark ? "#fff" : "#000" }}
                viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
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
              background: isDark ? "#ffffff" : "#000000",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}>
              <svg style={{ width: 14, height: 14, color: isDark ? "#000" : "#fff" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
          )}

          {activeContextCount > 0 && !loading && !success && (
            <div style={{
              position: "absolute",
              bottom: -2, right: -2,
              minWidth: 10, height: 10,
              background: isDark ? "#ffffff" : "#000000",
              border: `2px solid ${isDark ? "#000" : "#fff"}`,
              borderRadius: 6,
              pointerEvents: "none",
              zIndex: 1,
              fontSize: 7,
              fontWeight: 800,
              color: isDark ? "#1c1917" : "#ffffff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "0 2px",
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

      <style>{`@keyframes tfa-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </>
  );
}
