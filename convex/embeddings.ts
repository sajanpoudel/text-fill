import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { EMBEDDING_DIMENSIONS, resolveEmbeddingConfig } from "./embeddingConfig";

const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models";
const REINDEX_BATCH_SIZE = 25;

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function getEmbeddingScopeKey(
  userId: Id<"users">,
  provider: string,
  model: string
): string {
  return `${userId}:${provider}:${model}`;
}

// ── Core embedding generation ──────────────────────────────────────────────

export const generate = internalAction({
  args: {
    text: v.string(),
    provider: v.string(),
    model: v.string(),
    apiKey: v.optional(v.string()),
  },
  handler: async (_ctx, { text, provider, model, apiKey }): Promise<number[]> => {
    const input = text.slice(0, 8000);

    if (provider === "gemini") {
      if (!apiKey) throw new Error("No Gemini API key available");
      const res = await fetch(
        `${GEMINI_ENDPOINT}/${model}:embedContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: `models/${model}`,
            content: { parts: [{ text: input }] },
            taskType: "SEMANTIC_SIMILARITY",
            outputDimensionality: EMBEDDING_DIMENSIONS,
          }),
        }
      );
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Gemini embedding error [${res.status}]: ${body.slice(0, 300)}`);
      }
      const json = (await res.json()) as {
        embedding?: { values?: number[] };
        embeddings?: Array<{ values?: number[] }>;
      };
      const embedding =
        json.embedding?.values ?? json.embeddings?.[0]?.values ?? null;
      if (!embedding?.length) {
        throw new Error("Gemini embedding response was empty");
      }
      return embedding;
    }

    const key = apiKey ?? process.env.OPENAI_API_KEY;
    if (!key) throw new Error("No OpenAI API key available");

    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        input,
        dimensions: EMBEDDING_DIMENSIONS,
        encoding_format: "float",
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenAI embedding error [${res.status}]: ${body.slice(0, 300)}`);
    }
    const json = (await res.json()) as { data: [{ embedding: number[] }] };
    return json.data[0].embedding;
  },
});

// ── Persistence ───────────────────────────────────────────────────────────

export const storeEmbedding = internalMutation({
  args: {
    memoryId: v.id("memories"),
    userId: v.id("users"),
    provider: v.string(),
    model: v.string(),
    embedding: v.array(v.float64()),
  },
  handler: async (ctx, { memoryId, userId, provider, model, embedding }) => {
    const scopeKey = getEmbeddingScopeKey(userId, provider, model);
    const existing = await ctx.db
      .query("memoryEmbeddings")
      .withIndex("by_memory", (q) => q.eq("memoryId", memoryId))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { scopeKey, provider, model, embedding });
    } else {
      await ctx.db.insert("memoryEmbeddings", {
        memoryId,
        userId,
        scopeKey,
        provider,
        model,
        embedding,
      });
    }
  },
});

// Called from scheduler after a memory is saved
export const generateAndStore = internalAction({
  args: {
    memoryId: v.id("memories"),
    userId: v.id("users"),
    text: v.string(),
    provider: v.string(),
    model: v.string(),
    apiKey: v.optional(v.string()),
  },
  handler: async (ctx, { memoryId, userId, text, provider, model, apiKey }) => {
    const embedding: number[] = await ctx.runAction(internal.embeddings.generate, {
      text,
      provider,
      model,
      apiKey,
    });
    await ctx.runMutation(internal.embeddings.storeEmbedding, {
      memoryId,
      userId,
      provider,
      model,
      embedding,
    });
  },
});

// ── Vector search (internal, called from generate.ts) ────────────────────

type MemorySearchResult = {
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
  score: number;
};

export const vectorSearch = internalAction({
  args: {
    userId: v.id("users"),
    queryText: v.string(),
    provider: v.string(),
    model: v.string(),
    apiKey: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (
    ctx,
    { userId, queryText, provider, model, apiKey, limit = 20 }
  ): Promise<MemorySearchResult[]> => {
    const embedding: number[] = await ctx.runAction(internal.embeddings.generate, {
      text: queryText,
      provider,
      model,
      apiKey,
    });

    const results = await ctx.vectorSearch("memoryEmbeddings", "by_embedding", {
      vector: embedding,
      limit,
      filter: (q) => q.eq("scopeKey", getEmbeddingScopeKey(userId, provider, model)),
    });

    if (results.length === 0) return [];

    const docs: Array<{
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
    }> = await ctx.runQuery(internal.memories.fetchByEmbeddingIds, {
      embeddingIds: results.map((r) => r._id),
    });

    return docs.map((doc, i) => ({ ...doc, score: results[i]?._score ?? 0 }));
  },
});

// Internal query to load embedding rows by their IDs
export const getEmbeddingRow = internalQuery({
  args: { embeddingId: v.id("memoryEmbeddings") },
  handler: async (ctx, { embeddingId }) => ctx.db.get(embeddingId),
});

export const listEmbeddableMemories = internalQuery({
  args: {
    userId: v.id("users"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { userId, limit = 800 }) => {
    const docs = await ctx.db
      .query("memories")
      .withIndex("by_user_created", (q) => q.eq("userId", userId))
      .order("desc")
      .take(limit);

    return docs
      .filter((memory) => memory.status !== "deleted")
      .map((memory) => ({
        memoryId: memory._id,
        text: memory.text,
      }));
  },
});

const reindexItemSchema = v.object({
  memoryId: v.id("memories"),
  text: v.string(),
});

export const reindexBatch = internalAction({
  args: {
    userId: v.id("users"),
    provider: v.string(),
    model: v.string(),
    apiKey: v.string(),
    items: v.array(reindexItemSchema),
  },
  handler: async (ctx, { userId, provider, model, apiKey, items }) => {
    for (const item of items) {
      await ctx.runAction(internal.embeddings.generateAndStore, {
        memoryId: item.memoryId,
        userId,
        text: item.text,
        provider,
        model,
        apiKey,
      });
    }

    return { processed: items.length };
  },
});

export const reindexUserEmbeddings = internalAction({
  args: {
    userId: v.id("users"),
    provider: v.string(),
    model: v.string(),
    apiKey: v.string(),
  },
  handler: async (ctx, { userId, provider, model, apiKey }) => {
    const memories: Array<{ memoryId: Id<"memories">; text: string }> = await ctx.runQuery(
      internal.embeddings.listEmbeddableMemories,
      { userId, limit: 800 }
    );

    const chunks = chunkArray(memories, REINDEX_BATCH_SIZE);
    for (const [index, items] of chunks.entries()) {
      await ctx.scheduler.runAfter(index * 100, internal.embeddings.reindexBatch, {
        userId,
        provider,
        model,
        apiKey,
        items,
      });
    }

    return { scheduled: memories.length };
  },
});

// Public action for memory viewer semantic search
export const searchMemories = internalAction({
  args: {
    userId: v.id("users"),
    queryText: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<MemorySearchResult[]> => {
    const profile:
      | {
          provider?: string;
          embeddingProvider?: string;
          embeddingModel?: string;
          openaiKey?: string;
          geminiKey?: string;
        }
      | null = await ctx.runQuery(
      internal.users._getProfileByUserId,
      { userId: args.userId }
    );
    const embeddingConfig = resolveEmbeddingConfig(profile);
    if (!embeddingConfig.ok) return [];

    return ctx.runAction(internal.embeddings.vectorSearch, {
      userId: args.userId,
      queryText: args.queryText,
      provider: embeddingConfig.provider,
      model: embeddingConfig.model,
      apiKey: embeddingConfig.apiKey,
      limit: args.limit,
    });
  },
});
