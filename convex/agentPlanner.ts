import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  applyLinkedInConnectDrafts,
  buildConversationDraftPrompt,
  buildLinkedInConnectDraftPrompt,
  buildRollingPlannerSummary,
  deriveBootstrapPlannerDecision,
  normalizeConversationDraft,
  planLinkedInSearchCollectionPass,
} from "../src/lib/agent-planner";
import { callProvider, resolveApiKey } from "./llmProvider";
import { agentFieldTargetValidator } from "./agentRunValidators";

const nullableString = v.union(v.string(), v.null());

const interactiveElementValidator = v.object({
  id: v.string(),
  selector: v.string(),
  tag: v.string(),
  role: nullableString,
  type: nullableString,
  href: nullableString,
  label: nullableString,
  text: nullableString,
  disabled: v.boolean(),
});

const structuredExtractionValidator = v.optional(
  v.object({
    data: v.optional(v.any()),
    matchedFields: v.optional(v.array(v.string())),
    unmatchedFields: v.optional(v.array(v.string())),
    headings: v.optional(v.array(v.string())),
    text: v.optional(v.string()),
  })
);

const plannerContextStepValidator = v.object({
  stepIndex: v.number(),
  role: v.string(),
  content: v.string(),
});

const plannerBatchItemValidator = v.object({
  targetUrl: v.string(),
  targetName: v.string(),
  generatedText: v.optional(v.string()),
  targetHeadline: v.optional(v.string()),
});

const scannedCandidateValidator = v.object({
  targetUrl: v.string(),
  targetName: v.string(),
  headline: v.optional(v.string()),
});

export const planBootstrapRun = internalAction({
  args: {
    goal: v.string(),
    platformHint: v.optional(v.string()),
    pageUrl: v.optional(v.string()),
    interactiveSummary: v.optional(v.string()),
    accessibilitySummary: v.optional(v.string()),
    interactiveElements: v.optional(v.array(interactiveElementValidator)),
    structured: structuredExtractionValidator,
  },
  handler: async (_ctx, args) => {
    return deriveBootstrapPlannerDecision(args);
  },
});

export const summarizeRunProgress = internalAction({
  args: {
    goal: v.string(),
    platformHint: v.optional(v.string()),
    latestSummary: v.optional(v.string()),
    recentSteps: v.array(plannerContextStepValidator),
  },
  handler: async (_ctx, args) => {
    return {
      summary: buildRollingPlannerSummary(args),
    };
  },
});

export const planLinkedInSearchCollection = internalAction({
  args: {
    goal: v.string(),
    pageUrl: v.optional(v.string()),
    interactiveElements: v.optional(v.array(interactiveElementValidator)),
    scannedCandidates: v.optional(v.array(scannedCandidateValidator)),
    nextPageUrl: v.optional(v.string()),
    accumulatedItems: v.optional(v.array(plannerBatchItemValidator)),
  },
  handler: async (_ctx, args) => {
    return planLinkedInSearchCollectionPass(args);
  },
});

export const generateLinkedInConnectDrafts = internalAction({
  args: {
    userId: v.id("users"),
    goal: v.string(),
    items: v.array(plannerBatchItemValidator),
  },
  handler: async (ctx, args) => {
    if (args.items.length === 0) {
      return {
        items: args.items,
        source: "heuristic" as const,
        errorMessage: null,
      };
    }

    const profile = await ctx.runQuery(internal.users._getProfileByUserId, {
      userId: args.userId,
    });
    const { provider, apiKey } = resolveApiKey(profile);

    if (!apiKey) {
      return {
        items: args.items,
        source: "heuristic" as const,
        errorMessage: `Missing API key for ${provider}. Add it in Settings.`,
      };
    }

    const { system, user } = buildLinkedInConnectDraftPrompt({
      goal: args.goal,
      items: args.items,
    });

    try {
      const raw = await callProvider({
        provider,
        model: profile?.memoryModel ?? profile?.model ?? "gpt-5-nano",
        apiKey,
        system,
        user,
        maxOutputTokens: Math.min(2048, 256 * args.items.length),
        temperature: 0.4,
      });
      const applied = applyLinkedInConnectDrafts({
        items: args.items,
        responseText: raw,
      });
      return {
        items: applied.items,
        source: applied.source,
        errorMessage:
          applied.source === "model"
            ? null
            : "Provider response did not contain usable structured drafts.",
      };
    } catch (error) {
      return {
        items: args.items,
        source: "heuristic" as const,
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  },
});

export const generateConversationDraft = internalAction({
  args: {
    userId: v.id("users"),
    goal: v.string(),
    platformHint: v.optional(v.string()),
    pageContext: v.string(),
    fieldTarget: agentFieldTargetValidator,
  },
  handler: async (ctx, args) => {
    const profile = await ctx.runQuery(internal.users._getProfileByUserId, {
      userId: args.userId,
    });
    const { provider, apiKey } = resolveApiKey(profile);

    if (!apiKey) {
      return {
        generatedText: null,
        source: "unavailable" as const,
        errorMessage: `Missing API key for ${provider}. Add it in Settings.`,
      };
    }

    const { system, user } = buildConversationDraftPrompt({
      goal: args.goal,
      platformHint: args.platformHint,
      pageContext: args.pageContext,
      charLimit: args.fieldTarget.charLimit,
    });

    try {
      const raw = await callProvider({
        provider,
        model: profile?.memoryModel ?? profile?.model ?? "gpt-5-nano",
        apiKey,
        system,
        user,
        maxOutputTokens: Math.min(
          2048,
          Math.max(128, (args.fieldTarget.charLimit ?? 800) * 2)
        ),
        temperature: 0.5,
      });
      const generatedText = normalizeConversationDraft(
        raw,
        typeof args.fieldTarget.charLimit === "number"
          ? Math.max(1, Math.min(3000, Math.round(args.fieldTarget.charLimit)))
          : 800
      );
      if (!generatedText) {
        return {
          generatedText: null,
          source: "error" as const,
          errorMessage: "Provider returned an empty conversation draft.",
        };
      }
      return {
        generatedText,
        source: "model" as const,
        errorMessage: null,
      };
    } catch (error) {
      return {
        generatedText: null,
        source: "error" as const,
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  },
});
