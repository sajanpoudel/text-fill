import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { getVisibleFieldAnchor } from "../../src/lib/platform.ts";

interface Props {
  text: string;
  field: Element;
  onAccept: () => void;
  onDismiss: () => void;
  onOptions: () => void;
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

export function SuggestionPreview({ text, field, onAccept, onDismiss, onOptions }: Props) {
  const dark = isPageDark();
  const cardRef = useRef<HTMLDivElement>(null);

  // Lock position on mount — computed once so touchpad/mouse movement can't shift it.
  const posRef = useRef<{ top: number; left: number; maxH: number } | null>(null);
  if (!posRef.current) {
    const anchor = getVisibleFieldAnchor(field) ?? field;
    const CARD_W = 340;
    const MIN_H = 160; // minimum usable card height
    const MARGIN = 8;
    const rect = anchor.getBoundingClientRect();
    const vh = window.innerHeight;
    const vw = window.innerWidth;

    // Horizontal: align to field left, clamp inside viewport
    let left = rect.left;
    if (left + CARD_W > vw - MARGIN) left = vw - CARD_W - MARGIN;
    if (left < MARGIN) left = MARGIN;

    // Vertical: prefer below the field; flip above when more space is available there
    const spaceBelow = vh - rect.bottom - MARGIN;
    const spaceAbove = rect.top - MARGIN;
    let top: number;
    let maxH: number;
    if (spaceBelow >= MIN_H && spaceBelow >= spaceAbove) {
      top = rect.bottom + MARGIN;
      maxH = spaceBelow;
    } else if (spaceAbove >= MIN_H) {
      maxH = spaceAbove;
      top = rect.top - maxH - MARGIN;
    } else {
      // Neither side has much room — use whichever is larger
      if (spaceBelow >= spaceAbove) {
        top = rect.bottom + MARGIN;
        maxH = spaceBelow;
      } else {
        maxH = spaceAbove;
        top = MARGIN;
      }
    }
    // Cap at a sensible max and never exceed viewport
    maxH = Math.min(maxH, 520);
    top = Math.max(MARGIN, top);

    posRef.current = { top, left, maxH };
  }
  const { top, left, maxH } = posRef.current!;

  // Keyboard shortcuts: Enter = accept, Esc = dismiss
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        onAccept();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onDismiss();
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [onAccept, onDismiss]);

  // No click-outside dismiss — the card only closes via Accept, Dismiss, or Options buttons.

  const mountNode = document.body ?? document.documentElement;

  return createPortal(
    <div
      ref={cardRef}
      data-tfa-ui="preview"
      style={{
        position: "fixed",
        top,
        left,
        width: 340,
        maxHeight: maxH,
        zIndex: 2147483647,
        background: dark ? "#1c1c1e" : "#ffffff",
        border: `1px solid ${dark ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.1)"}`,
        borderRadius: 12,
        boxShadow: "0 8px 32px rgba(0,0,0,0.22), 0 2px 10px rgba(0,0,0,0.1)",
        fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
        fontSize: 13,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        animation: "tfa-fadein 0.18s ease",
        pointerEvents: "auto",
      }}
    >
      {/* Text preview */}
      <div
        style={{
          padding: "12px 14px 10px",
          overflowY: "auto",
          flex: 1,
          minHeight: 0,
          color: dark ? "#e5e5e7" : "#1a1a1a",
          lineHeight: 1.6,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          userSelect: "text",
          WebkitUserSelect: "text",
          flexShrink: 1,
        }}
      >
        {text}
      </div>

      {/* Action bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "7px 10px",
          borderTop: `1px solid ${dark ? "rgba(255,255,255,0.07)" : "#f0f0f0"}`,
          background: dark ? "#242426" : "#fafafa",
          flexShrink: 0,
          gap: 6,
        }}
      >
        <span
          style={{
            fontSize: 10.5,
            color: dark ? "rgba(255,255,255,0.28)" : "rgba(0,0,0,0.32)",
            userSelect: "none",
            WebkitUserSelect: "none",
          }}
        >
          ↵ Accept · Esc Dismiss
        </span>

        <div style={{ display: "flex", gap: 5, flexShrink: 0 }}>
          <PreviewBtn dark={dark} onClick={onDismiss} variant="ghost">
            Dismiss
          </PreviewBtn>
          <PreviewBtn dark={dark} onClick={onOptions} variant="outline">
            Options
          </PreviewBtn>
          <PreviewBtn dark={dark} onClick={onAccept} variant="primary">
            Accept ✓
          </PreviewBtn>
        </div>
      </div>
    </div>,
    mountNode
  );
}

function PreviewBtn({
  dark,
  onClick,
  variant,
  children,
}: {
  dark: boolean;
  onClick: () => void;
  variant: "ghost" | "outline" | "primary";
  children: React.ReactNode;
}) {
  const [hov, setHov] = useState(false);

  const base: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    padding: "4px 10px",
    border: "none",
    borderRadius: 6,
    fontSize: 12,
    fontFamily: "inherit",
    cursor: "pointer",
    transition: "all 0.12s",
    userSelect: "none",
    WebkitUserSelect: "none",
    fontWeight: 500,
  };

  const variantStyle: React.CSSProperties =
    variant === "primary"
      ? {
          background: hov ? "#16a34a" : "#22c55e",
          color: "#fff",
          fontWeight: 600,
        }
      : variant === "outline"
      ? {
          background: hov
            ? dark
              ? "rgba(255,255,255,0.08)"
              : "#ebebeb"
            : "transparent",
          color: dark ? "#bbb" : "#555",
          border: `1px solid ${dark ? "rgba(255,255,255,0.14)" : "#d0d0d0"}`,
        }
      : {
          background: "transparent",
          color: hov ? "#ef4444" : dark ? "#666" : "#999",
        };

  return (
    <button
      type="button"
      data-tfa-ui="preview-btn"
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{ ...base, ...variantStyle }}
    >
      {children}
    </button>
  );
}
