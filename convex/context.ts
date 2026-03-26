import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";

const TTL_MS = 30 * 60 * 1000; // 30 minutes

export const capture = mutation({
  args: {
    title: v.string(),
    url: v.string(),
    text: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    // Deactivate any existing active context for this user
    const existing = await ctx.db
      .query("capturedContexts")
      .withIndex("by_user_active", (q) =>
        q.eq("userId", userId).eq("isActive", true)
      )
      .collect();
    for (const e of existing) {
      await ctx.db.patch(e._id, { isActive: false });
    }

    const now = Date.now();
    return ctx.db.insert("capturedContexts", {
      userId,
      title: args.title,
      url: args.url,
      text: args.text.slice(0, 8000),
      capturedAt: now,
      expiresAt: now + TTL_MS,
      isActive: true,
    });
  },
});

// Returns the active context — TTL check happens in a separate cleanup mutation
export const getActive = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const ctx_ = await ctx.db
      .query("capturedContexts")
      .withIndex("by_user_active", (q) =>
        q.eq("userId", userId).eq("isActive", true)
      )
      .first();
    if (!ctx_) return null;
    // Only return non-expired contexts (client responsible for calling expireActive if needed)
    if (ctx_.expiresAt < Date.now()) return null;
    return ctx_;
  },
});

// Called by background SW alarm to expire stale contexts
export const expireActive = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return;
    const now = Date.now();
    const stale = await ctx.db
      .query("capturedContexts")
      .withIndex("by_user_active", (q) =>
        q.eq("userId", userId).eq("isActive", true)
      )
      .collect();
    for (const e of stale) {
      if (e.expiresAt < now) await ctx.db.patch(e._id, { isActive: false });
    }
  },
});

export const clear = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const active = await ctx.db
      .query("capturedContexts")
      .withIndex("by_user_active", (q) =>
        q.eq("userId", userId).eq("isActive", true)
      )
      .collect();
    for (const e of active) {
      await ctx.db.patch(e._id, { isActive: false });
    }
  },
});
