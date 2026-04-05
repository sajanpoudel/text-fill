import { useState } from "react";
import type { LinkedInSearchResult } from "../../src/lib/platforms/linkedin.ts";

interface Props {
  results: LinkedInSearchResult[];
  onOpenQueue: (results: LinkedInSearchResult[]) => void;
}

/**
 * Floating chip that appears on LinkedIn search pages when Connect-able
 * profiles are found. Clicking it opens the QueuePreviewPanel.
 */
export function SuggestionChip({ results, onOpenQueue }: Props) {
  const [hovered, setHovered] = useState(false);
  const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const count = results.length;

  if (count === 0) return null;

  const chipStyle: React.CSSProperties = {
    position: "fixed",
    bottom: 88,
    right: 20,
    zIndex: 2147483647,
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 14px",
    borderRadius: 24,
    background: isDark ? "#000000" : "#ffffff",
    border: `1px solid ${isDark ? "#333333" : "#e5e5e5"}`,
    boxShadow: hovered
      ? isDark
        ? "0 6px 20px rgba(0,0,0,0.8)"
        : "0 6px 20px rgba(0,0,0,0.2)"
      : isDark
        ? "0 2px 10px rgba(0,0,0,0.6)"
        : "0 2px 10px rgba(0,0,0,0.12)",
    cursor: "pointer",
    transform: hovered ? "scale(1.03)" : "scale(1)",
    transition: "transform 0.15s ease, box-shadow 0.15s ease",
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
    fontSize: 13,
    fontWeight: 600,
    color: isDark ? "#fcfcfb" : "#1c1917",
    userSelect: "none",
  };

  const dotStyle: React.CSSProperties = {
    width: 8,
    height: 8,
    borderRadius: "50%",
    background: isDark ? "#fcfcfb" : "#1c1917",
    flexShrink: 0,
  };

  return (
    <button
      type="button"
      data-tfa-ui="suggestion-chip"
      style={chipStyle}
      onClick={() => onOpenQueue(results)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <span style={dotStyle} />
      Connect with {count} recruiter{count !== 1 ? "s" : ""}
    </button>
  );
}
