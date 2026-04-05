import { getAuthUserId } from "@convex-dev/auth/server";
import type { EventId, WorkflowId } from "@convex-dev/workflow";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalQuery,
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import {
  agentRunStatusValidator,
  agentRunStepRoleValidator,
  approvalDecisionEventValidator,
  approvalStatusValidator,
  browserCommandCompletionEventValidator,
  browserCommandDeliveryScopeValidator,
  browserCommandStatusValidator,
  browserCommandTerminalStatusValidator,
  completionEventIdValidator,
  runTabStatusValidator,
  workflowIdValidator,
} from "./agentRunValidators";
import { workflow } from "./workflow";

type ReaderCtx = QueryCtx | MutationCtx;

async function requireAuthenticatedUserId(ctx: ReaderCtx): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (!userId) {
    throw new Error("Unauthenticated");
  }
  return userId;
}

async function requireRun(
  ctx: ReaderCtx,
  runId: Id<"agentRuns">
): Promise<Doc<"agentRuns">> {
  const run = await ctx.db.get(runId);
  if (!run) {
    throw new Error("Agent run not found");
  }
  return run;
}

async function requireOwnedRun(
  ctx: ReaderCtx,
  runId: Id<"agentRuns">,
  userId: Id<"users">
): Promise<Doc<"agentRuns">> {
  const run = await requireRun(ctx, runId);
  if (run.userId !== userId) {
    throw new Error("Forbidden");
  }
  return run;
}

async function requireRunStep(
  ctx: ReaderCtx,
  stepId: Id<"agentRunSteps">
): Promise<Doc<"agentRunSteps">> {
  const step = await ctx.db.get(stepId);
  if (!step) {
    throw new Error("Agent run step not found");
  }
  return step;
}

async function requireCommand(
  ctx: ReaderCtx,
  commandId: Id<"browserCommands">
): Promise<Doc<"browserCommands">> {
  const command = await ctx.db.get(commandId);
  if (!command) {
    throw new Error("Browser command not found");
  }
  return command;
}

async function requireApproval(
  ctx: ReaderCtx,
  approvalId: Id<"agentApprovals">
): Promise<Doc<"agentApprovals">> {
  const approval = await ctx.db.get(approvalId);
  if (!approval) {
    throw new Error("Approval not found");
  }
  return approval;
}

function matchesTargetUrl(
  pageUrl: string | undefined,
  targetUrl: string | undefined
): boolean {
  if (!targetUrl) return true;
  if (!pageUrl) return false;

  try {
    const current = new URL(pageUrl);
    const target = new URL(targetUrl);
    if (current.href === target.href) return true;
    if (current.origin !== target.origin) return false;
    return current.pathname.startsWith(target.pathname);
  } catch {
    return pageUrl === targetUrl;
  }
}

async function claimBrowserCommandRecord(
  ctx: MutationCtx,
  command: Doc<"browserCommands">,
  claimedBy: string
) {
  if (command.status !== "queued") {
    return { ok: false as const, status: command.status };
  }

  await ctx.db.patch(command._id, {
    status: "claimed",
    claimedBy,
    claimedAt: Date.now(),
    attemptCount: command.attemptCount + 1,
  });

  return {
    ok: true as const,
    status: "claimed" as const,
    command: command.command,
    runId: command.runId,
  };
}

async function completeBrowserCommandRecord(
  ctx: MutationCtx,
  command: Doc<"browserCommands">,
  args: {
    status: "completed" | "failed";
    result?: unknown;
    errorMessage?: string;
  }
) {
  const existingResult = await ctx.db
    .query("browserCommandResults")
    .withIndex("by_command", (q) => q.eq("commandId", command._id))
    .unique();

  if (existingResult) {
    return { resultId: existingResult._id, alreadyCompleted: true };
  }

  const now = Date.now();
  const resultId = await ctx.db.insert("browserCommandResults", {
    userId: command.userId,
    runId: command.runId,
    commandId: command._id,
    status: args.status,
    result: args.result,
    errorMessage: args.errorMessage,
    createdAt: now,
  });

  await ctx.db.patch(command._id, {
    status: args.status,
    completedAt: now,
    lastError: args.errorMessage,
  });

  if (command.completionEventId) {
    await workflow.sendEvent(ctx, {
      id: command.completionEventId as EventId<string>,
      validator: browserCommandCompletionEventValidator,
      value: {
        commandId: command._id,
        resultId,
        status: args.status,
      },
    });
  }

  return { resultId, alreadyCompleted: false };
}

async function cancelBrowserCommandRecord(
  ctx: MutationCtx,
  command: Doc<"browserCommands">,
  errorMessage: string
) {
  if (
    command.status === "completed" ||
    command.status === "failed" ||
    command.status === "cancelled"
  ) {
    return { ok: true as const, status: command.status };
  }

  await ctx.db.patch(command._id, {
    status: "cancelled",
    completedAt: Date.now(),
    lastError: errorMessage,
  });
  return { ok: true as const, status: "cancelled" as const };
}

async function upsertRunTabRecord(
  ctx: MutationCtx,
  run: Doc<"agentRuns">,
  tabId: number,
  url: string
) {
  const existing = await ctx.db
    .query("agentRunTabs")
    .withIndex("by_run_and_tab_id", (q) =>
      q.eq("runId", run._id).eq("tabId", tabId)
    )
    .unique();
  const now = Date.now();

  if (existing) {
    await ctx.db.patch(existing._id, {
      url,
      status: "open",
      updatedAt: now,
      closedAt: undefined,
    });
    return { tabRecordId: existing._id };
  }

  const tabRecordId = await ctx.db.insert("agentRunTabs", {
    userId: run.userId,
    runId: run._id,
    tabId,
    url,
    status: "open",
    openedAt: now,
    updatedAt: now,
  });

  return { tabRecordId };
}

async function closeRunTabRecord(
  ctx: MutationCtx,
  runId: Id<"agentRuns">,
  tabId: number,
  status: "closed" | "orphaned"
) {
  const existing = await ctx.db
    .query("agentRunTabs")
    .withIndex("by_run_and_tab_id", (q) =>
      q.eq("runId", runId).eq("tabId", tabId)
    )
    .unique();
  if (!existing) {
    throw new Error("Run tab not found");
  }

  const now = Date.now();
  await ctx.db.patch(existing._id, {
    status,
    updatedAt: now,
    closedAt: now,
  });

  return { ok: true };
}

export const createRun = mutation({
  args: {
    goal: v.string(),
    platformHint: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireAuthenticatedUserId(ctx);
    const now = Date.now();
    const runId = await ctx.db.insert("agentRuns", {
      userId,
      goal: args.goal.trim(),
      platformHint: args.platformHint?.trim(),
      status: "created",
      currentStepIndex: 0,
      lastSummarizedAtStep: 0,
      createdAt: now,
      updatedAt: now,
    });

    return { runId };
  },
});

export const cancelRun = mutation({
  args: {
    runId: v.id("agentRuns"),
  },
  handler: async (ctx, args) => {
    const userId = await requireAuthenticatedUserId(ctx);
    const run = await requireOwnedRun(ctx, args.runId, userId);
    if (run.activeWorkflowId && run.status !== "completed" && run.status !== "failed") {
      await workflow.cancel(ctx, run.activeWorkflowId as WorkflowId);
    }

    for await (const command of ctx.db
      .query("browserCommands")
      .withIndex("by_run_and_created_at", (q) => q.eq("runId", args.runId))) {
      await cancelBrowserCommandRecord(
        ctx,
        command,
        "Run cancelled before browser command execution completed"
      );
    }

    for await (const approval of ctx.db
      .query("agentApprovals")
      .withIndex("by_run_and_created_at", (q) => q.eq("runId", args.runId))) {
      if (approval.status !== "pending") continue;
      await ctx.db.patch(approval._id, {
        status: "cancelled",
        decidedAt: Date.now(),
      });
    }

    const now = Date.now();
    await ctx.db.patch(args.runId, {
      status: "cancelled",
      completedAt: run.completedAt ?? now,
      updatedAt: now,
      lastError: "Run cancelled by user",
    });

    return { ok: true };
  },
});

export const getRun = query({
  args: {
    runId: v.id("agentRuns"),
    stepLimit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return null;
    }

    const run = await requireOwnedRun(ctx, args.runId, userId);
    const stepLimit = Math.max(1, Math.min(50, Math.round(args.stepLimit ?? 20)));
    const steps = await ctx.db
      .query("agentRunSteps")
      .withIndex("by_run_and_step_index", (q) => q.eq("runId", args.runId))
      .order("desc")
      .take(stepLimit);
    const approvals = await ctx.db
      .query("agentApprovals")
      .withIndex("by_run_and_created_at", (q) => q.eq("runId", args.runId))
      .order("desc")
      .take(20);
    const tabs = await ctx.db
      .query("agentRunTabs")
      .withIndex("by_run_and_status_and_opened_at", (q) =>
        q.eq("runId", args.runId).eq("status", "open")
      )
      .order("desc")
      .take(20);

    return {
      run,
      steps: [...steps].reverse(),
      approvals,
      tabs,
    };
  },
});

export const listRuns = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return [];
    }

    const limit = Math.max(1, Math.min(50, Math.round(args.limit ?? 20)));
    return ctx.db
      .query("agentRuns")
      .withIndex("by_user_and_updated_at", (q) => q.eq("userId", userId))
      .order("desc")
      .take(limit);
  },
});

export const listPendingApprovals = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return [];
    }

    const limit = Math.max(1, Math.min(50, Math.round(args.limit ?? 20)));
    return ctx.db
      .query("agentApprovals")
      .withIndex("by_user_and_status_and_created_at", (q) =>
        q.eq("userId", userId).eq("status", "pending")
      )
      .order("desc")
      .take(limit);
  },
});

export const listPendingCommandsForTab = query({
  args: {
    tabId: v.number(),
    pageUrl: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return [];
    }

    const limit = Math.max(1, Math.min(50, Math.round(args.limit ?? 20)));
    const specificTabCommands = await ctx.db
      .query("browserCommands")
      .withIndex("by_user_and_status_and_target_tab_id", (q) =>
        q.eq("userId", userId).eq("status", "queued").eq("targetTabId", args.tabId)
      )
      .order("asc")
      .take(limit);
    const attachedCommands = await ctx.db
      .query("browserCommands")
      .withIndex("by_user_and_status_and_delivery_scope", (q) =>
        q.eq("userId", userId).eq("status", "queued").eq("deliveryScope", "any_attached_tab")
      )
      .order("asc")
      .take(limit);

    const merged = [...specificTabCommands];
    for (const command of attachedCommands) {
      if (!matchesTargetUrl(args.pageUrl, command.targetUrl)) {
        continue;
      }
      if (merged.some((candidate) => candidate._id === command._id)) {
        continue;
      }
      merged.push(command);
    }

    return merged
      .sort((left, right) => left.createdAt - right.createdAt)
      .slice(0, limit);
  },
});

export const getBrowserCommandResultForWorkflow = internalQuery({
  args: {
    commandId: v.id("browserCommands"),
  },
  handler: async (ctx, args) => {
    return ctx.db
      .query("browserCommandResults")
      .withIndex("by_command", (q) => q.eq("commandId", args.commandId))
      .unique();
  },
});

export const getPlannerContext = internalQuery({
  args: {
    runId: v.id("agentRuns"),
    recentStepLimit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const run = await requireRun(ctx, args.runId);
    const recentStepLimit = Math.max(
      1,
      Math.min(10, Math.round(args.recentStepLimit ?? 5))
    );
    const steps = await ctx.db
      .query("agentRunSteps")
      .withIndex("by_run_and_step_index", (q) => q.eq("runId", args.runId))
      .order("desc")
      .take(25);
    const recentSteps = [...steps]
      .reverse()
      .filter((step) => step.stepIndex > run.lastSummarizedAtStep)
      .filter((step) => step.role !== "summary")
      .slice(-recentStepLimit)
      .map((step) => ({
        stepIndex: step.stepIndex,
        role: step.role,
        content: step.content,
      }));

    return {
      runId: run._id,
      goal: run.goal,
      platformHint: run.platformHint,
      pageUrl: run.pageUrl,
      initialPageContext: run.initialPageContext,
      fieldTarget: run.fieldTarget,
      currentStepIndex: run.currentStepIndex,
      lastSummarizedAtStep: run.lastSummarizedAtStep,
      latestSummary: run.latestSummary,
      recentSteps,
    };
  },
});

export const resolveApproval = mutation({
  args: {
    approvalId: v.id("agentApprovals"),
    decision: approvalStatusValidator,
    decisionNote: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (args.decision === "pending") {
      throw new Error("Approval decisions must be terminal");
    }

    const userId = await requireAuthenticatedUserId(ctx);
    const approval = await requireApproval(ctx, args.approvalId);
    const run = await requireOwnedRun(ctx, approval.runId, userId);
    const now = Date.now();

    if (approval.status !== "pending") {
      return { ok: true, status: approval.status };
    }

    await ctx.db.patch(args.approvalId, {
      status: args.decision,
      decidedAt: now,
      decisionNote: args.decisionNote,
    });
    await ctx.db.patch(run._id, {
      updatedAt: now,
    });

    if (approval.completionEventId) {
      await workflow.sendEvent(ctx, {
        id: approval.completionEventId as EventId<string>,
        validator: approvalDecisionEventValidator,
        value: {
          approvalId: approval._id,
          decision: args.decision,
        },
      });
    }

    return { ok: true, status: args.decision };
  },
});

export const claimBrowserCommandForRelay = mutation({
  args: {
    commandId: v.id("browserCommands"),
    claimedBy: v.string(),
    tabId: v.number(),
    pageUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireAuthenticatedUserId(ctx);
    const command = await requireCommand(ctx, args.commandId);
    const run = await requireRun(ctx, command.runId);
    if (command.userId !== userId) {
      throw new Error("Forbidden");
    }
    if (run.status === "cancelled") {
      await cancelBrowserCommandRecord(
        ctx,
        command,
        "Run cancelled before relay claim"
      );
      return { ok: false as const, status: "cancelled" as const };
    }

    if (
      command.deliveryScope === "specific_tab" &&
      command.targetTabId !== args.tabId
    ) {
      throw new Error("Command does not target this tab");
    }

    if (
      command.deliveryScope === "any_attached_tab" &&
      !matchesTargetUrl(args.pageUrl, command.targetUrl)
    ) {
      throw new Error("Command does not match this page");
    }

    return claimBrowserCommandRecord(ctx, command, args.claimedBy);
  },
});

export const completeBrowserCommandForRelay = mutation({
  args: {
    commandId: v.id("browserCommands"),
    claimedBy: v.string(),
    status: browserCommandTerminalStatusValidator,
    result: v.optional(v.any()),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireAuthenticatedUserId(ctx);
    const command = await requireCommand(ctx, args.commandId);
    const run = await requireRun(ctx, command.runId);
    const existingResult = await ctx.db
      .query("browserCommandResults")
      .withIndex("by_command", (q) => q.eq("commandId", args.commandId))
      .unique();
    if (command.userId !== userId) {
      throw new Error("Forbidden");
    }
    if (existingResult) {
      return { resultId: existingResult._id, alreadyCompleted: true };
    }
    if (command.status === "cancelled" || run.status === "cancelled") {
      await cancelBrowserCommandRecord(
        ctx,
        command,
        "Run cancelled before browser command completion"
      );
      return { alreadyCompleted: true, cancelled: true };
    }
    if (command.status !== "claimed") {
      throw new Error("Browser command must be claimed before completion");
    }
    if (command.claimedBy !== args.claimedBy) {
      throw new Error("Browser command is claimed by a different executor");
    }

    return completeBrowserCommandRecord(ctx, command, args);
  },
});

export const syncRunTabForRelay = mutation({
  args: {
    runId: v.id("agentRuns"),
    tabId: v.number(),
    status: runTabStatusValidator,
    url: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireAuthenticatedUserId(ctx);
    const run = await requireOwnedRun(ctx, args.runId, userId);

    if (args.status === "open") {
      if (!args.url) {
        throw new Error("Open run tabs require a url");
      }
      return upsertRunTabRecord(ctx, run, args.tabId, args.url);
    }

    return closeRunTabRecord(ctx, run._id, args.tabId, args.status);
  },
});

export const setWorkflowId = internalMutation({
  args: {
    runId: v.id("agentRuns"),
    workflowId: workflowIdValidator,
  },
  handler: async (ctx, args) => {
    const run = await requireRun(ctx, args.runId);
    await ctx.db.patch(run._id, {
      activeWorkflowId: args.workflowId,
      updatedAt: Date.now(),
    });
    return { ok: true };
  },
});

export const setRunStatus = internalMutation({
  args: {
    runId: v.id("agentRuns"),
    status: agentRunStatusValidator,
    lastError: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const run = await requireRun(ctx, args.runId);
    const now = Date.now();
    await ctx.db.patch(run._id, {
      status: args.status,
      updatedAt: now,
      completedAt:
        args.status === "completed" ||
        args.status === "failed" ||
        args.status === "cancelled"
          ? run.completedAt ?? now
          : run.completedAt,
      lastError: args.lastError,
    });
    return { ok: true };
  },
});

export const appendStep = internalMutation({
  args: {
    runId: v.id("agentRuns"),
    role: agentRunStepRoleValidator,
    content: v.string(),
    toolCall: v.optional(v.any()),
    commandId: v.optional(v.id("browserCommands")),
    approvalId: v.optional(v.id("agentApprovals")),
    summaryAfterStep: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const run = await requireRun(ctx, args.runId);
    const now = Date.now();
    const stepIndex = run.currentStepIndex + 1;
    const stepId = await ctx.db.insert("agentRunSteps", {
      runId: run._id,
      stepIndex,
      role: args.role,
      content: args.content,
      toolCall: args.toolCall,
      commandId: args.commandId,
      approvalId: args.approvalId,
      summaryAfterStep: args.summaryAfterStep,
      createdAt: now,
    });

    await ctx.db.patch(run._id, {
      currentStepIndex: stepIndex,
      latestSummary: args.summaryAfterStep ?? run.latestSummary,
      lastSummarizedAtStep: args.summaryAfterStep
        ? stepIndex
        : run.lastSummarizedAtStep,
      updatedAt: now,
    });

    return { stepId, stepIndex };
  },
});

export const enqueueBrowserCommand = internalMutation({
  args: {
    runId: v.id("agentRuns"),
    stepId: v.id("agentRunSteps"),
    deliveryScope: browserCommandDeliveryScopeValidator,
    targetTabId: v.optional(v.number()),
    targetUrl: v.optional(v.string()),
    command: v.any(),
    completionEventId: completionEventIdValidator,
  },
  handler: async (ctx, args) => {
    const run = await requireRun(ctx, args.runId);
    const step = await requireRunStep(ctx, args.stepId);
    if (step.runId !== run._id) {
      throw new Error("Step does not belong to run");
    }
    if (args.deliveryScope === "specific_tab" && args.targetTabId === undefined) {
      throw new Error("specific_tab commands require targetTabId");
    }

    const commandId = await ctx.db.insert("browserCommands", {
      userId: run.userId,
      runId: run._id,
      stepId: step._id,
      status: "queued",
      deliveryScope: args.deliveryScope,
      targetTabId: args.targetTabId,
      targetUrl: args.targetUrl,
      command: args.command,
      completionEventId: args.completionEventId,
      createdAt: Date.now(),
      attemptCount: 0,
    });

    return { commandId };
  },
});

export const scheduleBrowserCommandTimeout = internalMutation({
  args: {
    commandId: v.id("browserCommands"),
    timeoutMs: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.scheduler.runAfter(
      args.timeoutMs,
      internal.agentRuns.timeoutBrowserCommand,
      args
    );
    return { ok: true };
  },
});

export const claimBrowserCommand = internalMutation({
  args: {
    commandId: v.id("browserCommands"),
    claimedBy: v.string(),
  },
  handler: async (ctx, args) => {
    const command = await requireCommand(ctx, args.commandId);
    const result = await claimBrowserCommandRecord(ctx, command, args.claimedBy);
    return result.ok ? { ok: true } : result;
  },
});

export const completeBrowserCommand = internalMutation({
  args: {
    commandId: v.id("browserCommands"),
    status: browserCommandTerminalStatusValidator,
    result: v.optional(v.any()),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const command = await requireCommand(ctx, args.commandId);
    return completeBrowserCommandRecord(ctx, command, args);
  },
});

export const timeoutBrowserCommand = internalMutation({
  args: {
    commandId: v.id("browserCommands"),
    timeoutMs: v.number(),
  },
  handler: async (ctx, args) => {
    const command = await requireCommand(ctx, args.commandId);
    const run = await requireRun(ctx, command.runId);
    if (
      command.status === "completed" ||
      command.status === "failed" ||
      command.status === "cancelled"
    ) {
      return { ok: true, status: command.status };
    }
    if (run.status === "cancelled") {
      return cancelBrowserCommandRecord(
        ctx,
        command,
        "Run cancelled before browser command timeout fired"
      );
    }
    return completeBrowserCommandRecord(ctx, command, {
      status: "failed",
      errorMessage: `Timed out after ${args.timeoutMs}ms waiting for relay execution`,
    });
  },
});

export const registerRunTab = internalMutation({
  args: {
    runId: v.id("agentRuns"),
    tabId: v.number(),
    url: v.string(),
  },
  handler: async (ctx, args) => {
    const run = await requireRun(ctx, args.runId);
    return upsertRunTabRecord(ctx, run, args.tabId, args.url);
  },
});

export const closeRunTab = internalMutation({
  args: {
    runId: v.id("agentRuns"),
    tabId: v.number(),
    status: runTabStatusValidator,
  },
  handler: async (ctx, args) => {
    if (args.status === "open") {
      throw new Error("closeRunTab requires a terminal tab status");
    }
    return closeRunTabRecord(ctx, args.runId, args.tabId, args.status);
  },
});

export const createApproval = internalMutation({
  args: {
    runId: v.id("agentRuns"),
    stepId: v.id("agentRunSteps"),
    approvalKind: v.string(),
    title: v.string(),
    reason: v.optional(v.string()),
    payload: v.optional(v.any()),
    completionEventId: completionEventIdValidator,
    expiresAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const run = await requireRun(ctx, args.runId);
    const step = await requireRunStep(ctx, args.stepId);
    if (step.runId !== run._id) {
      throw new Error("Step does not belong to run");
    }

    const now = Date.now();
    const approvalId = await ctx.db.insert("agentApprovals", {
      userId: run.userId,
      runId: run._id,
      stepId: step._id,
      approvalKind: args.approvalKind,
      title: args.title,
      reason: args.reason,
      payload: args.payload,
      status: "pending",
      completionEventId: args.completionEventId,
      expiresAt: args.expiresAt,
      createdAt: now,
    });

    await ctx.db.patch(run._id, {
      status: "awaiting_approval",
      updatedAt: now,
    });

    return { approvalId };
  },
});

export const scheduleApprovalExpiry = internalMutation({
  args: {
    approvalId: v.id("agentApprovals"),
    expiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    const delayMs = Math.max(0, args.expiresAt - Date.now());
    await ctx.scheduler.runAfter(delayMs, internal.agentRuns.expireApproval, {
      approvalId: args.approvalId,
    });
    return { ok: true };
  },
});

export const expireApproval = internalMutation({
  args: {
    approvalId: v.id("agentApprovals"),
  },
  handler: async (ctx, args) => {
    const approval = await requireApproval(ctx, args.approvalId);
    if (approval.status !== "pending") {
      return { ok: true, status: approval.status };
    }

    const now = Date.now();
    await ctx.db.patch(approval._id, {
      status: "expired",
      decidedAt: now,
    });
    await ctx.db.patch(approval.runId, {
      updatedAt: now,
    });

    if (approval.completionEventId) {
      await workflow.sendEvent(ctx, {
        id: approval.completionEventId as EventId<string>,
        validator: approvalDecisionEventValidator,
        value: {
          approvalId: approval._id,
          decision: "expired",
        },
      });
    }

    return { ok: true, status: "expired" };
  },
});
