export type LocalCompanionRunStatus =
  | "created"
  | "planning"
  | "executing"
  | "awaiting_approval"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

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

export interface LocalCompanionRun {
  _id: string;
  goal: string;
  platformHint?: string;
  status: LocalCompanionRunStatus;
  latestSummary?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  lastError?: string;
  runtime?: "local_companion";
}

export interface LocalCompanionPanelState {
  authenticated: boolean;
  approvals: LocalCompanionApproval[];
  runs: LocalCompanionRun[];
  runtime: "local_companion";
  runtimeConnected: boolean;
  runtimeError?: string;
}

export interface LocalCompanionStartRunParams {
  userScope: string;
  goal: string;
  platformHint?: string;
  pageUrl?: string;
  pageContext?: string;
  fieldTarget?: LocalCompanionFieldTarget;
  scannedCandidates?: LocalCompanionCandidateScanItem[];
  nextPageUrl?: string | null;
  structured?: LocalCompanionStructuredExtraction | null;
  providerConfig?: LocalCompanionProviderConfig | null;
}

export interface LocalCompanionStartRunResult {
  runId: string;
  runtimeId: string;
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

