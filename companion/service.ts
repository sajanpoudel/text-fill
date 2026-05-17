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

function isRetryableAgentError(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) return true;
  if (
    normalized.includes("missing api key") ||
    normalized.includes("providerconfig is required") ||
    normalized.includes("goal is required") ||
    normalized.includes("approval not found") ||
    normalized.includes("unsupported")
  ) {
    return false;
  }
  return true;
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
  private readonly activeRunAbortControllers = new Map<string, AbortController>();
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
    void this.recoverInterruptedRuns();
  }

  async getPanelState(args: {
    userScope: string;
    limit?: number;
  }): Promise<LocalCompanionPanelState> {
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
    if (!params.providerConfig?.apiKey) {
      throw new Error(
        "Missing API key for the configured provider. Add it in Settings to run Chrome MCP agent tasks."
      );
    }

    const resumeSourceRun =
      options?.resumeSourceRun !== undefined
        ? options.resumeSourceRun
        : await this.findResumeSourceRun(params);
    const resumeContext = resumeSourceRun
      ? buildResumeContext(resumeSourceRun)
      : undefined;
    const siteExperienceContext = await this.findSiteExperienceContext(
      params,
      resumeSourceRun?._id
    );
    const initialTasks = createInitialRunTasks(params);
    const initialWorkItems = deriveGenericBrowserWorkItems(params);
    const initialTask = initialTasks[0];
    const initialProgress = buildRunProgressPatch(initialTasks, {
      latestPageUrl: params.pageUrl,
      resumeCursor: initialTask?._id,
    });

    const run = await this.store.createRun({
      userScope: params.userScope,
      goal: params.goal,
      platformHint: params.platformHint,
      pageUrl: params.pageUrl,
      pageContext: params.pageContext,
      fieldTarget: params.fieldTarget,
      resumeSourceRunId: resumeSourceRun?._id,
      ...(initialWorkItems.length > 0 ? { workItems: initialWorkItems } : {}),
      tasks: initialTasks,
      progress: initialProgress,
    });

    try {
      this.logger.event("info", "service", "start_run", {
        runId: run._id,
        goal: params.goal,
        platformHint: params.platformHint,
        pageUrl: params.pageUrl,
        ...(resumeSourceRun ? { resumeSourceRunId: resumeSourceRun._id } : {}),
        provider: params.providerConfig.provider,
        model: params.providerConfig.model,
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
          latestPageUrl: params.pageUrl,
          resumeCursor: initialTask._id,
        }),
      });
      this.startAgentTaskExecution(
        params.userScope,
        run._id,
        params,
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

    this.activeRunAbortControllers.get(run._id)?.abort();
    this.runtime.killPythonBridge();

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

  private async recoverInterruptedRuns(): Promise<void> {
    try {
      const userScopes = await this.store.getAllUserScopes();
      for (const userScope of userScopes) {
        const runs = await this.store.listRuns(userScope, 50);
        for (const run of runs) {
          if (run.status === "executing" || run.status === "planning") {
            await this.store.updateRun(userScope, run._id, {
              status: "failed",
              lastError: "Run was interrupted when the companion server restarted.",
              latestSummary: "Run interrupted by server restart.",
              completedAt: Date.now(),
              workflowId: undefined,
              workflowRunId: undefined,
              workflowStatus: undefined,
            });
            this.logger.event("info", "service", "run_marked_interrupted", {
              runId: run._id,
              userScope,
            });
          }
        }
      }
    } catch (error) {
      this.logger.event("error", "service", "recover_interrupted_runs_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
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
      outcome = await this.runtime.executeLinkedInConnectBatch({
        items: action.items,
        dailyLimit: action.dailyLimit,
        providerConfig,
      });
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

    const controller = new AbortController();
    this.activeRunAbortControllers.set(runId, controller);

    const execution = this.executeAgentTask(
      userScope,
      runId,
      params,
      resumeContext,
      siteExperienceContext,
      controller.signal
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
        this.activeRunAbortControllers.delete(runId);
      });

    this.activeExecutions.set(executionKey, execution);
  }

  private buildAgentTaskRuntimeArgs(
    params: LocalCompanionStartRunParams,
    resumeContext?: string,
    siteExperienceContext?: string,
    runId?: string
  ): {
    providerConfig: LocalCompanionProviderConfig;
    goal: string;
    runId?: string;
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
      ...(runId ? { runId } : {}),
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
    params: { pageUrl?: string },
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

    // Plan-managed tasks (ids "task_0", "task_1", …) are updated live via progress
    // events. Rebuilding them here would race with pending incrementCompletedTasks
    // mutations and double-count completions. Only touch tasks when there are no
    // plan-managed tasks or when the metadata provides explicit runtime steps.
    const hasPlanManagedTasks = updatedRun?.tasks?.some((t) =>
      /^task_\d+$/.test(t._id)
    );
    const runtimeSteps = coerceRuntimeTaskSteps(outcome.metadata);

    if (!hasPlanManagedTasks) {
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
    } else if (finalPageUrl) {
      await this.store.updateRunProgress(userScope, runId, {
        latestPageUrl: finalPageUrl,
        lastCheckpointAt: Date.now(),
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
              tasks: refreshedRun.tasks,
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



  private async executeAgentTask(
    userScope: string,
    runId: string,
    params: LocalCompanionStartRunParams,
    resumeContext?: string,
    siteExperienceContext?: string,
    signal?: AbortSignal
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

    await this.runtime.registerProgressHandler(runId, (event) => {
      void this.handleProgressEvent(event, userScope, runId);
    });

    let outcome:
      | {
          summary: string;
          metadata?: Record<string, unknown>;
        }
      | undefined;
    let lastErrorMessage = "";
    const maxRetries = MAX_AGENT_TASK_RETRIES;

    try {
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
            siteExperienceContext,
            runId
          ),
          signal
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
    } finally {
      this.runtime.unregisterProgressHandler(runId);
    }
  }

  private async handleProgressEvent(
    event: Record<string, unknown>,
    userScope: string,
    runId: string
  ): Promise<void> {
    const eventType = typeof event.event === "string" ? event.event : null;
    if (!eventType) return;

    switch (eventType) {
      case "planning":
        await this.store.updateRun(userScope, runId, {
          status: "planning",
          latestSummary: "Generating a step-by-step plan…",
        });
        break;

      case "plan_ready": {
        const rawSteps = Array.isArray(event.steps) ? event.steps : [];
        const now = Date.now();
        const tasks: LocalCompanionRunTask[] = rawSteps.map((step, i) => ({
          _id: `task_${i}`,
          title:
            typeof (step as Record<string, unknown>).title === "string"
              ? String((step as Record<string, unknown>).title)
              : `Step ${i + 1}`,
          status: "pending" as const,
          retryCount: 0,
          createdAt: now,
          updatedAt: now,
        }));
        await this.store.updateRun(userScope, runId, {
          status: "executing",
          tasks,
          progress: {
            totalTasks: tasks.length,
            completedTasks: 0,
            skippedTasks: 0,
            blockedTasks: 0,
            retryingTasks: 0,
            currentTaskIndex: 0,
          },
          latestSummary: `Plan ready: ${tasks.length} step${tasks.length !== 1 ? "s" : ""}.`,
        });
        break;
      }

      case "step_started": {
        const idx = typeof event.index === "number" ? event.index : 0;
        const stepTitle = typeof event.title === "string" && event.title.trim()
          ? event.title.trim() : null;
        await this.store.updateRunTask(userScope, runId, idx, {
          status: "running",
          startedAt: Date.now(),
        });
        await this.store.updateRunProgress(userScope, runId, { currentTaskIndex: idx });
        if (stepTitle) {
          await this.store.updateRun(userScope, runId, {
            latestSummary: `Step ${idx + 1}: ${stepTitle}`,
          });
        }
        break;
      }

      case "step_retrying": {
        const idx = typeof event.index === "number" ? event.index : 0;
        const attempt = typeof event.attempt === "number" ? event.attempt : 1;
        const err = typeof event.error === "string" ? event.error : undefined;
        await this.store.updateRunTask(userScope, runId, idx, {
          status: "retrying",
          retryCount: attempt,
          ...(err ? { lastError: err } : {}),
        });
        break;
      }

      case "step_completed": {
        const idx = typeof event.index === "number" ? event.index : 0;
        const summary = typeof event.summary === "string" && event.summary.trim()
          ? event.summary.trim() : undefined;
        const verified = typeof event.verified === "boolean" ? event.verified : undefined;
        const observations = typeof event.observations === "string" && event.observations.trim()
          ? event.observations.trim()
          : undefined;
        await this.store.updateRunTask(userScope, runId, idx, {
          status: "completed",
          completedAt: Date.now(),
          lastError: undefined,
          ...(summary ? { resultSummary: summary } : {}),
          ...(verified !== undefined ? { verified } : {}),
          ...(observations ? { observations } : {}),
        });
        await this.store.incrementCompletedTasks(userScope, runId);
        if (summary) {
          await this.store.updateRun(userScope, runId, { latestSummary: summary });
        }
        break;
      }

      case "step_failed": {
        const idx = typeof event.index === "number" ? event.index : 0;
        const err = typeof event.error === "string" ? event.error : "Step failed";
        const skipped = event.skipped === true;
        await this.store.updateRunTask(userScope, runId, idx, {
          status: skipped ? "skipped" : "failed",
          lastError: err,
        });
        break;
      }
    }
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

    return (
      incompleteRuns.find((run) => {
        const runPageUrl = normalizeComparableUrl(
          run.progress?.latestPageUrl ?? run.pageUrl
        );
        return runPageUrl === currentPageUrl;
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
    const currentPathFamily = extractPathFamily(params.pageUrl);
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
      if (sameHost && samePathFamily) {
        return true;
      }
      if (sameHost && !currentPathFamily && !runPathFamily) {
        return true;
      }
      return false;
    });

    const context = buildSiteExperienceContext(matchingRuns);
    return context || undefined;
  }
}
