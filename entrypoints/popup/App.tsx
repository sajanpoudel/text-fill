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
    width: 320,
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    background: "#fff",
    color: "#111",
  } as React.CSSProperties,

  header: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "14px 16px 12px",
    borderBottom: "1px solid #f0f0f0",
  } as React.CSSProperties,

  logo: {
    width: 32,
    height: 32,
    borderRadius: 8,
    objectFit: "cover" as const,
  },

  title: {
    margin: 0,
    fontSize: 16,
    fontWeight: 700,
    color: "#111",
    flex: 1,
  } as React.CSSProperties,

  settingsBtn: {
    background: "none",
    border: "none",
    cursor: "pointer",
    color: "#888",
    padding: 4,
    borderRadius: 6,
    display: "flex",
    alignItems: "center",
  } as React.CSSProperties,

  desc: {
    margin: 0,
    fontSize: 13,
    color: "#666",
    padding: "12px 16px 8px",
    lineHeight: 1.5,
  } as React.CSSProperties,

  statsRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "6px 16px 10px",
    fontSize: 12,
    color: "#888",
  } as React.CSSProperties,

  memoriesSection: {
    borderTop: "1px solid #f4f4f5",
  } as React.CSSProperties,

  memHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "10px 16px 6px",
  } as React.CSSProperties,

  memTitle: {
    fontSize: 11,
    fontWeight: 600,
    textTransform: "uppercase" as const,
    letterSpacing: "0.5px",
    color: "#888",
  } as React.CSSProperties,

  memLink: {
    fontSize: 12,
    color: "#1d4ed8",
    cursor: "pointer",
    background: "none",
    border: "none",
    padding: 0,
    fontFamily: "inherit",
  } as React.CSSProperties,

  memItem: {
    padding: "8px 16px",
    borderTop: "1px solid #f9f9f9",
    fontSize: 13,
    color: "#333",
    lineHeight: 1.4,
  } as React.CSSProperties,

  memMeta: {
    fontSize: 11,
    color: "#bbb",
    marginTop: 2,
  } as React.CSSProperties,

  emptyMsg: {
    padding: "20px 16px",
    fontSize: 13,
    color: "#aaa",
    textAlign: "center" as const,
    lineHeight: 1.5,
  } as React.CSSProperties,

  footer: {
    display: "flex",
    gap: 8,
    padding: "10px 16px 14px",
    borderTop: "1px solid #f0f0f0",
    marginTop: 4,
  } as React.CSSProperties,

  openSettingsBtn: {
    flex: 1,
    padding: "9px 0",
    background: "#18181b",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "inherit",
  } as React.CSSProperties,

  signOutBtn: {
    padding: "9px 14px",
    background: "transparent",
    color: "#888",
    border: "1px solid #e4e4e7",
    borderRadius: 8,
    fontSize: 13,
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
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
          <button style={S.memLink} onClick={openMemoryPage}>Manage Memory →</button>
        </div>

        {isLoading ? (
          <div style={S.emptyMsg}>Loading…</div>
        ) : memories.length === 0 ? (
          <div style={S.emptyMsg}>
            No memories yet.<br />
            Generate text in the extension to start building memory.
          </div>
        ) : (
          memories.slice(0, 5).map((m) => (
            <div key={m._id} style={S.memItem}>
              <div>{truncate(m.text, 100)}</div>
              <div style={S.memMeta}>
                {m.platform && <span style={{ marginRight: 6, color: "#1d4ed8" }}>{m.platform}</span>}
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
        Click the AI button on any text field to auto-fill with a personalized response.
      </p>
      <div style={S.footer}>
        <button style={S.openSettingsBtn} onClick={openSettings}>Open Settings</button>
      </div>
      <div style={{ display: "flex", justifyContent: "center", gap: 16, padding: "0 0 14px", fontSize: 12, color: "#bbb" }}>
        <a href="https://www.cheatresume.com/" target="_blank" rel="noopener" style={{ color: "#bbb", textDecoration: "none" }}>Website</a>
        <span>·</span>
        <a href="https://github.com/sajanpoudel/text-fill" target="_blank" rel="noopener" style={{ color: "#bbb", textDecoration: "none" }}>GitHub</a>
      </div>
    </div>
  );
}

export function App() {
  return (
    <AppProviders>
      <TokenBridge />
      <AuthLoading>
        <div style={{ width: 300, padding: 24, fontFamily: "system-ui", color: "#888", textAlign: "center" }}>
          Loading…
        </div>
      </AuthLoading>
      <Unauthenticated>
        <div style={{ width: 320 }}>
          <AuthScreen />
        </div>
      </Unauthenticated>
      <Authenticated>
        <Dashboard />
      </Authenticated>
    </AppProviders>
  );
}
