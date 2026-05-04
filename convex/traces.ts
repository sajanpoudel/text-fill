import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";

// ── Record a trace after generation ──────────────────────────────────────────

export const recordTrace = internalMutation({
  args: {
    userId: v.id("users"),
    platform: v.string(),
    modelId: v.string(),
    promptFingerprint: v.string(),
    presentedOutput: v.string(),
    hadLiveContext: v.boolean(),
    retrievedPatternCount: v.number(),
    episodeExampleCount: v.number(),
    latencyMs: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("traces", {
      userId: args.userId,
      platform: args.platform,
      modelId: args.modelId,
      promptFingerprint: args.promptFingerprint,
      presentedOutput: args.presentedOutput.slice(0, 2000),
      hadLiveContext: args.hadLiveContext,
      retrievedPatternCount: args.retrievedPatternCount,
      episodeExampleCount: args.episodeExampleCount,
      latencyMs: args.latencyMs,
      createdAt: Date.now(),
    });
  },
});

export const recordTraceArtifact = internalMutation({
  args: {
    traceId: v.id("traces"),
    systemPrompt: v.string(),
    userPrompt: v.string(),
    rawLlmOutput: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("traceArtifacts")
      .withIndex("by_trace", (q) => q.eq("traceId", args.traceId))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        systemPrompt: args.systemPrompt.slice(0, 12000),
        userPrompt: args.userPrompt.slice(0, 12000),
        rawLlmOutput: args.rawLlmOutput.slice(0, 12000),
      });
      return existing._id;
    }
    return await ctx.db.insert("traceArtifacts", {
      traceId: args.traceId,
      systemPrompt: args.systemPrompt.slice(0, 12000),
      userPrompt: args.userPrompt.slice(0, 12000),
      rawLlmOutput: args.rawLlmOutput.slice(0, 12000),
    });
  },
});

// ── Update trace outcome on session close ─────────────────────────────────────

// Called from interactions.ts recordSession when a traceId is present in the
// session payload. Links the session outcome back to the generation trace.
export const updateOutcome = internalMutation({
  args: {
    traceId: v.id("traces"),
    sessionId: v.id("interactionSessions"),
    userAction: v.string(),
    editFraction: v.optional(v.number()),
  },
  handler: async (ctx, { traceId, sessionId, userAction, editFraction }) => {
    const trace = await ctx.db.get(traceId);
    if (!trace) return;
    await ctx.db.patch(traceId, {
      sessionId,
      userAction,
      editFraction,
    });
  },
});

// ── Query for "bad cases" — for options page / regression testing ─────────────

// Returns traces where the user heavily edited or rewrote the AI output.
// These form the regression dataset for prompt evaluation.
export const getRecentBadCases = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];

    const traces = await ctx.db
      .query("traces")
      .withIndex("by_user_action", (q) =>
        q.eq("userId", userId).eq("userAction", "heavily_edited")
      )
      .order("desc")
      .take(25);

    const rewritten = await ctx.db
      .query("traces")
      .withIndex("by_user_action", (q) =>
        q.eq("userId", userId).eq("userAction", "rewritten")
      )
      .order("desc")
      .take(25);

    return [...traces, ...rewritten]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 50)
      .map((t) => ({
        traceId: t._id,
        platform: t.platform,
        modelId: t.modelId,
        userAction: t.userAction,
        editFraction: t.editFraction,
        hadLiveContext: t.hadLiveContext,
        retrievedPatternCount: t.retrievedPatternCount,
        episodeExampleCount: t.episodeExampleCount,
        latencyMs: t.latencyMs,
        presentedOutput: t.presentedOutput.slice(0, 300),
        createdAt: t.createdAt,
      }));
  },
});

// ── Summary stats for options/popup ──────────────────────────────────────────

export const getTraceStats = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;

    const recent = await ctx.db
      .query("traces")
      .withIndex("by_user_created", (q) => q.eq("userId", userId))
      .order("desc")
      .take(200);

    const total = recent.length;
    const withOutcome = recent.filter((t) => t.userAction !== undefined).length;
    const avgLatency =
      total > 0
        ? Math.round(recent.reduce((s, t) => s + t.latencyMs, 0) / total)
        : 0;
    const outcomes: Record<string, number> = {};
    for (const t of recent) {
      if (t.userAction) outcomes[t.userAction] = (outcomes[t.userAction] ?? 0) + 1;
    }

    return { total, withOutcome, avgLatency, outcomes };
  },
});
