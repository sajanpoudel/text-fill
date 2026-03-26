import {
  useState,
  useEffect,
  useRef,
  useCallback,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

export interface CapturedContext {
  id: string;
  title: string;
  url: string;
  hostname: string;
  text: string;
  time: number;
  active: boolean;
}

// ── Storage helpers ───────────────────────────────────────────────────────────

function normalize(ctx: any): CapturedContext {
  return {
    id: typeof ctx.id === "string" && ctx.id ? ctx.id : `ctx_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    title: typeof ctx.title === "string" ? ctx.title : "",
    url: typeof ctx.url === "string" ? ctx.url : "",
    hostname: typeof ctx.hostname === "string" ? ctx.hostname : "",
    text: typeof ctx.text === "string" ? ctx.text : "",
    time: Number.isFinite(ctx.time) ? ctx.time : Date.now(),
    active: ctx.active !== false,
  };
}

export async function loadContexts(): Promise<CapturedContext[]> {
  const { capturedContexts } = await chrome.storage.local.get("capturedContexts");
  return (Array.isArray(capturedContexts) ? capturedContexts : [])
    .filter((c: any) => c && typeof c === "object")
    .map(normalize)
    .filter((c) => c.text.trim());
}

export async function saveContexts(list: CapturedContext[]): Promise<void> {
  const normalized = list.filter((c) => c.text.trim());
  await chrome.storage.local.set({
    capturedContexts: normalized,
    capturedContextActive: normalized.some((c) => c.active),
  });
}

// ── Page text extraction (mirrors original extractCapturedPageText) ───────────

function extractPageText(): string {
  const main =
    document.querySelector<HTMLElement>("main, article, [role='main']") || document.body;
  return (main.innerText ?? "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 4000);
}

// ── Dark mode detection ───────────────────────────────────────────────────────

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

// ── Time formatting ───────────────────────────────────────────────────────────

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

// ── Context Panel ─────────────────────────────────────────────────────────────

interface PanelProps {
  contexts: CapturedContext[];
  dark: boolean;
  onClose: () => void;
  onAdd: () => void;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
  onDeleteAll: () => void;
  fabRef: React.RefObject<HTMLButtonElement | null>;
}

function ContextPanel({ contexts, dark, onClose, onAdd, onToggle, onDelete, onDeleteAll, fabRef }: PanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const swallowPointer = (e: ReactPointerEvent | ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  // Position above the FAB
  const [pos, setPos] = useState<{ right: number; bottom: number }>({ right: 20, bottom: 60 });
  useEffect(() => {
    if (fabRef.current) {
      const r = fabRef.current.getBoundingClientRect();
      const PANEL_W = 288;
      const right = Math.max(window.innerWidth - r.right, 8);
      const bottom = window.innerHeight - r.top + 8;
      setPos({ right: Math.min(right, window.innerWidth - PANEL_W - 8), bottom });
    }
  }, [fabRef]);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const path = e.composedPath ? e.composedPath() : [];
      const fab = fabRef.current;
      if (
        panelRef.current &&
        !path.includes(panelRef.current) &&
        !(fab && path.includes(fab))
      ) {
        onClose();
      }
    };
    const timer = setTimeout(() => document.addEventListener("click", handler, true), 50);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("click", handler, true);
    };
  }, [onClose, fabRef]);

  const bg = dark ? "#1c1c1e" : "#ffffff";
  const borderColor = dark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.1)";
  const titleColor = dark ? "#f0f0f0" : "#111";
  const addBtnBg = dark ? "rgba(96,165,250,0.15)" : "#eff6ff";
  const addBtnColor = dark ? "#60a5fa" : "#1d4ed8";
  const rowHoverBg = dark ? "rgba(255,255,255,0.05)" : "#f9f9f9";
  const itemTitleColor = dark ? "#e0e0e0" : "#111";
  const metaColor = dark ? "#666" : "#aaa";
  const avatarBg = dark ? "#3a3a3c" : "#e4e4e7";
  const avatarColor = dark ? "#aaa" : "#555";
  const footerBorder = dark ? "rgba(255,255,255,0.07)" : "#f0f0f0";
  const emptyColor = dark ? "#555" : "#aaa";

  return (
    <div
      ref={panelRef}
      style={{
        position: "fixed",
        right: pos.right,
        bottom: pos.bottom,
        zIndex: 2147483647,
        width: 288,
        maxHeight: 360,
        background: bg,
        border: `1px solid ${borderColor}`,
        borderRadius: 14,
        boxShadow: "0 4px 6px rgba(0,0,0,0.05), 0 12px 32px rgba(0,0,0,0.18)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        pointerEvents: "auto",
        fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
        animation: "tfa-fadein 0.15s cubic-bezier(0.16,1,0.3,1)",
      }}
    >
      {/* Header */}
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "11px 12px 10px",
        borderBottom: `1px solid ${dark ? "rgba(255,255,255,0.07)" : "#f0f0f0"}`,
        flexShrink: 0,
      }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: titleColor, textTransform: "uppercase", letterSpacing: "0.5px" }}>
          Context Library
        </span>
        <button
          type="button"
          onClick={onAdd}
          onPointerDown={swallowPointer}
          onMouseDown={swallowPointer}
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: addBtnColor,
            background: addBtnBg,
            border: "none",
            borderRadius: 6,
            padding: "4px 9px",
            cursor: "pointer",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = dark ? "rgba(96,165,250,0.25)" : "#dbeafe")}
          onMouseLeave={(e) => (e.currentTarget.style.background = addBtnBg)}
        >
          + Add this page
        </button>
      </div>

      {/* Context list */}
      <div style={{ flex: 1, overflowY: "auto", padding: "4px 0" }}>
        {contexts.length === 0 ? (
          <div style={{ padding: "20px 14px", fontSize: 12.5, color: emptyColor, textAlign: "center", lineHeight: 1.5 }}>
            No contexts yet — browse to a page and click "+".
          </div>
        ) : (
          [...contexts].reverse().map((ctx) => (
            <div
              key={ctx.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "7px 12px",
                opacity: ctx.active ? 1 : 0.45,
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = rowHoverBg)}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              <input
                type="checkbox"
                checked={ctx.active}
                onChange={() => onToggle(ctx.id)}
                title={ctx.active ? "Deactivate" : "Activate"}
                style={{ flexShrink: 0, width: 14, height: 14, cursor: "pointer", accentColor: "#3b82f6", margin: 0 }}
              />
              <span style={{
                flexShrink: 0,
                width: 22, height: 22,
                borderRadius: 6,
                background: avatarBg,
                fontSize: 11, fontWeight: 700, color: avatarColor,
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                {(ctx.hostname || ctx.title || "?").charAt(0).toUpperCase()}
              </span>
              <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 1 }}>
                <span
                  title={ctx.url}
                  style={{ fontSize: 12.5, fontWeight: 500, color: itemTitleColor, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                >
                  {(ctx.title || ctx.hostname || ctx.url).slice(0, 40)}
                </span>
                <span style={{ fontSize: 11, color: metaColor, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {ctx.hostname} · {relativeTime(ctx.time)}
                </span>
              </div>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onDelete(ctx.id); }}
                onPointerDown={swallowPointer}
                onMouseDown={swallowPointer}
                title="Remove"
                style={{ flexShrink: 0, background: "none", border: "none", color: "#ccc", cursor: "pointer", padding: "3px 4px", borderRadius: 4, display: "flex", alignItems: "center" }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "#dc2626"; e.currentTarget.style.background = "#fee2e2"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = "#ccc"; e.currentTarget.style.background = "none"; }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          ))
        )}
      </div>

      {/* Footer */}
      {contexts.length > 0 && (
        <div style={{ borderTop: `1px solid ${footerBorder}`, padding: "8px 12px", flexShrink: 0 }}>
          <button
            type="button"
            onClick={onDeleteAll}
            onPointerDown={swallowPointer}
            onMouseDown={swallowPointer}
            style={{ fontSize: 12, color: metaColor, background: "none", border: "none", cursor: "pointer", padding: 0 }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "#dc2626")}
            onMouseLeave={(e) => (e.currentTarget.style.color = metaColor)}
          >
            Delete all
          </button>
        </div>
      )}
    </div>
  );
}

// ── Floating FAB ──────────────────────────────────────────────────────────────

interface FABProps {
  visible: boolean;
  contexts: CapturedContext[];
  onContextsChange: (contexts: CapturedContext[]) => void;
  showToast: (msg: string, type?: "success" | "error" | "info") => void;
}

export function ContextFAB({ visible, contexts, onContextsChange, showToast }: FABProps) {
  const [panelOpen, setPanelOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [logoBroken, setLogoBroken] = useState(false);
  const fabRef = useRef<HTMLButtonElement>(null);
  const logoUrl = (() => { try { return chrome.runtime.getURL("logo.png"); } catch { return ""; } })();
  const dark = isPageDark();

  const activeCount = contexts.filter((c) => c.active).length;

  const persist = useCallback(async (next: CapturedContext[]) => {
    await saveContexts(next);
    onContextsChange(next);
  }, [onContextsChange]);

  const handleAdd = useCallback(async () => {
    setAdding(true);
    try {
      const text = extractPageText();
      if (!text) { showToast("No usable page content found", "error"); return; }
      const url = window.location.href;
      const hostname = window.location.hostname;
      const title = document.title || hostname;
      const id = `ctx_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const entry: CapturedContext = { id, title, url, hostname, text, time: Date.now(), active: true };

      const current = await loadContexts();
      const idx = current.findIndex((c) => c.url === url);
      const next = [...current];
      if (idx >= 0) { next[idx] = entry; } else { next.push(entry); }
      await persist(next);
      showToast(`Context saved: ${(title || hostname).slice(0, 40)}`);
    } catch {
      showToast("Failed to capture context", "error");
    } finally {
      setAdding(false);
    }
  }, [persist, showToast]);

  const handleToggle = useCallback(async (id: string) => {
    const current = await loadContexts();
    const next = current.map((c) => c.id === id ? { ...c, active: !c.active } : c);
    await persist(next);
  }, [persist]);

  const handleDelete = useCallback(async (id: string) => {
    const current = await loadContexts();
    await persist(current.filter((c) => c.id !== id));
  }, [persist]);

  const handleDeleteAll = useCallback(async () => {
    await persist([]);
    showToast("All contexts cleared");
  }, [persist, showToast]);

  const swallowPointer = (e: ReactPointerEvent | ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  if (!visible) return null;

  return (
    <>
      <button
        ref={fabRef}
        type="button"
        title="Context library — save pages to use as AI context"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setPanelOpen((v) => !v); }}
        onPointerDown={swallowPointer}
        onMouseDown={swallowPointer}
        disabled={adding}
        style={{
          position: "fixed",
          bottom: 20,
          right: 20,
          zIndex: 2147483647,
          width: 32,
          height: 32,
          padding: 0,
          border: `1px solid ${dark ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.08)"}`,
          borderRadius: "50%",
          background: dark ? "rgba(28,28,30,0.96)" : "rgba(255,255,255,0.96)",
          cursor: adding ? "wait" : "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: "0 2px 10px rgba(0,0,0,0.22)",
          overflow: "visible",
          transition: "transform 0.15s ease, box-shadow 0.15s ease",
          pointerEvents: "auto",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.transform = "scale(1.1)"; e.currentTarget.style.boxShadow = "0 4px 16px rgba(0,0,0,0.3)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.transform = "scale(1)"; e.currentTarget.style.boxShadow = "0 2px 10px rgba(0,0,0,0.22)"; }}
      >
        {!logoBroken ? (
          <img
            src={logoUrl}
            alt="Context"
            onError={() => setLogoBroken(true)}
            style={{ width: 32, height: 32, borderRadius: "50%", objectFit: "cover", display: "block" }}
          />
        ) : (
          <span
            style={{
              fontSize: 14,
              lineHeight: 1,
              fontWeight: 700,
              color: dark ? "#60a5fa" : "#2563eb",
              fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
            }}
          >
            CR
          </span>
        )}
        {/* Badge */}
        {contexts.length > 0 && (
          <span style={{
            position: "absolute",
            top: -4, right: -4,
            minWidth: 16, height: 16,
            background: "#3b82f6",
            border: "2px solid #fff",
            borderRadius: 8,
            fontSize: 9, fontWeight: 700, color: "#fff",
            display: "flex", alignItems: "center", justifyContent: "center",
            padding: "0 3px",
            boxSizing: "border-box",
            pointerEvents: "none",
            fontFamily: "system-ui, -apple-system, sans-serif",
            lineHeight: 1,
          }}>
            {contexts.length}
          </span>
        )}
      </button>

      {panelOpen && (
        <ContextPanel
          contexts={contexts}
          dark={dark}
          onClose={() => setPanelOpen(false)}
          onAdd={async () => { await handleAdd(); }}
          onToggle={handleToggle}
          onDelete={handleDelete}
          onDeleteAll={handleDeleteAll}
          fabRef={fabRef}
        />
      )}
    </>
  );
}
