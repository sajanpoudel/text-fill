export type LocalCompanionRunStatus =
  | "created"
  | "planning"
  | "executing"
  | "awaiting_approval"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export type LocalCompanionTaskStatus =
  | "pending"
  | "running"
  | "retrying"
  | "completed"
  | "blocked"
  | "skipped"
  | "failed";

export interface LocalCompanionFieldTarget {
  selector: string;
  platform?: string;
  fieldType?: string;
  charLimit?: number;
}

export interface LocalCompanionStructuredExtraction {
  data?: Record<string, unknown>;
  matchedFields?: string[];
  unmatchedFields?: string[];
  headings?: string[];
  text?: string;
}

export interface LocalCompanionCandidateScanItem {
  targetName: string;
  targetUrl: string;
  headline?: string;
}

export interface LocalCompanionBrowserWorkItem {
  title: string;
  pageUrl?: string;
  targetUrl?: string;
  targetName?: string;
  itemGoal?: string;
  itemContext?: string;
  sourceType?: string;
}

export interface LocalCompanionProviderConfig {
  provider: string;
  apiKey: string;
  model: string;
}

export interface LocalCompanionApproval {
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

export interface LocalCompanionRunTask {
  _id: string;
  title: string;
  status: LocalCompanionTaskStatus;
  retryCount: number;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  pageUrl?: string;
  resultSummary?: string;
  lastError?: string;
  skipReason?: string;
}

export interface LocalCompanionRunProgress {
  totalTasks: number;
  completedTasks: number;
  skippedTasks: number;
  blockedTasks: number;
  retryingTasks: number;
  currentTaskIndex: number;
  latestPageUrl?: string;
  lastCheckpointAt?: number;
  resumeCursor?: string;
}

export interface LocalCompanionRun {
  _id: string;
  goal: string;
  platformHint?: string;
  status: LocalCompanionRunStatus;
  resumeSourceRunId?: string;
  workflowId?: string;
  workflowRunId?: string;
  workflowStatus?: string;
  latestSummary?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  lastError?: string;
  runtime?: "local_companion";
  progress?: LocalCompanionRunProgress;
  tasks?: LocalCompanionRunTask[];
}

export interface LocalCompanionPanelState {
  authenticated: boolean;
  approvals: LocalCompanionApproval[];
  runs: LocalCompanionRun[];
  runtime: "local_companion";
  runtimeConnected: boolean;
  runtimeError?: string;
}

export interface ResumeFileData {
  name: string;      // e.g. "resume.pdf"
  mimeType: string;  // e.g. "application/pdf"
  base64: string;    // raw file bytes as base64 — stored in chrome.storage.local, NOT Convex
}

export interface LocalCompanionStartRunParams {
  userScope: string;
  goal: string;
  platformHint?: string;
  pageUrl?: string;
  pageContext?: string;
  userContext?: string;
  systemPrompt?: string;
  fieldTarget?: LocalCompanionFieldTarget;
  scannedCandidates?: LocalCompanionCandidateScanItem[];
  workItems?: LocalCompanionBrowserWorkItem[];
  nextPageUrl?: string | null;
  structured?: LocalCompanionStructuredExtraction | null;
  providerConfig?: LocalCompanionProviderConfig | null;
  resumeFile?: ResumeFileData | null;
}

export interface LocalCompanionStartRunResult {
  runId: string;
  runtimeId: string;
}

export interface LocalCompanionCancelRunParams {
  userScope: string;
  runId: string;
}

export interface LocalCompanionCancelRunResult {
  ok: boolean;
  status: LocalCompanionRunStatus;
  runId: string;
}

export interface LocalCompanionResumeRunParams {
  userScope: string;
  runId: string;
  pageUrl?: string;
  pageContext?: string;
  userContext?: string;
  systemPrompt?: string;
  fieldTarget?: LocalCompanionFieldTarget;
  scannedCandidates?: LocalCompanionCandidateScanItem[];
  workItems?: LocalCompanionBrowserWorkItem[];
  nextPageUrl?: string | null;
  structured?: LocalCompanionStructuredExtraction | null;
  providerConfig?: LocalCompanionProviderConfig | null;
  resumeFile?: ResumeFileData | null;
}

export interface LocalCompanionResumeRunResult {
  ok: boolean;
  status: LocalCompanionRunStatus;
  runId: string;
  runtimeId?: string;
  resumedExistingRun?: boolean;
  sourceRunId?: string;
}

export type LocalCompanionAction =
  | {
      kind: "insert_draft";
      fieldTarget: LocalCompanionFieldTarget;
      generatedText: string;
      verifyText: string;
      targetName?: string;
      pageUrl?: string;
    }
  | {
      kind: "enqueue_task_batch";
      batchType: string;
      dailyLimit: number;
      items: Array<{
        targetUrl: string;
        targetName?: string;
        generatedText?: string;
      }>;
    };

export interface LocalCompanionResolveApprovalParams {
  userScope: string;
  approvalId: string;
  decision: "approved" | "rejected";
  decisionNote?: string;
  providerConfig?: LocalCompanionProviderConfig | null;
}

export interface LocalCompanionResolveApprovalResult {
  ok: boolean;
  status: string;
  runId?: string;
  action?: LocalCompanionAction;
}

export interface LocalCompanionReportActionResultParams {
  userScope: string;
  approvalId: string;
  succeeded: boolean;
  summary?: string;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
}

export interface LocalCompanionReportActionResult {
  ok: boolean;
  status: string;
  runId?: string;
}

export interface LocalCompanionHealthResult {
  ok: true;
  runtime: "local_companion";
}

export type LocalCompanionMethod =
  | "health"
  | "get_panel_state"
  | "start_run"
  | "cancel_run"
  | "resume_run"
  | "resolve_approval"
  | "report_action_result";

export interface LocalCompanionRequestEnvelope<TParams = unknown> {
  type: "request";
  requestId: string;
  method: LocalCompanionMethod;
  params?: TParams;
}

export interface LocalCompanionErrorBody {
  code?: string;
  message: string;
}

export interface LocalCompanionResponseEnvelope<TResult = unknown> {
  type: "response";
  requestId: string;
  ok: boolean;
  result?: TResult;
  error?: LocalCompanionErrorBody;
}
