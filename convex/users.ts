import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { DEFAULT_OPENAI_EMBEDDING_MODEL, resolveEmbeddingConfig } from "./embeddingConfig";

// Internal — called from auth callback to provision profile on first sign-up
export const ensureProfile = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const existing = await ctx.db
      .query("userProfiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (!existing) {
      await ctx.db.insert("userProfiles", {
        userId,
        provider: "openai",
        model: "gpt-4o",
        embeddingProvider: "openai",
        embeddingModel: DEFAULT_OPENAI_EMBEDDING_MODEL,
      });
    }
  },
});

// Query — reactive, used in popup/options
export const getProfile = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    return ctx.db
      .query("userProfiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
  },
});

// Internal query — fetch profile by userId (used by generate.ts action)
export const _getProfileByUserId = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) =>
    ctx.db
      .query("userProfiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first(),
});

// Mutation — save settings from options page
export const updateProfile = mutation({
  args: {
    contextText: v.optional(v.string()),
    contextFileName: v.optional(v.string()),
    systemPrompt: v.optional(v.string()),
    provider: v.optional(v.string()),
    model: v.optional(v.string()),
    embeddingProvider: v.optional(v.string()),
    embeddingModel: v.optional(v.string()),
    openaiKey: v.optional(v.string()),
    anthropicKey: v.optional(v.string()),
    geminiKey: v.optional(v.string()),
    memoryModel: v.optional(v.string()),
    jobProfile: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const profile = await ctx.db
      .query("userProfiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (!profile) throw new Error("Profile not found");
    const beforeEmbedding = resolveEmbeddingConfig(profile);
    // Only patch fields that were explicitly provided
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) {
      if (v !== undefined) patch[k] = v;
    }
    await ctx.db.patch(profile._id, patch);

    const afterEmbedding = resolveEmbeddingConfig({
      ...profile,
      ...patch,
    });
    const needsInitialEmbeddingConfig =
      profile.embeddingProvider === undefined || profile.embeddingModel === undefined;
    const embeddingConfigChanged =
      beforeEmbedding.ok !== afterEmbedding.ok ||
      beforeEmbedding.provider !== afterEmbedding.provider ||
      beforeEmbedding.model !== afterEmbedding.model;

    if (afterEmbedding.ok && (needsInitialEmbeddingConfig || embeddingConfigChanged)) {
      await ctx.scheduler.runAfter(0, internal.embeddings.reindexUserEmbeddings, {
        userId,
        provider: afterEmbedding.provider,
        model: afterEmbedding.model,
        apiKey: afterEmbedding.apiKey,
      });
    }
  },
});
