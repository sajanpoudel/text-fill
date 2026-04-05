import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";

const TERMINAL_ITEM_STATUSES = new Set(["sent", "failed", "skipped"]);

async function requireOwnedBatch(
  ctx: any,
  batchId: any,
  userId: any
) {
  const batch = await ctx.db.get(batchId);
  if (!batch) throw new Error("Batch not found");
  if (batch.userId !== userId) throw new Error("Forbidden");
  return batch;
}

async function requireOwnedItem(
  ctx: any,
  itemId: any,
  userId: any
) {
  const item = await ctx.db.get(itemId);
  if (!item) throw new Error("Task item not found");
  if (item.userId !== userId) throw new Error("Forbidden");
  return item;
}

export const createBatch = mutation({
  args: {
    batchType: v.string(),
    dailyLimit: v.number(),
    items: v.array(
      v.object({
        targetUrl: v.string(),
        targetName: v.optional(v.string()),
      })
    ),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthenticated");
    if (args.items.length === 0) throw new Error("No items to queue");

    const now = Date.now();
    const batchId = await ctx.db.insert("taskBatches", {
      userId,
      batchType: args.batchType,
      status: "pending",
      totalTasks: args.items.length,
      completedTasks: 0,
      dailyLimit: Math.max(1, Math.min(100, Math.round(args.dailyLimit))),
      createdAt: now,
    });

    const itemIds = [];
    for (let i = 0; i < args.items.length; i += 1) {
      const item = args.items[i];
      const itemId = await ctx.db.insert("taskItems", {
        batchId,
        userId,
        targetUrl: item.targetUrl,
        targetName: item.targetName,
        status: "pending",
        sortOrder: i,
      });
      itemIds.push(itemId);
    }

    return { batchId, itemIds };
  },
});

export const approveBatch = mutation({
  args: { batchId: v.id("taskBatches") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthenticated");

    const batch = await requireOwnedBatch(ctx, args.batchId, userId);
    const now = Date.now();
    const nextStatus = batch.status === "done" ? "done" : "approved";

    await ctx.db.patch(args.batchId, {
      status: nextStatus,
      approvedAt: batch.approvedAt ?? now,
    });

    return { ok: true, status: nextStatus };
  },
});

export const markBatchRunning = mutation({
  args: { batchId: v.id("taskBatches") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthenticated");

    const batch = await requireOwnedBatch(ctx, args.batchId, userId);
    if (batch.status === "done") return { ok: true, status: "done" };

    await ctx.db.patch(args.batchId, { status: "running" });
    return { ok: true, status: "running" };
  },
});

export const pauseBatch = mutation({
  args: { batchId: v.id("taskBatches") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthenticated");

    const batch = await requireOwnedBatch(ctx, args.batchId, userId);
    if (batch.status === "done") return { ok: true, status: "done" };

    await ctx.db.patch(args.batchId, { status: "paused" });
    return { ok: true, status: "paused" };
  },
});

export const updateItemStatus = mutation({
  args: {
    itemId: v.id("taskItems"),
    status: v.string(),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthenticated");

    const item = await requireOwnedItem(ctx, args.itemId, userId);
    const batch = await requireOwnedBatch(ctx, item.batchId, userId);
    const now = Date.now();
    const wasTerminal = TERMINAL_ITEM_STATUSES.has(item.status);
    const isTerminal = TERMINAL_ITEM_STATUSES.has(args.status);

    await ctx.db.patch(args.itemId, {
      status: args.status,
      executedAt: isTerminal ? now : item.executedAt,
      errorMessage: args.errorMessage,
    });

    let completedTasks = batch.completedTasks;
    if (!wasTerminal && isTerminal) {
      completedTasks += 1;
    }

    const remaining = await ctx.db
      .query("taskItems")
      .withIndex("by_batch", (q) => q.eq("batchId", item.batchId))
      .collect();
    const done = remaining.every((taskItem) =>
      TERMINAL_ITEM_STATUSES.has(
        taskItem._id === args.itemId ? args.status : taskItem.status
      )
    );

    await ctx.db.patch(item.batchId, {
      completedTasks,
      status: done ? "done" : batch.status === "pending" ? "approved" : batch.status,
      ...(done && !batch.completedAt ? { completedAt: now } : {}),
    });

    return { ok: true };
  },
});

export const attachGeneratedText = mutation({
  args: {
    itemId: v.id("taskItems"),
    generatedText: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthenticated");

    await requireOwnedItem(ctx, args.itemId, userId);
    await ctx.db.patch(args.itemId, {
      generatedText: args.generatedText.slice(0, 4000),
    });
    return { ok: true };
  },
});

export const saveItemEdit = mutation({
  args: {
    itemId: v.id("taskItems"),
    userEditedText: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthenticated");

    await requireOwnedItem(ctx, args.itemId, userId);
    await ctx.db.patch(args.itemId, {
      userEditedText: args.userEditedText.slice(0, 4000),
      status: "approved",
    });
    return { ok: true };
  },
});

export const getBatch = query({
  args: { batchId: v.id("taskBatches") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;

    const batch = await ctx.db.get(args.batchId);
    if (!batch || batch.userId !== userId) return null;

    const items = await ctx.db
      .query("taskItems")
      .withIndex("by_batch", (q) => q.eq("batchId", args.batchId))
      .order("asc")
      .collect();

    return { batch, items };
  },
});

export const getPendingBatches = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];

    const results = await Promise.all(
      ["pending", "approved", "running", "paused"].map((status) =>
        ctx.db
          .query("taskBatches")
          .withIndex("by_user_status", (q) =>
            q.eq("userId", userId).eq("status", status)
          )
          .order("desc")
          .take(10)
      )
    );

    return results.flat().sort((a, b) => b.createdAt - a.createdAt);
  },
});
