import { Authenticated, Unauthenticated, AuthLoading } from "convex/react";
import { AppProviders } from "../../src/components/AppProviders";
import { AuthScreen } from "../../src/components/AuthScreen";
import { TokenBridge } from "../../src/components/TokenBridge";
import { useMemories } from "../../src/hooks/useMemories";
import { useCurrentUser } from "../../src/hooks/useCurrentUser";
import { useAuthActions } from "@convex-dev/auth/react";
import { formatRelativeTime, truncate } from "../../src/lib/utils";

// ── Popup styles inline to avoid Tailwind dependency issues in popup ───────

const S = {
  popup: {
    width: 340,
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    background: "#ffffff",
    color: "#000000",
    WebkitFontSmoothing: "antialiased",
  } as React.CSSProperties,

  header: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "16px 20px 14px",
    borderBottom: "1px solid #e5e5e5",
  } as React.CSSProperties,

  logo: {
    width: 24,
    height: 24,
    borderRadius: 4,
    objectFit: "cover" as const,
  },

  title: {
    margin: 0,
    fontSize: 16,
    fontWeight: 800,
    color: "#000000",
    flex: 1,
    letterSpacing: "-0.5px",
  } as React.CSSProperties,

  settingsBtn: {
    background: "none",
    border: "none",
    cursor: "pointer",
    color: "#666",
    padding: 6,
    borderRadius: 4,
    display: "flex",
    alignItems: "center",
    lineHeight: 1,
    transition: "color 0.2s",
  } as React.CSSProperties,

  desc: {
    margin: 0,
    fontSize: 13,
    color: "#444",
    padding: "16px 20px 0",
    lineHeight: 1.6,
    fontWeight: 500,
  } as React.CSSProperties,

  statsRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "10px 20px 12px",
    fontSize: 11,
    fontWeight: 700,
    textTransform: "uppercase" as const,
    letterSpacing: "0.5px",
    color: "#888",
  } as React.CSSProperties,

  memoriesSection: {
    borderTop: "1px solid #f0f0f0",
  } as React.CSSProperties,

  memHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "12px 20px 6px",
  } as React.CSSProperties,

  memTitle: {
    fontSize: 11,
    fontWeight: 800,
    textTransform: "uppercase" as const,
    letterSpacing: "0.8px",
    color: "#666",
  } as React.CSSProperties,

  memLink: {
    fontSize: 12,
    color: "#000",
    cursor: "pointer",
    background: "none",
    border: "none",
    padding: 0,
    fontFamily: "inherit",
    fontWeight: 700,
    textDecoration: "underline",
  } as React.CSSProperties,

  memItem: {
    padding: "10px 20px",
    borderTop: "1px solid #f9f9f9",
    fontSize: 13,
    fontWeight: 500,
    color: "#222",
    lineHeight: 1.5,
  } as React.CSSProperties,

  memMeta: {
    fontSize: 11,
    fontWeight: 600,
    color: "#888",
    marginTop: 4,
    letterSpacing: "0.2px",
    textTransform: "uppercase" as const,
  } as React.CSSProperties,

  emptyMsg: {
    padding: "24px 20px",
    fontSize: 13,
    fontWeight: 500,
    color: "#888",
    textAlign: "center" as const,
    lineHeight: 1.6,
  } as React.CSSProperties,

  footer: {
    display: "flex",
    gap: 10,
    padding: "16px 20px",
    borderTop: "1px solid #e5e5e5",
    marginTop: 8,
  } as React.CSSProperties,

  openSettingsBtn: {
    flex: 1,
    padding: "10px 0",
    background: "#000",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 700,
    cursor: "pointer",
    fontFamily: "inherit",
    letterSpacing: "0.2px",
    boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
  } as React.CSSProperties,

  signOutBtn: {
    padding: "10px 16px",
    background: "transparent",
    color: "#000",
    border: "1px solid #d4d4d4",
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "inherit",
  } as React.CSSProperties,
};

function Dashboard() {
  const { memories, stats, isLoading } = useMemories(10);
  const { signOut } = useAuthActions();

  function openSettings() {
    chrome.runtime.openOptionsPage();
  }

  function openMemoryPage() {
    chrome.tabs.create({ url: chrome.runtime.getURL("memory.html") });
  }

  return (
    <div style={S.popup}>
      {/* Header */}
      <div style={S.header}>
        <img src={chrome.runtime.getURL("logo.png")} alt="CheatResume" style={S.logo} />
        <h1 style={S.title}>CheatResume</h1>
        <button style={S.settingsBtn} onClick={openSettings} title="Settings">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>

      {/* Description */}
      <p style={S.desc}>
        Click the AI button on any text field to auto-fill with a personalized response.
      </p>

      {/* Stats */}
      <div style={S.statsRow}>
        <span>{stats.active} active memories · {stats.archived} archived</span>
      </div>

      {/* Recent memories */}
      <div style={S.memoriesSection}>
        <div style={S.memHeader}>
          <span style={S.memTitle}>Recent Memories</span>
          <button style={S.memLink} onClick={openMemoryPage}>Manage</button>
        </div>

        {isLoading ? (
          <div style={S.emptyMsg}>Loading…</div>
        ) : memories.length === 0 ? (
          <div style={S.emptyMsg}>
            No memories yet.<br />
            Generate text in the extension to start building memory.
          </div>
        ) : (
          memories
            .slice(0, 5)
            .map((m: { _id: string; text: string; platform?: string; createdAt: number }) => (
            <div key={m._id} style={S.memItem}>
              <div>{truncate(m.text, 100)}</div>
              <div style={S.memMeta}>
                {m.platform && <span style={{ marginRight: 6, color: "#aaa" }}>{m.platform}</span>}
                {formatRelativeTime(m.createdAt)}
              </div>
            </div>
            ))
        )}
      </div>

      {/* Footer */}
      <div style={S.footer}>
        <button style={S.openSettingsBtn} onClick={openSettings}>Open Settings</button>
        <button style={S.signOutBtn} onClick={() => signOut()}>Sign out</button>
      </div>
    </div>
  );
}

function SimplePopup() {
  function openSettings() {
    chrome.runtime.openOptionsPage();
  }

  return (
    <div style={{ ...S.popup, padding: 0 }}>
      <div style={S.header}>
        <img src={chrome.runtime.getURL("logo.png")} alt="CheatResume" style={S.logo} />
        <h1 style={S.title}>CheatResume</h1>
      </div>
      <p style={S.desc}>
        Click the action button on any text field to auto-fill with a personalized response.
      </p>
      <div style={S.footer}>
        <button style={S.openSettingsBtn} onClick={openSettings}>Open Settings</button>
      </div>
      <div style={{ display: "flex", justifyContent: "center", gap: 16, padding: "0 0 16px", fontSize: 12, fontWeight: 700, textTransform: "uppercase" }}>
        <a href="https://www.cheatresume.com/" target="_blank" rel="noopener" style={{ color: "var(--color-primary, #7f1d1d)", textDecoration: "underline" }}>Website</a>
        <span style={{ color: "var(--color-text-muted, #78716c)" }}>·</span>
        <a href="https://github.com/sajanpoudel/text-fill" target="_blank" rel="noopener" style={{ color: "var(--color-primary, #7f1d1d)", textDecoration: "underline" }}>GitHub</a>
      </div>
    </div>
  );
}

export function App() {
  return (
    <AppProviders>
      <TokenBridge />
      <AuthLoading>
        <div style={{ width: 340, padding: 32, fontFamily: "system-ui", color: "#666", textAlign: "center", fontWeight: 700, fontSize: 12, textTransform: "uppercase", letterSpacing: "1px" }}>
          Loading…
        </div>
      </AuthLoading>
      <Unauthenticated>
        <div style={{ width: 340 }}>
          <AuthScreen />
        </div>
      </Unauthenticated>
      <Authenticated>
        <Dashboard />
      </Authenticated>
    </AppProviders>
  );
}
