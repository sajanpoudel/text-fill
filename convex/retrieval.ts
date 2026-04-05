import { v } from "convex/values";
import { internalQuery } from "./_generated/server";

// ── Episodic retrieval ─────────────────────────────────────────────────────────

// Returns anonymized edit summaries from recent non-abandoned sessions for a
// given platform + contextType. These are injected as few-shot examples in the
// generation prompt — never raw prior messages.
export const getRecentEpisodes = internalQuery({
  args: {
    userId: v.id("users"),
    platform: v.string(),
    contextType: v.optional(v.string()),
    limit: v.number(),
  },
  handler: async (ctx, { userId, platform, contextType, limit }) => {
    const sessions = await ctx.db
      .query("interactionSessions")
      .withIndex("by_user_platform", (q) =>
        q.eq("userId", userId).eq("platform", platform)
      )
      .order("desc")
      .filter((q) => q.neq(q.field("outcome"), "abandoned"))
      .take(60);

    // Filter by contextType: exact match when specified
    const filtered = contextType
      ? sessions.filter((s) => s.contextType === contextType)
      : sessions;

    const recent = filtered.slice(0, limit);

    // Build anonymized edit summaries — no raw message content
    return recent.map((s) => {
      const parts: string[] = [`outcome: ${s.outcome}`];
      if (s.editFraction !== undefined && s.editFraction > 0) {
        const pct = Math.round(s.editFraction * 100);
        parts.push(`${pct}% of AI text changed`);
      }
      if (s.charDelta !== undefined && s.charDelta !== 0) {
        const dir = s.charDelta < 0 ? "shortened" : "expanded";
        parts.push(`${dir} by ${Math.abs(s.charDelta)} chars`);
      }
      return `- ${parts.join(", ")}`;
    });
  },
});

// ── Procedural retrieval ───────────────────────────────────────────────────────

// Returns active rule texts for the given platform + contextType.
// Only returns patterns with confidence >= 0.3 (not decayed to noise).
export const getProceduralPatterns = internalQuery({
  args: {
    userId: v.id("users"),
    platform: v.string(),
    contextType: v.optional(v.string()),
  },
  handler: async (ctx, { userId, platform, contextType }) => {
    const patterns = await ctx.db
      .query("proceduralPatterns")
      .withIndex("by_user_active", (q) =>
        q.eq("userId", userId).eq("deletedAt", undefined).eq("platform", platform)
      )
      .filter((q) => q.gte(q.field("confidence"), 0.3))
      .collect();

    // Include patterns for this exact contextType AND platform-level patterns (no contextType)
    return patterns
      .filter(
        (p) =>
          !contextType ||
          p.contextType === undefined ||
          p.contextType === contextType
      )
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 5)
      .map((p) => p.ruleText);
  },
});
