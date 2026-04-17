import type { PlatformKey } from "./platform.ts";
import type { AgentFieldTarget } from "./agent-run-context.ts";
import type {
  LocalCompanionBrowserWorkItem,
  LocalCompanionCandidateScanItem,
  LocalCompanionRunProgress,
  LocalCompanionRunTask,
  LocalCompanionStructuredExtraction,
} from "./local-agent-protocol.ts";

export type AgentRunStatus =
  | "created"
  | "planning"
  | "executing"
  | "awaiting_approval"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export interface AgentPanelApproval {
  _id: string;
  runId?: string;
  approvalKind: string;
  title: string;
  reason?: string;
  payload?: Record<string, unknown>;
  status: string;
  expiresAt?: number;
  createdAt: number;
}

export interface AgentPanelRun {
  _id: string;
  goal: string;
  platformHint?: string;
  status: AgentRunStatus;
  resumeSourceRunId?: string;
  workflowId?: string;
  workflowRunId?: string;
  workflowStatus?: string;
  latestSummary?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  lastError?: string;
  progress?: LocalCompanionRunProgress;
  tasks?: LocalCompanionRunTask[];
}

export interface AgentPanelState {
  authenticated: boolean;
  approvals: AgentPanelApproval[];
  runs: AgentPanelRun[];
  runtime: "local_companion" | "legacy_convex";
  runtimeConnected: boolean;
  runtimeError?: string;
}

type RuntimeResponse = {
  error?: string;
} & Record<string, unknown>;

type RuntimeSender = (message: Record<string, unknown>) => Promise<RuntimeResponse>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function getAgentPanelPollMs(hidden: boolean): number {
  return hidden ? 15_000 : 5_000;
}

export function normalizeAgentGoal(goal: string, maxLength = 280): string {
  return goal.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

export function buildDefaultAgentGoal(
  platform: PlatformKey,
  pageUrl: string
): string {
  if (platform === "linkedin" && /linkedin\.com\/search\/results\/people/i.test(pageUrl)) {
    return "Find relevant LinkedIn profiles on this page and execute the requested outreach workflow directly in the browser.";
  }

  if (platform === "linkedin" && /linkedin\.com\/in\//i.test(pageUrl)) {
    return "Handle the requested LinkedIn action for this profile directly in the browser.";
  }

  if (platform === "gmail" || platform === "outlook") {
    return "Draft and place a reply for this email thread directly in the compose field.";
  }

  if (
    [
      "messenger",
      "facebook",
      "twitter",
      "threads",
      "instagram",
      "youtube",
      "reddit",
      "slack",
      "discord",
      "canvas",
    ].includes(platform)
  ) {
    return "Draft and place a context-aware reply for this conversation directly in the compose field.";
  }

  return "Inspect this page and complete the requested browser task directly using the local Chrome agent.";
}

export function formatAgentRunStatus(status: AgentRunStatus): string {
  switch (status) {
    case "awaiting_approval":
      return "Awaiting approval";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "planning":
      return "Planning";
    case "executing":
      return "Executing";
    case "paused":
      return "Paused";
    case "created":
      return "Created";
    default:
      return status;
  }
}

export function getAgentRunSummary(run: AgentPanelRun): string {
  const latestSummary =
    typeof run.latestSummary === "string" ? run.latestSummary.trim() : "";
  if (latestSummary) return latestSummary;

  const lastError =
    typeof run.lastError === "string" ? run.lastError.trim() : "";
  if (lastError) return lastError;

  switch (run.status) {
    case "planning":
      return "Preparing the local Chrome agent.";
    case "executing":
      return "Executing browser steps through the local Chrome agent.";
    case "awaiting_approval":
      return "Waiting for explicit approval before continuing.";
    case "paused":
      return "Paused and waiting for user action.";
    case "completed":
      return "Run completed.";
    case "failed":
      return "Run failed.";
    case "cancelled":
      return "Run cancelled.";
    default:
      return "Run created.";
  }
}

export function getAgentRunProgressSummary(run: AgentPanelRun): string | null {
  if (!run.progress) return null;
  const parts = [`${run.progress.completedTasks}/${run.progress.totalTasks} complete`];
  if (run.progress.retryingTasks > 0) {
    parts.push(`${run.progress.retryingTasks} retrying`);
  }
  if (run.progress.blockedTasks > 0) {
    parts.push(`${run.progress.blockedTasks} blocked`);
  }
  if (run.progress.skippedTasks > 0) {
    parts.push(`${run.progress.skippedTasks} skipped`);
  }
  return parts.join(" · ");
}

export function getAgentRunCurrentTask(run: AgentPanelRun): LocalCompanionRunTask | null {
  if (!Array.isArray(run.tasks) || run.tasks.length === 0) return null;
  if (run.status === "completed") {
    return (
      [...run.tasks].reverse().find((task) => task.status === "completed") ??
      run.tasks.at(-1) ??
      run.tasks[0]
    );
  }
  return (
    run.tasks.find((task) => task.status === "running" || task.status === "retrying") ??
    run.tasks.find((task) => task.status === "blocked") ??
    run.tasks[run.progress?.currentTaskIndex ?? 0] ??
    run.tasks[0]
  );
}

export function summarizeApprovalPayload(
  payload: Record<string, unknown> | undefined
): string | null {
  if (!payload) return null;
  const items = Array.isArray(payload.items)
    ? payload.items.filter((item): item is Record<string, unknown> => isPlainObject(item))
    : [];
  if (items.length > 0) {
    if (items.length === 1) {
      const generatedText =
        typeof items[0].generatedText === "string" && items[0].generatedText.trim()
          ? items[0].generatedText.trim()
          : null;
      if (generatedText) return generatedText;

      const targetName =
        typeof items[0].targetName === "string" && items[0].targetName.trim()
          ? items[0].targetName.trim()
          : null;
      if (targetName) {
        return `Target: ${targetName}`;
      }

      const targetUrl =
        typeof items[0].targetUrl === "string" && items[0].targetUrl.trim()
          ? items[0].targetUrl.trim()
          : null;
      return targetUrl ? `Target URL: ${targetUrl}` : null;
    }

    const previewNames = items
      .map((item) =>
        typeof item.targetName === "string" && item.targetName.trim()
          ? item.targetName.trim()
          : null
      )
      .filter((name): name is string => Boolean(name))
      .slice(0, 3);
    if (previewNames.length > 0) {
      const extraCount = items.length - previewNames.length;
      return `Targets (${items.length}): ${previewNames.join(", ")}${extraCount > 0 ? ` +${extraCount} more` : ""}`;
    }
    return `Targets queued: ${items.length}`;
  }

  const generatedText =
    typeof payload.generatedText === "string" && payload.generatedText.trim()
      ? payload.generatedText.trim()
      : null;
  if (generatedText) return generatedText;

  const targetName =
    typeof payload.targetName === "string" && payload.targetName.trim()
      ? payload.targetName.trim()
      : null;
  if (targetName) {
    return `Target: ${targetName}`;
  }

  const targetUrl =
    typeof payload.targetUrl === "string" && payload.targetUrl.trim()
      ? payload.targetUrl.trim()
      : null;
  return targetUrl ? `Target URL: ${targetUrl}` : null;
}

async function sendRuntimeMessage<T>(
  sendMessage: RuntimeSender,
  message: Record<string, unknown>,
  normalize: (response: RuntimeResponse) => T
): Promise<T> {
  const response = await sendMessage(message);
  if (typeof response?.error === "string" && response.error) {
    throw new Error(response.error);
  }
  return normalize(response ?? {});
}

export async function fetchAgentPanelState(
  sendMessage: RuntimeSender,
  limit = 5
): Promise<AgentPanelState> {
  return sendRuntimeMessage(
    sendMessage,
    { type: "GET_AGENT_PANEL_STATE", payload: { limit } },
    (response) => ({
      authenticated: response.authenticated === true,
      approvals: Array.isArray(response.approvals)
        ? (response.approvals as AgentPanelApproval[])
        : [],
      runs: Array.isArray(response.runs) ? (response.runs as AgentPanelRun[]) : [],
      runtime:
        response.runtime === "legacy_convex" ? "legacy_convex" : "local_companion",
      runtimeConnected:
        response.runtimeConnected === false ? false : response.authenticated === true,
      runtimeError:
        typeof response.runtimeError === "string" && response.runtimeError.trim()
          ? response.runtimeError
          : undefined,
    })
  );
}

export async function startAgentRun(
  sendMessage: RuntimeSender,
  args: {
    goal: string;
    platformHint?: PlatformKey;
    pageUrl?: string;
    pageContext?: string;
    fieldTarget?: AgentFieldTarget;
    scannedCandidates?: LocalCompanionCandidateScanItem[];
    workItems?: LocalCompanionBrowserWorkItem[];
    nextPageUrl?: string | null;
    structured?: LocalCompanionStructuredExtraction | null;
  }
): Promise<{ runId: string; runtimeId?: string }> {
  const goal = normalizeAgentGoal(args.goal);
  if (!goal) {
    throw new Error("Goal is required");
  }

  return sendRuntimeMessage(
    sendMessage,
    {
      type: "START_AGENT_RUN",
      payload: {
        goal,
        platformHint: args.platformHint,
        pageUrl:
          typeof args.pageUrl === "string" && args.pageUrl.trim()
            ? args.pageUrl
            : undefined,
        pageContext:
          typeof args.pageContext === "string" && args.pageContext.trim()
            ? args.pageContext
            : undefined,
        fieldTarget: args.fieldTarget,
        scannedCandidates: Array.isArray(args.scannedCandidates)
          ? args.scannedCandidates
          : undefined,
        workItems: Array.isArray(args.workItems) ? args.workItems : undefined,
        nextPageUrl:
          typeof args.nextPageUrl === "string" || args.nextPageUrl === null
            ? args.nextPageUrl
            : undefined,
        structured:
          args.structured && isPlainObject(args.structured)
            ? args.structured
            : undefined,
      },
    },
    (response) => {
      if (!isPlainObject(response) || typeof response.runId !== "string") {
        throw new Error("Invalid agent run response");
      }
      return {
        runId: response.runId,
        runtimeId:
          typeof response.runtimeId === "string" ? response.runtimeId : undefined,
      };
    }
  );
}

export async function cancelAgentRun(
  sendMessage: RuntimeSender,
  args: {
    runId: string;
  }
): Promise<{ ok: boolean; status: string; runId: string }> {
  if (!args.runId.trim()) {
    throw new Error("Run id is required");
  }

  return sendRuntimeMessage(
    sendMessage,
    {
      type: "CANCEL_AGENT_RUN",
      payload: {
        runId: args.runId.trim(),
      },
    },
    (response) => {
      if (!isPlainObject(response) || typeof response.runId !== "string") {
        throw new Error("Invalid cancel agent run response");
      }
      return {
        ok: response.ok === true,
        status: typeof response.status === "string" ? response.status : "unknown",
        runId: response.runId,
      };
    }
  );
}

export async function resumeAgentRun(
  sendMessage: RuntimeSender,
  args: {
    runId: string;
    goal?: string;
    platformHint?: PlatformKey;
    pageUrl?: string;
    pageContext?: string;
    fieldTarget?: AgentFieldTarget;
    scannedCandidates?: LocalCompanionCandidateScanItem[];
    workItems?: LocalCompanionBrowserWorkItem[];
    nextPageUrl?: string | null;
    structured?: LocalCompanionStructuredExtraction | null;
  }
): Promise<{ ok: boolean; status: string; runId: string; runtimeId?: string }> {
  if (!args.runId.trim()) {
    throw new Error("Run id is required");
  }

  return sendRuntimeMessage(
    sendMessage,
    {
      type: "RESUME_AGENT_RUN",
      payload: {
        runId: args.runId.trim(),
        goal:
          typeof args.goal === "string" && args.goal.trim()
            ? args.goal.trim()
            : undefined,
        platformHint: args.platformHint,
        pageUrl:
          typeof args.pageUrl === "string" && args.pageUrl.trim()
            ? args.pageUrl
            : undefined,
        pageContext:
          typeof args.pageContext === "string" && args.pageContext.trim()
            ? args.pageContext
            : undefined,
        fieldTarget: args.fieldTarget,
        scannedCandidates: Array.isArray(args.scannedCandidates)
          ? args.scannedCandidates
          : undefined,
        workItems: Array.isArray(args.workItems) ? args.workItems : undefined,
        nextPageUrl:
          typeof args.nextPageUrl === "string" || args.nextPageUrl === null
            ? args.nextPageUrl
            : undefined,
        structured:
          args.structured && isPlainObject(args.structured)
            ? args.structured
            : undefined,
      },
    },
    (response) => {
      if (!isPlainObject(response) || typeof response.runId !== "string") {
        throw new Error("Invalid resume agent run response");
      }
      return {
        ok: response.ok === true,
        status: typeof response.status === "string" ? response.status : "unknown",
        runId: response.runId,
        runtimeId:
          typeof response.runtimeId === "string" ? response.runtimeId : undefined,
      };
    }
  );
}

export async function resolveAgentApproval(
  sendMessage: RuntimeSender,
  args: {
    approvalId: string;
    decision: "approved" | "rejected";
    decisionNote?: string;
  }
): Promise<{ ok: boolean; status: string }> {
  return sendRuntimeMessage(
    sendMessage,
    {
      type: "RESOLVE_AGENT_APPROVAL",
      payload: args,
    },
    (response) => ({
      ok: response.ok === true,
      status: typeof response.status === "string" ? response.status : "unknown",
    })
  );
}
