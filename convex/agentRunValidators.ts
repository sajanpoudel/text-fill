import { v } from "convex/values";

export const agentRunStatusValidator = v.union(
  v.literal("created"),
  v.literal("planning"),
  v.literal("executing"),
  v.literal("awaiting_approval"),
  v.literal("paused"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("cancelled")
);

export const agentRunStepRoleValidator = v.union(
  v.literal("system"),
  v.literal("planner"),
  v.literal("browser_command"),
  v.literal("browser_result"),
  v.literal("approval"),
  v.literal("summary")
);

export const browserCommandStatusValidator = v.union(
  v.literal("queued"),
  v.literal("claimed"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("cancelled")
);

export const browserCommandTerminalStatusValidator = v.union(
  v.literal("completed"),
  v.literal("failed")
);

export const browserCommandDeliveryScopeValidator = v.union(
  v.literal("specific_tab"),
  v.literal("any_attached_tab")
);

export const approvalStatusValidator = v.union(
  v.literal("pending"),
  v.literal("approved"),
  v.literal("rejected"),
  v.literal("expired"),
  v.literal("cancelled")
);

export const approvalTerminalStatusValidator = v.union(
  v.literal("approved"),
  v.literal("rejected"),
  v.literal("expired"),
  v.literal("cancelled")
);

export const runTabStatusValidator = v.union(
  v.literal("open"),
  v.literal("closed"),
  v.literal("orphaned")
);

export const workflowIdValidator = v.optional(v.string());
export const completionEventIdValidator = v.optional(v.string());

export const agentFieldTargetValidator = v.object({
  selector: v.string(),
  platform: v.optional(v.string()),
  fieldType: v.optional(v.string()),
  charLimit: v.optional(v.number()),
});

export const browserCommandCompletionEventValidator = v.object({
  commandId: v.id("browserCommands"),
  resultId: v.id("browserCommandResults"),
  status: browserCommandTerminalStatusValidator,
});

export const approvalDecisionEventValidator = v.object({
  approvalId: v.id("agentApprovals"),
  decision: approvalTerminalStatusValidator,
});
