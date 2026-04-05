import { useState, useEffect, useRef } from "react";
import { Authenticated, Unauthenticated, AuthLoading, useMutation } from "convex/react";
import { AppProviders } from "../../src/components/AppProviders";
import { AuthScreen } from "../../src/components/AuthScreen";
import { TokenBridge } from "../../src/components/TokenBridge";
import { useCurrentUser } from "../../src/hooks/useCurrentUser";
import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "../../convex/_generated/api";

// ── Model lists ────────────────────────────────────────────────────────────

const OPENAI_MODELS = ["gpt-5-nano", "gpt-5-mini"];
const OPENAI_MEMORY_MODELS = ["gpt-5-nano"];
const OPENAI_EMBED_MODELS = ["text-embedding-3-small", "text-embedding-3-large"];
const ANTHROPIC_MODELS = ["claude-sonnet-4-5", "claude-haiku-3-5"];
const ANTHROPIC_MEMORY_MODELS = ["claude-haiku-3-5"];
const GEMINI_MODELS = ["gemini-3-pro-preview", "gemini-3-flash-preview"];
const GEMINI_MEMORY_MODELS = ["gemini-2.5-flash-lite", "gemini-3-flash-preview"];
const GEMINI_EMBED_MODELS = ["gemini-embedding-001"];

// ── Accordion helper ──────────────────────────────────────────────────────

function Accordion({
  title,
  dotStyle,
  chips,
  open,
  onToggle,
  children,
}: {
  title: string;
  dotStyle: React.CSSProperties;
  chips: string[];
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div style={{ borderTop: "1px solid #e5e5e5" }}>
      <button
        type="button"
        onClick={onToggle}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          width: "100%",
          padding: "16px 0",
          border: "none",
          background: "transparent",
          cursor: "pointer",
          textAlign: "left",
          gap: 8,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 14, flex: 1, minWidth: 0 }}>
          <div style={{ ...dotStyle, width: 10, height: 10, borderRadius: "50%", flexShrink: 0 }} />
          <div>
            <span style={{ display: "block", fontSize: 15, fontWeight: 700, color: "var(--color-text)" }}>{title}</span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
              {chips.map((c) => (
                <span
                  key={c}
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: "#666",
                    background: "#f5f5f5",
                    border: "1px solid #e5e5e5",
                    borderRadius: 4,
                    padding: "2px 8px",
                    whiteSpace: "nowrap",
                    textTransform: "uppercase",
                    letterSpacing: "0.5px"
                  }}
                >
                  {c}
                </span>
              ))}
            </div>
          </div>
        </div>
        <svg
          width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#000" strokeWidth="2.5"
          style={{ flexShrink: 0, transform: open ? "rotate(180deg)" : "none", transition: "transform 0.2s ease" }}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14, paddingBottom: 20, paddingTop: 4 }}>
          {children}
        </div>
      )}
    </div>
  );
}

// ── EyeButton ─────────────────────────────────────────────────────────────

function EyeButton({ visible, onToggle }: { visible: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      style={{
        position: "absolute",
        right: 4,
        top: "50%",
        transform: "translateY(-50%)",
        background: "transparent",
        border: "none",
        padding: 8,
        cursor: "pointer",
        color: "#666",
        display: "flex",
        alignItems: "center",
        borderRadius: 4,
      }}
    >
      {visible ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
          <line x1="1" y1="1" x2="23" y2="23" />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      )}
    </button>
  );
}

// ── PasswordField ──────────────────────────────────────────────────────────

function PasswordField({
  id, label, value, onChange, placeholder,
}: {
  id: string; label: string; value: string; onChange: (v: string) => void; placeholder: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
        <input
          type={show ? "text" : "password"}
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          style={{ paddingRight: 44 }}
        />
        <EyeButton visible={show} onToggle={() => setShow((v) => !v)} />
      </div>
    </div>
  );
}

// ── FileUpload ─────────────────────────────────────────────────────────────

function FileUpload({
  id, label, value, onChange,
}: {
  id: string; label: string; value: string; onChange: (text: string) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);

  async function handleFile(file: File) {
    setFileName(file.name);
    const text = await file.text();
    onChange(text.slice(0, 30000));
  }

  return (
    <div>
      {!fileName ? (
        <div
          style={{
            position: "relative",
            border: "1.5px dashed #ccc",
            borderRadius: 6,
            padding: 20,
            textAlign: "center",
            cursor: "pointer",
            color: "#666",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 10,
            fontSize: 13,
            fontWeight: 600,
          }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const f = e.dataTransfer.files[0];
            if (f) handleFile(f);
          }}
          onClick={() => fileRef.current?.click()}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
          <span>Drop PDF or text file, or click to browse</span>
          <input
            ref={fileRef}
            type="file"
            id={id}
            accept=".txt,.md"
            style={{ position: "absolute", inset: 0, opacity: 0, cursor: "pointer", width: "100%", height: "100%" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFile(f);
            }}
          />
        </div>
      ) : (
        <div style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 14px",
          background: "#f5f5f5",
          borderRadius: 6,
          fontSize: 13,
          fontWeight: 600,
          color: "var(--color-text)",
        }}>
          <span>{fileName}</span>
          <button
            type="button"
            onClick={() => { setFileName(null); onChange(""); if (fileRef.current) fileRef.current.value = ""; }}
            style={{ background: "none", border: "none", color: "#666", cursor: "pointer", padding: "4px 8px", fontSize: 13, borderRadius: 4 }}
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}

// ── Main Settings Page ────────────────────────────────────────────────────

function SettingsPage() {
  const { profile } = useCurrentUser();
  const { signOut } = useAuthActions();
  const updateProfile = useMutation(api.users.updateProfile);

  const [provider, setProvider] = useState("openai");
  const [model, setModel] = useState("gpt-5-nano");
  const [memoryModel, setMemoryModel] = useState("gpt-5-nano");
  const [anthropicEmbeddingProvider, setAnthropicEmbeddingProvider] = useState<"openai" | "gemini">("openai");
  const [openaiEmbeddingModel, setOpenaiEmbeddingModel] = useState(OPENAI_EMBED_MODELS[0]);
  const [geminiEmbeddingModel, setGeminiEmbeddingModel] = useState(GEMINI_EMBED_MODELS[0]);
  const [openaiKey, setOpenaiKey] = useState("");
  const [anthropicKey, setAnthropicKey] = useState("");
  const [geminiKey, setGeminiKey] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [workContext, setWorkContext] = useState("");
  const [socialContext, setSocialContext] = useState("");
  const [alwaysContext, setAlwaysContext] = useState("");
  const [openAccordion, setOpenAccordion] = useState<"work" | "social" | "always" | null>("work");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ msg: string; ok: boolean } | null>(null);

  // Sync from profile
  useEffect(() => {
    if (!profile) return;
    setProvider(profile.provider ?? "openai");
    setModel(profile.model ?? "gpt-5-nano");
    setMemoryModel(profile.memoryModel ?? "");
    setSystemPrompt(profile.systemPrompt ?? "");
    const resolvedEmbeddingProvider =
      profile.embeddingProvider === "gemini"
        ? "gemini"
        : profile.provider === "gemini"
          ? "gemini"
          : "openai";
    setAnthropicEmbeddingProvider(resolvedEmbeddingProvider);
    if (resolvedEmbeddingProvider === "gemini") {
      setGeminiEmbeddingModel(
        profile.embeddingModel && GEMINI_EMBED_MODELS.includes(profile.embeddingModel)
          ? profile.embeddingModel
          : GEMINI_EMBED_MODELS[0]
      );
    } else {
      setOpenaiEmbeddingModel(
        profile.embeddingModel && OPENAI_EMBED_MODELS.includes(profile.embeddingModel)
          ? profile.embeddingModel
          : OPENAI_EMBED_MODELS[0]
      );
    }
    if (profile.contextText) {
      try {
        const parsed = JSON.parse(profile.contextText);
        setWorkContext(parsed.work ?? "");
        setSocialContext(parsed.social ?? "");
        setAlwaysContext(parsed.always ?? "");
      } catch {
        setAlwaysContext(profile.contextText);
      }
    }
  }, [profile?._id]);

  useEffect(() => {
    const models = provider === "openai" ? OPENAI_MODELS : provider === "anthropic" ? ANTHROPIC_MODELS : GEMINI_MODELS;
    if (!models.includes(model)) setModel(models[0]);
    const memModels = provider === "openai" ? OPENAI_MEMORY_MODELS : provider === "anthropic" ? ANTHROPIC_MEMORY_MODELS : GEMINI_MEMORY_MODELS;
    if (!memModels.includes(memoryModel)) setMemoryModel(memModels[0]);
  }, [provider]);

  async function save() {
    setSaving(true);
    setStatus(null);
    try {
      const embeddingProvider = provider === "anthropic" ? anthropicEmbeddingProvider : provider;
      const embeddingModel =
        embeddingProvider === "gemini" ? geminiEmbeddingModel : openaiEmbeddingModel;
      const patch: Record<string, string | undefined> = {
        provider,
        model,
        memoryModel: memoryModel || undefined,
        embeddingProvider,
        embeddingModel,
        systemPrompt: systemPrompt || undefined,
        contextText: JSON.stringify({ work: workContext, social: socialContext, always: alwaysContext }),
      };
      if (openaiKey) patch.openaiKey = openaiKey;
      if (anthropicKey) patch.anthropicKey = anthropicKey;
      if (geminiKey) patch.geminiKey = geminiKey;
      await updateProfile(patch as any);
      setStatus({ msg: "Settings saved", ok: true });
      setOpenaiKey(""); setAnthropicKey(""); setGeminiKey("");
      setTimeout(() => setStatus(null), 3000);
    } catch (err: any) {
      setStatus({ msg: err.message ?? "Save failed", ok: false });
    } finally {
      setSaving(false);
    }
  }

  function openMemory() {
    chrome.tabs.create({ url: chrome.runtime.getURL("memory.html") });
  }

  return (
    <main className="container" style={{ fontFamily: "system-ui, -apple-system, sans-serif", color: "var(--color-text)" }}>
      {/* Header */}
      <header className="app-header">
        <img src={chrome.runtime.getURL("logo.png")} alt="Text Fill" className="header-logo" style={{ borderRadius: 4 }} />
        <div className="header-text">
          <h1 style={{ fontWeight: 800, letterSpacing: "-0.5px" }}>CheatResume</h1>
          <p style={{ color: "#666", fontWeight: 600, letterSpacing: "0.5px", textTransform: "uppercase", fontSize: 11 }}>AI writing assistant</p>
        </div>
      </header>

      {/* How it works */}
      <div className="info-banner" style={{ background: "#f9f9f9", border: "1px solid #e5e5e5", color: "var(--color-text)" }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <span>
          <strong>Single-click</strong> the icon for the action menu —{" "}
          <strong>double-click</strong> to generate instantly. Contexts are applied automatically based on the site you're on.
        </span>
      </div>

      {/* Memory bar */}
      <div className="memory-bar" style={{ background: "#000", border: "none", color: "#fff" }}>
        <span className="memory-bar-label" style={{ color: "#fff", fontWeight: 600, letterSpacing: "0.2px" }}>Memories learned from your activity</span>
        <button type="button" className="btn-manage-memory" onClick={openMemory} style={{ background: "#fff", color: "var(--color-text)", border: "none", borderRadius: 4, fontWeight: 700 }}>
          Manage Memory
        </button>
      </div>

      {/* AI Provider */}
      <section className="card" style={{ border: "1px solid #e5e5e5", boxShadow: "0 2px 8px rgba(0,0,0,0.02)" }}>
        <div className="card-header">
          <h2 style={{ fontWeight: 800 }}>AI Provider</h2>
          <span className="active-badge" style={{ background: "#f0f0f0", color: "var(--color-text)", fontWeight: 700 }}>{provider === "openai" ? "OpenAI" : provider === "anthropic" ? "Anthropic" : "Gemini"}</span>
        </div>

        {/* Provider tabs */}
        <div className="tabs" role="tablist" style={{ background: "#f5f5f5", padding: 4, borderRadius: 6 }}>
          {(["openai", "anthropic", "gemini"] as const).map((p) => (
            <button
              key={p}
              className={`tab provider-tab${provider === p ? " active" : ""}`}
              role="tab"
              onClick={() => setProvider(p)}
              style={{
                background: provider === p ? "#000" : "transparent",
                color: provider === p ? "#fff" : "#666",
                fontWeight: 700,
                borderRadius: 4,
                boxShadow: provider === p ? "0 2px 4px rgba(0,0,0,0.1)" : "none"
              }}
            >
              {p === "openai" ? "OpenAI" : p === "anthropic" ? "Anthropic" : "Gemini"}
            </button>
          ))}
        </div>

        {/* API key field */}
        {provider === "openai" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <PasswordField id="openaiKey" label="API Key" value={openaiKey} onChange={setOpenaiKey} placeholder="sk-proj-..." />
            <div className="field">
              <label htmlFor="openaiModel">Model</label>
              <select id="openaiModel" value={model} onChange={(e) => setModel(e.target.value)}>
                {OPENAI_MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <div className="field field-memory">
              <label htmlFor="openaiMemoryModel">Memory Model <span className="field-hint">background tasks</span></label>
              <select id="openaiMemoryModel" value={memoryModel || OPENAI_MEMORY_MODELS[0]} onChange={(e) => setMemoryModel(e.target.value)}>
                {OPENAI_MEMORY_MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <div className="field field-memory">
              <label>Embedding Model <span className="field-hint">vector index</span></label>
              <select value={openaiEmbeddingModel} onChange={(e) => setOpenaiEmbeddingModel(e.target.value)}>
                {OPENAI_EMBED_MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
          </div>
        )}

        {provider === "anthropic" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <PasswordField id="anthropicKey" label="API Key" value={anthropicKey} onChange={setAnthropicKey} placeholder="sk-ant-..." />
            <div className="field">
              <label htmlFor="anthropicModel">Model</label>
              <select id="anthropicModel" value={model} onChange={(e) => setModel(e.target.value)}>
                {ANTHROPIC_MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <div className="field field-memory">
              <label htmlFor="anthropicMemoryModel">Memory Model <span className="field-hint">background tasks</span></label>
              <select id="anthropicMemoryModel" value={memoryModel || ANTHROPIC_MEMORY_MODELS[0]} onChange={(e) => setMemoryModel(e.target.value)}>
                {ANTHROPIC_MEMORY_MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <div className="field field-memory">
              <label htmlFor="anthropicEmbeddingProvider">Embedding Provider <span className="field-hint">semantic memory</span></label>
              <select
                id="anthropicEmbeddingProvider"
                value={anthropicEmbeddingProvider}
                onChange={(e) => setAnthropicEmbeddingProvider(e.target.value as "openai" | "gemini")}
              >
                <option value="openai">OpenAI</option>
                <option value="gemini">Gemini</option>
              </select>
            </div>
            {anthropicEmbeddingProvider === "openai" ? (
              <>
                <div className="embed-hint" style={{ background: "#f9f9f9", border: "1px solid #e5e5e5", color: "var(--color-text)" }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                  Anthropic stays active for writing. <strong>OpenAI</strong> is used only for semantic memory embeddings and retrieval.
                </div>
                <PasswordField id="openaiKeyForEmbed" label="OpenAI Key (for embeddings)" value={openaiKey} onChange={setOpenaiKey} placeholder="sk-proj-..." />
                <div className="field field-memory">
                  <label>Embedding Model <span className="field-hint">vector index</span></label>
                  <select value={openaiEmbeddingModel} onChange={(e) => setOpenaiEmbeddingModel(e.target.value)}>
                    {OPENAI_EMBED_MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
              </>
            ) : (
              <>
                <div className="embed-hint" style={{ background: "#f9f9f9", border: "1px solid #e5e5e5", color: "var(--color-text)" }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                  Anthropic stays active for writing. <strong>Gemini</strong> is used only for semantic memory embeddings and retrieval.
                </div>
                <PasswordField id="geminiKeyForEmbed" label="Gemini Key (for embeddings)" value={geminiKey} onChange={setGeminiKey} placeholder="AIza..." />
                <div className="field field-memory">
                  <label>Embedding Model <span className="field-hint">vector index</span></label>
                  <select value={geminiEmbeddingModel} onChange={(e) => setGeminiEmbeddingModel(e.target.value)}>
                    {GEMINI_EMBED_MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
              </>
            )}
          </div>
        )}

        {provider === "gemini" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <PasswordField id="geminiKey" label="API Key" value={geminiKey} onChange={setGeminiKey} placeholder="AIza..." />
            <div className="field">
              <label htmlFor="geminiModel">Model</label>
              <select id="geminiModel" value={model} onChange={(e) => setModel(e.target.value)}>
                {GEMINI_MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <div className="field field-memory">
              <label htmlFor="geminiMemoryModel">Memory Model <span className="field-hint">background tasks</span></label>
              <select id="geminiMemoryModel" value={memoryModel || GEMINI_MEMORY_MODELS[0]} onChange={(e) => setMemoryModel(e.target.value)}>
                {GEMINI_MEMORY_MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <div className="field field-memory">
              <label>Embedding Model <span className="field-hint">vector index</span></label>
              <select value={geminiEmbeddingModel} onChange={(e) => setGeminiEmbeddingModel(e.target.value)}>
                {GEMINI_EMBED_MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
          </div>
        )}
      </section>

      {/* Your Contexts */}
      <section className="card ctx-card" style={{ border: "1px solid #e5e5e5", boxShadow: "0 2px 8px rgba(0,0,0,0.02)" }}>
        <div className="card-header">
          <h2 style={{ fontWeight: 800 }}>Your Contexts</h2>
          <span className="auto-badge" style={{ background: "#000", color: "#fff", fontWeight: 700 }}>Auto-selected by site</span>
        </div>
        <p className="hint" style={{ color: "#444", fontWeight: 500, fontSize: 13 }}>
          Add info for different parts of your life. The extension picks the right context automatically — you never have to switch modes.
        </p>

        <Accordion
          title="Career & Work"
          dotStyle={{ background: "#000" }}
          chips={["LinkedIn", "Job boards", "Gmail", "Slack", "Notion"]}
          open={openAccordion === "work"}
          onToggle={() => setOpenAccordion((v) => v === "work" ? null : "work")}
        >
          <FileUpload id="workFile" label="Work" value={workContext} onChange={setWorkContext} />
          <textarea
            id="workText"
            value={workContext}
            onChange={(e) => setWorkContext(e.target.value)}
            placeholder="Resume, skills, job history, achievements, company info you work at..."
            rows={7}
            style={{ borderRadius: 6, border: "1px solid #e5e5e5" }}
          />
        </Accordion>

        <Accordion
          title="Social & Personal"
          dotStyle={{ background: "#666" }}
          chips={["Twitter/X", "Instagram", "Facebook", "Reddit", "Messenger", "Discord"]}
          open={openAccordion === "social"}
          onToggle={() => setOpenAccordion((v) => v === "social" ? null : "social")}
        >
          <FileUpload id="socialFile" label="Social" value={socialContext} onChange={setSocialContext} />
          <textarea
            id="socialText"
            value={socialContext}
            onChange={(e) => setSocialContext(e.target.value)}
            placeholder="Interests, hobbies, personality, how you like to interact online, topics you care about..."
            rows={5}
            style={{ borderRadius: 6, border: "1px solid #e5e5e5" }}
          />
        </Accordion>

        <Accordion
          title="Always Active"
          dotStyle={{ border: "2px solid #000", background: "transparent" }}
          chips={["Every platform"]}
          open={openAccordion === "always"}
          onToggle={() => setOpenAccordion((v) => v === "always" ? null : "always")}
        >
          <textarea
            id="alwaysText"
            value={alwaysContext}
            onChange={(e) => setAlwaysContext(e.target.value)}
            placeholder="Facts or preferences that apply everywhere — e.g. name, location, preferred tone, things to always/never say..."
            rows={4}
            style={{ borderRadius: 6, border: "1px solid #e5e5e5" }}
          />
        </Accordion>
      </section>

      {/* Custom System Prompt */}
      <section className="card" style={{ border: "1px solid #e5e5e5", boxShadow: "0 2px 8px rgba(0,0,0,0.02)" }}>
        <div className="prompt-header">
          <div>
            <h2 style={{ fontWeight: 800 }}>Custom System Prompt <span className="optional-label" style={{ background: "#f0f0f0", color: "#666", fontWeight: 700 }}>optional</span></h2>
            <p className="hint" style={{ color: "#444", fontWeight: 500, fontSize: 13 }}>Completely overrides the default AI instructions. Leave empty unless you want full control.</p>
          </div>
        </div>
        <textarea
          id="systemPrompt"
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          placeholder="e.g., Always write in a direct, confident tone. Never use bullet points. Mirror the style of the conversation."
          rows={3}
          style={{ borderRadius: 6, border: "1px solid #e5e5e5" }}
        />
      </section>

      {/* Save */}
      <div className="actions">
        <button id="save" className="btn-primary" onClick={save} disabled={saving} style={{ background: "#000", color: "#fff", fontWeight: 700, borderRadius: 6 }}>
          {saving ? "Saving…" : "Save Settings"}
        </button>
        {status && (
          <span id="status" className={status.ok ? "success" : "error"} style={{ fontWeight: 700, background: status.ok ? "#000" : "#fff", color: status.ok ? "#fff" : "#dc2626", border: status.ok ? "none" : "1px solid #dc2626", padding: "4px 10px", borderRadius: 4 }}>
            {status.msg}
          </span>
        )}
      </div>

      {/* Footer */}
      <footer className="footer" style={{ borderTop: "1px solid #e5e5e5", paddingTop: 20 }}>
        <a href="https://www.cheatresume.com/" target="_blank" rel="noopener" style={{ color: "var(--color-text)", fontWeight: 700 }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" />
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
          </svg>
          Website
        </a>
        <a href="https://github.com/sajanpoudel/text-fill" target="_blank" rel="noopener" style={{ color: "var(--color-text)", fontWeight: 700 }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />
          </svg>
          GitHub
        </a>
        <button
          type="button"
          onClick={() => signOut()}
          style={{ background: "none", border: "1px solid #ccc", borderRadius: 4, color: "var(--color-text)", cursor: "pointer", fontSize: 13, fontWeight: 700, padding: "6px 12px" }}
        >
          Sign out
        </button>
      </footer>
    </main>
  );
}

export function App() {
  return (
    <AppProviders>
      <TokenBridge />
      <AuthLoading>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", color: "#666", fontFamily: "system-ui", fontWeight: 700, textTransform: "uppercase", letterSpacing: "1px" }}>
          Loading…
        </div>
      </AuthLoading>
      <Unauthenticated>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh" }}>
          <div style={{ width: "100%", maxWidth: 380 }}>
            <AuthScreen />
          </div>
        </div>
      </Unauthenticated>
      <Authenticated>
        <SettingsPage />
      </Authenticated>
    </AppProviders>
  );
}
