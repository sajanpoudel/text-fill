import type {
  LocalCompanionCancelRunResult,
  LocalCompanionAction,
  LocalCompanionBrowserWorkItem,
  LocalCompanionPanelState,
  LocalCompanionProviderConfig,
  LocalCompanionReportActionResult,
  LocalCompanionResumeRunResult,
  LocalCompanionResolveApprovalResult,
  LocalCompanionRunProgress,
  LocalCompanionRunTask,
  LocalCompanionStartRunParams,
  LocalCompanionStartRunResult,
} from "../src/lib/local-agent-protocol.ts";
import {
  CompanionStateStore,
  type StoredApprovalRecord,
  type StoredRunRecord,
  type StoredRunSiteMemory,
  type StoredRunSiteMemoryItem,
  type StoredRunSiteMemoryTaskPattern,
} from "./state-store.ts";
import { ChromeDevtoolsMcpRuntime } from "./chrome-devtools-mcp-runtime.ts";
import {
  createNoopCompanionLogger,
  type CompanionLogger,
} from "./live-logger.ts";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function createTaskId(): string {
  const randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  const suffix =
    typeof randomUUID === "function"
      ? randomUUID().replace(/-/g, "")
      : `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  return `task_${suffix}`;
}

function derivePrimaryTaskTitle(params: LocalCompanionStartRunParams): string {
  const goal = params.goal.trim();
  if (
    params.platformHint === "linkedin" &&
    typeof params.pageUrl === "string" &&
    /linkedin\.com\/in\//i.test(params.pageUrl)
  ) {
    return "Handle LinkedIn profile action";
  }
  if (
    params.platformHint === "linkedin" &&
    typeof params.pageUrl === "string" &&
    /linkedin\.com\/jobs\//i.test(params.pageUrl)
  ) {
    return "Handle LinkedIn jobs task";
  }
  if (params.fieldTarget?.selector) {
    return "Draft and place browser response";
  }
  return goal.length > 72 ? `${goal.slice(0, 69)}...` : goal;
}

function deriveGenericBrowserWorkItems(
  params: LocalCompanionStartRunParams
): LocalCompanionBrowserWorkItem[] {
  if (Array.isArray(params.workItems) && params.workItems.length > 1) {
    return params.workItems
      .map((item, index) => {
        const title = typeof item?.title === "string" ? item.title.trim() : "";
        const pageUrl =
          typeof item?.pageUrl === "string" && item.pageUrl.trim()
            ? item.pageUrl.trim()
            : typeof item?.targetUrl === "string" && item.targetUrl.trim()
              ? item.targetUrl.trim()
              : "";
        if (!title) {
          return pageUrl
            ? {
                title: `Handle item ${index + 1}`,
                pageUrl,
                targetUrl: pageUrl,
              }
            : null;
        }
        return {
          title,
          ...(pageUrl ? { pageUrl, targetUrl: pageUrl } : {}),
          ...(typeof item?.targetName === "string" && item.targetName.trim()
            ? { targetName: item.targetName.trim() }
            : {}),
          ...(typeof item?.itemGoal === "string" && item.itemGoal.trim()
            ? { itemGoal: item.itemGoal.trim() }
            : {}),
          ...(typeof item?.itemContext === "string" && item.itemContext.trim()
            ? { itemContext: item.itemContext.trim() }
            : {}),
          ...(typeof item?.sourceType === "string" && item.sourceType.trim()
            ? { sourceType: item.sourceType.trim() }
            : {}),
        };
      })
      .filter((item): item is LocalCompanionBrowserWorkItem => item !== null);
  }

  if (!params.scannedCandidates || params.scannedCandidates.length <= 1) {
    return [];
  }

  return params.scannedCandidates.map((candidate, index) => {
    const targetName = candidate.targetName.trim();
    const targetUrl = candidate.targetUrl.trim();
    const headline = candidate.headline?.trim();
    const label = targetName || targetUrl || `Target ${index + 1}`;
    const itemContextParts = [
      `Target: ${label}`,
      ...(headline ? [`Headline: ${headline}`] : []),
      ...(targetUrl ? [`Target URL: ${targetUrl}`] : []),
      "Handle only this target before moving to the next queued item.",
    ];

    return {
      title: targetName ? `Handle ${targetName}` : `Handle target ${index + 1}`,
      ...(targetUrl ? { pageUrl: targetUrl, targetUrl } : {}),
      ...(targetName ? { targetName } : {}),
      itemGoal: params.goal,
      itemContext: itemContextParts.join("\n"),
      sourceType: "scanned_candidate",
    };
  });
}

function createInitialRunTasks(
  params: LocalCompanionStartRunParams,
  useItemizedQueueTasks = false
): LocalCompanionRunTask[] {
  const now = Date.now();
  const workItems = useItemizedQueueTasks
    ? deriveGenericBrowserWorkItems(params)
    : [];
  if (workItems.length > 1) {
    return workItems.map((item) => ({
      _id: createTaskId(),
      title: item.title,
      status: "pending" as const,
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
      ...(item.pageUrl ? { pageUrl: item.pageUrl } : {}),
    }));
  }

  return [
    {
      _id: createTaskId(),
      title: derivePrimaryTaskTitle(params),
      status: "pending",
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
      ...(typeof params.pageUrl === "string" ? { pageUrl: params.pageUrl } : {}),
    },
  ];
}

function createRunTasksFromWorkItems(
  workItems: LocalCompanionBrowserWorkItem[],
  options?: { firstTaskRunning?: boolean }
): LocalCompanionRunTask[] {
  const now = Date.now();
  return workItems.map((item, index) => ({
    _id: createTaskId(),
    title: item.title,
    status: options?.firstTaskRunning && index === 0 ? "running" : "pending",
    retryCount: 0,
    createdAt: now,
    updatedAt: now,
    ...(options?.firstTaskRunning && index === 0 ? { startedAt: now } : {}),
    ...(item.pageUrl ? { pageUrl: item.pageUrl } : {}),
  }));
}

const RESUME_GOAL_PATTERN =
  /\b(continue|resume|pick up|keep going|proceed|try again|from where you left off)\b/i;

function normalizeComparableUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    parsed.hash = "";
    return `${parsed.origin}${parsed.pathname}${parsed.search}`;
  } catch {
    return trimmed;
  }
}

function extractComparableHost(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isResumeLikeGoal(goal: string): boolean {
  return RESUME_GOAL_PATTERN.test(goal.trim());
}

function normalizeGoalForImplicitContinuation(goal: string): string | null {
  const normalized = goal
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || null;
}

function normalizeHttpUrlCandidate(value: string): string | null {
  const trimmed = value.trim().replace(/[),.;!?]+$/u, "");
  if (!trimmed) return null;
  const raw = /^https?:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(raw);
    if (!/^https?:$/iu.test(parsed.protocol)) {
      return null;
    }
    if (parsed.hostname.toLowerCase() === "google.com") {
      parsed.hostname = "www.google.com";
    }
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function extractExplicitGoalStartUrl(goal: string): string | null {
  const trimmedGoal = goal.trim();
  if (!trimmedGoal) {
    return null;
  }

  const navigationMatch = trimmedGoal.match(
    /\b(?:go to|goto|open|visit|navigate to|head to|load)\s+((?:https?:\/\/|www\.)?[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s]*)?)/iu
  );
  if (navigationMatch?.[1]) {
    return normalizeHttpUrlCandidate(navigationMatch[1]);
  }

  if (
    /\b(?:go to|goto|open|visit|navigate to|head to|load|search)\b[\s\S]{0,80}\bgoogle(?:\.com)?\b/iu.test(
      trimmedGoal
    ) ||
    /\bgoogle(?:\.com)?\b[\s\S]{0,80}\bsearch\b/iu.test(trimmedGoal)
  ) {
    return "https://www.google.com/";
  }

  return null;
}

function alignStartParamsWithGoal(
  params: LocalCompanionStartRunParams
): LocalCompanionStartRunParams {
  const explicitStartUrl = extractExplicitGoalStartUrl(params.goal);
  if (!explicitStartUrl) {
    return params;
  }

  const currentComparableUrl = normalizeComparableUrl(params.pageUrl);
  const explicitComparableUrl = normalizeComparableUrl(explicitStartUrl);
  const shouldResetPageScopedContext =
    !currentComparableUrl ||
    !explicitComparableUrl ||
    currentComparableUrl !== explicitComparableUrl;

  if (!shouldResetPageScopedContext) {
    return params.pageUrl?.trim() === explicitStartUrl
      ? params
      : {
          ...params,
          pageUrl: explicitStartUrl,
        };
  }

  return {
    ...params,
    pageUrl: explicitStartUrl,
    pageContext: undefined,
    fieldTarget: undefined,
    scannedCandidates: undefined,
    workItems: undefined,
    nextPageUrl: undefined,
    structured: undefined,
  };
}

function buildResumeContext(run: StoredRunRecord): string {
  const lines = [
    "Continuation context from the previous interrupted run:",
    `Previous goal: ${run.goal}`,
    `Previous status: ${run.status}`,
  ];

  if (run.latestSummary?.trim()) {
    lines.push(`Latest summary: ${run.latestSummary.trim()}`);
  }
  if (run.lastError?.trim()) {
    lines.push(`Last error: ${run.lastError.trim()}`);
  }
  if (run.progress) {
    lines.push(
      `Progress: ${run.progress.completedTasks}/${run.progress.totalTasks} complete, ${run.progress.retryingTasks} retrying, ${run.progress.blockedTasks} blocked, ${run.progress.skippedTasks} skipped`
    );
    if (run.progress.latestPageUrl?.trim()) {
      lines.push(`Last known page: ${run.progress.latestPageUrl.trim()}`);
    }
  } else if (run.pageUrl?.trim()) {
    lines.push(`Last known page: ${run.pageUrl.trim()}`);
  }

  const currentTask =
    run.tasks?.find((task) => task.status === "running" || task.status === "retrying") ??
    run.tasks?.find((task) => task.status === "blocked" || task.status === "failed") ??
    null;
  if (currentTask) {
    lines.push(
      `Current task: ${currentTask.title} (${currentTask.status}, retries ${currentTask.retryCount})`
    );
    if (currentTask.pageUrl?.trim()) {
      lines.push(`Current task page: ${currentTask.pageUrl.trim()}`);
    }
    if (currentTask.lastError?.trim()) {
      lines.push(`Current task error: ${currentTask.lastError.trim()}`);
    }
  }

  const completedTasks =
    run.tasks?.filter((task) => task.status === "completed").slice(0, 5) ?? [];
  if (completedTasks.length > 0) {
    lines.push(
      `Completed tasks: ${completedTasks.map((task) => task.title).join(" | ")}`
    );
  }

  lines.push(
    "Do not restart from scratch if the live browser state already reflects completed work. Inspect the current page, verify what is already done, and continue from the last checkpoint."
  );
  return lines.join("\n");
}

function truncateMemoryText(value: string | undefined, maxLength: number): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 3)}...` : trimmed;
}

function normalizePathPattern(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    const normalizedPath = parsed.pathname
      .split("/")
      .filter(Boolean)
      .map((segment) => {
        if (/^\d+$/u.test(segment)) {
          return ":id";
        }
        if (
          /^[0-9a-f]{8,}$/iu.test(segment) ||
          /^[0-9a-f-]{12,}$/iu.test(segment) ||
          /^(?:[a-z0-9]+-){2,}[a-z0-9-]+$/iu.test(segment)
        ) {
          return ":entity";
        }
        return segment.toLowerCase();
      })
      .join("/");
    return `${parsed.hostname.toLowerCase()}/${normalizedPath}`;
  } catch {
    return trimmed.toLowerCase();
  }
}

function extractPathFamily(value: string | undefined): string | null {
  const pattern = normalizePathPattern(value);
  if (!pattern) return null;
  const [, ...pathSegments] = pattern.split("/").filter(Boolean);
  if (pathSegments.length === 0) return null;
  return pathSegments.join("/");
}

function uniqueNonEmpty(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value))
    )
  );
}

function buildSiteMemoryExampleItems(
  workItems: LocalCompanionBrowserWorkItem[] | undefined
): StoredRunSiteMemoryItem[] | undefined {
  if (!Array.isArray(workItems) || workItems.length === 0) {
    return undefined;
  }

  const items = workItems
    .slice(0, 4)
    .map((item) => {
      const title = item.title?.trim();
      if (!title) return null;
      return {
        title,
        ...(item.sourceType?.trim() ? { sourceType: item.sourceType.trim() } : {}),
        ...(normalizePathPattern(item.pageUrl ?? item.targetUrl)
          ? {
              pagePattern:
                normalizePathPattern(item.pageUrl ?? item.targetUrl) ?? undefined,
            }
          : {}),
        ...(item.itemGoal?.trim() ? { itemGoal: item.itemGoal.trim() } : {}),
      };
    })
    .filter((item): item is StoredRunSiteMemoryItem => item !== null);

  return items.length > 0 ? items : undefined;
}

function buildSiteMemoryTaskPatterns(
  tasks: LocalCompanionRunTask[] | undefined
): StoredRunSiteMemoryTaskPattern[] | undefined {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return undefined;
  }

  const patterns = tasks
    .slice(0, 6)
    .map((task) => ({
      title: task.title,
      status: task.status,
      ...(normalizePathPattern(task.pageUrl)
        ? { pagePattern: normalizePathPattern(task.pageUrl) ?? undefined }
        : {}),
      ...(truncateMemoryText(task.resultSummary, 240)
        ? { resultSummary: truncateMemoryText(task.resultSummary, 240) ?? undefined }
        : {}),
      ...(truncateMemoryText(task.lastError, 200)
        ? { lastError: truncateMemoryText(task.lastError, 200) ?? undefined }
        : {}),
      ...(truncateMemoryText(task.skipReason, 200)
        ? { skipReason: truncateMemoryText(task.skipReason, 200) ?? undefined }
        : {}),
    }))
    .filter((pattern) => pattern.title.trim().length > 0);

  return patterns.length > 0 ? patterns : undefined;
}

function buildRunSiteMemory(args: {
  run: StoredRunRecord;
  fallbackPageUrl?: string;
  workItems?: LocalCompanionBrowserWorkItem[];
  workflowName?: string;
  queueType?: string;
  terminalStatus?: StoredRunRecord["status"];
  summary?: string;
  lastError?: string;
  tasks?: LocalCompanionRunTask[];
  itemCount?: number;
}): StoredRunSiteMemory | undefined {
  const latestPageUrl =
    args.run.progress?.latestPageUrl ??
    args.fallbackPageUrl ??
    args.run.pageUrl;
  const memoryPageUrl =
    args.run.pageUrl ??
    args.fallbackPageUrl ??
    args.run.progress?.latestPageUrl;
  const host =
    extractComparableHost(memoryPageUrl) ??
    extractComparableHost(latestPageUrl) ??
    args.run.siteMemory?.host ??
    undefined;
  const pagePattern =
    normalizePathPattern(memoryPageUrl) ??
    normalizePathPattern(latestPageUrl) ??
    args.run.siteMemory?.pagePattern ??
    undefined;
  const sourceTypes = uniqueNonEmpty([
    ...(args.workItems?.map((item) => item.sourceType) ?? []),
    ...(args.run.workItems?.map((item) => item.sourceType) ?? []),
    ...(args.run.siteMemory?.sourceTypes ?? []),
  ]);
  const exampleItems =
    buildSiteMemoryExampleItems(args.workItems ?? args.run.workItems) ??
    args.run.siteMemory?.exampleItems;
  const taskPatterns =
    buildSiteMemoryTaskPatterns(args.tasks ?? args.run.tasks) ??
    args.run.siteMemory?.taskPatterns;
  const workflowName =
    args.workflowName?.trim() ||
    args.run.siteMemory?.workflowName ||
    undefined;
  const queueType =
    args.queueType?.trim() || args.run.siteMemory?.queueType || undefined;
  const summary =
    truncateMemoryText(args.summary, 320) ??
    args.run.siteMemory?.summary ??
    undefined;
  const lastError =
    truncateMemoryText(args.lastError, 240) ??
    args.run.siteMemory?.lastError ??
    undefined;
  const itemCount =
    (typeof args.itemCount === "number" && Number.isFinite(args.itemCount)
      ? Math.max(1, Math.round(args.itemCount))
      : undefined) ??
    (Array.isArray(args.workItems) && args.workItems.length > 0
      ? args.workItems.length
      : undefined) ??
    args.run.siteMemory?.itemCount;

  if (
    !host &&
    !pagePattern &&
    !workflowName &&
    !queueType &&
    sourceTypes.length === 0 &&
    !summary &&
    !lastError &&
    !exampleItems?.length &&
    !taskPatterns?.length
  ) {
    return undefined;
  }

  return {
    ...(host ? { host } : {}),
    ...(pagePattern ? { pagePattern } : {}),
    ...(workflowName ? { workflowName } : {}),
    ...(queueType ? { queueType } : {}),
    ...(typeof itemCount === "number" ? { itemCount } : {}),
    ...(sourceTypes.length > 0 ? { sourceTypes } : {}),
    ...(exampleItems?.length ? { exampleItems } : {}),
    ...(taskPatterns?.length ? { taskPatterns } : {}),
    ...((args.terminalStatus ?? args.run.status)
      ? { terminalStatus: (args.terminalStatus ?? args.run.status) as StoredRunRecord["status"] }
      : {}),
    ...(summary ? { summary } : {}),
    ...(lastError ? { lastError } : {}),
    updatedAt: Date.now(),
  };
}

function buildSiteExperienceContext(
  runs: StoredRunRecord[],
  options: {
    maxSuccesses?: number;
    maxFailures?: number;
  } = {}
): string | null {
  const maxSuccesses = options.maxSuccesses ?? 3;
  const maxFailures = options.maxFailures ?? 3;
  const successfulRuns = runs
    .filter(
      (run) =>
        run.status === "completed" &&
        run.siteMemory?.terminalStatus === "completed"
    )
    .slice(0, maxSuccesses);
  const failedRuns = runs
    .filter(
      (run) =>
        (run.status === "failed" || run.status === "cancelled") &&
        Boolean(run.siteMemory)
    )
    .slice(0, maxFailures);

  if (successfulRuns.length === 0 && failedRuns.length === 0) {
    return null;
  }

  const parts: string[] = [
    "Reusable structured memory from similar pages on this site. Reuse verified workflow patterns and avoid repeating failed tactics.",
  ];

  if (successfulRuns.length > 0) {
    parts.push("Successful reusable patterns:");
    for (const run of successfulRuns) {
      const memory = run.siteMemory;
      const details = [
        memory?.workflowName ? `workflow ${memory.workflowName}` : null,
        memory?.queueType ? `queue ${memory.queueType}` : null,
        memory?.pagePattern ? `page ${memory.pagePattern}` : null,
        memory?.itemCount ? `${memory.itemCount} items` : null,
      ]
        .filter((value): value is string => Boolean(value))
        .join(" | ");
      parts.push(
        `- Goal: ${run.goal}${
          details ? ` | ${details}` : ""
        } | Result: ${
          memory?.summary ?? run.latestSummary?.trim() ?? "completed"
        }`
      );
      if (memory?.sourceTypes?.length) {
        parts.push(`  Source types: ${memory.sourceTypes.join(", ")}`);
      }
      if (memory?.exampleItems?.length) {
        parts.push(
          `  Example items: ${memory.exampleItems
            .map((item) =>
              [
                item.title,
                item.sourceType ? `source ${item.sourceType}` : null,
                item.pagePattern ? `page ${item.pagePattern}` : null,
              ]
                .filter((value): value is string => Boolean(value))
                .join(" · ")
            )
            .join(" || ")}`
        );
      }
      if (memory?.taskPatterns?.length) {
        const completedPatterns = memory.taskPatterns.filter(
          (pattern) => pattern.status === "completed"
        );
        if (completedPatterns.length > 0) {
        parts.push(
            `  Reusable steps: ${completedPatterns
            .map((pattern) =>
              [
                pattern.title,
                pattern.status,
                pattern.resultSummary ?? null,
              ]
                .filter((value): value is string => Boolean(value))
                .join(" · ")
            )
            .join(" || ")}`
        );
        }
      }
    }
  }

  if (failedRuns.length > 0) {
    parts.push("Failure patterns to avoid or verify before retrying:");
    for (const run of failedRuns) {
      const memory = run.siteMemory;
      parts.push(
        `- Goal: ${run.goal}${
          memory?.pagePattern ? ` | page ${memory.pagePattern}` : ""
        } | Failure: ${(
          memory?.lastError ??
          run.lastError?.trim() ??
          memory?.summary ??
          run.latestSummary?.trim() ??
          "failed"
        ).trim()}`
      );
      if (memory?.taskPatterns?.length) {
        parts.push(
          `  Failure steps: ${memory.taskPatterns
            .filter(
              (pattern) =>
                pattern.status === "failed" ||
                pattern.status === "blocked" ||
                pattern.status === "skipped"
            )
            .map((pattern) =>
              [
                pattern.title,
                pattern.status,
                pattern.lastError ?? pattern.skipReason ?? pattern.resultSummary ?? null,
              ]
                .filter((value): value is string => Boolean(value))
                .join(" · ")
            )
            .join(" || ")}`
        );
      }
    }
  }

  return parts.join("\n");
}

function summarizeRunProgress(progress: LocalCompanionRunProgress | undefined): string | null {
  if (!progress) return null;
  const parts = [
    `${progress.completedTasks}/${progress.totalTasks} complete`,
  ];
  if (progress.retryingTasks > 0) {
    parts.push(`${progress.retryingTasks} retrying`);
  }
  if (progress.blockedTasks > 0) {
    parts.push(`${progress.blockedTasks} blocked`);
  }
  if (progress.skippedTasks > 0) {
    parts.push(`${progress.skippedTasks} skipped`);
  }
  return parts.join(" · ");
}

type RuntimeTaskStep = {
  title: string;
  status?: LocalCompanionRunTask["status"];
  resultSummary?: string;
  pageUrl?: string;
  lastError?: string;
  skipReason?: string;
  retryCount?: number;
};

function coerceRuntimeTaskSteps(
  metadata: Record<string, unknown> | undefined
): RuntimeTaskStep[] {
  const rawSteps = metadata?.taskSteps;
  if (!Array.isArray(rawSteps)) {
    return [];
  }

  return rawSteps
    .map((item) => {
      if (!isPlainObject(item)) {
        return null;
      }
      const title =
        typeof item.title === "string" && item.title.trim()
          ? item.title.trim()
          : null;
      if (!title) {
        return null;
      }
      return {
        title,
        ...(typeof item.status === "string" && item.status.trim()
          ? {
              status: item.status.trim() as LocalCompanionRunTask["status"],
            }
          : {}),
        ...(typeof item.resultSummary === "string" && item.resultSummary.trim()
          ? { resultSummary: item.resultSummary.trim() }
          : {}),
        ...(typeof item.pageUrl === "string" && item.pageUrl.trim()
          ? { pageUrl: item.pageUrl.trim() }
          : {}),
        ...(typeof item.lastError === "string" && item.lastError.trim()
          ? { lastError: item.lastError.trim() }
          : {}),
        ...(typeof item.skipReason === "string" && item.skipReason.trim()
          ? { skipReason: item.skipReason.trim() }
          : {}),
        ...(typeof item.retryCount === "number" && Number.isFinite(item.retryCount)
          ? { retryCount: Math.max(0, Math.round(item.retryCount)) }
          : {}),
      };
    })
    .filter((item): item is RuntimeTaskStep => item !== null);
}

function coerceWorkflowStatus(
  value: unknown
): {
  status?: string;
  running?: boolean;
  completed?: boolean;
  error?: string;
  metadata?: Record<string, unknown>;
  value?: Record<string, unknown>;
  state?: Record<string, unknown>;
} | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const state = isPlainObject(value.state)
    ? (value.state as Record<string, unknown>)
    : undefined;
  const result = isPlainObject(value.result)
    ? (value.result as Record<string, unknown>)
    : undefined;
  const workflowValue =
    result && isPlainObject(result.value)
      ? (result.value as Record<string, unknown>)
      : undefined;
  const workflowMetadata =
    result && isPlainObject(result.metadata)
      ? (result.metadata as Record<string, unknown>)
      : undefined;

  return {
    ...(typeof value.status === "string" ? { status: value.status } : {}),
    ...(typeof value.running === "boolean" ? { running: value.running } : {}),
    ...(typeof value.completed === "boolean" ? { completed: value.completed } : {}),
    ...(typeof value.error === "string" && value.error.trim()
      ? { error: value.error.trim() }
      : {}),
    ...(state ? { state } : {}),
    ...(workflowMetadata ? { metadata: workflowMetadata } : {}),
    ...(workflowValue ? { value: workflowValue } : {}),
  };
}

function buildRunTasksFromRuntimeSteps(args: {
  existingTasks: LocalCompanionRunTask[] | undefined;
  runtimeSteps: RuntimeTaskStep[];
  finalPageUrl?: string;
}): LocalCompanionRunTask[] | null {
  if (args.runtimeSteps.length === 0) {
    return null;
  }

  const now = Date.now();
  return args.runtimeSteps.map((step, index) => {
    const existingTask = index === 0 ? args.existingTasks?.[0] : undefined;
    return {
      _id: existingTask?._id ?? createTaskId(),
      title: step.title,
      status: step.status ?? "completed",
      retryCount: step.retryCount ?? existingTask?.retryCount ?? 0,
      createdAt: existingTask?.createdAt ?? now,
      updatedAt: now,
      ...(existingTask?.startedAt || step.status === "running" || step.status === "retrying"
        ? { startedAt: existingTask?.startedAt ?? now }
        : {}),
      ...(step.status === "completed" ||
      step.status === "failed" ||
      step.status === "skipped"
        ? { completedAt: existingTask?.completedAt ?? now }
        : {}),
      ...(step.pageUrl
        ? { pageUrl: step.pageUrl }
        : args.finalPageUrl
          ? { pageUrl: args.finalPageUrl }
          : {}),
      ...(step.resultSummary ? { resultSummary: step.resultSummary } : {}),
      ...(step.lastError ? { lastError: step.lastError } : {}),
      ...(step.skipReason ? { skipReason: step.skipReason } : {}),
    };
  });
}

function buildRunProgressPatch(
  tasks: LocalCompanionRunTask[],
  overrides?: Partial<LocalCompanionRunProgress>
): LocalCompanionRunProgress {
  const completedTasks = tasks.filter((task) => task.status === "completed").length;
  const skippedTasks = tasks.filter((task) => task.status === "skipped").length;
  const blockedTasks = tasks.filter(
    (task) => task.status === "blocked" || task.status === "failed"
  ).length;
  const retryingTasks = tasks.filter((task) => task.status === "retrying").length;
  const terminalTasks = tasks.filter((task) =>
    task.status === "completed" ||
    task.status === "skipped" ||
    task.status === "failed"
  ).length;
  const currentTaskIndex = Math.max(
    0,
    tasks.findIndex((task) =>
      task.status === "running" || task.status === "retrying" || task.status === "blocked"
    )
  );

  return {
    totalTasks: tasks.length,
    completedTasks,
    skippedTasks,
    blockedTasks,
    retryingTasks,
    currentTaskIndex:
      tasks.length > 0 && terminalTasks === tasks.length ? tasks.length : currentTaskIndex,
    ...(overrides?.latestPageUrl ? { latestPageUrl: overrides.latestPageUrl } : {}),
    ...(overrides?.resumeCursor ? { resumeCursor: overrides.resumeCursor } : {}),
    ...(overrides?.lastCheckpointAt ? { lastCheckpointAt: overrides.lastCheckpointAt } : {}),
  };
}

const MAX_AGENT_TASK_RETRIES = 2;

function isPermanentProviderErrorMessage(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) return false;
  const markers = [
    "llm request failed with a permanent error",
    "resource_exhausted",
    "prepayment credits are depleted",
    "manage your project and billing",
    "insufficient_quota",
    "permission_denied",
    "service_disabled",
    "gemini api has not been used",
    "vertex ai api has not been used",
    "enable it by visiting",
    "aiplatform.googleapis.com",
    "api key not valid",
    "invalid api key",
  ];
  return markers.some((marker) => normalized.includes(marker));
}

function isRetryableAgentError(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) return true;
  if (
    normalized.includes("missing api key") ||
    normalized.includes("providerconfig is required") ||
    normalized.includes("goal is required") ||
    normalized.includes("approval not found") ||
    normalized.includes("unsupported") ||
    isPermanentProviderErrorMessage(normalized)
  ) {
    return false;
  }
  return true;
}

function isLinkedInProfileConnectGoal(params: LocalCompanionStartRunParams): boolean {
  const goal = params.goal.trim().toLowerCase();
  const platformHint = String(params.platformHint ?? "").trim().toLowerCase();
  const pageUrl = String(params.pageUrl ?? "").trim().toLowerCase();

  const isLinkedIn = platformHint === "linkedin" || pageUrl.includes("linkedin.com");
  const isProfile = pageUrl.includes("linkedin.com/in/");
  const wantsConnect = ["connect", "connection request", "invite", "add a note", "connection note"].some(
    (phrase) => goal.includes(phrase)
  );

  return isLinkedIn && isProfile && wantsConnect;
}

function isTerminalRunStatus(
  status: StoredRunRecord["status"] | LocalCompanionRunTask["status"] | undefined
): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "skipped"
  );
}

function isPausedWorkflowStatus(status: string | undefined): boolean {
  return status === "paused";
}

function shouldUseManagedAgentWorkflow(
  params: LocalCompanionStartRunParams,
  runtime: ChromeDevtoolsMcpRuntime
): boolean {
  return (
    typeof (runtime as { supportsManagedTaskWorkflows?: () => boolean })
      .supportsManagedTaskWorkflows === "function" &&
    (runtime as { supportsManagedTaskWorkflows: () => boolean })
      .supportsManagedTaskWorkflows() &&
    !isLinkedInProfileConnectGoal(params)
  );
}

function shouldUseManagedQueueWorkflow(
  params: LocalCompanionStartRunParams,
  runtime: ChromeDevtoolsMcpRuntime
): boolean {
  return shouldUseManagedAgentWorkflow(params, runtime);
}

type ManagedWorkflowTrackingParams = {
  goal: string;
  platformHint?: string;
  pageUrl?: string;
  pageContext?: string;
  fieldTarget?: LocalCompanionStartRunParams["fieldTarget"];
};

function coerceActionFromApproval(
  approval: StoredApprovalRecord
): LocalCompanionAction | null {
  const payload = approval.payload;
  if (!isPlainObject(payload) || typeof payload.actionType !== "string") {
    return null;
  }

  if (payload.actionType === "insert_draft") {
    if (
      !isPlainObject(payload.fieldTarget) ||
      typeof payload.fieldTarget.selector !== "string" ||
      typeof payload.generatedText !== "string"
    ) {
      return null;
    }

    return {
      kind: "insert_draft",
      fieldTarget: {
        selector: payload.fieldTarget.selector,
        ...(typeof payload.fieldTarget.platform === "string"
          ? { platform: payload.fieldTarget.platform }
          : {}),
        ...(typeof payload.fieldTarget.fieldType === "string"
          ? { fieldType: payload.fieldTarget.fieldType }
          : {}),
        ...(typeof payload.fieldTarget.charLimit === "number"
          ? { charLimit: payload.fieldTarget.charLimit }
          : {}),
      },
      generatedText: payload.generatedText,
      verifyText:
        typeof payload.verifyText === "string" && payload.verifyText.trim()
          ? payload.verifyText
          : payload.generatedText,
      ...(typeof payload.targetName === "string"
        ? { targetName: payload.targetName }
        : {}),
      ...(typeof payload.pageUrl === "string" ? { pageUrl: payload.pageUrl } : {}),
    };
  }

  if (payload.actionType === "create_task_batch") {
    if (
      typeof payload.batchType !== "string" ||
      !Array.isArray(payload.items) ||
      payload.items.length === 0
    ) {
      return null;
    }

    const items = payload.items
      .map((item) => {
        if (!isPlainObject(item) || typeof item.targetUrl !== "string") {
          return null;
        }
        return {
          targetUrl: item.targetUrl,
          ...(typeof item.targetName === "string"
            ? { targetName: item.targetName }
            : {}),
          ...(typeof item.generatedText === "string"
            ? { generatedText: item.generatedText }
            : {}),
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);

    if (items.length === 0) {
      return null;
    }

    return {
      kind: "enqueue_task_batch",
      batchType: payload.batchType,
      dailyLimit:
        typeof payload.dailyLimit === "number" && Number.isFinite(payload.dailyLimit)
          ? Math.max(1, Math.min(100, Math.round(payload.dailyLimit)))
          : items.length,
      items,
    };
  }

  return null;
}

export class LocalAgentCompanionService {
  private readonly runtime: ChromeDevtoolsMcpRuntime;
  private readonly logger: CompanionLogger;
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly recoveringManagedUsers = new Set<string>();
  private recoveringAllManagedRuns = false;
  private runtimeHealth:
    | {
        connected: boolean;
        error?: string;
        checkedAt: number;
      }
    | null = null;
  private runtimeHealthRefreshPromise:
    | Promise<{
        connected: boolean;
        error?: string;
      }>
    | null = null;

  constructor(
    private readonly store = new CompanionStateStore(),
    runtime?: ChromeDevtoolsMcpRuntime,
    logger: CompanionLogger = createNoopCompanionLogger()
  ) {
    this.logger = logger;
    this.runtime = runtime ?? new ChromeDevtoolsMcpRuntime({ logger });
    this.logger.event("info", "service", "constructed");
    this.ensureRuntimeHealthFresh(true);
    this.kickOffManagedWorkflowRecovery();
  }

  async getPanelState(args: {
    userScope: string;
    limit?: number;
  }): Promise<LocalCompanionPanelState> {
    this.kickOffManagedWorkflowRecovery(args.userScope);
    const panelState = await this.store.listPanelState(args.userScope, args.limit ?? 5);
    const runtimeHealth = this.getCachedRuntimeHealth();
    this.ensureRuntimeHealthFresh();
    return {
      ...panelState,
      runtimeConnected: runtimeHealth.connected,
      ...(runtimeHealth.error ? { runtimeError: runtimeHealth.error } : {}),
    };
  }

  async getHealth(): Promise<{
    ok: true;
    runtime: "local_companion";
    runtimeConnected: boolean;
    runtimeError?: string;
  }> {
    const runtimeHealth = await this.ensureRuntimeHealthFresh(true);
    return {
      ok: true,
      runtime: "local_companion",
      runtimeConnected: runtimeHealth.connected,
      ...(runtimeHealth.error ? { runtimeError: runtimeHealth.error } : {}),
    };
  }

  private async createAndLaunchRun(
    params: LocalCompanionStartRunParams,
    options?: {
      resumeSourceRun?: StoredRunRecord | null;
    }
  ): Promise<LocalCompanionStartRunResult> {
    const effectiveParams = alignStartParamsWithGoal(params);

    if (!effectiveParams.providerConfig?.apiKey) {
      throw new Error(
        "Missing API key for the configured provider. Add it in Settings to run Chrome MCP agent tasks."
      );
    }

    const resumeSourceRun =
      options?.resumeSourceRun !== undefined
        ? options.resumeSourceRun
        : await this.findResumeSourceRun(effectiveParams);
    const resumeContext = resumeSourceRun
      ? buildResumeContext(resumeSourceRun)
      : undefined;
    const siteExperienceContext = await this.findSiteExperienceContext(
      effectiveParams,
      resumeSourceRun?._id
    );
    const initialTasks = createInitialRunTasks(
      effectiveParams,
      shouldUseManagedQueueWorkflow(effectiveParams, this.runtime)
    );
    const initialWorkItems = deriveGenericBrowserWorkItems(effectiveParams);
    const initialTask = initialTasks[0];
    const initialProgress = buildRunProgressPatch(initialTasks, {
      latestPageUrl: effectiveParams.pageUrl,
      resumeCursor: initialTask?._id,
    });

    const run = await this.store.createRun({
      userScope: effectiveParams.userScope,
      goal: effectiveParams.goal,
      platformHint: effectiveParams.platformHint,
      pageUrl: effectiveParams.pageUrl,
      pageContext: effectiveParams.pageContext,
      fieldTarget: effectiveParams.fieldTarget,
      resumeSourceRunId: resumeSourceRun?._id,
      ...(initialWorkItems.length > 0 ? { workItems: initialWorkItems } : {}),
      tasks: initialTasks,
      progress: initialProgress,
    });

    try {
      this.logger.event("info", "service", "start_run", {
        runId: run._id,
        goal: effectiveParams.goal,
        platformHint: effectiveParams.platformHint,
        pageUrl: effectiveParams.pageUrl,
        ...(resumeSourceRun ? { resumeSourceRunId: resumeSourceRun._id } : {}),
        provider: effectiveParams.providerConfig.provider,
        model: effectiveParams.providerConfig.model,
      });
      const runningTasks = run.tasks?.map((task) =>
        task._id === initialTask?._id
          ? {
              ...task,
              status: "running" as const,
              startedAt: Date.now(),
              updatedAt: Date.now(),
            }
          : task
      ) ?? [initialTask];
      await this.store.updateRun(params.userScope, run._id, {
        status: "executing",
        latestSummary: resumeSourceRun
          ? `Resuming from the last interrupted run. ${
              summarizeRunProgress(initialProgress) ??
              "Handing the task to the local Chrome MCP agent for tool-driven execution."
            }`
          : summarizeRunProgress(initialProgress) ??
            "Handing the task to the local Chrome MCP agent for tool-driven execution.",
        tasks: runningTasks,
        progress: buildRunProgressPatch(runningTasks, {
          latestPageUrl: effectiveParams.pageUrl,
          resumeCursor: initialTask._id,
        }),
      });
      this.startAgentTaskExecution(
        effectiveParams.userScope,
        run._id,
        effectiveParams,
        resumeContext,
        siteExperienceContext
      );
      return {
        runId: run._id,
        runtimeId: run._id,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.event("error", "service", "start_run_failed", {
        runId: run._id,
        message,
      });
      await this.store.updateRun(params.userScope, run._id, {
        status: "failed",
        latestSummary: message,
        lastError: message,
        completedAt: Date.now(),
      });
      throw error;
    }
  }

  async startRun(
    params: LocalCompanionStartRunParams
  ): Promise<LocalCompanionStartRunResult> {
    return this.createAndLaunchRun(params);
  }

  async cancelRun(args: {
    userScope: string;
    runId: string;
  }): Promise<LocalCompanionCancelRunResult> {
    const run = await this.store.getRun(args.userScope, args.runId);
    if (!run) {
      throw new Error("Run not found");
    }

    if (isTerminalRunStatus(run.status)) {
      return {
        ok: true,
        status: run.status,
        runId: run._id,
      };
    }

    if (run.workflowId || run.workflowRunId) {
      const cancelled = await this.runtime.cancelAgentTaskWorkflow({
        workflowId: run.workflowId,
        runId: run.workflowRunId,
      });
      if (!cancelled) {
        throw new Error("Could not cancel the managed browser workflow.");
      }
    }

    await this.updatePrimaryRunTask(args.userScope, run._id, {
      status: "skipped",
      latestPageUrl: run.progress?.latestPageUrl ?? run.pageUrl,
      skipReason: "Cancelled by user",
      clearResumeCursor: true,
    });
    await this.store.updateRun(args.userScope, run._id, {
      status: "cancelled",
      workflowStatus: "cancelled",
      latestSummary: "Run cancelled by the user.",
      lastError: undefined,
      completedAt: Date.now(),
    });
    this.logger.event("info", "service", "cancel_run", {
      runId: run._id,
      workflowId: run.workflowId,
      workflowRunId: run.workflowRunId,
    });

    return {
      ok: true,
      status: "cancelled",
      runId: run._id,
    };
  }

  async resumeRun(args: {
    userScope: string;
    runId: string;
    pageUrl?: string;
    pageContext?: string;
    userContext?: string;
    systemPrompt?: string;
    fieldTarget?: LocalCompanionStartRunParams["fieldTarget"];
    scannedCandidates?: LocalCompanionStartRunParams["scannedCandidates"];
    workItems?: LocalCompanionStartRunParams["workItems"];
    nextPageUrl?: string | null;
    structured?: LocalCompanionStartRunParams["structured"];
    providerConfig?: LocalCompanionProviderConfig | null;
    resumeFile?: LocalCompanionStartRunParams["resumeFile"];
  }): Promise<LocalCompanionResumeRunResult> {
    const sourceRun = await this.store.getRun(args.userScope, args.runId);
    if (!sourceRun) {
      throw new Error("Run not found");
    }
    if (!args.providerConfig?.apiKey) {
      throw new Error(
        "Missing API key for the configured provider. Add it in Settings to resume Chrome MCP agent tasks."
      );
    }

    if (
      sourceRun.status === "paused" &&
      (sourceRun.workflowId || sourceRun.workflowRunId)
    ) {
      const resumePayload = this.buildWorkflowResumeSignalPayload({
        pageUrl:
          args.pageUrl ??
          sourceRun.progress?.latestPageUrl ??
          sourceRun.pageUrl,
        pageContext: args.pageContext ?? sourceRun.pageContext,
        userContext: args.userContext,
        systemPrompt: args.systemPrompt,
        fieldTarget: args.fieldTarget ?? sourceRun.fieldTarget,
        scannedCandidates: args.scannedCandidates,
        workItems: args.workItems,
        structured: args.structured,
        resumeFile: args.resumeFile,
      });
      const resumed = await this.runtime.resumeAgentTaskWorkflow({
        workflowId: sourceRun.workflowId,
        runId: sourceRun.workflowRunId,
        signalName: "resume",
        ...(resumePayload ? { payload: resumePayload } : {}),
      });
      if (!resumed) {
        throw new Error("Could not resume the paused browser workflow.");
      }
      await this.store.updateRun(args.userScope, sourceRun._id, {
        status: "executing",
        workflowStatus: "running",
        latestSummary:
          "Resumed the paused browser workflow in the local Chrome runtime.",
        completedAt: undefined,
        lastError: undefined,
      });
      await this.updatePrimaryRunTask(args.userScope, sourceRun._id, {
        status: "running",
        latestPageUrl:
          args.pageUrl ??
          sourceRun.progress?.latestPageUrl ??
          sourceRun.pageUrl,
      });
      this.startManagedWorkflowTracking(
        args.userScope,
        sourceRun._id,
        {
          goal: sourceRun.goal,
          platformHint: sourceRun.platformHint,
          pageUrl:
            args.pageUrl ??
            sourceRun.progress?.latestPageUrl ??
            sourceRun.pageUrl,
          pageContext: args.pageContext ?? sourceRun.pageContext,
          fieldTarget: args.fieldTarget ?? sourceRun.fieldTarget,
        },
        {
          workflowId: sourceRun.workflowId ?? sourceRun.workflowRunId ?? sourceRun._id,
          runId: sourceRun.workflowRunId,
        }
      );
      return {
        ok: true,
        status: "executing",
        runId: sourceRun._id,
        runtimeId: sourceRun.workflowRunId ?? sourceRun.workflowId,
        resumedExistingRun: true,
        sourceRunId: sourceRun._id,
      };
    }

    const resumed = await this.createAndLaunchRun(
      {
        userScope: args.userScope,
        goal: sourceRun.goal,
        platformHint: sourceRun.platformHint,
        pageUrl:
          args.pageUrl ??
          sourceRun.progress?.latestPageUrl ??
          sourceRun.pageUrl,
        pageContext: args.pageContext ?? sourceRun.pageContext,
        userContext: args.userContext,
        systemPrompt: args.systemPrompt,
        fieldTarget: args.fieldTarget ?? sourceRun.fieldTarget,
        scannedCandidates: args.scannedCandidates,
        workItems: args.workItems,
        nextPageUrl: args.nextPageUrl,
        structured: args.structured,
        providerConfig: args.providerConfig,
        resumeFile: args.resumeFile,
      },
      {
        resumeSourceRun: sourceRun,
      }
    );

    return {
      ok: true,
      status: "executing",
      runId: resumed.runId,
      runtimeId: resumed.runtimeId,
      resumedExistingRun: false,
      sourceRunId: sourceRun._id,
    };
  }

  async resolveApproval(args: {
    userScope: string;
    approvalId: string;
    decision: "approved" | "rejected";
    decisionNote?: string;
    providerConfig?: LocalCompanionProviderConfig | null;
  }): Promise<LocalCompanionResolveApprovalResult> {
    const approval = await this.store.getApproval(args.userScope, args.approvalId);
    if (!approval) {
      throw new Error("Approval not found");
    }

    if (approval.status === "approved") {
      const approvedAction = coerceActionFromApproval(approval);
      if (approvedAction && !this.activeExecutions.has(approval._id)) {
        await this.store.updateRun(args.userScope, approval.runId, {
          status: "executing",
          latestSummary:
            "Resuming the previously approved action through the local Chrome MCP runtime.",
        });
        this.startApprovedExecution(
          args.userScope,
          approval,
          approvedAction,
          args.providerConfig ?? null
        );
      }
      return {
        ok: true,
        status: approvedAction ? "executing" : "approved",
        runId: approval.runId,
      };
    }

    if (approval.status !== "pending") {
      return {
        ok: true,
        status: approval.status,
        runId: approval.runId,
      };
    }

    if (args.decision === "rejected") {
      this.logger.event("info", "service", "resolve_approval_rejected", {
        approvalId: approval._id,
        runId: approval.runId,
      });
      await this.store.updateApproval(args.userScope, approval._id, {
        status: "rejected",
      });
      await this.store.updateRun(args.userScope, approval.runId, {
        status: "cancelled",
        latestSummary:
          args.decisionNote?.trim() ||
          "The user rejected this approval gate, so the run was cancelled safely.",
        completedAt: Date.now(),
      });
      return {
        ok: true,
        status: "rejected",
        runId: approval.runId,
      };
    }

    const action = coerceActionFromApproval(approval);
    if (!action) {
      throw new Error("Approval payload does not describe an executable action");
    }

    this.logger.event("info", "service", "resolve_approval_approved", {
      approvalId: approval._id,
      runId: approval.runId,
      actionKind: action.kind,
    });
    await this.store.updateApproval(args.userScope, approval._id, {
      status: "approved",
    });
    await this.store.updateRun(args.userScope, approval.runId, {
      status: "executing",
      latestSummary:
        "Approval granted. Executing the reviewed action through the local Chrome MCP runtime.",
    });

    this.startApprovedExecution(
      args.userScope,
      approval,
      action,
      args.providerConfig ?? null
    );

    return {
      ok: true,
      status: "executing",
      runId: approval.runId,
    };
  }

  async reportActionResult(args: {
    userScope: string;
    approvalId: string;
    succeeded: boolean;
    summary?: string;
    errorMessage?: string;
    metadata?: Record<string, unknown>;
  }): Promise<LocalCompanionReportActionResult> {
    const approval = await this.store.getApproval(args.userScope, args.approvalId);
    if (!approval) {
      throw new Error("Approval not found");
    }

    await this.store.updateApproval(args.userScope, approval._id, {
      status: args.succeeded ? "completed" : "failed",
      ...(args.metadata
        ? { payload: { ...(approval.payload ?? {}), actionResult: args.metadata } }
        : {}),
    });

    if (args.succeeded) {
      await this.store.updateRun(args.userScope, approval.runId, {
        status: "completed",
        latestSummary:
          args.summary?.trim() || "Approved action completed successfully.",
        completedAt: Date.now(),
        lastError: undefined,
      });
      return {
        ok: true,
        status: "completed",
        runId: approval.runId,
      };
    }

    const message = args.errorMessage?.trim() || "Approved action failed.";
    await this.store.updateRun(args.userScope, approval.runId, {
      status: "failed",
      latestSummary: message,
      lastError: message,
      completedAt: Date.now(),
    });
    return {
      ok: true,
      status: "failed",
      runId: approval.runId,
    };
  }

  async dispose(): Promise<void> {
    await this.runtime.dispose();
  }

  private getCachedRuntimeHealth(): {
    connected: boolean;
    error?: string;
  } {
    if (this.runtimeHealth) {
      return {
        connected: this.runtimeHealth.connected,
        ...(this.runtimeHealth.error ? { error: this.runtimeHealth.error } : {}),
      };
    }

    return {
      connected: false,
      error: "Starting local browser runtime.",
    };
  }

  private kickOffManagedWorkflowRecovery(userScope?: string): void {
    void this.recoverManagedWorkflowTracking(userScope).catch((error) => {
      this.logger.event("error", "service", "managed_workflow_recovery_failed", {
        ...(userScope ? { userScope } : {}),
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private buildManagedWorkflowTrackingParams(
    run: StoredRunRecord
  ): ManagedWorkflowTrackingParams {
    return {
      goal: run.goal,
      ...(run.platformHint ? { platformHint: run.platformHint } : {}),
      ...(run.progress?.latestPageUrl || run.pageUrl
        ? { pageUrl: run.progress?.latestPageUrl ?? run.pageUrl }
        : {}),
      ...(run.pageContext ? { pageContext: run.pageContext } : {}),
      ...(run.fieldTarget ? { fieldTarget: run.fieldTarget } : {}),
    };
  }

  private buildManagedWorkflowTrackingParamsFromStartParams(
    params: LocalCompanionStartRunParams
  ): ManagedWorkflowTrackingParams {
    return {
      goal: params.goal,
      ...(params.platformHint ? { platformHint: params.platformHint } : {}),
      ...(params.pageUrl ? { pageUrl: params.pageUrl } : {}),
      ...(params.pageContext ? { pageContext: params.pageContext } : {}),
      ...(params.fieldTarget ? { fieldTarget: params.fieldTarget } : {}),
    };
  }

  private async maybeDeriveManagedQueueWorkItems(
    params: LocalCompanionStartRunParams,
    resumeContext?: string,
    siteExperienceContext?: string
  ): Promise<LocalCompanionBrowserWorkItem[] | null> {
    if (!shouldUseManagedAgentWorkflow(params, this.runtime)) {
      return null;
    }

    const existingItems = deriveGenericBrowserWorkItems(params);

    const discovery = await this.runtime.deriveBrowserWorkItems(
      this.buildAgentTaskRuntimeArgs(params, resumeContext, siteExperienceContext)
    );
    const discoveredItems =
      Array.isArray(discovery.workItems) && discovery.workItems.length > 1
        ? discovery.workItems
        : null;

    this.logger.event("info", "service", "derive_work_items", {
      goal: params.goal,
      pageUrl: params.pageUrl,
      mode: discovery.mode,
      itemCount: discovery.workItems.length,
      summary: discovery.summary,
      fallbackItemCount: existingItems.length,
    });

    return discoveredItems ?? (existingItems.length > 1 ? existingItems : null);
  }

  private buildWorkflowResumeSignalPayload(args: {
    pageUrl?: string;
    pageContext?: string;
    userContext?: string;
    systemPrompt?: string;
    fieldTarget?: LocalCompanionStartRunParams["fieldTarget"];
    scannedCandidates?: LocalCompanionStartRunParams["scannedCandidates"];
    workItems?: LocalCompanionStartRunParams["workItems"];
    structured?: LocalCompanionStartRunParams["structured"];
    resumeFile?: LocalCompanionStartRunParams["resumeFile"];
  }): Record<string, unknown> | undefined {
    const payload: Record<string, unknown> = {};

    if (args.pageUrl?.trim()) {
      payload.pageUrl = args.pageUrl.trim();
    }
    if (args.pageContext?.trim()) {
      payload.pageContext = args.pageContext.trim();
    }
    if (args.userContext?.trim()) {
      payload.userContext = args.userContext.trim();
    }
    if (args.systemPrompt?.trim()) {
      payload.systemPrompt = args.systemPrompt.trim();
    }
    if (args.fieldTarget) {
      payload.fieldTarget = args.fieldTarget;
    }
    if (args.structured) {
      payload.structured = args.structured;
    }
    if (args.scannedCandidates?.length) {
      payload.scannedCandidates = args.scannedCandidates;
    }
    if (args.workItems?.length) {
      payload.workItems = args.workItems;
    }
    if (args.resumeFile) {
      payload.resumeFile = args.resumeFile;
    }

    return Object.keys(payload).length > 0 ? payload : undefined;
  }

  private async recoverManagedWorkflowTracking(userScope?: string): Promise<void> {
    if (userScope) {
      if (this.recoveringManagedUsers.has(userScope)) {
        return;
      }
      this.recoveringManagedUsers.add(userScope);
    } else if (this.recoveringAllManagedRuns) {
      return;
    } else {
      this.recoveringAllManagedRuns = true;
    }

    try {
      const runtimeHealth = await this.ensureRuntimeHealthFresh();
      if (!runtimeHealth.connected) {
        return;
      }

      const runs = userScope
        ? await this.store.listRuns(userScope, 40)
        : await this.store.listRecoverableManagedRuns(80);

      for (const run of runs) {
        if (
          run.status !== "executing" ||
          (!run.workflowId && !run.workflowRunId)
        ) {
          continue;
        }
        const executionKey = `agent:${run._id}`;
        if (this.activeExecutions.has(executionKey)) {
          continue;
        }

        this.logger.event("info", "service", "managed_workflow_recovered", {
          runId: run._id,
          workflowId: run.workflowId,
          workflowRunId: run.workflowRunId,
          userScope: run.userScope,
        });
        this.startManagedWorkflowTracking(
          run.userScope,
          run._id,
          this.buildManagedWorkflowTrackingParams(run),
          {
            workflowId: run.workflowId ?? run.workflowRunId ?? run._id,
            runId: run.workflowRunId,
          }
        );
      }
    } finally {
      if (userScope) {
        this.recoveringManagedUsers.delete(userScope);
      } else {
        this.recoveringAllManagedRuns = false;
      }
    }
  }

  private ensureRuntimeHealthFresh(
    force = false
  ): Promise<{
    connected: boolean;
    error?: string;
  }> {
    const now = Date.now();
    const maxAgeMs = this.runtimeHealth?.connected ? 5_000 : 15_000;
    if (
      !force &&
      this.runtimeHealth &&
      now - this.runtimeHealth.checkedAt < maxAgeMs
    ) {
      return Promise.resolve({
        connected: this.runtimeHealth.connected,
        ...(this.runtimeHealth.error ? { error: this.runtimeHealth.error } : {}),
      });
    }

    if (this.runtimeHealthRefreshPromise) {
      return this.runtimeHealthRefreshPromise;
    }

    this.runtimeHealthRefreshPromise = this.runtime
      .checkAvailability()
      .then((health) => {
        this.logger.event(
          health.connected ? "info" : "warn",
          "runtime",
          "health",
          {
            connected: health.connected,
            ...(health.error ? { error: health.error } : {}),
          }
        );
        this.runtimeHealth = {
          connected: health.connected,
          ...(health.error ? { error: health.error } : {}),
          checkedAt: Date.now(),
        };
        return health;
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.event("error", "runtime", "health_failed", {
          message,
        });
        const health = {
          connected: false,
          error: message,
        };
        this.runtimeHealth = {
          ...health,
          checkedAt: Date.now(),
        };
        return health;
      })
      .finally(() => {
        this.runtimeHealthRefreshPromise = null;
      });

    return this.runtimeHealthRefreshPromise;
  }

  private async updatePrimaryRunTask(
    userScope: string,
    runId: string,
    update: {
      status: LocalCompanionRunTask["status"];
      latestPageUrl?: string;
      lastError?: string;
      skipReason?: string;
      incrementRetry?: boolean;
      clearResumeCursor?: boolean;
    }
  ): Promise<void> {
    const run = await this.store.getRun(userScope, runId);
    if (!run?.tasks?.length) {
      return;
    }

    const targetTaskId = run.progress?.resumeCursor ?? run.tasks[0]?._id;
    const now = Date.now();
    const tasks = run.tasks.map((task) => {
      if (task._id !== targetTaskId) {
        return task;
      }

      return {
        ...task,
        status: update.status,
        updatedAt: now,
        ...(task.startedAt ? {} : update.status === "running" ? { startedAt: now } : {}),
        ...(update.status === "completed" ||
        update.status === "failed" ||
        update.status === "skipped"
          ? { completedAt: now }
          : {}),
        ...(typeof update.latestPageUrl === "string" ? { pageUrl: update.latestPageUrl } : {}),
        ...(update.lastError !== undefined
          ? { lastError: update.lastError }
          : update.status === "running" || update.status === "retrying" || update.status === "completed"
            ? { lastError: undefined }
            : {}),
        ...(update.skipReason !== undefined
          ? { skipReason: update.skipReason }
          : update.status !== "skipped"
            ? { skipReason: undefined }
            : {}),
        ...(update.incrementRetry ? { retryCount: task.retryCount + 1 } : {}),
      };
    });

    const progress = buildRunProgressPatch(tasks, {
      latestPageUrl: update.latestPageUrl ?? run.progress?.latestPageUrl ?? run.pageUrl,
      lastCheckpointAt: now,
      ...(update.clearResumeCursor ? {} : { resumeCursor: targetTaskId }),
    });

    await this.store.updateRun(userScope, runId, {
      tasks,
      progress,
    });
  }

  private startApprovedExecution(
    userScope: string,
    approval: StoredApprovalRecord,
    action: LocalCompanionAction,
    providerConfig: LocalCompanionProviderConfig | null
  ): void {
    if (this.activeExecutions.has(approval._id)) {
      return;
    }

    const execution = this.executeApprovedAction(
      userScope,
      approval,
      action,
      providerConfig
    )
      .catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.event("error", "service", "approved_execution_failed", {
          approvalId: approval._id,
          runId: approval.runId,
          actionKind: action.kind,
          message,
        });
        await this.store.updateApproval(userScope, approval._id, {
          status: "failed",
          payload: {
            ...(approval.payload ?? {}),
            actionResult: {
              errorMessage: message,
            },
          },
        });
        await this.store.updateRun(userScope, approval.runId, {
          status: "failed",
          latestSummary: message,
          lastError: message,
          completedAt: Date.now(),
        });
      })
      .finally(() => {
        this.activeExecutions.delete(approval._id);
      });

    this.activeExecutions.set(approval._id, execution);
  }

  private async executeApprovedAction(
    userScope: string,
    approval: StoredApprovalRecord,
    action: LocalCompanionAction,
    providerConfig: LocalCompanionProviderConfig | null
  ): Promise<void> {
    if (!providerConfig?.apiKey) {
      throw new Error(
        "Missing API key for the configured provider. Add it in Settings before approving browser actions."
      );
    }

    const run = await this.store.getRun(userScope, approval.runId);
    if (!run) {
      throw new Error("Run not found for approval execution");
    }
    this.logger.event("info", "service", "approved_execution_start", {
      approvalId: approval._id,
      runId: approval.runId,
      actionKind: action.kind,
    });

    let outcome:
      | {
          summary: string;
          metadata?: Record<string, unknown>;
        }
      | undefined;

    if (action.kind === "insert_draft") {
      const pageUrl = action.pageUrl?.trim() || run.pageUrl?.trim();
      if (!pageUrl) {
        throw new Error(
          "The run does not have a page URL, so the approved draft cannot be inserted."
        );
      }
      outcome = await this.runtime.insertDraft({
        pageUrl,
        fieldTarget: action.fieldTarget,
        generatedText: action.generatedText,
        verifyText: action.verifyText,
        providerConfig,
        ...(action.targetName ? { targetName: action.targetName } : {}),
      });
    } else if (action.kind === "enqueue_task_batch") {
      if (action.batchType !== "linkedin_connect") {
        throw new Error(`Unsupported task batch type: ${action.batchType}`);
      }
      if (this.runtime.supportsManagedTaskWorkflows()) {
        const workflowExecution = await this.runtime.startLinkedInConnectBatchWorkflow({
          items: action.items,
          dailyLimit: action.dailyLimit,
          providerConfig,
        });
        await this.store.updateRun(userScope, approval.runId, {
          status: "executing",
          workflowId: workflowExecution.workflowId,
          workflowRunId: workflowExecution.runId,
          workflowStatus: "scheduled",
          latestSummary:
            "LinkedIn connect batch workflow started in the local Chrome runtime.",
          completedAt: undefined,
          lastError: undefined,
        });
        await this.trackManagedWorkflowExecution(
          userScope,
          approval.runId,
          this.buildManagedWorkflowTrackingParams(run),
          workflowExecution
        );
        const workflowStatus = coerceWorkflowStatus(
          await this.runtime.getAgentTaskWorkflowStatus({
            workflowId: workflowExecution.workflowId,
            runId: workflowExecution.runId,
          })
        );
        const workflowValue = workflowStatus?.value;
        outcome =
          workflowValue &&
          typeof workflowValue.summary === "string" &&
          workflowValue.summary.trim()
            ? {
                summary: workflowValue.summary.trim(),
                metadata: isPlainObject(workflowValue.metadata)
                  ? (workflowValue.metadata as Record<string, unknown>)
                  : undefined,
              }
            : {
                summary:
                  "LinkedIn connect batch workflow completed in the local Chrome runtime.",
              };
      } else {
        outcome = await this.runtime.executeLinkedInConnectBatch({
          items: action.items,
          dailyLimit: action.dailyLimit,
          providerConfig,
        });
      }
      const sentCount =
        typeof outcome.metadata?.sent === "number" ? outcome.metadata.sent : 0;
      const failedCount =
        typeof outcome.metadata?.failed === "number" ? outcome.metadata.failed : 0;
      if (failedCount > 0 && sentCount === 0) {
        throw new Error(outcome.summary);
      }
    } else {
      throw new Error(`Unsupported companion action: ${(action as { kind: string }).kind}`);
    }

    await this.store.updateApproval(userScope, approval._id, {
      status: "completed",
      payload: {
        ...(approval.payload ?? {}),
        ...(outcome?.metadata ? { actionResult: outcome.metadata } : {}),
      },
    });
    await this.store.updateRun(userScope, approval.runId, {
      status: "completed",
      latestSummary:
        outcome?.summary || "Approved action completed successfully.",
      completedAt: Date.now(),
      lastError: undefined,
    });
    this.logger.event("info", "service", "approved_execution_complete", {
      approvalId: approval._id,
      runId: approval.runId,
      actionKind: action.kind,
      summary: outcome?.summary,
    });
  }

  private startAgentTaskExecution(
    userScope: string,
    runId: string,
    params: LocalCompanionStartRunParams,
    resumeContext?: string,
    siteExperienceContext?: string
  ): void {
    const executionKey = `agent:${runId}`;
    if (this.activeExecutions.has(executionKey)) {
      return;
    }

    const execution = this.executeAgentTask(
      userScope,
      runId,
      params,
      resumeContext,
      siteExperienceContext
    )
      .catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        const currentRun = await this.store.getRun(userScope, runId);
        if (currentRun?.status === "cancelled") {
          this.logger.event("info", "service", "agent_task_cancelled", {
            runId,
            message,
          });
          return;
        }
        this.logger.event("error", "service", "agent_task_failed", {
          runId,
          message,
        });
        await this.updatePrimaryRunTask(userScope, runId, {
          status: "failed",
          lastError: message,
          latestPageUrl: params.pageUrl,
        });
        const failedRun = await this.store.getRun(userScope, runId);
        const progressSummary = summarizeRunProgress(failedRun?.progress);
        await this.store.updateRun(userScope, runId, {
          status: "failed",
          latestSummary: progressSummary ? `${message} · ${progressSummary}` : message,
          lastError: message,
          completedAt: Date.now(),
          ...(failedRun
            ? {
                siteMemory: buildRunSiteMemory({
                  run: failedRun,
                  fallbackPageUrl: params.pageUrl,
                  tasks: failedRun.tasks,
                  terminalStatus: "failed",
                  summary: progressSummary ? `${message} · ${progressSummary}` : message,
                  lastError: message,
                }),
              }
            : {}),
        });
      })
      .finally(() => {
        this.activeExecutions.delete(executionKey);
      });

    this.activeExecutions.set(executionKey, execution);
  }

  private buildAgentTaskRuntimeArgs(
    params: LocalCompanionStartRunParams,
    resumeContext?: string,
    siteExperienceContext?: string
  ): {
    providerConfig: LocalCompanionProviderConfig;
    goal: string;
    pageUrl?: string;
    platformHint?: string;
    pageContext?: string;
    resumeContext?: string;
    siteExperienceContext?: string;
    userContext?: string;
    systemPrompt?: string;
    fieldTarget?: LocalCompanionStartRunParams["fieldTarget"];
    structured?: LocalCompanionStartRunParams["structured"];
    scannedCandidates?: LocalCompanionStartRunParams["scannedCandidates"];
    workItems?: LocalCompanionBrowserWorkItem[];
    resumeFile?: LocalCompanionStartRunParams["resumeFile"];
  } {
    const workItems = deriveGenericBrowserWorkItems(params);
    return {
      providerConfig: params.providerConfig as LocalCompanionProviderConfig,
      goal: params.goal,
      ...(typeof params.pageUrl === "string" ? { pageUrl: params.pageUrl } : {}),
      ...(typeof params.platformHint === "string"
        ? { platformHint: params.platformHint }
        : {}),
      ...(typeof params.pageContext === "string"
        ? { pageContext: params.pageContext }
        : {}),
      ...(typeof resumeContext === "string" ? { resumeContext } : {}),
      ...(typeof siteExperienceContext === "string"
        ? { siteExperienceContext }
        : {}),
      ...(typeof params.userContext === "string"
        ? { userContext: params.userContext }
        : {}),
      ...(typeof params.systemPrompt === "string"
        ? { systemPrompt: params.systemPrompt }
        : {}),
      ...(params.fieldTarget ? { fieldTarget: params.fieldTarget } : {}),
      ...(params.structured ? { structured: params.structured } : {}),
      ...(params.scannedCandidates && params.scannedCandidates.length > 0
        ? { scannedCandidates: params.scannedCandidates }
        : {}),
      ...(workItems.length > 1 ? { workItems } : {}),
      ...(params.resumeFile ? { resumeFile: params.resumeFile } : {}),
    };
  }

  private async finalizeAgentTaskOutcome(
    userScope: string,
    runId: string,
    params: ManagedWorkflowTrackingParams,
    outcome: {
      summary: string;
      metadata?: Record<string, unknown>;
    }
  ): Promise<void> {
    const finalPageUrl =
      typeof outcome.metadata?.finalUrl === "string" && outcome.metadata.finalUrl.trim()
        ? outcome.metadata.finalUrl.trim()
        : typeof outcome.metadata?.targetUrl === "string" && outcome.metadata.targetUrl.trim()
          ? outcome.metadata.targetUrl.trim()
          : params.pageUrl;
    const updatedRun = await this.store.getRun(userScope, runId);
    const runtimeSteps = coerceRuntimeTaskSteps(outcome.metadata);
    const completedTasks =
      buildRunTasksFromRuntimeSteps({
        existingTasks: updatedRun?.tasks,
        runtimeSteps,
        finalPageUrl,
      }) ??
      updatedRun?.tasks?.map((task, index) => ({
        ...task,
        ...(index === 0
          ? {
              status: "completed" as const,
              updatedAt: Date.now(),
              completedAt: Date.now(),
              ...(finalPageUrl ? { pageUrl: finalPageUrl } : {}),
              lastError: undefined,
              skipReason: undefined,
            }
          : task),
      }));

    if (completedTasks?.length) {
      await this.store.updateRun(userScope, runId, {
        tasks: completedTasks,
        progress: buildRunProgressPatch(completedTasks, {
          latestPageUrl: finalPageUrl,
          lastCheckpointAt: Date.now(),
        }),
      });
    } else {
      await this.updatePrimaryRunTask(userScope, runId, {
        status: "completed",
        latestPageUrl: finalPageUrl,
        clearResumeCursor: true,
      });
    }

    const refreshedRun = await this.store.getRun(userScope, runId);
    const progressSummary = summarizeRunProgress(refreshedRun?.progress);

    await this.store.updateRun(userScope, runId, {
      status: "completed",
      workflowStatus: "completed",
      latestSummary: progressSummary
        ? `${outcome.summary} · ${progressSummary}`
        : outcome.summary,
      completedAt: Date.now(),
      lastError: undefined,
      ...(refreshedRun
        ? {
            siteMemory: buildRunSiteMemory({
              run: refreshedRun,
              fallbackPageUrl: finalPageUrl,
              tasks: completedTasks ?? refreshedRun.tasks,
              workflowName:
                typeof outcome.metadata?.workflowName === "string"
                  ? outcome.metadata.workflowName
                  : undefined,
              queueType:
                typeof outcome.metadata?.queueType === "string"
                  ? outcome.metadata.queueType
                  : typeof outcome.metadata?.batchType === "string"
                    ? outcome.metadata.batchType
                    : undefined,
              terminalStatus: "completed",
              summary: progressSummary
                ? `${outcome.summary} · ${progressSummary}`
                : outcome.summary,
              itemCount:
                typeof outcome.metadata?.itemCount === "number"
                  ? outcome.metadata.itemCount
                  : undefined,
            }),
          }
        : {}),
    });
    this.logger.event("info", "service", "agent_task_complete", {
      runId,
      summary: outcome.summary,
    });
  }

  private async trackManagedWorkflowExecution(
    userScope: string,
    runId: string,
    params: ManagedWorkflowTrackingParams,
    workflowExecution: {
      workflowId: string;
      runId?: string;
    }
  ): Promise<void> {
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      const workflowStatus = coerceWorkflowStatus(
        await this.runtime.getAgentTaskWorkflowStatus({
          workflowId: workflowExecution.workflowId,
          runId: workflowExecution.runId,
        })
      );

      if (!workflowStatus) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        continue;
      }

      const workflowState = workflowStatus.state;
      const attemptCount =
        typeof workflowState?.metadata === "object" &&
        workflowState.metadata !== null &&
        typeof (workflowState.metadata as Record<string, unknown>).attempts === "number"
          ? Number((workflowState.metadata as Record<string, unknown>).attempts)
          : undefined;
      const workflowRunStatus =
        typeof workflowStatus.status === "string" ? workflowStatus.status : undefined;
      const latestPageUrl =
        typeof workflowState?.metadata === "object" &&
        workflowState.metadata !== null &&
        typeof (workflowState.metadata as Record<string, unknown>).latestPageUrl ===
          "string"
          ? String((workflowState.metadata as Record<string, unknown>).latestPageUrl)
          : params.pageUrl;
      const workflowPauseReason =
        typeof workflowState?.metadata === "object" &&
        workflowState.metadata !== null &&
        typeof (workflowState.metadata as Record<string, unknown>).pauseReason ===
          "string"
          ? String((workflowState.metadata as Record<string, unknown>).pauseReason)
          : typeof workflowState?.metadata === "object" &&
              workflowState.metadata !== null &&
              typeof (workflowState.metadata as Record<string, unknown>).lastError ===
                "string"
            ? String((workflowState.metadata as Record<string, unknown>).lastError)
            : undefined;
      const workflowStateMetadata =
        typeof workflowState?.metadata === "object" && workflowState.metadata !== null
          ? (workflowState.metadata as Record<string, unknown>)
          : undefined;
      const workflowStateSteps = coerceRuntimeTaskSteps(workflowStateMetadata);
      const currentRun = await this.store.getRun(userScope, runId);
      if (currentRun?.status === "cancelled" && workflowRunStatus !== "cancelled") {
        await new Promise((resolve) => setTimeout(resolve, 400));
        continue;
      }

      await this.store.updateRun(userScope, runId, {
        workflowId: workflowExecution.workflowId,
        workflowRunId: workflowExecution.runId,
        ...(workflowRunStatus ? { workflowStatus: workflowRunStatus } : {}),
        latestSummary:
          workflowRunStatus === "running" && attemptCount && attemptCount > 1
            ? `Workflow retry ${attemptCount} in progress inside the local Chrome runtime.`
            : workflowRunStatus === "running"
              ? "Workflow running inside the local Chrome runtime."
              : workflowRunStatus === "scheduled"
                ? "Workflow scheduled in the local Chrome runtime."
                : undefined,
      });
      if (workflowStateSteps.length > 0) {
        const currentRunForSteps = await this.store.getRun(userScope, runId);
        const updatedTasks = buildRunTasksFromRuntimeSteps({
          existingTasks: currentRunForSteps?.tasks,
          runtimeSteps: workflowStateSteps,
          finalPageUrl: latestPageUrl,
        });
        if (updatedTasks) {
          await this.store.updateRun(userScope, runId, {
            tasks: updatedTasks,
            progress: buildRunProgressPatch(updatedTasks, {
              latestPageUrl,
              lastCheckpointAt: Date.now(),
            }),
          });
        }
      }
      if (isPausedWorkflowStatus(workflowRunStatus)) {
        await this.updatePrimaryRunTask(userScope, runId, {
          status: "blocked",
          latestPageUrl,
          ...(workflowPauseReason ? { lastError: workflowPauseReason } : {}),
        });
        await this.store.updateRun(userScope, runId, {
          status: "paused",
          workflowId: workflowExecution.workflowId,
          workflowRunId: workflowExecution.runId,
          workflowStatus: workflowRunStatus,
          latestSummary:
            workflowPauseReason && workflowPauseReason.trim()
              ? `Workflow paused inside the local Chrome runtime. ${workflowPauseReason.trim()}`
              : "Workflow paused inside the local Chrome runtime. Resume to continue from the last checkpoint.",
          completedAt: undefined,
        });
        this.logger.event("info", "service", "agent_task_paused", {
          runId,
          workflowId: workflowExecution.workflowId,
          workflowRunId: workflowExecution.runId,
        });
        return;
      }

      if (attemptCount && attemptCount > 1) {
        await this.updatePrimaryRunTask(userScope, runId, {
          status: "retrying",
          latestPageUrl,
        });
      } else if (workflowRunStatus === "running" || workflowRunStatus === "scheduled") {
        await this.updatePrimaryRunTask(userScope, runId, {
          status: "running",
          latestPageUrl,
        });
      }

      if (workflowStatus.completed) {
        const outcomeValue = workflowStatus.value;
        if (
          !outcomeValue ||
          typeof outcomeValue.summary !== "string" ||
          !outcomeValue.summary.trim()
        ) {
          throw new Error("Managed browser workflow completed without a usable result.");
        }
        await this.finalizeAgentTaskOutcome(userScope, runId, params, {
          summary: outcomeValue.summary.trim(),
          metadata: isPlainObject(outcomeValue.metadata)
            ? (outcomeValue.metadata as Record<string, unknown>)
            : undefined,
        });
        return;
      }

      if (
        !workflowStatus.running &&
        workflowRunStatus &&
        workflowRunStatus !== "paused" &&
        workflowRunStatus !== "scheduled" &&
        workflowRunStatus !== "running"
      ) {
        const currentRun = await this.store.getRun(userScope, runId);
        if (currentRun?.status === "cancelled" && workflowRunStatus === "cancelled") {
          this.logger.event("info", "service", "managed_workflow_cancelled", {
            runId,
            workflowId: workflowExecution.workflowId,
            workflowRunId: workflowExecution.runId,
          });
          return;
        }
        throw new Error(
          workflowStatus.error || `Managed browser workflow ended with status ${workflowRunStatus}.`
        );
      }

      await new Promise((resolve) => setTimeout(resolve, 400));
    }

    throw new Error("Managed browser workflow timed out.");
  }

  private startManagedWorkflowTracking(
    userScope: string,
    runId: string,
    params: ManagedWorkflowTrackingParams,
    workflowExecution: {
      workflowId: string;
      runId?: string;
    }
  ): void {
    const executionKey = `agent:${runId}`;
    if (this.activeExecutions.has(executionKey)) {
      return;
    }

    const execution = this.trackManagedWorkflowExecution(
      userScope,
      runId,
      params,
      workflowExecution
    )
      .catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        const currentRun = await this.store.getRun(userScope, runId);
        if (currentRun?.status === "cancelled") {
          this.logger.event("info", "service", "managed_workflow_cancelled", {
            runId,
            message,
          });
          return;
        }
        this.logger.event("error", "service", "agent_task_failed", {
          runId,
          message,
        });
        await this.updatePrimaryRunTask(userScope, runId, {
          status: "failed",
          lastError: message,
          latestPageUrl: params.pageUrl,
        });
        const failedRun = await this.store.getRun(userScope, runId);
        const progressSummary = summarizeRunProgress(failedRun?.progress);
        await this.store.updateRun(userScope, runId, {
          status: "failed",
          latestSummary: progressSummary ? `${message} · ${progressSummary}` : message,
          lastError: message,
          completedAt: Date.now(),
        });
      })
      .finally(() => {
        this.activeExecutions.delete(executionKey);
      });

    this.activeExecutions.set(executionKey, execution);
  }

  private async executeAgentTaskViaManagedWorkflow(
    userScope: string,
    runId: string,
    params: LocalCompanionStartRunParams,
    resumeContext?: string,
    siteExperienceContext?: string
  ): Promise<void> {
    let runtimeArgs = this.buildAgentTaskRuntimeArgs(
      params,
      resumeContext,
      siteExperienceContext
    );
    let useQueueWorkflow = false;
    try {
      const discoveredWorkItems = await this.maybeDeriveManagedQueueWorkItems(
        params,
        resumeContext,
        siteExperienceContext
      );
      if (discoveredWorkItems && discoveredWorkItems.length > 1) {
        runtimeArgs = {
          ...runtimeArgs,
          workItems: discoveredWorkItems,
        };
        useQueueWorkflow = true;
        const queuedTasks = createRunTasksFromWorkItems(discoveredWorkItems, {
          firstTaskRunning: true,
        });
        await this.store.updateRun(userScope, runId, {
          workItems: discoveredWorkItems,
          tasks: queuedTasks,
          progress: buildRunProgressPatch(queuedTasks, {
            latestPageUrl:
              discoveredWorkItems[0]?.pageUrl ?? params.pageUrl,
            resumeCursor: queuedTasks[0]?._id,
          }),
          latestSummary:
            "Started a durable queue workflow from repeated browser work items.",
        });
      }
    } catch (error) {
      this.logger.event("warn", "service", "derive_work_items_failed", {
        runId,
        goal: params.goal,
        message: error instanceof Error ? error.message : String(error),
      });
      if (
        error instanceof Error &&
        !isRetryableAgentError(error.message)
      ) {
        throw error;
      }
      const fallbackWorkItems = deriveGenericBrowserWorkItems(params);
      if (fallbackWorkItems.length > 1) {
        runtimeArgs = {
          ...runtimeArgs,
          workItems: fallbackWorkItems,
        };
        useQueueWorkflow = true;
        const queuedTasks = createRunTasksFromWorkItems(fallbackWorkItems, {
          firstTaskRunning: true,
        });
        await this.store.updateRun(userScope, runId, {
          workItems: fallbackWorkItems,
          tasks: queuedTasks,
          progress: buildRunProgressPatch(queuedTasks, {
            latestPageUrl: fallbackWorkItems[0]?.pageUrl ?? params.pageUrl,
            resumeCursor: queuedTasks[0]?._id,
          }),
          latestSummary:
            "Started a durable queue workflow using fallback browser work items after agent discovery failed.",
        });
      }
    }

    const workflowExecution = useQueueWorkflow
      ? await this.runtime.startGenericBrowserQueueWorkflow({
          ...runtimeArgs,
          workItems: runtimeArgs.workItems ?? deriveGenericBrowserWorkItems(params),
        })
      : await this.runtime.startAgentTaskWorkflow(runtimeArgs);
    await this.store.updateRun(userScope, runId, {
      workflowId: workflowExecution.workflowId,
      workflowRunId: workflowExecution.runId,
      workflowStatus: "scheduled",
      latestSummary: useQueueWorkflow
        ? "Generic browser queue workflow started in the local Chrome runtime."
        : "Generic browser task workflow started in the local Chrome runtime.",
    });
    await this.trackManagedWorkflowExecution(
      userScope,
      runId,
      this.buildManagedWorkflowTrackingParamsFromStartParams(params),
      workflowExecution
    );
  }

  private async executeAgentTask(
    userScope: string,
    runId: string,
    params: LocalCompanionStartRunParams,
    resumeContext?: string,
    siteExperienceContext?: string
  ): Promise<void> {
    if (!params.providerConfig?.apiKey) {
      throw new Error(
        "Missing API key for the configured provider. Add it in Settings to run Chrome MCP agent tasks."
      );
    }

    this.logger.event("info", "service", "agent_task_start", {
      runId,
      provider: params.providerConfig.provider,
      model: params.providerConfig.model,
      goal: params.goal,
      pageUrl: params.pageUrl,
    });

    if (shouldUseManagedAgentWorkflow(params, this.runtime)) {
      await this.executeAgentTaskViaManagedWorkflow(
        userScope,
        runId,
        params,
        resumeContext,
        siteExperienceContext
      );
      return;
    }

    let outcome:
      | {
          summary: string;
          metadata?: Record<string, unknown>;
        }
      | undefined;
    let lastErrorMessage = "";
    const maxRetries =
      typeof (this.runtime as { supportsManagedTaskRetries?: () => boolean })
        .supportsManagedTaskRetries === "function" &&
      (this.runtime as { supportsManagedTaskRetries: () => boolean })
        .supportsManagedTaskRetries() &&
      !isLinkedInProfileConnectGoal(params)
        ? 0
        : MAX_AGENT_TASK_RETRIES;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      await this.updatePrimaryRunTask(userScope, runId, {
        status: attempt === 0 ? "running" : "retrying",
        ...(attempt > 0 ? { incrementRetry: true } : {}),
        latestPageUrl: params.pageUrl,
        ...(lastErrorMessage ? { lastError: lastErrorMessage } : {}),
      });

      if (attempt > 0) {
        await this.store.updateRun(userScope, runId, {
          status: "executing",
          latestSummary: `Retrying from the last checkpoint (${attempt}/${maxRetries}) after: ${lastErrorMessage}`,
        });
      }

      try {
        outcome = await this.runtime.executeAgentTask(
          this.buildAgentTaskRuntimeArgs(
            params,
            resumeContext,
            siteExperienceContext
          )
        );
        break;
      } catch (error) {
        lastErrorMessage = error instanceof Error ? error.message : String(error);
        const shouldRetry =
          attempt < maxRetries && isRetryableAgentError(lastErrorMessage);
        this.logger.event(
          shouldRetry ? "warn" : "error",
          "service",
          shouldRetry ? "agent_task_retry_scheduled" : "agent_task_retry_exhausted",
          {
            runId,
            attempt: attempt + 1,
            maxAttempts: maxRetries + 1,
            message: lastErrorMessage,
          }
        );

        await this.updatePrimaryRunTask(userScope, runId, {
          status: shouldRetry ? "retrying" : "failed",
          latestPageUrl: params.pageUrl,
          lastError: lastErrorMessage,
        });

        if (!shouldRetry) {
          throw error;
        }

        await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
      }
    }

    if (!outcome) {
      throw new Error(lastErrorMessage || "The browser agent did not return an outcome.");
    }
    await this.finalizeAgentTaskOutcome(userScope, runId, params, outcome);
  }

  private async findResumeSourceRun(
    params: LocalCompanionStartRunParams
  ): Promise<StoredRunRecord | null> {
    const recentRuns = await this.store.listRuns(params.userScope, 12);
    if (recentRuns.length === 0) {
      return null;
    }

    const currentPageUrl = normalizeComparableUrl(params.pageUrl);
    const incompleteRuns = recentRuns.filter(
      (run) => run.status !== "completed" && run.status !== "cancelled"
    );

    if (isResumeLikeGoal(params.goal)) {
      return incompleteRuns[0] ?? recentRuns[0] ?? null;
    }

    if (!currentPageUrl) {
      return null;
    }

    const normalizedGoal = normalizeGoalForImplicitContinuation(params.goal);
    if (!normalizedGoal) {
      return null;
    }

    return (
      incompleteRuns.find((run) => {
        const runPageUrl = normalizeComparableUrl(
          run.progress?.latestPageUrl ?? run.pageUrl
        );
        if (runPageUrl !== currentPageUrl) {
          return false;
        }
        return normalizeGoalForImplicitContinuation(run.goal) === normalizedGoal;
      }) ?? null
    );
  }

  private async findSiteExperienceContext(
    params: LocalCompanionStartRunParams,
    excludeRunId?: string
  ): Promise<string | undefined> {
    const currentHost = extractComparableHost(params.pageUrl);
    if (!currentHost) {
      return undefined;
    }
    if (currentHost === "google.com" || currentHost === "www.google.com") {
      return undefined;
    }
    const currentPathFamily = extractPathFamily(params.pageUrl);
    if (!currentPathFamily) {
      return undefined;
    }
    const recentRuns = await this.store.listRuns(params.userScope, 16);
    const matchingRuns = recentRuns.filter((run) => {
      if (excludeRunId && run._id === excludeRunId) {
        return false;
      }
      if (run._id === excludeRunId) {
        return false;
      }
      const sameHost =
        currentHost &&
        (extractComparableHost(run.siteMemory?.host) ??
          extractComparableHost(run.progress?.latestPageUrl ?? run.pageUrl)) === currentHost;
      const runPathFamily =
        extractPathFamily(run.siteMemory?.pagePattern) ??
        extractPathFamily(run.progress?.latestPageUrl ?? run.pageUrl);
      const samePathFamily =
        currentPathFamily &&
        runPathFamily &&
        currentPathFamily === runPathFamily;
      return Boolean(sameHost && samePathFamily);
    });

    const context = buildSiteExperienceContext(matchingRuns);
    return context || undefined;
  }
}
