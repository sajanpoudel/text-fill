import { v } from "convex/values";
import { internalMutation, internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";

// ── Pattern promotion check ───────────────────────────────────────────────────

// Called after every session record. Decides whether to promote a new pattern
// or trigger re-evaluation of an existing one.
export const checkPromotion = internalMutation({
  args: {
    userId: v.id("users"),
    platform: v.string(),
    contextType: v.optional(v.string()),
    sessionRowId: v.id("interactionSessions"),
    outcome: v.string(),
  },
  handler: async (ctx, { userId, platform, contextType, sessionRowId, outcome }) => {
    // Abandoned sessions provide no positive signal
    if (outcome === "abandoned") return;

    // Find existing active pattern for this platform + contextType
    const candidates = await ctx.db
      .query("proceduralPatterns")
      .withIndex("by_user_active", (q) =>
        q.eq("userId", userId).eq("deletedAt", undefined).eq("platform", platform)
      )
      .collect();

    const existing = candidates.find(
      (p) => (p.contextType ?? null) === (contextType ?? null)
    );

    if (existing) {
      const newPendingCount = existing.pendingCount + 1;
      await ctx.db.patch(existing._id, {
        triggerCount: existing.triggerCount + 1,
        pendingCount: newPendingCount,
        lastTriggeredAt: Date.now(),
      });
      const existingSupport = await ctx.db
        .query("patternSupports")
        .withIndex("by_pattern_and_session", (q) =>
          q.eq("patternId", existing._id).eq("sessionId", sessionRowId)
        )
        .first();
      if (!existingSupport) {
        await ctx.db.insert("patternSupports", {
          patternId: existing._id,
          sessionId: sessionRowId,
          createdAt: Date.now(),
        });
      }
      // Re-evaluate rule after 5 new sessions (behavior may have changed)
      if (newPendingCount >= 5) {
        await ctx.scheduler.runAfter(0, internal.patterns.promoteAsync, {
          userId,
          platform,
          contextType,
          patternId: existing._id,
          supportingSessionIds: [sessionRowId],
        });
      }
      return;
    }

    // No existing pattern — count sessions to see if we have enough to create one
    const recentSessions = await ctx.db
      .query("interactionSessions")
      .withIndex("by_user_platform", (q) =>
        q.eq("userId", userId).eq("platform", platform)
      )
      .order("desc")
      .take(60);

    const matching = recentSessions.filter((s) => {
      const ctxMatch = contextType
        ? s.contextType === contextType
        : s.contextType === undefined || s.contextType === null;
      return ctxMatch && s.aiGeneratedAt !== undefined && s.outcome !== "abandoned";
    });

    if (matching.length < 3) return;

    // Require sessions across 2+ distinct calendar days to filter out single power-user bursts
    const days = new Set(
      matching.slice(0, 15).map((s) => {
        const d = new Date(s.openedAt);
        return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
      })
    );
    if (days.size < 2) return;

    // Conditions met — schedule LLM-based pattern creation
    await ctx.scheduler.runAfter(0, internal.patterns.promoteAsync, {
      userId,
      platform,
      contextType,
      patternId: undefined,
      supportingSessionIds: matching.slice(0, 10).map((s) => s._id),
    });
  },
});

// ── LLM promotion action ──────────────────────────────────────────────────────

// Drafts a behavioral rule from recent session history using the user's LLM.
// Creates a new proceduralPattern or updates an existing one.
export const promoteAsync = internalAction({
  args: {
    userId: v.id("users"),
    platform: v.string(),
    contextType: v.optional(v.string()),
    patternId: v.optional(v.id("proceduralPatterns")),
    supportingSessionIds: v.optional(v.array(v.id("interactionSessions"))),
  },
  handler: async (ctx, { userId, platform, contextType, patternId, supportingSessionIds }) => {
    const profile = await ctx.runQuery(internal.users._getProfileByUserId, { userId });
    if (!profile) return;

    const provider = profile.provider ?? "openai";
    const apiKey =
      provider === "anthropic"
        ? profile.anthropicKey
        : provider === "gemini"
          ? profile.geminiKey
          : profile.openaiKey;
    if (!apiKey) return;

    // Use a lighter model for background extraction if configured
    const model = profile.memoryModel ?? profile.model ?? "gpt-4o-mini";

    const sessions = await ctx.runQuery(internal.patterns._getSessionsForPromotion, {
      userId,
      platform,
      contextType,
    });

    if (sessions.length < 3) return;

    const examples = sessions
      .slice(0, 10)
      .map((s: any, i: number) => {
        const parts = [`Session ${i + 1}: outcome=${s.outcome}`];
        if (s.editFraction !== undefined)
          parts.push(`editFraction=${(s.editFraction * 100).toFixed(0)}%`);
        if (s.charDelta !== undefined) parts.push(`charDelta=${s.charDelta}`);
        if (s.artifact?.aiGeneratedText)
          parts.push(`AI (first 150): "${s.artifact.aiGeneratedText.slice(0, 150)}"`);
        if (s.artifact?.userFinalText)
          parts.push(`User final (first 150): "${s.artifact.userFinalText.slice(0, 150)}"`);
        return parts.join(", ");
      })
      .join("\n");

    const contextLabel = `${platform}${contextType ? ` ${contextType}` : ""}`;
    const systemPrompt =
      "You are analyzing a user's editing behavior to derive a concise behavioral rule. " +
      "Given sessions of AI-generated text and user edits, extract ONE rule (max 2 sentences) " +
      "that captures what the user consistently does. Be specific and actionable. Focus on: " +
      "length preference, tone adjustments, content they remove or add, structural changes.";

    const userPrompt =
      `Platform: ${contextLabel}\n\nSessions (${sessions.length} total):\n${examples}\n\n` +
      `Write ONE rule (max 2 sentences) for ${contextLabel} messages. ` +
      `Example format: "For LinkedIn recruiter DMs: keep under 3 sentences and remove proof points. Always end with a direct question."`;

    let ruleText = "";
    try {
      if (provider === "anthropic") {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model,
            max_tokens: 200,
            system: systemPrompt,
            messages: [{ role: "user", content: userPrompt }],
          }),
        });
        const data = (await res.json()) as any;
        ruleText = (data.content?.[0]?.text ?? "").trim();
      } else if (provider === "gemini") {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }] }],
              generationConfig: { maxOutputTokens: 200, temperature: 0.2 },
            }),
          }
        );
        const data = (await res.json()) as any;
        ruleText = (data.candidates?.[0]?.content?.parts ?? [])
          .map((p: any) => p.text ?? "")
          .join("")
          .trim();
      } else {
        // OpenAI
        const res = await fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ model, instructions: systemPrompt, input: userPrompt }),
        });
        const data = (await res.json()) as any;
        ruleText = (data.output_text ?? "").trim();
        if (!ruleText) {
          const parts: string[] = [];
          for (const item of data.output ?? []) {
            if (item?.type === "message" && Array.isArray(item?.content)) {
              for (const c of item.content) {
                if (c?.type === "output_text") parts.push(c.text);
              }
            }
          }
          ruleText = parts.join("").trim();
        }
      }
    } catch {
      return;
    }

    if (!ruleText) return;

    await ctx.runMutation(internal.patterns._upsertPattern, {
      userId,
      platform,
      contextType,
      ruleText,
      patternId,
      supportingSessionIds,
    });
  },
});

// ── Internal helpers ──────────────────────────────────────────────────────────

export const _getSessionsForPromotion = internalQuery({
  args: {
    userId: v.id("users"),
    platform: v.string(),
    contextType: v.optional(v.string()),
  },
  handler: async (ctx, { userId, platform, contextType }) => {
    const sessions = await ctx.db
      .query("interactionSessions")
      .withIndex("by_user_platform", (q) =>
        q.eq("userId", userId).eq("platform", platform)
      )
      .order("desc")
      .take(100);

    const matching = sessions
      .filter((s) => {
        const ctxMatch = contextType
          ? s.contextType === contextType
          : s.contextType === undefined || s.contextType === null;
        return ctxMatch && s.aiGeneratedAt !== undefined && s.outcome !== "abandoned";
      })
      .slice(0, 10);

    return Promise.all(
      matching.map(async (s) => {
        const artifact = s.artifactId ? await ctx.db.get(s.artifactId) : null;
        return { ...s, artifact };
      })
    );
  },
});

export const _upsertPattern = internalMutation({
  args: {
    userId: v.id("users"),
    platform: v.string(),
    contextType: v.optional(v.string()),
    ruleText: v.string(),
    patternId: v.optional(v.id("proceduralPatterns")),
    supportingSessionIds: v.optional(v.array(v.id("interactionSessions"))),
  },
  handler: async (ctx, { userId, platform, contextType, ruleText, patternId, supportingSessionIds }) => {
    const uniqueSessionIds = Array.from(new Set(supportingSessionIds ?? []));
    const ensureSupports = async (targetPatternId: any) => {
      for (const sessionId of uniqueSessionIds) {
        const existingSupport = await ctx.db
          .query("patternSupports")
          .withIndex("by_pattern_and_session", (q) =>
            q.eq("patternId", targetPatternId).eq("sessionId", sessionId)
          )
          .first();
        if (!existingSupport) {
          await ctx.db.insert("patternSupports", {
            patternId: targetPatternId,
            sessionId,
            createdAt: Date.now(),
          });
        }
      }
    };

    if (patternId) {
      const existing = await ctx.db.get(patternId);
      if (!existing) return;
      await ctx.db.patch(patternId, {
        ruleText,
        confidence: Math.min(1.0, existing.confidence + 0.2),
        pendingCount: 0,
        promotedAt: Date.now(),
        triggerCount: Math.max(existing.triggerCount, uniqueSessionIds.length || existing.triggerCount),
      });
      await ensureSupports(patternId);
    } else {
      const candidates = await ctx.db
        .query("proceduralPatterns")
        .withIndex("by_user_active", (q) =>
          q.eq("userId", userId).eq("deletedAt", undefined).eq("platform", platform)
        )
        .collect();
      const existing = candidates.find(
        (p) => (p.contextType ?? null) === (contextType ?? null)
      );
      if (existing) {
        await ctx.db.patch(existing._id, {
          ruleText,
          confidence: Math.min(1.0, existing.confidence + 0.2),
          pendingCount: 0,
          promotedAt: Date.now(),
          triggerCount: Math.max(existing.triggerCount, uniqueSessionIds.length || existing.triggerCount),
          lastTriggeredAt: Date.now(),
        });
        await ensureSupports(existing._id);
        return;
      }

      const createdId = await ctx.db.insert("proceduralPatterns", {
        userId,
        platform,
        contextType,
        ruleText,
        confidence: 0.7,
        triggerCount: uniqueSessionIds.length,
        pendingCount: 0,
        promotedAt: Date.now(),
        lastTriggeredAt: Date.now(),
      });
      await ensureSupports(createdId);
    }
  },
});

// ── Weekly confidence decay ───────────────────────────────────────────────────

// Called by cron weekly. Decays confidence for patterns not triggered in 7 days.
// Soft-deletes patterns that fall below the noise floor.
export const decayConfidence = internalMutation({
  args: {},
  handler: async (ctx) => {
    const ONE_WEEK_AGO = Date.now() - 7 * 24 * 60 * 60 * 1000;
    // Scan active patterns — table stays small (one rule per platform+contextType per user)
    const patterns = await ctx.db
      .query("proceduralPatterns")
      .filter((q) => q.eq(q.field("deletedAt"), undefined))
      .take(500);

    for (const pattern of patterns) {
      if ((pattern.lastTriggeredAt ?? 0) >= ONE_WEEK_AGO) continue;
      const newConfidence = pattern.confidence * 0.9;
      if (newConfidence < 0.1) {
        await ctx.db.patch(pattern._id, { deletedAt: Date.now() });
      } else {
        await ctx.db.patch(pattern._id, { confidence: newConfidence });
      }
    }
  },
});
