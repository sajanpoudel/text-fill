import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internal } from "./_generated/api";
import { resolveEmbeddingConfig } from "./embeddingConfig";
import {
  canonicalizeMemoryText,
  getMemoryFingerprint,
  inferMemoryIdentity,
  isLowSignalMemory,
  normalizeMemoryText,
  sanitizeMemoryText,
  scoreMemoryText,
} from "./memoryRules";

const SCHEMA_VERSION = 3;
const MEMORY_DEFAULT_IMPORTANCE = 0.4;
const MEMORY_DEFAULT_CONFIDENCE = 0.9;
const ACTIVE_CAP = 500;
const ARCHIVED_CAP = 200;
const DEDUP_SCAN_LIMIT = ACTIVE_CAP + ARCHIVED_CAP + 100;
const ARCHIVE_THRESHOLD = 0.6;
const DELETE_THRESHOLD = 0.85;
const LOW_IMPORTANCE_DELETE_MAX = 0.45;
const ARCHIVE_IMPORTANCE_MIN = 0.7;
const MAX_TAGS = 8;

type MemoryDoc = Doc<"memories">;

type MemoryUpsertInput = {
  userId: Id<"users">;
  text: string;
  tags?: string[];
  platform?: string;
  sourceUrl?: string;
  importance?: number;
  confidence?: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function normalizeImportance(value?: number): number {
  return clamp(value ?? MEMORY_DEFAULT_IMPORTANCE, 0, 1);
}

function normalizeConfidence(value?: number): number {
  return clamp(value ?? MEMORY_DEFAULT_CONFIDENCE, 0, 1);
}

function tokenize(text: string): string[] {
  return Array.from(
    new Set(
      normalizeMemoryText(text)
        .split(" ")
        .filter((token) => token.length >= 3)
    )
  );
}

function jaccardSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const aSet = new Set(a);
  const bSet = new Set(b);
  let intersection = 0;
  for (const token of aSet) {
    if (bSet.has(token)) intersection += 1;
  }
  const union = new Set([...aSet, ...bSet]).size;
  return union === 0 ? 0 : intersection / union;
}

function shouldMergeMemory(
  existing: MemoryDoc,
  incoming: MemoryUpsertInput
): boolean {
  const existingNorm = normalizeMemoryText(existing.text);
  const incomingNorm = normalizeMemoryText(incoming.text);
  if (!existingNorm || !incomingNorm) return false;
  if (existingNorm === incomingNorm) return true;

  const existingIdentity = inferMemoryIdentity({
    text: existing.text,
    tags: existing.tags,
    platform: existing.platform,
  });
  const incomingIdentity = inferMemoryIdentity({
    text: incoming.text,
    tags: incoming.tags,
    platform: incoming.platform,
  });
  if (existingIdentity && incomingIdentity && existingIdentity === incomingIdentity) {
    return true;
  }

  const shortest = Math.min(existingNorm.length, incomingNorm.length);
  if (
    shortest >= 50 &&
    (existingNorm.includes(incomingNorm) || incomingNorm.includes(existingNorm))
  ) {
    return true;
  }

  return jaccardSimilarity(tokenize(existing.text), tokenize(incoming.text)) >= 0.92;
}

function chooseCanonicalText(existingText: string, incomingText: string): string {
  const existing = sanitizeMemoryText(existingText) ?? existingText.trim();
  const incoming = sanitizeMemoryText(incomingText) ?? incomingText.trim();
  const existingNorm = normalizeMemoryText(existing);
  const incomingNorm = normalizeMemoryText(incoming);
  if (existingNorm === incomingNorm) {
    return scoreMemoryText(incoming) > scoreMemoryText(existing)
      ? incoming
      : existing;
  }
  const incomingScore = scoreMemoryText(incoming);
  const existingScore = scoreMemoryText(existing);
  if (incomingScore !== existingScore) {
    return incomingScore > existingScore ? incoming : existing;
  }
  return incoming.length > existing.length ? incoming : existing;
}

function mergeTags(existing: string[], incoming: string[]): string[] {
  return Array.from(
    new Set(
      [...existing, ...incoming]
        .map((tag) => tag.trim())
        .filter(Boolean)
    )
  ).slice(0, MAX_TAGS);
}

function computeForgetScore(memory: {
  platform?: string;
  importance?: number;
  mentions?: number;
  updatedAt?: number;
  createdAt: number;
  lastAccessedAt?: number;
  sessionsSinceAccess?: number;
}): number {
  if (memory.platform === "persona") return 0;

  const now = Date.now();
  const daysSinceUpdate =
    (now - (memory.updatedAt ?? memory.createdAt ?? now)) / 86_400_000;
  const daysSinceAccess =
    (now - (memory.lastAccessedAt ?? memory.createdAt ?? now)) / 86_400_000;

  const stability =
    7 * Math.pow(1.8, Math.max(0, Math.min(memory.mentions ?? 1, 10) - 1));
  const updateRetention = Math.exp(-daysSinceUpdate / stability);
  const accessRetention = Math.exp(-daysSinceAccess / (stability * 1.5));
  const retention = updateRetention * 0.4 + accessRetention * 0.6;

  const importanceShield = normalizeImportance(memory.importance);
  const sessionPenalty = Math.min((memory.sessionsSinceAccess ?? 0) / 20, 1);
  const rawForget =
    (1 - retention) * (1 - importanceShield * 0.7) + sessionPenalty * 0.3;

  return clamp(rawForget, 0, 1);
}

function archivedRank(memory: {
  importance?: number;
  mentions?: number;
}): number {
  return normalizeImportance(memory.importance) * Math.log1p(memory.mentions ?? 1);
}

async function getEmbeddingProfile(
  ctx: MutationCtx,
  userId: Id<"users">
): Promise<{
  provider?: string;
  embeddingProvider?: string;
  embeddingModel?: string;
  openaiKey?: string;
  geminiKey?: string;
} | null> {
  return ctx.db
    .query("userProfiles")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
}

async function scheduleEmbedding(
  ctx: MutationCtx,
  userId: Id<"users">,
  memoryId: Id<"memories">,
  text: string
) {
  const profile = await getEmbeddingProfile(ctx, userId);
  const embeddingConfig = resolveEmbeddingConfig(profile);
  if (!embeddingConfig.ok) return;

  await ctx.scheduler.runAfter(0, internal.embeddings.generateAndStore, {
    memoryId,
    userId,
    text,
    provider: embeddingConfig.provider,
    model: embeddingConfig.model,
    apiKey: embeddingConfig.apiKey,
  });
}

async function pruneEmbedding(
  ctx: MutationCtx,
  memoryId: Id<"memories">
) {
  const existing = await ctx.db
    .query("memoryEmbeddings")
    .withIndex("by_memory", (q) => q.eq("memoryId", memoryId))
    .first();
  if (existing) {
    await ctx.db.delete(existing._id);
  }
}

async function loadUserMemoriesForLifecycle(
  ctx: MutationCtx,
  userId: Id<"users">
): Promise<MemoryDoc[]> {
  const active = await ctx.db
    .query("memories")
    .withIndex("by_user_status", (q) =>
      q.eq("userId", userId).eq("status", "active")
    )
    .take(DEDUP_SCAN_LIMIT);
  const archived = await ctx.db
    .query("memories")
    .withIndex("by_user_status", (q) =>
      q.eq("userId", userId).eq("status", "archived")
    )
    .take(DEDUP_SCAN_LIMIT);
  return [...active, ...archived];
}

async function upsertMemory(
  ctx: MutationCtx,
  input: MemoryUpsertInput
): Promise<{ memoryId: Id<"memories">; action: "created" | "reinforced" }> {
  const now = Date.now();
  const text = sanitizeMemoryText(input.text);
  if (!text) {
    throw new Error("Memory text is required");
  }

  const tags = mergeTags([], input.tags ?? []);
  const importance = normalizeImportance(input.importance);
  const confidence = normalizeConfidence(input.confidence);
  const incomingIdentity = inferMemoryIdentity({
    text,
    tags,
    platform: input.platform,
  });
  const memories = await loadUserMemoriesForLifecycle(ctx, input.userId);
  const duplicateCluster = memories.filter((memory) =>
    shouldMergeMemory(memory, {
      ...input,
      text,
      tags,
      platform: input.platform,
    })
  );

  if (duplicateCluster.length > 0) {
    const primary = duplicateCluster.reduce((best, current) => {
      const bestScore =
        scoreMemoryText(best.text) +
        normalizeImportance(best.importance) * 4 +
        Math.log1p(best.mentions ?? 1);
      const currentScore =
        scoreMemoryText(current.text) +
        normalizeImportance(current.importance) * 4 +
        Math.log1p(current.mentions ?? 1);
      return currentScore > bestScore ? current : best;
    });

    let nextText = chooseCanonicalText(primary.text, text);
    let nextTags = mergeTags(primary.tags, tags);
    let nextImportance = Math.max(normalizeImportance(primary.importance), importance);
    let nextConfidence = Math.max(normalizeConfidence(primary.confidence), confidence);
    let nextMentions = (primary.mentions ?? 1) + 1;
    let nextAccessCount = primary.accessCount ?? 0;
    let nextLastAccessedAt = primary.lastAccessedAt;
    let nextPlatform = primary.platform ?? input.platform;
    let nextSourceUrl = primary.sourceUrl ?? input.sourceUrl;

    for (const duplicate of duplicateCluster) {
      if (duplicate._id === primary._id) continue;
      nextText = chooseCanonicalText(nextText, duplicate.text);
      nextTags = mergeTags(nextTags, duplicate.tags);
      nextImportance = Math.max(nextImportance, normalizeImportance(duplicate.importance));
      nextConfidence = Math.max(nextConfidence, normalizeConfidence(duplicate.confidence));
      nextMentions += duplicate.mentions ?? 1;
      nextAccessCount += duplicate.accessCount ?? 0;
      nextLastAccessedAt = Math.max(
        nextLastAccessedAt ?? 0,
        duplicate.lastAccessedAt ?? 0
      ) || undefined;
      nextPlatform = nextPlatform ?? duplicate.platform;
      nextSourceUrl = nextSourceUrl ?? duplicate.sourceUrl;
    }

    const patch: Partial<MemoryDoc> = {
      text: nextText,
      tags: nextTags,
      status: "active",
      importance: nextImportance,
      confidence: nextConfidence,
      mentions: nextMentions,
      accessCount: nextAccessCount,
      lastAccessedAt: nextLastAccessedAt,
      updatedAt: now,
      sessionsSinceAccess: 0,
      forgetScore: 0,
      schemaVersion: SCHEMA_VERSION,
      validAt: primary.validAt ?? now,
      invalidAt: undefined,
    };
    if (nextPlatform) patch.platform = nextPlatform;
    if (nextSourceUrl) patch.sourceUrl = nextSourceUrl;
    await ctx.db.patch(primary._id, patch);

    for (const duplicate of duplicateCluster) {
      if (duplicate._id === primary._id) continue;
      await ctx.db.patch(duplicate._id, {
        status: "deleted",
        updatedAt: now,
        schemaVersion: SCHEMA_VERSION,
        invalidAt: duplicate.invalidAt ?? now,
      });
      await pruneEmbedding(ctx, duplicate._id);
    }

    if (
      nextText !== primary.text ||
      getMemoryFingerprint({
        text: primary.text,
        tags: primary.tags,
        platform: primary.platform,
      }) !==
        getMemoryFingerprint({
          text: nextText,
          tags: nextTags,
          platform: nextPlatform,
        })
    ) {
      await scheduleEmbedding(ctx, input.userId, primary._id, nextText);
    }

    return { memoryId: primary._id, action: "reinforced" };
  }

  const doc: Omit<MemoryDoc, "_id" | "_creationTime"> = {
    userId: input.userId,
    text,
    status: "active",
    tags,
    importance,
    confidence,
    mentions: 1,
    accessCount: 0,
    createdAt: now,
    updatedAt: now,
    sessionsSinceAccess: 0,
    forgetScore: 0,
    schemaVersion: SCHEMA_VERSION,
    validAt: now,
  };
  if (input.platform) doc.platform = input.platform;
  if (input.sourceUrl) doc.sourceUrl = input.sourceUrl;

  if (
    incomingIdentity?.startsWith("work:current-employer:")
  ) {
    for (const memory of memories) {
      if (
        memory.userId === input.userId &&
        memory.status === "active" &&
        memory.invalidAt === undefined
      ) {
        const identity = inferMemoryIdentity({
          text: memory.text,
          tags: memory.tags,
          platform: memory.platform,
        });
        if (
          identity?.startsWith("work:current-employer:") &&
          identity !== incomingIdentity
        ) {
          await ctx.db.patch(memory._id, {
            status: "archived",
            invalidAt: now,
            updatedAt: now,
            schemaVersion: SCHEMA_VERSION,
          });
        }
      }
    }
  }

  const memoryId = await ctx.db.insert("memories", doc);

  await scheduleEmbedding(ctx, input.userId, memoryId, text);
  return { memoryId, action: "created" };
}

export const repairExtractedForUser = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const memories = await loadUserMemoriesForLifecycle(ctx, userId);
    const now = Date.now();

    const groups = new Map<string, MemoryDoc[]>();
    let deleted = 0;
    let merged = 0;

    for (const memory of memories) {
      if (memory.status === "deleted") continue;

      const canonicalText = canonicalizeMemoryText({
        text: memory.text,
        tags: memory.tags,
        platform: memory.platform,
      });

      if (
        !canonicalText ||
        isLowSignalMemory({
          text: canonicalText,
          tags: memory.tags,
          platform: memory.platform,
        })
      ) {
        await ctx.db.patch(memory._id, {
          status: "deleted",
          updatedAt: now,
          schemaVersion: SCHEMA_VERSION,
        });
        await pruneEmbedding(ctx, memory._id);
        deleted += 1;
        continue;
      }

      if (canonicalText !== memory.text) {
        await ctx.db.patch(memory._id, {
          text: canonicalText,
          updatedAt: now,
          schemaVersion: SCHEMA_VERSION,
        });
        await scheduleEmbedding(ctx, userId, memory._id, canonicalText);
      }

      const fingerprint = getMemoryFingerprint({
        text: canonicalText,
        tags: memory.tags,
        platform: memory.platform,
      });
      const nextMemory = canonicalText === memory.text ? memory : { ...memory, text: canonicalText };
      const bucket = groups.get(fingerprint);
      if (bucket) {
        bucket.push(nextMemory);
      } else {
        groups.set(fingerprint, [nextMemory]);
      }
    }

    for (const cluster of groups.values()) {
      if (cluster.length <= 1) continue;

      const primary = cluster.reduce((best, current) => {
        const bestScore =
          scoreMemoryText(best.text) +
          normalizeImportance(best.importance) * 4 +
          Math.log1p(best.mentions ?? 1);
        const currentScore =
          scoreMemoryText(current.text) +
          normalizeImportance(current.importance) * 4 +
          Math.log1p(current.mentions ?? 1);
        return currentScore > bestScore ? current : best;
      });

      let nextText = primary.text;
      let nextTags = primary.tags;
      let nextImportance = normalizeImportance(primary.importance);
      let nextConfidence = normalizeConfidence(primary.confidence);
      let nextMentions = primary.mentions ?? 1;
      let nextAccessCount = primary.accessCount ?? 0;
      let nextLastAccessedAt = primary.lastAccessedAt;
      let nextPlatform = primary.platform;
      let nextSourceUrl = primary.sourceUrl;
      let nextStatus = cluster.some((memory) => memory.status === "active")
        ? "active"
        : primary.status;

      for (const duplicate of cluster) {
        if (duplicate._id === primary._id) continue;
        nextText = chooseCanonicalText(nextText, duplicate.text);
        nextTags = mergeTags(nextTags, duplicate.tags);
        nextImportance = Math.max(nextImportance, normalizeImportance(duplicate.importance));
        nextConfidence = Math.max(nextConfidence, normalizeConfidence(duplicate.confidence));
        nextMentions += duplicate.mentions ?? 1;
        nextAccessCount += duplicate.accessCount ?? 0;
        nextLastAccessedAt = Math.max(
          nextLastAccessedAt ?? 0,
          duplicate.lastAccessedAt ?? 0
        ) || undefined;
        nextPlatform = nextPlatform ?? duplicate.platform;
        nextSourceUrl = nextSourceUrl ?? duplicate.sourceUrl;
      }

      const patch: Partial<MemoryDoc> = {
        text: nextText,
        tags: nextTags,
        status: nextStatus,
        importance: nextImportance,
        confidence: nextConfidence,
        mentions: nextMentions,
        accessCount: nextAccessCount,
        lastAccessedAt: nextLastAccessedAt,
        updatedAt: now,
        sessionsSinceAccess: 0,
        forgetScore: nextStatus === "active" ? 0 : primary.forgetScore ?? 0,
        schemaVersion: SCHEMA_VERSION,
      };
      if (nextPlatform) patch.platform = nextPlatform;
      if (nextSourceUrl) patch.sourceUrl = nextSourceUrl;
      await ctx.db.patch(primary._id, patch);
      await scheduleEmbedding(ctx, userId, primary._id, nextText);

      for (const duplicate of cluster) {
        if (duplicate._id === primary._id) continue;
        await ctx.db.patch(duplicate._id, {
          status: "deleted",
          updatedAt: now,
          schemaVersion: SCHEMA_VERSION,
        });
        await pruneEmbedding(ctx, duplicate._id);
        merged += 1;
      }
    }

    return { deleted, merged };
  },
});

// ── Public queries (reactive subscriptions) ───────────────────────────────

export const listActive = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit = 50 }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const active = await ctx.db
      .query("memories")
      .withIndex("by_user_active", (q) =>
        q.eq("userId", userId).eq("invalidAt", undefined)
      )
      .order("desc")
      .take(limit * 3);
    return active
      .filter((memory) => memory.status === "active")
      .slice(0, limit);
  },
});

export const listAll = query({
  args: {
    status: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { status, limit = 100 }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const q = ctx.db.query("memories").withIndex("by_user_status", (index) =>
      status
        ? index.eq("userId", userId).eq("status", status)
        : index.eq("userId", userId)
    );
    return q.order("desc").take(limit);
  },
});

export const getStats = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { active: 0, archived: 0 };
    const active = await ctx.db
      .query("memories")
      .withIndex("by_user_active", (q) =>
        q.eq("userId", userId).eq("invalidAt", undefined)
      )
      .collect();
    const archived = await ctx.db
      .query("memories")
      .withIndex("by_user_status", (q) =>
        q.eq("userId", userId).eq("status", "archived")
      )
      .collect();
    return {
      active: active.filter((memory) => memory.status === "active").length,
      archived: archived.length,
    };
  },
});

// ── Public mutations ──────────────────────────────────────────────────────

export const save = mutation({
  args: {
    text: v.string(),
    tags: v.optional(v.array(v.string())),
    platform: v.optional(v.string()),
    sourceUrl: v.optional(v.string()),
    importance: v.optional(v.number()),
    confidence: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    return upsertMemory(ctx, {
      userId,
      text: args.text,
      tags: args.tags,
      platform: args.platform,
      sourceUrl: args.sourceUrl,
      importance: args.importance,
      confidence: args.confidence,
    });
  },
});

export const updateStatus = mutation({
  args: {
    memoryId: v.id("memories"),
    status: v.string(),
  },
  handler: async (ctx, { memoryId, status }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const memory = await ctx.db.get(memoryId);
    if (!memory || memory.userId !== userId) throw new Error("Not found");
    await ctx.db.patch(memoryId, {
      status,
      invalidAt: status === "active" ? undefined : memory.invalidAt ?? Date.now(),
      forgetScore: status === "active" ? 0 : memory.forgetScore ?? 0,
      sessionsSinceAccess: status === "active" ? 0 : memory.sessionsSinceAccess ?? 0,
      updatedAt: Date.now(),
      schemaVersion: SCHEMA_VERSION,
    });
  },
});

export const updateText = mutation({
  args: {
    memoryId: v.id("memories"),
    text: v.string(),
  },
  handler: async (ctx, { memoryId, text }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const memory = await ctx.db.get(memoryId);
    if (!memory || memory.userId !== userId) throw new Error("Not found");
    const nextText = text.trim();
    await ctx.db.patch(memoryId, {
      text: nextText,
      updatedAt: Date.now(),
      sessionsSinceAccess: 0,
      forgetScore: 0,
      schemaVersion: SCHEMA_VERSION,
      ...(memory.invalidAt !== undefined ? { invalidAt: undefined } : {}),
    });
    await scheduleEmbedding(ctx, userId, memoryId, nextText);
  },
});

export const remove = mutation({
  args: { memoryId: v.id("memories") },
  handler: async (ctx, { memoryId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const memory = await ctx.db.get(memoryId);
    if (!memory || memory.userId !== userId) throw new Error("Not found");
    await ctx.db.patch(memoryId, {
      status: "deleted",
      invalidAt: memory.invalidAt ?? Date.now(),
      updatedAt: Date.now(),
      schemaVersion: SCHEMA_VERSION,
    });
    await pruneEmbedding(ctx, memoryId);
  },
});

// ── Internal helpers (used by embeddings.ts + generate.ts) ───────────────

export const upsertExtracted = internalMutation({
  args: {
    userId: v.id("users"),
    text: v.string(),
    tags: v.array(v.string()),
    platform: v.optional(v.string()),
    importance: v.optional(v.number()),
    confidence: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return upsertMemory(ctx, args);
  },
});

// Load memory docs given a list of memoryEmbedding IDs
export const fetchByEmbeddingIds = internalQuery({
  args: { embeddingIds: v.array(v.id("memoryEmbeddings")) },
  handler: async (ctx, { embeddingIds }) => {
    const results: Array<{
      _id: string;
      text: string;
      tags: string[];
      platform?: string;
      status: string;
      createdAt: number;
      updatedAt?: number;
      importance?: number;
      confidence?: number;
      mentions?: number;
      accessCount?: number;
      lastAccessedAt?: number;
      forgetScore?: number;
      sourceUrl?: string;
      invalidAt?: number;
    }> = [];
    for (const embId of embeddingIds) {
      const emb = await ctx.db.get(embId);
      if (!emb) continue;
      const memory = await ctx.db.get(emb.memoryId);
      if (!memory || memory.status === "deleted" || memory.invalidAt !== undefined) continue;
      results.push({
        _id: memory._id,
        text: memory.text,
        tags: memory.tags,
        platform: memory.platform,
        status: memory.status,
        createdAt: memory.createdAt,
        updatedAt: memory.updatedAt,
        importance: memory.importance,
        confidence: memory.confidence,
        mentions: memory.mentions,
        accessCount: memory.accessCount,
        lastAccessedAt: memory.lastAccessedAt,
        forgetScore: memory.forgetScore,
        sourceUrl: memory.sourceUrl,
        invalidAt: memory.invalidAt,
      });
    }
    return results;
  },
});

// Public action — semantic search (called from memory viewer + hooks)
export const searchMemories = action({
  args: {
    queryText: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (
    ctx,
    { queryText, limit = 20 }
  ): Promise<
    Array<{
      _id: string;
      text: string;
      tags: string[];
      platform?: string;
      status: string;
      createdAt: number;
      score: number;
    }>
  > => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    return ctx.runAction(internal.embeddings.searchMemories, {
      userId,
      queryText,
      limit,
    });
  },
});

// Increment access count when a memory is used in generation
export const recordAccess = internalMutation({
  args: { memoryIds: v.array(v.id("memories")) },
  handler: async (ctx, { memoryIds }) => {
    const now = Date.now();
    for (const id of memoryIds) {
      const memory = await ctx.db.get(id);
      if (memory && memory.status === "active" && memory.invalidAt === undefined) {
        await ctx.db.patch(id, {
          accessCount: memory.accessCount + 1,
          lastAccessedAt: now,
          sessionsSinceAccess: 0,
          forgetScore: 0,
          schemaVersion: SCHEMA_VERSION,
        });
      }
    }
  },
});

export const listUsersForMaintenance = internalQuery({
  args: {},
  handler: async (ctx) => {
    return ctx.db.query("userProfiles").take(200);
  },
});

export const applyForgettingForUser = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const memories = await loadUserMemoriesForLifecycle(ctx, userId);
    if (memories.length === 0) {
      return { processed: 0, archived: 0, deleted: 0, restored: 0 };
    }

    const working = memories.map((memory) => {
      const sessionsSinceAccess = (memory.sessionsSinceAccess ?? 0) + 1;
      const forgetScore = round3(
        computeForgetScore({
          platform: memory.platform,
          importance: memory.importance,
          mentions: memory.mentions,
          updatedAt: memory.updatedAt,
          createdAt: memory.createdAt,
          lastAccessedAt: memory.lastAccessedAt,
          sessionsSinceAccess,
        })
      );

      let status = memory.status;
      if (memory.platform === "persona") {
        status = "active";
      } else if (
        forgetScore > DELETE_THRESHOLD &&
        normalizeImportance(memory.importance) <= LOW_IMPORTANCE_DELETE_MAX
      ) {
        status = "deleted";
      } else if (forgetScore > ARCHIVE_THRESHOLD) {
        status = "archived";
      } else {
        status = "active";
      }

      return {
        ...memory,
        importance: normalizeImportance(memory.importance),
        confidence: normalizeConfidence(memory.confidence),
        mentions: Math.max(memory.mentions ?? 1, 1),
        updatedAt: memory.updatedAt ?? memory.createdAt,
        sessionsSinceAccess,
        forgetScore,
        nextStatus: status,
      };
    });

    const active = working
      .filter((memory) => memory.nextStatus === "active")
      .sort(
        (a, b) =>
          a.forgetScore - b.forgetScore ||
          normalizeImportance(b.importance) - normalizeImportance(a.importance)
      );

    for (const overflow of active.slice(ACTIVE_CAP)) {
      if (
        overflow.platform !== "persona" &&
        normalizeImportance(overflow.importance) >= ARCHIVE_IMPORTANCE_MIN
      ) {
        overflow.nextStatus = "archived";
      } else {
        overflow.nextStatus = "deleted";
      }
    }

    const archived = working
      .filter((memory) => memory.nextStatus === "archived")
      .sort((a, b) => archivedRank(b) - archivedRank(a));

    for (const overflow of archived.slice(ARCHIVED_CAP)) {
      overflow.nextStatus = "deleted";
    }

    let archivedCount = 0;
    let deletedCount = 0;
    let restoredCount = 0;

    for (const memory of working) {
      const patch: Partial<MemoryDoc> = {
        importance: normalizeImportance(memory.importance),
        confidence: normalizeConfidence(memory.confidence),
        mentions: Math.max(memory.mentions ?? 1, 1),
        updatedAt: memory.updatedAt ?? memory.createdAt,
        sessionsSinceAccess: memory.sessionsSinceAccess,
        forgetScore: memory.forgetScore,
        status: memory.nextStatus,
        schemaVersion: SCHEMA_VERSION,
      };

      if (memory.status !== memory.nextStatus) {
        if (memory.status === "archived" && memory.nextStatus === "active") {
          restoredCount += 1;
        } else if (memory.nextStatus === "archived") {
          archivedCount += 1;
        } else if (memory.nextStatus === "deleted") {
          deletedCount += 1;
        }
      }

      await ctx.db.patch(memory._id, patch);
      if (memory.nextStatus === "deleted") {
        await pruneEmbedding(ctx, memory._id);
      }
    }

    return {
      processed: working.length,
      archived: archivedCount,
      deleted: deletedCount,
      restored: restoredCount,
    };
  },
});

export const runWeeklyMaintenance = internalAction({
  args: {},
  handler: async (ctx): Promise<{ processedUsers: number }> => {
    const profiles: Array<{ userId: Id<"users"> }> = await ctx.runQuery(
      internal.memories.listUsersForMaintenance,
      {}
    );

    for (const profile of profiles) {
      await ctx.runMutation(internal.memories.applyForgettingForUser, {
        userId: profile.userId,
      });
    }

    return {
      processedUsers: profiles.length,
    };
  },
});
