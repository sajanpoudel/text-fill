import { v } from "convex/values";
import { mutation, internalQuery } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";

// ── Record a completed interaction session ─────────────────────────────────────

export const recordSession = mutation({
  args: {
    sessionId: v.string(),
    platform: v.string(),
    contextType: v.optional(v.string()),
    recipientName: v.optional(v.string()),
    openedAt: v.number(),
    aiGeneratedAt: v.optional(v.number()),
    closedAt: v.number(),
    outcome: v.string(),
    charDelta: v.optional(v.number()),
    editFraction: v.optional(v.number()),
    // Text artifacts — only present when AI was used
    aiPreText: v.optional(v.string()),
    aiGeneratedText: v.optional(v.string()),
    userFinalText: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;

    // Insert the session row first (artifact needs its ID)
    const sessionRowId = await ctx.db.insert("interactionSessions", {
      userId,
      sessionId: args.sessionId,
      platform: args.platform,
      contextType: args.contextType,
      recipientName: args.recipientName,
      openedAt: args.openedAt,
      aiGeneratedAt: args.aiGeneratedAt,
      closedAt: args.closedAt,
      outcome: args.outcome,
      charDelta: args.charDelta,
      editFraction: args.editFraction,
      artifactId: undefined,
    });

    // Only create artifact when AI was actually used
    if (args.aiGeneratedText) {
      const artifactId = await ctx.db.insert("sessionArtifacts", {
        sessionId: sessionRowId,
        aiPreText: args.aiPreText?.slice(0, 4000),
        aiGeneratedText: args.aiGeneratedText.slice(0, 4000),
        userFinalText: args.userFinalText?.slice(0, 4000),
      });
      await ctx.db.patch(sessionRowId, { artifactId });
    }

    return sessionRowId;
  },
});

// ── Stats query for the popup / options page ───────────────────────────────────

export const getSessionStats = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const recent = await ctx.db
      .query("interactionSessions")
      .withIndex("by_user_opened", (q) => q.eq("userId", userId))
      .order("desc")
      .take(200);

    const total = recent.length;
    const withAI = recent.filter((s) => s.aiGeneratedAt !== undefined).length;
    const outcomes: Record<string, number> = {};
    for (const s of recent) {
      outcomes[s.outcome] = (outcomes[s.outcome] ?? 0) + 1;
    }

    return { total, withAI, outcomes };
  },
});
