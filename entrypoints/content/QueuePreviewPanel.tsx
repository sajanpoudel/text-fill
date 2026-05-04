import { useState } from "react";
import type { LinkedInSearchResult } from "../../src/lib/platforms/linkedin.ts";

interface Props {
  results: LinkedInSearchResult[];
  onClose: () => void;
  onEnqueue: (selected: LinkedInSearchResult[], dailyLimit: number) => void;
  showToast: (message: string, type?: "success" | "error" | "info") => void;
}

const DAILY_LIMIT_DEFAULT = 20;

/**
 * Panel that previews the batch connection queue before the user approves it.
 * Shows the list of profiles to connect with and allows removing individuals
 * or adjusting the daily send limit.
 */
export function QueuePreviewPanel({
  results,
  onClose,
  onEnqueue,
  showToast,
}: Props) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(results.map((r) => r.profileUrl))
  );
  const [dailyLimit, setDailyLimit] = useState(DAILY_LIMIT_DEFAULT);
  const [submitting, setSubmitting] = useState(false);
  const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;

  const toggleItem = (url: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
  };

  const handleStart = async () => {
    const selectedResults = results.filter((r) => selected.has(r.profileUrl));
    if (selectedResults.length === 0) {
      showToast("No profiles selected", "error");
      return;
    }
    setSubmitting(true);
    try {
      await onEnqueue(selectedResults, dailyLimit);
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  const overlayStyle: React.CSSProperties = {
    position: "fixed",
    inset: 0,
    zIndex: 2147483646,
    background: isDark ? "rgba(0,0,0,0.6)" : "rgba(0,0,0,0.3)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  };

  const panelStyle: React.CSSProperties = {
    background: isDark ? "#111111" : "#ffffff",
    border: `1px solid ${isDark ? "#333333" : "#e5e5e5"}`,
    borderRadius: 12,
    boxShadow: isDark
      ? "0 16px 48px rgba(0,0,0,0.9)"
      : "0 16px 48px rgba(0,0,0,0.15)",
    width: 420,
    maxHeight: "70vh",
    display: "flex",
    flexDirection: "column",
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
    color: isDark ? "#ffffff" : "#000000",
    overflow: "hidden",
  };

  const headerStyle: React.CSSProperties = {
    padding: "16px 20px 12px",
    borderBottom: `1px solid ${isDark ? "#222222" : "#f0f0f0"}`,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  };

  const listStyle: React.CSSProperties = {
    flex: 1,
    overflowY: "auto",
    padding: "8px 0",
  };

  const itemStyle = (checked: boolean): React.CSSProperties => ({
    display: "flex",
    alignItems: "flex-start",
    gap: 10,
    padding: "8px 20px",
    cursor: "pointer",
    background: checked
      ? isDark
        ? "rgba(255,255,255,0.05)"
        : "rgba(0,0,0,0.03)"
      : "transparent",
    transition: "background 0.1s",
  });

  const footerStyle: React.CSSProperties = {
    padding: "12px 20px 16px",
    borderTop: `1px solid ${isDark ? "#222222" : "#f0f0f0"}`,
    display: "flex",
    flexDirection: "column",
    gap: 10,
  };

  const btnPrimaryStyle: React.CSSProperties = {
    padding: "9px 0",
    borderRadius: 8,
    border: "none",
    background: isDark ? "#ffffff" : "#000000",
    color: isDark ? "#ffffff" : "#1c1917",
    fontSize: 13,
    fontWeight: 700,
    cursor: submitting ? "wait" : "pointer",
    width: "100%",
    fontFamily: "inherit",
  };

  const btnSecondaryStyle: React.CSSProperties = {
    padding: "9px 0",
    borderRadius: 8,
    border: `1px solid ${isDark ? "#44403c" : "#e7e5e4"}`,
    background: "transparent",
    color: isDark ? "#fcfcfb" : "#1c1917",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    width: "100%",
    fontFamily: "inherit",
  };

  return (
    <div
      data-tfa-ui="queue-panel"
      style={overlayStyle}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div style={panelStyle} onPointerDown={(e) => e.stopPropagation()}>
        <div style={headerStyle}>
          <span style={{ fontSize: 15, fontWeight: 700 }}>
            Connect with {selected.size} recruiter{selected.size !== 1 ? "s" : ""}
          </span>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              fontSize: 18,
              lineHeight: 1,
              color: isDark ? "#888888" : "#999999",
              padding: 4,
            }}
          >
            ×
          </button>
        </div>

        <div style={listStyle}>
          {results.map((r) => {
            const checked = selected.has(r.profileUrl);
            return (
              <div
                key={r.profileUrl}
                style={itemStyle(checked)}
                onClick={() => toggleItem(r.profileUrl)}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggleItem(r.profileUrl)}
                  style={{ marginTop: 2, flexShrink: 0, cursor: "pointer" }}
                />
                <div style={{ minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {r.name}
                  </div>
                  {r.headline && (
                    <div
                      style={{
                        fontSize: 11,
                        color: isDark ? "#888888" : "#666666",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {r.headline}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div style={footerStyle}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              fontSize: 12,
              color: isDark ? "#888888" : "#666666",
            }}
          >
            <label htmlFor="tfa-daily-limit">Daily limit</label>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input
                id="tfa-daily-limit"
                type="number"
                min={1}
                max={100}
                value={dailyLimit}
                onChange={(e) =>
                  setDailyLimit(Math.max(1, Math.min(100, Number(e.target.value))))
                }
                style={{
                  width: 52,
                  padding: "3px 6px",
                  borderRadius: 6,
                  border: `1px solid ${isDark ? "#444444" : "#e0e0e0"}`,
                  background: isDark ? "#1a1a1a" : "#f8f8f8",
                  color: isDark ? "#ffffff" : "#000000",
                  fontSize: 12,
                  fontFamily: "inherit",
                  textAlign: "center",
                }}
              />
              <span>/ day</span>
            </div>
          </div>
          <button
            type="button"
            disabled={submitting || selected.size === 0}
            style={btnPrimaryStyle}
            onClick={handleStart}
          >
            {submitting ? "Queuing…" : `Start connecting (${selected.size})`}
          </button>
          <button type="button" style={btnSecondaryStyle} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
