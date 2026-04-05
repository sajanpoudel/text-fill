import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { isPageDark } from "../../src/lib/dom/theme.ts";
import {
  buildDefaultAgentGoal,
  fetchAgentPanelState,
  formatAgentRunStatus,
  getAgentPanelPollMs,
  getAgentRunSummary,
  normalizeAgentGoal,
  resolveAgentApproval,
  startAgentRun,
  summarizeApprovalPayload,
  type AgentPanelApproval as AgentApprovalListEntry,
  type AgentPanelRun as AgentRunListEntry,
} from "../../src/lib/agent-panel-runtime.ts";
import { buildAgentRunStartContext } from "../../src/lib/agent-run-context.ts";
import type { PlatformKey } from "../../src/lib/platform.ts";

type ToastType = "success" | "error" | "info";

interface AgentFABProps {
  visible: boolean;
  platform: PlatformKey;
  currentField: Element | null;
  showToast: (msg: string, type?: ToastType) => void;
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function getStatusColors(status: string, dark: boolean) {
  switch (status) {
    case "completed":
    case "approved":
      return {
        background: dark ? "rgba(22,101,52,0.25)" : "rgba(22,101,52,0.08)",
        color: dark ? "#bbf7d0" : "#166534",
      };
    case "awaiting_approval":
    case "planning":
    case "executing":
    case "running":
      return {
        background: dark ? "rgba(37,99,235,0.25)" : "rgba(37,99,235,0.08)",
        color: dark ? "#bfdbfe" : "#1d4ed8",
      };
    case "failed":
    case "rejected":
    case "cancelled":
      return {
        background: dark ? "rgba(220,38,38,0.25)" : "rgba(220,38,38,0.08)",
        color: dark ? "#fecaca" : "#b91c1c",
      };
    default:
      return {
        background: dark ? "rgba(168,85,247,0.22)" : "rgba(120,113,108,0.08)",
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

function AgentPanel({
  dark,
  goal,
  runs,
  approvals,
  authenticated,
  placeholder,
  loading,
  starting,
  actingApprovalId,
  onGoalChange,
  onRefresh,
  onStart,
  onResolve,
  onClose,
  fabRef,
}: {
  dark: boolean;
  goal: string;
  runs: AgentRunListEntry[];
  approvals: AgentApprovalListEntry[];
  authenticated: boolean;
  placeholder: string;
  loading: boolean;
  starting: boolean;
  actingApprovalId: string | null;
  onGoalChange: (next: string) => void;
  onRefresh: () => void;
  onStart: () => void;
  onResolve: (
    approvalId: string,
    decision: "approved" | "rejected"
  ) => void;
  onClose: () => void;
  fabRef: RefObject<HTMLButtonElement | null>;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ right: number; bottom: number }>({
    right: 64,
    bottom: 60,
  });

  const swallowPointer = (event: ReactPointerEvent | ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };

  useEffect(() => {
    if (!fabRef.current) return;
    const rect = fabRef.current.getBoundingClientRect();
    const PANEL_W = 336;
    const right = Math.max(window.innerWidth - rect.right, 8);
    const bottom = window.innerHeight - rect.top + 8;
    setPos({
      right: Math.min(right, Math.max(8, window.innerWidth - PANEL_W - 8)),
      bottom,
    });
  }, [fabRef]);

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      const path = event.composedPath ? event.composedPath() : [];
      const fab = fabRef.current;
      if (
        panelRef.current &&
        !path.includes(panelRef.current) &&
        !(fab && path.includes(fab))
      ) {
        onClose();
      }
    };
    const timer = window.setTimeout(() => {
      document.addEventListener("click", handler, true);
    }, 50);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("click", handler, true);
    };
  }, [fabRef, onClose]);

  const bg = dark ? "#111111" : "#ffffff";
  const border = dark ? "#333333" : "#e5e5e5";
  const muted = dark ? "#a8a29e" : "#57534e";
  const title = dark ? "#ffffff" : "#0f172a";

  return (
    <div
      ref={panelRef}
      data-tfa-ui="agent-panel"
      style={{
        position: "fixed",
        right: pos.right,
        bottom: pos.bottom,
        zIndex: 2147483647,
        width: 336,
        maxHeight: 460,
        background: bg,
        border: `1px solid ${border}`,
        borderRadius: 12,
        boxShadow: dark
          ? "0 16px 48px rgba(0,0,0,0.72)"
          : "0 16px 48px rgba(15,23,42,0.16)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        pointerEvents: "auto",
        fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
        animation: "tfa-fadein 0.15s cubic-bezier(0.16,1,0.3,1)",
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 14px",
          borderBottom: `1px solid ${border}`,
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span
            style={{
              fontSize: 12,
              fontWeight: 800,
              color: title,
              textTransform: "uppercase",
              letterSpacing: "0.5px",
            }}
          >
            Agent Tasks
          </span>
          <span style={{ fontSize: 11, color: muted }}>
            Start a durable run or review approval gates.
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            type="button"
            onClick={onRefresh}
            onPointerDown={swallowPointer}
            onMouseDown={swallowPointer}
            style={{
              border: "none",
              background: "none",
              cursor: loading ? "wait" : "pointer",
              padding: 0,
              color: muted,
              fontSize: 11,
              fontWeight: 700,
            }}
            disabled={loading}
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={onClose}
            onPointerDown={swallowPointer}
            onMouseDown={swallowPointer}
            style={{
              border: "none",
              background: "none",
              cursor: "pointer",
              padding: 0,
              color: muted,
              fontSize: 18,
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>
      </div>

      <div style={{ padding: "14px", borderBottom: `1px solid ${border}` }}>
        {!authenticated ? (
          <div style={{ fontSize: 13, lineHeight: 1.5, color: muted }}>
            Sign in through the extension popup to start durable agent runs.
          </div>
        ) : (
          <>
            <label
              htmlFor="tfa-agent-goal"
              style={{
                display: "block",
                marginBottom: 8,
                fontSize: 12,
                fontWeight: 700,
                color: title,
              }}
            >
              Goal for this page
            </label>
            <textarea
              id="tfa-agent-goal"
              value={goal}
              onChange={(event) => onGoalChange(event.target.value)}
              placeholder={placeholder}
              rows={3}
              style={{
                width: "100%",
                resize: "vertical",
                minHeight: 74,
                padding: "10px 12px",
                borderRadius: 10,
                border: `1px solid ${border}`,
                background: dark ? "#292524" : "#ffffff",
                color: title,
                fontSize: 13,
                lineHeight: 1.5,
                fontFamily: "inherit",
                boxSizing: "border-box",
              }}
            />
            <div
              style={{
                marginTop: 6,
                fontSize: 11,
                lineHeight: 1.4,
                color: muted,
              }}
            >
              {goal || "Describe a bounded task for the current page."}
            </div>
            <div
              style={{
                marginTop: 10,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
              }}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span style={{ fontSize: 11, color: muted }}>
                  Agent runs are durable and stop for approval before irreversible actions.
                </span>
                <button
                  type="button"
                  onClick={() => onGoalChange(placeholder)}
                  onPointerDown={swallowPointer}
                  onMouseDown={swallowPointer}
                  style={{
                    alignSelf: "flex-start",
                    border: "none",
                    background: "none",
                    padding: 0,
                    color: dark ? "#bfdbfe" : "#1d4ed8",
                    cursor: "pointer",
                    fontSize: 11,
                    fontWeight: 700,
                  }}
                >
                  Use page suggestion
                </button>
              </div>
              <button
                type="button"
                onClick={onStart}
                onPointerDown={swallowPointer}
                onMouseDown={swallowPointer}
                disabled={starting || !normalizeAgentGoal(goal)}
                style={{
                  border: "none",
                  borderRadius: 8,
                  background: dark ? "#ffffff" : "#111827",
                  color: dark ? "#000000" : "#ffffff",
                  padding: "9px 12px",
                  minWidth: 92,
                  cursor:
                    starting || !normalizeAgentGoal(goal) ? "not-allowed" : "pointer",
                  fontSize: 12,
                  fontWeight: 700,
                }}
              >
                {starting ? "Starting…" : "Start Run"}
              </button>
            </div>
          </>
        )}
      </div>

      <div style={{ flex: 1, overflowY: "auto" }}>
        <div style={{ padding: "14px", borderBottom: `1px solid ${border}` }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 10,
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 800, color: title }}>
              Pending Approvals
            </span>
            <span style={{ fontSize: 11, color: muted }}>{approvals.length}</span>
          </div>
          {approvals.length === 0 ? (
            <div style={{ fontSize: 12, color: muted, lineHeight: 1.5 }}>
              No approval gates are waiting right now.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {approvals.map((approval) => {
                const generatedText = summarizeApprovalPayload(approval.payload);
                return (
                  <div
                    key={approval._id}
                    style={{
                      border: `1px solid ${border}`,
                      borderRadius: 10,
                      padding: "10px 12px",
                      background: dark ? "#292524" : "#ffffff",
                    }}
                  >
                    <div style={{ fontSize: 13, fontWeight: 700, color: title }}>
                      {approval.title}
                    </div>
                    <div
                      style={{
                        marginTop: 4,
                        fontSize: 12,
                        lineHeight: 1.5,
                        color: muted,
                      }}
                    >
                      {approval.reason}
                    </div>
                    {generatedText ? (
                      <div
                        style={{
                          marginTop: 8,
                          fontSize: 12,
                          lineHeight: 1.5,
                          color: title,
                          padding: "8px 10px",
                          borderRadius: 8,
                          background: dark ? "#0c0a09" : "#ffffff",
                          border: `1px solid ${border}`,
                        }}
                      >
                        {generatedText}
                      </div>
                    ) : null}
                    <div
                      style={{
                        marginTop: 10,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 8,
                      }}
                    >
                      <span style={{ fontSize: 11, color: muted }}>
                        {relativeTime(approval.createdAt)}
                      </span>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button
                          type="button"
                          onClick={() => onResolve(approval._id, "rejected")}
                          disabled={actingApprovalId === approval._id}
                          style={{
                            borderRadius: 8,
                            border: `1px solid ${border}`,
                            background: "transparent",
                            color: title,
                            padding: "7px 10px",
                            fontSize: 12,
                            fontWeight: 700,
                            cursor:
                              actingApprovalId === approval._id ? "wait" : "pointer",
                          }}
                        >
                          Reject
                        </button>
                        <button
                          type="button"
                          onClick={() => onResolve(approval._id, "approved")}
                          disabled={actingApprovalId === approval._id}
                          style={{
                            borderRadius: 8,
                            border: "none",
                            background: dark ? "#ffffff" : "#111827",
                            color: dark ? "#000000" : "#ffffff",
                            padding: "7px 10px",
                            fontSize: 12,
                            fontWeight: 700,
                            cursor:
                              actingApprovalId === approval._id ? "wait" : "pointer",
                          }}
                        >
                          {actingApprovalId === approval._id ? "Saving…" : "Approve"}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div style={{ padding: "14px" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 10,
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 800, color: title }}>
              Recent Runs
            </span>
            <span style={{ fontSize: 11, color: muted }}>{runs.length}</span>
          </div>
          {runs.length === 0 ? (
            <div style={{ fontSize: 12, color: muted, lineHeight: 1.5 }}>
              No durable agent runs yet for this account.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {runs.map((run) => {
                const statusColors = getStatusColors(run.status, dark);
                return (
                  <div
                    key={run._id}
                    style={{
                      border: `1px solid ${border}`,
                      borderRadius: 10,
                      padding: "10px 12px",
                      background: dark ? "#292524" : "#ffffff",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 10,
                      }}
                    >
                      <div
                        style={{
                          fontSize: 13,
                          fontWeight: 700,
                          color: title,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={run.goal}
                      >
                        {run.goal}
                      </div>
                      <span
                        style={{
                          flexShrink: 0,
                          padding: "3px 8px",
                          borderRadius: 999,
                          fontSize: 10,
                          fontWeight: 800,
                          background: statusColors.background,
                          color: statusColors.color,
                        }}
                      >
                        {formatAgentRunStatus(run.status)}
                      </span>
                    </div>
                    <div
                      style={{
                        marginTop: 6,
                        fontSize: 12,
                        lineHeight: 1.5,
                        color: muted,
                      }}
                    >
                      {getAgentRunSummary(run)}
                    </div>
                    <div style={{ marginTop: 8, fontSize: 11, color: muted }}>
                      Updated {relativeTime(run.updatedAt)}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
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
  const [approvals, setApprovals] = useState<AgentApprovalListEntry[]>([]);
  const [runs, setRuns] = useState<AgentRunListEntry[]>([]);
  const [actingApprovalId, setActingApprovalId] = useState<string | null>(null);
  const fabRef = useRef<HTMLButtonElement>(null);
  const placeholder = useMemo(
    () => buildDefaultAgentGoal(platform, location.href),
    [platform]
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const snapshot = await fetchAgentPanelState(
        (message) => chrome.runtime.sendMessage(message),
        6
      );
      setAuthenticated(snapshot.authenticated);
      setRuns(snapshot.runs);
      setApprovals(snapshot.approvals);
    } catch (error: any) {
      showToast(error?.message ?? "Failed to load agent state", "error");
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    if (!panelOpen) return;
    void refresh();

    const intervalId = window.setInterval(() => {
      void refresh();
    }, getAgentPanelPollMs(document.hidden));
    const onVisibilityChange = () => void refresh();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [panelOpen, refresh]);

  const handleStart = useCallback(async () => {
    setStarting(true);
    try {
      const result = await startAgentRun(
        (message) => chrome.runtime.sendMessage(message),
        currentField
          ? {
              goal,
              platformHint: platform,
              ...buildAgentRunStartContext(currentField, platform),
            }
          : {
              goal,
              platformHint: platform,
            }
      );

      showToast("Agent run started", "success");
      setGoal("");
      await refresh();
      if (!result.runId) {
        throw new Error("Agent run did not return an id");
      }
    } catch (error: any) {
      showToast(error?.message ?? "Failed to start agent run", "error");
    } finally {
      setStarting(false);
    }
  }, [currentField, goal, platform, refresh, showToast]);

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

  const swallowPointer = (event: ReactPointerEvent | ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };

  if (!visible) return null;

  return (
    <>
      <button
        ref={fabRef}
        type="button"
        data-tfa-ui="agent-fab"
        title="Agent tasks — durable runs and approvals"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setPanelOpen((current) => !current);
        }}
        onPointerDown={swallowPointer}
        onMouseDown={swallowPointer}
        style={{
          position: "fixed",
          bottom: 20,
          right: 60,
          zIndex: 2147483647,
          width: 32,
          height: 32,
          padding: 0,
          border: `1px solid ${dark ? "rgba(68, 64, 60, 0.5)" : "rgba(231, 229, 228, 0.5)"}`,
          borderRadius: "50%",
          background: dark ? "rgba(28, 25, 23, 0.7)" : "rgba(252, 252, 251, 0.7)",
          backdropFilter: "blur(8px)",
          WebkitBackdropFilter: "blur(8px)",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: dark
            ? "0 2px 10px rgba(0,0,0,0.5)"
            : "0 2px 10px rgba(0,0,0,0.1)",
          transition: "transform 0.15s ease, box-shadow 0.15s ease",
          pointerEvents: "auto",
        }}
        onMouseEnter={(event) => {
          event.currentTarget.style.transform = "scale(1.1)";
          event.currentTarget.style.boxShadow = dark
            ? "0 4px 16px rgba(0,0,0,0.6)"
            : "0 4px 16px rgba(0,0,0,0.15)";
        }}
        onMouseLeave={(event) => {
          event.currentTarget.style.transform = "scale(1)";
          event.currentTarget.style.boxShadow = dark
            ? "0 2px 10px rgba(0,0,0,0.5)"
            : "0 2px 10px rgba(0,0,0,0.1)";
        }}
      >
        <span
          style={{
            fontSize: 11,
            lineHeight: 1,
            fontWeight: 800,
            color: dark ? "#fcfcfb" : "#1c1917",
            fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
          }}
        >
          AI
        </span>
        {approvals.length > 0 ? (
          <span
            style={{
              position: "absolute",
              top: -4,
              right: -4,
              minWidth: 16,
              height: 16,
              background: dark ? "#fcfcfb" : "#7f1d1d",
              border: `2px solid ${dark ? "#44403c" : "#fcfcfb"}`,
              borderRadius: 8,
              fontSize: 9,
              fontWeight: 800,
              color: dark ? "#1c1917" : "#ffffff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "0 3px",
              boxSizing: "border-box",
              pointerEvents: "none",
              lineHeight: 1,
            }}
          >
            {approvals.length}
          </span>
        ) : null}
      </button>

      {panelOpen ? (
        <AgentPanel
          dark={dark}
          goal={goal}
          runs={runs}
          approvals={approvals}
          authenticated={authenticated}
          placeholder={placeholder}
          loading={loading}
          starting={starting}
          actingApprovalId={actingApprovalId}
          onGoalChange={setGoal}
          onRefresh={() => {
            void refresh();
          }}
          onStart={() => {
            void handleStart();
          }}
          onResolve={(approvalId, decision) => {
            void handleResolve(approvalId, decision);
          }}
          onClose={() => setPanelOpen(false)}
          fabRef={fabRef}
        />
      ) : null}
    </>
  );
}
