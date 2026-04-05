import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { mutation } from "./_generated/server";
import { agentFieldTargetValidator } from "./agentRunValidators";
import { workflow } from "./workflow";

export const startRun = mutation({
  args: {
    goal: v.string(),
    platformHint: v.optional(v.string()),
    targetTabId: v.number(),
    pageUrl: v.optional(v.string()),
    pageContext: v.optional(v.string()),
    fieldTarget: v.optional(agentFieldTargetValidator),
  },
  handler: async (
    ctx,
    args
  ): Promise<{ runId: Id<"agentRuns">; workflowId: string }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Unauthenticated");
    }

    const goal = args.goal.trim();
    if (!goal) {
      throw new Error("Goal is required");
    }

    const now = Date.now();
    const runId = await ctx.db.insert("agentRuns", {
      userId,
      goal,
      platformHint: args.platformHint?.trim(),
      pageUrl: args.pageUrl,
      initialPageContext: args.pageContext?.trim() || undefined,
      fieldTarget: args.fieldTarget,
      status: "planning",
      currentStepIndex: 0,
      lastSummarizedAtStep: 0,
      createdAt: now,
      updatedAt: now,
    });

    let workflowId: string;
    try {
      workflowId = (await workflow.start(
        ctx,
        internal.agentWorkflows.bootstrapObservationRun,
        {
          runId,
          userId,
          goal,
          platformHint: args.platformHint?.trim(),
          targetTabId: args.targetTabId,
          pageUrl: args.pageUrl,
          initialPageContext: args.pageContext?.trim() || undefined,
          fieldTarget: args.fieldTarget,
        }
      )) as string;
    } catch (error) {
      await ctx.db.delete(runId);
      throw error;
    }

    await ctx.db.patch(runId, {
      activeWorkflowId: workflowId,
      updatedAt: Date.now(),
    });

    return { runId, workflowId };
  },
});
