import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { isPageDark } from "../../src/lib/dom/theme.ts";
import {
  buildDefaultAgentGoal,
  cancelAgentRun,
  fetchAgentPanelState,
  getAgentRunCurrentTask,
  getAgentRunProgressSummary,
  formatAgentRunStatus,
  getAgentPanelPollMs,
  getAgentRunSummary,
  normalizeAgentGoal,
  resumeAgentRun,
  resolveAgentApproval,
  startAgentRun,
  summarizeApprovalPayload,
  type AgentPanelApproval as AgentApprovalListEntry,
  type AgentPanelRun as AgentRunListEntry,
} from "../../src/lib/agent-panel-runtime.ts";
import { buildAgentRunStartContext } from "../../src/lib/agent-run-context.ts";
import { buildAgentRunBootstrapContext } from "../../src/lib/agent-run-bootstrap.ts";
import type { PlatformKey } from "../../src/lib/platform.ts";

type ToastType = "success" | "error" | "info";

interface AgentFABProps {
  visible: boolean;
  platform: PlatformKey;
  currentField: Element | null;
  showToast: (msg: string, type?: ToastType) => void;
}

type SpeechRecognitionConstructor = typeof window.SpeechRecognition;

const SR: SpeechRecognitionConstructor | undefined =
  window.SpeechRecognition ?? window.webkitSpeechRecognition;

function createRecognition(): SpeechRecognition | null {
  if (!SR) return null;
  const recognition = new SR();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = "en-US";
  return recognition;
}


function getStatusColors(status: string, dark: boolean) {
  switch (status) {
    case "completed":
    case "approved":
      return {
        background: dark ? "rgba(22,101,52,0.22)" : "rgba(22,101,52,0.08)",
        color: dark ? "#bbf7d0" : "#166534",
      };
    case "awaiting_approval":
    case "planning":
    case "executing":
    case "running":
      return {
        background: dark ? "rgba(37,99,235,0.22)" : "rgba(37,99,235,0.08)",
        color: dark ? "#bfdbfe" : "#1d4ed8",
      };
    case "failed":
    case "rejected":
    case "cancelled":
      return {
        background: dark ? "rgba(220,38,38,0.22)" : "rgba(220,38,38,0.08)",
        color: dark ? "#fecaca" : "#b91c1c",
      };
    default:
      return {
        background: dark ? "rgba(120,113,108,0.22)" : "rgba(120,113,108,0.08)",
        color: dark ? "#e7e5e4" : "#57534e",
      };
  }
}

function scheduleTaskQueueNudge() {
  const delays = [0, 2_500, 7_500];
  for (const delay of delays) {
    window.setTimeout(() => {
      void chrome.runtime.sendMessage({ type: "PROCESS_TASK_QUEUE" }).catch(() => {});
    }, delay);
  }
}

function AgentComposer({
  dark,
  goal,
  authenticated,
  runtimeConnected,
  runtimeError,
  placeholder,
  loading,
  starting,
  latestRun,
  approvals,
  actingApprovalId,
  runActionPending,
  onGoalChange,
  onRefresh,
  onStart,
  onCancelRun,
  onResumeRun,
  onResolve,
  onClose,
  isListening,
  onVoiceToggle,
}: {
  dark: boolean;
  goal: string;
  authenticated: boolean;
  runtimeConnected: boolean;
  runtimeError?: string;
  placeholder: string;
  loading: boolean;
  starting: boolean;
  latestRun: AgentRunListEntry | null;
  approvals: AgentApprovalListEntry[];
  actingApprovalId: string | null;
  runActionPending: "cancel" | "resume" | null;
  onGoalChange: (next: string) => void;
  onRefresh: () => void;
  onStart: () => void;
  onCancelRun: () => void;
  onResumeRun: () => void;
  onResolve: (approvalId: string, decision: "approved" | "rejected") => void;
  onClose: () => void;
  isListening: boolean;
  onVoiceToggle: () => void;
}) {
  const composerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [tasksCollapsed, setTasksCollapsed] = useState(false);

  // Auto-expand when a run becomes active; auto-collapse when it finishes.
  const runStatus = latestRun?.status;
  useEffect(() => {
    if (runStatus === "planning" || runStatus === "executing") {
      setTasksCollapsed(false);
    } else if (runStatus === "completed" || runStatus === "failed" || runStatus === "cancelled") {
      setTasksCollapsed(true);
    }
  }, [runStatus]);

  // ── Theme Colours (Matched to GenerateModal) ──────────────────────────────
  const bg        = dark ? "#0A0A0A" : "#ffffff";
  const border    = dark ? "#333333" : "#e5e5e5";
  const text      = dark ? "#ffffff" : "#000000";
  const textSub   = dark ? "#888888" : "#666666";
  const textMuted = dark ? "#555555" : "#999999";
  const divider   = dark ? "#222222" : "#f0f0f0";
  const hoverBg   = dark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.04)";
  const primary   = dark ? "#ffffff" : "#000000";

  const primaryDisabled =
    starting || !runtimeConnected || !normalizeAgentGoal(goal);
  const firstApproval = approvals[0] ?? null;

  useEffect(() => {
    window.setTimeout(() => inputRef.current?.focus(), 40);
  }, []);

  const stopDown = (e: ReactMouseEvent | ReactPointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const statusColors = latestRun ? getStatusColors(latestRun.status, dark) : null;
  const summary = latestRun ? getAgentRunSummary(latestRun) : null;
  const progressSummary = latestRun ? getAgentRunProgressSummary(latestRun) : null;
  const currentTask = latestRun ? getAgentRunCurrentTask(latestRun) : null;
  const canCancelLatestRun = Boolean(
    latestRun &&
      (latestRun.status === "planning" || latestRun.status === "executing")
  );
  const canResumeLatestRun = Boolean(
    latestRun &&
      (latestRun.status === "paused" ||
        latestRun.status === "failed" ||
        latestRun.status === "cancelled")
  );

  let detail = "Start a bounded task for the current page.";
  if (!authenticated) {
    detail = "Sign in to start agent runs.";
  } else if (!runtimeConnected) {
    detail = runtimeError?.trim() ? runtimeError : "Connect local companion.";
  } else if (summary) {
    detail = summary;
  }

  const isAgentActive =
    latestRun?.status === "executing" || latestRun?.status === "planning";

  return createPortal(
    <div
      data-tfa-ui="modal-overlay"
      aria-hidden={isAgentActive ? "true" : undefined}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 2147483647,
        background: "transparent", // No blocking/blurring overlay
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
        paddingBottom: 40,
        pointerEvents: "none",
      }}
    >
      <div
        ref={composerRef}
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: 640,
          background: bg,
          border: `1px solid ${border}`,
          borderRadius: 8,
          boxShadow: `0 8px 30px rgba(0,0,0,${dark ? "0.6" : "0.15"}), 0 0 0 1px ${border}`,
          fontFamily: `system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          animation: "tfa-modal-in 0.2s ease-out",
          pointerEvents: "auto",
          userSelect: "text",
          WebkitUserSelect: "text",
        }}
      >
        {/* Header/Status Strip */}
        <div style={{ padding: "10px 14px", borderBottom: `1px solid ${divider}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
            <span style={{
              padding: "2px 6px",
              borderRadius: 4,
              fontSize: 10,
              fontWeight: 700,
              textTransform: "uppercase",
              background: statusColors ? statusColors.background : divider,
              color: statusColors ? statusColors.color : textMuted,
            }}>
              {latestRun ? formatAgentRunStatus(latestRun.status) : "Agent Ready"}
            </span>
            <span style={{ fontSize: 11, color: textSub, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {detail}
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            {canResumeLatestRun && (
              <button
                onClick={onResumeRun}
                onMouseDown={stopDown}
                disabled={runActionPending !== null}
                title="Continue from the last checkpoint"
                style={{
                  height: 24,
                  padding: "0 8px",
                  borderRadius: 4,
                  border: `1px solid ${border}`,
                  background: bg,
                  color: text,
                  fontSize: 10,
                  fontWeight: 700,
                  cursor: runActionPending ? "not-allowed" : "pointer",
                  opacity: runActionPending ? 0.6 : 1,
                }}
              >
                {runActionPending === "resume" ? "Continuing…" : "Continue"}
              </button>
            )}
            {canCancelLatestRun && (
              <button
                onClick={onCancelRun}
                onMouseDown={stopDown}
                disabled={runActionPending !== null}
                title="Cancel the active workflow"
                style={{
                  height: 24,
                  padding: "0 8px",
                  borderRadius: 4,
                  border: `1px solid ${border}`,
                  background: bg,
                  color: textSub,
                  fontSize: 10,
                  fontWeight: 700,
                  cursor: runActionPending ? "not-allowed" : "pointer",
                  opacity: runActionPending ? 0.6 : 1,
                }}
              >
                {runActionPending === "cancel" ? "Cancelling…" : "Cancel"}
              </button>
            )}
            <button
              onClick={onRefresh}
              onMouseDown={stopDown}
              disabled={loading}
              title="Refresh"
              style={{ background: "none", border: "none", color: textSub, cursor: "pointer", padding: 4, borderRadius: 4, display: "flex" }}
              onMouseEnter={(e) => e.currentTarget.style.background = hoverBg}
              onMouseLeave={(e) => e.currentTarget.style.background = "none"}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ animation: loading ? "tfa-spin 1s linear infinite" : "none" }}>
                <path d="M21 12a9 9 0 1 1-6.219-8.56" /><polyline points="21 3 21 9 15 9" />
              </svg>
            </button>
            <button
              onClick={onClose}
              onMouseDown={stopDown}
              title="Close"
              style={{ background: "none", border: "none", color: textSub, cursor: "pointer", padding: 4, borderRadius: 4, display: "flex" }}
              onMouseEnter={(e) => e.currentTarget.style.background = hoverBg}
              onMouseLeave={(e) => e.currentTarget.style.background = "none"}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        {/* Progress summary — only show the count when task list is visible */}
        {progressSummary && !(latestRun?.tasks && latestRun.tasks.length > 0) && (
          <div
            style={{
              padding: "6px 14px",
              borderBottom: `1px solid ${divider}`,
              background: dark ? "rgba(255,255,255,0.02)" : "rgba(0,0,0,0.015)",
            }}
          >
            <div style={{ fontSize: 11, fontWeight: 700, color: text }}>
              {progressSummary}
            </div>
            {currentTask && (
              <div
                style={{
                  fontSize: 10,
                  color: textSub,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  marginTop: 2,
                }}
              >
                {currentTask.title}
                {currentTask.retryCount > 0 ? ` · retry ${currentTask.retryCount}` : ""}
              </div>
            )}
          </div>
        )}

        {/* Full Task List — Claude-Code style step-by-step plan */}
        {latestRun?.tasks && latestRun.tasks.length > 0 && (
          <div style={{ borderBottom: `1px solid ${divider}` }}>
            {/* Header row with progress summary + collapse toggle */}
            <div
              data-tfa-ui="task-list-header"
              onClick={() => setTasksCollapsed(c => !c)}
              style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: "5px 14px 4px", cursor: "pointer",
              }}
            >
              <span style={{ fontSize: 10, color: textMuted, fontWeight: 600 }}>
                {progressSummary || `${latestRun.tasks.length} steps`}
              </span>
              <span style={{ fontSize: 10, color: textMuted, lineHeight: 1, paddingLeft: 6 }}>
                {tasksCollapsed ? "▼" : "▲"}
              </span>
            </div>
            {!tasksCollapsed && (
            <div
              style={{
                padding: "0 14px 6px",
                maxHeight: 220,
                overflowY: "auto",
              }}
            >
            {latestRun.tasks.map((task) => {
              const isActive = task.status === "running" || task.status === "retrying";
              const icon =
                task.status === "pending"   ? "○" :
                task.status === "running"   ? "▶" :
                task.status === "retrying"  ? "↻" :
                task.status === "completed" ? "✓" :
                task.status === "skipped"   ? "⊘" : "✗";
              const iconColor =
                task.status === "completed" ? "#16a34a" :
                task.status === "failed"    ? "#b91c1c" :
                task.status === "skipped"   ? textMuted :
                isActive                    ? "#1d4ed8" : textMuted;

              return (
                <div
                  key={task._id}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 8,
                    padding: "3px 0",
                    fontSize: 11,
                    opacity: task.status === "pending" ? 0.5 : 1,
                  }}
                >
                  <span
                    style={{
                      color: iconColor,
                      flexShrink: 0,
                      width: 12,
                      fontWeight: 700,
                      paddingTop: 1,
                    }}
                  >
                    {icon}
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <span
                      style={{
                        color: isActive ? text : task.status === "completed" ? textMuted : text,
                        fontWeight: isActive ? 600 : 400,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        display: "block",
                      }}
                    >
                      {task.title}
                    </span>
                    {task.status === "running" && (
                      <span style={{ color: "#1d4ed8", fontSize: 10, display: "block" }}>
                        running…
                      </span>
                    )}
                    {task.status === "failed" && task.lastError && (
                      <span
                        style={{ color: "#b91c1c", fontSize: 10, display: "block" }}
                      >
                        {task.lastError.slice(0, 120)}
                      </span>
                    )}
                    {task.status === "retrying" && (
                      <span
                        style={{ color: "#d97706", fontSize: 10, display: "block" }}
                      >
                        Retrying (attempt {task.retryCount})…
                      </span>
                    )}
                    {task.status === "completed" && task.resultSummary && (
                      <span
                        style={{
                          color: task.verified === false ? "#d97706" : textMuted,
                          fontSize: 10,
                          display: "block",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {task.verified === false ? "⚠ unverified · " : ""}{task.resultSummary}
                      </span>
                    )}
                    {task.status === "completed" && task.observations && (
                      <span
                        style={{
                          color: textMuted,
                          fontSize: 10,
                          display: "block",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          fontStyle: "italic",
                        }}
                      >
                        {task.observations.slice(0, 100)}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
            </div>
            )}
          </div>
        )}

        {/* Input Area — hidden during active runs so take_snapshot never sees this textarea */}
        <div style={{ position: "relative", display: isAgentActive ? "none" : undefined }}>
          <textarea
            ref={inputRef}
            data-tfa-ui="agent-input"
            value={goal}
            onChange={(e) => onGoalChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onStart(); }
              if (e.key === "Escape") onClose();
            }}
            placeholder={isListening ? "Listening…" : placeholder}
            rows={2}
            style={{
              display: "block",
              width: "100%",
              boxSizing: "border-box",
              padding: "14px 14px 44px", // Bottom padding for absolute mic/start buttons
              fontSize: 14,
              lineHeight: 1.5,
              border: "none",
              background: "transparent",
              color: text,
              resize: "none",
              outline: "none",
              fontFamily: "inherit",
            }}
          />

          {/* Bottom Floating Controls */}
          <div style={{ position: "absolute", bottom: 8, left: 8, right: 8, display: "flex", justifyContent: "space-between", alignItems: "center", pointerEvents: "none" }}>
            <div style={{ display: "flex", gap: 6, pointerEvents: "auto" }}>
              {SR && (
                <button
                  type="button"
                  onClick={onVoiceToggle}
                  onMouseDown={stopDown}
                  style={{
                    width: 26, height: 26, borderRadius: 4, border: `1px solid ${isListening ? text : border}`,
                    background: isListening ? text : "transparent", color: isListening ? bg : textSub,
                    display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer",
                  }}
                >
                  {isListening ? (
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: bg, animation: "tfa-pulse 1s infinite" }} />
                  ) : (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v1a7 7 0 0 1-14 0v-1"/><line x1="12" y1="19" x2="12" y2="22"/></svg>
                  )}
                </button>
              )}
              <button
                type="button"
                onClick={() => onGoalChange(placeholder)}
                onMouseDown={stopDown}
                style={{
                  height: 26, padding: "0 8px", borderRadius: 4, border: `1px solid ${border}`,
                  background: bg, color: textSub, fontSize: 11, fontWeight: 600, cursor: "pointer",
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = hoverBg}
                onMouseLeave={(e) => e.currentTarget.style.background = bg}
              >
                Suggestion
              </button>
            </div>
            
            <div style={{ display: "flex", alignItems: "center", gap: 10, pointerEvents: "auto" }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: textMuted }}>Enter to run</div>
              <button
                type="button"
                onClick={onStart}
                onMouseDown={stopDown}
                disabled={primaryDisabled}
                style={{
                  width: 30, height: 30, borderRadius: 4, background: primary, color: bg, border: "none",
                  display: "flex", alignItems: "center", justifyContent: "center", cursor: primaryDisabled ? "not-allowed" : "pointer",
                  opacity: primaryDisabled ? 0.5 : 1, transition: "opacity 0.2s",
                }}
              >
                {starting ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ animation: "tfa-spin 1s linear infinite" }}><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="19" x2="12" y2="5" /><polyline points="5 12 12 5 19 12" /></svg>
                )}
              </button>
            </div>
          </div>
        </div>

        {/* Approvals Strip */}
        {firstApproval && (
          <div style={{ padding: "8px 14px", borderTop: `1px solid ${divider}`, background: dark ? "rgba(255,255,255,0.02)" : "rgba(0,0,0,0.01)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: text }}>{firstApproval.title}</div>
              <div style={{ fontSize: 10, color: textSub, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {summarizeApprovalPayload(firstApproval.payload) ?? "Review required."}
              </div>
            </div>
            <div style={{ display: "flex", gap: 4 }}>
              <button
                onClick={() => onResolve(firstApproval._id, "rejected")}
                disabled={actingApprovalId === firstApproval._id}
                style={{ height: 24, padding: "0 8px", borderRadius: 4, border: `1px solid ${border}`, background: bg, color: text, fontSize: 10, fontWeight: 700, cursor: "pointer" }}
              >
                Reject
              </button>
              <button
                onClick={() => onResolve(firstApproval._id, "approved")}
                disabled={actingApprovalId === firstApproval._id}
                style={{ height: 24, padding: "0 8px", borderRadius: 4, border: "none", background: text, color: bg, fontSize: 10, fontWeight: 800, cursor: "pointer" }}
              >
                Approve
              </button>
            </div>
          </div>
        )}
      </div>

      <style>{`
        @keyframes tfa-modal-in { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes tfa-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes tfa-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(0.75); } }
      `}</style>
    </div>,
    document.body
  );
}

export function AgentFAB({
  visible,
  platform,
  currentField,
  showToast,
}: AgentFABProps) {
  const dark = isPageDark();
  const [panelOpen, setPanelOpen] = useState(false);
  const [goal, setGoal] = useState("");
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [runtimeConnected, setRuntimeConnected] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string | undefined>();
  const [approvals, setApprovals] = useState<AgentApprovalListEntry[]>([]);
  const [runs, setRuns] = useState<AgentRunListEntry[]>([]);
  const [actingApprovalId, setActingApprovalId] = useState<string | null>(null);
  const [runActionPending, setRunActionPending] = useState<"cancel" | "resume" | null>(
    null
  );
  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const placeholder = useMemo(
    () => buildDefaultAgentGoal(platform, location.href),
    [platform]
  );

  const latestRun = runs[0] ?? null;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const snapshot = await fetchAgentPanelState(
        (message) => chrome.runtime.sendMessage(message),
        6
      );
      setAuthenticated(snapshot.authenticated);
      setRuntimeConnected(snapshot.runtimeConnected);
      setRuntimeError(snapshot.runtimeError);
      setRuns(snapshot.runs);
      setApprovals(snapshot.approvals);
    } catch (error: any) {
      showToast(error?.message ?? "Failed to load agent state", "error");
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  const latestRunStatus = latestRun?.status;

  useEffect(() => {
    if (!panelOpen) return;
    void refresh();

    const intervalId = window.setInterval(() => {
      void refresh();
    }, getAgentPanelPollMs(document.hidden, latestRun));
    const onVisibilityChange = () => void refresh();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelOpen, refresh, latestRunStatus]);

  useEffect(() => {
    return () => {
      try {
        recognitionRef.current?.stop();
      } catch {
        // ignore teardown stop errors
      }
      recognitionRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (panelOpen || !isListening) return;
    try {
      recognitionRef.current?.stop();
    } catch {
      // ignore close-time stop errors
    }
    recognitionRef.current = null;
    setIsListening(false);
  }, [isListening, panelOpen]);

  const toggleListening = useCallback(() => {
    if (!SR) {
      showToast("Speech recognition not supported in this browser", "error");
      return;
    }
    if (isListening) {
      setIsListening(false);
      try {
        recognitionRef.current?.stop();
      } catch {
        // ignore stop errors
      }
      recognitionRef.current = null;
      return;
    }

    const recognition = createRecognition();
    if (!recognition) {
      showToast("Speech recognition not supported in this browser", "error");
      return;
    }

    recognitionRef.current = recognition;
    let committed = goal;

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const chunk = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          committed += `${committed ? " " : ""}${chunk}`;
        } else {
          interim = chunk;
        }
      }
      setGoal(`${committed}${interim ? ` ${interim}` : ""}`.trim());
    };

    recognition.onend = () => {
      setGoal(committed.trim());
      setIsListening(false);
      recognitionRef.current = null;
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      setIsListening(false);
      recognitionRef.current = null;
      if (event.error !== "no-speech") {
        showToast(
          event.error === "not-allowed"
            ? "Microphone access denied"
            : `Voice error: ${event.error}`,
          "error"
        );
      }
    };

    try {
      recognition.start();
      setIsListening(true);
    } catch {
      recognitionRef.current = null;
      setIsListening(false);
      showToast("Could not start microphone", "error");
    }
  }, [goal, isListening, showToast]);

  const handleStart = useCallback(async () => {
    if (!runtimeConnected) {
      showToast(
        runtimeError ??
          "Start the local companion on your device before launching agent runs.",
        "error"
      );
      return;
    }

    setStarting(true);
    try {
      const bootstrap = buildAgentRunBootstrapContext(platform);
      const result = await startAgentRun(
        (message) => chrome.runtime.sendMessage(message),
        currentField
          ? {
              goal,
              platformHint: platform,
              pageUrl: bootstrap.pageUrl,
              scannedCandidates: bootstrap.scannedCandidates,
              workItems: bootstrap.workItems,
              nextPageUrl: bootstrap.nextPageUrl,
              structured: bootstrap.structured,
              ...buildAgentRunStartContext(currentField, platform),
            }
          : {
              goal,
              platformHint: platform,
              ...bootstrap,
            }
      );

      showToast("Agent run started", "success");
      setGoal("");
      setPanelOpen(true);
      await refresh();
      if (!result.runId) {
        throw new Error("Agent run did not return an id");
      }
    } catch (error: any) {
      showToast(error?.message ?? "Failed to start agent run", "error");
    } finally {
      setStarting(false);
    }
  }, [
    currentField,
    goal,
    platform,
    refresh,
    runtimeConnected,
    runtimeError,
    showToast,
  ]);

  const handleResolve = useCallback(
    async (approvalId: string, decision: "approved" | "rejected") => {
      setActingApprovalId(approvalId);
      try {
        await resolveAgentApproval((message) => chrome.runtime.sendMessage(message), {
          approvalId,
          decision,
        });
        if (decision === "approved") {
          scheduleTaskQueueNudge();
        }
        showToast(
          decision === "approved" ? "Approval recorded" : "Approval rejected",
          decision === "approved" ? "success" : "info"
        );
        await refresh();
      } catch (error: any) {
        showToast(error?.message ?? "Failed to resolve approval", "error");
      } finally {
        setActingApprovalId(null);
      }
    },
    [refresh, showToast]
  );

  const handleCancelRun = useCallback(async () => {
    if (!latestRun?.workflowId) {
      showToast("This run cannot be cancelled from the panel.", "info");
      return;
    }

    setRunActionPending("cancel");
    try {
      await cancelAgentRun((message) => chrome.runtime.sendMessage(message), {
        runId: latestRun._id,
      });
      showToast("Run cancelled", "info");
      await refresh();
    } catch (error: any) {
      showToast(error?.message ?? "Failed to cancel run", "error");
    } finally {
      setRunActionPending(null);
    }
  }, [latestRun, refresh, showToast]);

  const handleResumeRun = useCallback(async () => {
    if (!latestRun) {
      return;
    }

    setRunActionPending("resume");
    try {
      const bootstrap = buildAgentRunBootstrapContext(platform);
      await resumeAgentRun((message) => chrome.runtime.sendMessage(message), {
        runId: latestRun._id,
        goal: latestRun.goal,
        platformHint: platform,
        pageUrl: bootstrap.pageUrl,
        pageContext: bootstrap.pageContext,
        scannedCandidates: bootstrap.scannedCandidates,
        workItems: bootstrap.workItems,
        nextPageUrl: bootstrap.nextPageUrl,
        structured: bootstrap.structured,
        ...(currentField
          ? { fieldTarget: buildAgentRunStartContext(currentField, platform).fieldTarget }
          : {}),
      });
      showToast("Run continued from the last checkpoint", "success");
      await refresh();
    } catch (error: any) {
      showToast(error?.message ?? "Failed to continue run", "error");
    } finally {
      setRunActionPending(null);
    }
  }, [currentField, latestRun, platform, refresh, showToast]);

  const swallowPointer = (event: ReactPointerEvent | ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };

  if (!visible) return null;

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        data-tfa-ui="agent-fab"
        aria-hidden={
          (latestRun?.status === "executing" || latestRun?.status === "planning")
            ? "true"
            : undefined
        }
        title="Agent Command Center"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setPanelOpen((current) => !current);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setPanelOpen((current) => !current);
          }
        }}
        onPointerDown={swallowPointer}
        onMouseDown={swallowPointer}
        style={{
          position: "fixed",
          bottom: 20,
          right: 26,
          zIndex: 2147483647,
          width: 28,
          height: 28,
          padding: 0,
          border: dark
            ? "1px solid rgba(255,255,255,0.14)"
            : "1px solid rgba(0,0,0,0.08)",
          borderRight: "none",
          borderRadius: "6px 0 0 6px",
          background: dark ? "#303030" : "#181818",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: dark
            ? "-3px 2px 10px rgba(0,0,0,0.55)"
            : "-3px 2px 10px rgba(0,0,0,0.22)",
          transition: "background 0.15s ease",
          pointerEvents: "auto",
          overflow: "visible",
        }}
        onMouseEnter={(event) => { event.currentTarget.style.background = dark ? "#444444" : "#2a2a2a"; }}
        onMouseLeave={(event) => { event.currentTarget.style.background = dark ? "#303030" : "#181818"; }}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          style={{ display: "block", stroke: "#ffffff", fill: "none", strokeWidth: 2.8, strokeLinecap: "round", strokeLinejoin: "round" }}
        >
          <path d="M19 12H5" style={{ stroke: "#ffffff" }} />
          <path d="m11 18-6-6 6-6" style={{ stroke: "#ffffff" }} />
        </svg>
        {approvals.length > 0 ? (
          <span
            style={{
              position: "absolute",
              top: -4,
              left: -4,
              minWidth: 14,
              height: 14,
              background: "#ffffff",
              border: "1.5px solid rgba(12,12,12,0.88)",
              borderRadius: 7,
              fontSize: 8,
              fontWeight: 800,
              color: "#000000",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "0 2px",
              boxSizing: "border-box",
              pointerEvents: "none",
              lineHeight: 1,
            }}
          >
            {approvals.length}
          </span>
        ) : null}
      </div>

      {panelOpen && (
        <AgentComposer
          dark={dark}
          goal={goal}
          authenticated={authenticated}
          runtimeConnected={runtimeConnected}
          runtimeError={runtimeError}
          placeholder={placeholder}
          loading={loading}
          starting={starting}
          latestRun={latestRun}
          approvals={approvals}
          actingApprovalId={actingApprovalId}
          runActionPending={runActionPending}
          onGoalChange={setGoal}
          onRefresh={() => void refresh()}
          onStart={() => void handleStart()}
          onCancelRun={() => void handleCancelRun()}
          onResumeRun={() => void handleResumeRun()}
          onResolve={(approvalId, decision) => {
            void handleResolve(approvalId, decision);
          }}
          onClose={() => setPanelOpen(false)}
          isListening={isListening}
          onVoiceToggle={toggleListening}
        />
      )}
    </>
  );
}
