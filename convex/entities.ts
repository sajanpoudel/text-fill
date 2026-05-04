import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalAction,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { resolveEmbeddingConfig } from "./embeddingConfig";

const COMPANY_NOISE_TOKENS = new Set([
  "co",
  "company",
  "corp",
  "corporation",
  "inc",
  "incorporated",
  "llc",
  "ltd",
  "limited",
]);

type ActiveEntity = {
  _id: Id<"entities">;
  name: string;
  type: string;
  normalizedName: string;
  deletedAt?: number;
};

function foldEntityName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalizeEntityName(value: string): string {
  const tokens = foldEntityName(value)
    .split(" ")
    .filter(Boolean)
    .filter((token, index, all) =>
      all.length > 1 ? !COMPANY_NOISE_TOKENS.has(token) : true
    );
  return tokens.join(" ");
}

function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;

  const previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  const current = new Array<number>(b.length + 1).fill(0);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      const insertion = current[j - 1] + 1;
      const deletion = previous[j] + 1;
      current[j] = Math.min(substitution, insertion, deletion);
    }
    for (let j = 0; j <= b.length; j += 1) previous[j] = current[j];
  }

  return previous[b.length];
}

function lexicalEntitySimilarity(a: string, b: string): number {
  const canonicalA = canonicalizeEntityName(a);
  const canonicalB = canonicalizeEntityName(b);
  if (!canonicalA || !canonicalB) return 0;
  if (canonicalA === canonicalB) return 1;

  const distance = levenshteinDistance(canonicalA, canonicalB);
  const charScore =
    1 - distance / Math.max(canonicalA.length, canonicalB.length, 1);
  const tokensA = new Set(canonicalA.split(" ").filter(Boolean));
  const tokensB = new Set(canonicalB.split(" ").filter(Boolean));
  const overlap = [...tokensA].filter((token) => tokensB.has(token)).length;
  const tokenScore = (2 * overlap) / Math.max(tokensA.size + tokensB.size, 1);
  return Math.max(charScore, tokenScore);
}

function chooseLexicalEntityCandidate(
  entities: ActiveEntity[],
  name: string,
  type: string
): ActiveEntity | null {
  const threshold = type === "company" ? 0.9 : 0.94;
  const ranked = entities
    .filter((entity) => entity.type === type)
    .map((entity) => ({
      entity,
      score: lexicalEntitySimilarity(entity.normalizedName, name),
    }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  const second = ranked[1];
  if (!best || best.score < threshold) return null;
  if (second && best.score - second.score < 0.03 && best.score < 0.995) {
    return null;
  }
  return best.entity;
}

// ── Entity upsert ─────────────────────────────────────────────────────────────

// Ensures an entity exists for this user. Returns the entity's _id whether
// it was just created or already existed.
export const upsertEntity = internalMutation({
  args: {
    userId: v.id("users"),
    name: v.string(),
    type: v.string(), // "person" | "company" | "platform" | "self"
    normalizedName: v.string(),
  },
  handler: async (ctx, { userId, name, type, normalizedName }) => {
    const existing = await ctx.db
      .query("entities")
      .withIndex("by_user_name", (q) =>
        q.eq("userId", userId).eq("normalizedName", normalizedName)
      )
      .first();
    if (existing && !existing.deletedAt) return existing._id;
    return await ctx.db.insert("entities", {
      userId,
      name,
      type,
      normalizedName,
      createdAt: Date.now(),
    });
  },
});

export const getEntityByNormalizedName = internalQuery({
  args: {
    userId: v.id("users"),
    normalizedName: v.string(),
  },
  handler: async (ctx, { userId, normalizedName }) =>
    ctx.db
      .query("entities")
      .withIndex("by_user_name", (q) =>
        q.eq("userId", userId).eq("normalizedName", normalizedName)
      )
      .first(),
});

export const listActiveEntitiesByType = internalQuery({
  args: {
    userId: v.id("users"),
    type: v.string(),
  },
  handler: async (ctx, { userId, type }) => {
    const entities = await ctx.db
      .query("entities")
      .withIndex("by_user_active", (q) =>
        q.eq("userId", userId).eq("deletedAt", undefined)
      )
      .collect();
    return entities.filter((entity) => entity.type === type);
  },
});

export const getEntityByEmbeddingId = internalQuery({
  args: {
    embeddingId: v.id("entityEmbeddings"),
  },
  handler: async (ctx, { embeddingId }) => {
    const row = await ctx.db.get(embeddingId);
    if (!row) return null;
    const entity = await ctx.db.get(row.entityId);
    if (!entity || entity.deletedAt) return null;
    return entity;
  },
});

export const upsertEntityEmbedding = internalMutation({
  args: {
    entityId: v.id("entities"),
    userId: v.id("users"),
    embedding: v.array(v.float64()),
  },
  handler: async (ctx, { entityId, userId, embedding }) => {
    const existing = await ctx.db
      .query("entityEmbeddings")
      .withIndex("by_entity", (q) => q.eq("entityId", entityId))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { embedding, userId });
      return existing._id;
    }
    return ctx.db.insert("entityEmbeddings", {
      entityId,
      userId,
      embedding,
    });
  },
});

// ── Temporal edge upsert with contradiction handling ──────────────────────────

// Relations where only one target can be active at a time (e.g. a person can
// only work_at one company at a time). When a new exclusive edge is created,
// the previous active one is soft-invalidated.
const EXCLUSIVE_RELATIONS = new Set(["works_at", "reports_to", "employed_by"]);

export const upsertEdge = internalMutation({
  args: {
    userId: v.id("users"),
    fromEntityId: v.id("entities"),
    toEntityId: v.id("entities"),
    relation: v.string(),
    validAt: v.number(),
    sessionId: v.optional(v.id("interactionSessions")),
  },
  handler: async (
    ctx,
    { userId, fromEntityId, toEntityId, relation, validAt, sessionId }
  ) => {
    const now = Date.now();

    // Soft-invalidate conflicting active edges for exclusive relations
    if (EXCLUSIVE_RELATIONS.has(relation)) {
      const conflicting = await ctx.db
        .query("entityEdges")
        .withIndex("by_from_active", (q) =>
          q.eq("fromEntityId", fromEntityId).eq("invalidAt", undefined)
        )
        .filter((q) => q.eq(q.field("relation"), relation))
        .collect();
      for (const edge of conflicting) {
        if (edge.toEntityId !== toEntityId) {
          await ctx.db.patch(edge._id, {
            invalidAt: validAt,
            expiredAt: now,
          });
        }
      }
    }

    // Return existing active edge without duplicating
    const existing = await ctx.db
      .query("entityEdges")
      .withIndex("by_from_active", (q) =>
        q.eq("fromEntityId", fromEntityId).eq("invalidAt", undefined)
      )
      .filter((q) =>
        q.and(
          q.eq(q.field("toEntityId"), toEntityId),
          q.eq(q.field("relation"), relation)
        )
      )
      .first();

    if (existing) {
      if (sessionId) {
        const support = await ctx.db
          .query("edgeSupports")
          .withIndex("by_edge_and_session", (q) =>
            q.eq("edgeId", existing._id).eq("sessionId", sessionId)
          )
          .first();
        if (!support) {
          await ctx.db.insert("edgeSupports", {
            edgeId: existing._id,
            sessionId,
            createdAt: now,
          });
        }
      }
      return existing._id;
    }

    const edgeId = await ctx.db.insert("entityEdges", {
      userId,
      fromEntityId,
      toEntityId,
      relation,
      validAt,
      createdAt: now,
    });
    if (sessionId) {
      const support = await ctx.db
        .query("edgeSupports")
        .withIndex("by_edge_and_session", (q) =>
          q.eq("edgeId", edgeId).eq("sessionId", sessionId)
        )
        .first();
      if (!support) {
        await ctx.db.insert("edgeSupports", {
          edgeId,
          sessionId,
          createdAt: now,
        });
      }
    }
    return edgeId;
  },
});

// ── Self-entity resolution ────────────────────────────────────────────────────

// Returns the user's "self" entity ID, creating it on first call.
// All user-centric edges (works_at, knows, etc.) use this as fromEntityId.
export const getOrCreateSelfEntity = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const existing = await ctx.db
      .query("entities")
      .withIndex("by_user_name", (q) =>
        q.eq("userId", userId).eq("normalizedName", "__self__")
      )
      .first();
    if (existing) return existing._id;
    return await ctx.db.insert("entities", {
      userId,
      name: "User",
      type: "self",
      normalizedName: "__self__",
      createdAt: Date.now(),
    });
  },
});

// ── Entity query helpers ──────────────────────────────────────────────────────

export const getActiveEdgesFromSelf = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const selfEntity = await ctx.db
      .query("entities")
      .withIndex("by_user_name", (q) =>
        q.eq("userId", userId).eq("normalizedName", "__self__")
      )
      .first();
    if (!selfEntity) return [];

    return ctx.db
      .query("entityEdges")
      .withIndex("by_from_active", (q) =>
        q.eq("fromEntityId", selfEntity._id).eq("invalidAt", undefined)
      )
      .collect();
  },
});

async function resolveEntityIdWithFuzzyMatching(
  ctx: any,
  args: {
    userId: Id<"users">;
    name: string;
    type: "person" | "company";
    normalizedName: string;
  }
) : Promise<Id<"entities">> {
  const exact: ActiveEntity | null = await ctx.runQuery(
    internal.entities.getEntityByNormalizedName,
    {
      userId: args.userId,
      normalizedName: args.normalizedName,
    }
  );
  if (exact && !exact.deletedAt) return exact._id;

  const activeEntities: ActiveEntity[] = await ctx.runQuery(
    internal.entities.listActiveEntitiesByType,
    { userId: args.userId, type: args.type }
  );
  const lexicalMatch = chooseLexicalEntityCandidate(
    activeEntities,
    args.name,
    args.type
  );
  if (lexicalMatch) {
    return lexicalMatch._id;
  }

  const profile = await ctx.runQuery(internal.users._getProfileByUserId, {
    userId: args.userId,
  });
  const embeddingConfig = resolveEmbeddingConfig(profile);

  let embedding: number[] | null = null;
  if (embeddingConfig.ok) {
    embedding = await ctx.runAction(internal.embeddings.generate, {
      text: args.name,
      provider: embeddingConfig.provider,
      model: embeddingConfig.model,
      apiKey: embeddingConfig.apiKey,
    });

    const vectorMatches: Array<{
      _id: Id<"entityEmbeddings">;
      _score?: number;
    }> = await ctx.vectorSearch(
      "entityEmbeddings",
      "by_embedding",
      {
        vector: embedding,
        limit: 5,
        filter: (q: any) => q.eq("userId", args.userId),
      }
    );

    const candidates: Array<{
      score: number;
      entity: ActiveEntity | null;
    }> = await Promise.all(
      vectorMatches.map(async (match: { _id: Id<"entityEmbeddings">; _score?: number }) => ({
        score: match._score ?? 0,
        entity: (await ctx.runQuery(internal.entities.getEntityByEmbeddingId, {
          embeddingId: match._id,
        })) as ActiveEntity | null,
      }))
    );
    const ranked: Array<{
      entity: ActiveEntity;
      embeddingScore: number;
      lexicalScore: number;
    }> = candidates
      .filter(
        (
          candidate: { score: number; entity: ActiveEntity | null }
        ): candidate is { score: number; entity: ActiveEntity } =>
          !!candidate.entity && candidate.entity.type === args.type
      )
      .map((candidate) => ({
        entity: candidate.entity,
        embeddingScore: candidate.score,
        lexicalScore: lexicalEntitySimilarity(
          candidate.entity.normalizedName,
          args.name
        ),
      }))
      .sort(
        (
          a: { embeddingScore: number },
          b: { embeddingScore: number }
        ) => b.embeddingScore - a.embeddingScore
      );

    const best: (typeof ranked)[number] | undefined = ranked[0];
    const second: (typeof ranked)[number] | undefined = ranked[1];
    if (
      best &&
      best.embeddingScore >= 0.86 &&
      best.lexicalScore >= 0.55 &&
      (!second || best.embeddingScore - second.embeddingScore >= 0.02)
    ) {
      await ctx.runMutation(internal.entities.upsertEntityEmbedding, {
        entityId: best.entity._id,
        userId: args.userId,
        embedding,
      });
      return best.entity._id;
    }
  }

  const createdEntityId: Id<"entities"> = await ctx.runMutation(
    internal.entities.upsertEntity,
    {
      userId: args.userId,
      name: args.name,
      type: args.type,
      normalizedName: args.normalizedName,
    }
  );
  if (embedding) {
    await ctx.runMutation(internal.entities.upsertEntityEmbedding, {
      entityId: createdEntityId,
      userId: args.userId,
      embedding,
    });
  }
  return createdEntityId;
}

export const resolveEntity = internalAction({
  args: {
    userId: v.id("users"),
    name: v.string(),
    type: v.union(v.literal("person"), v.literal("company")),
    normalizedName: v.string(),
  },
  handler: async (
    ctx,
    args
  ): Promise<Id<"entities">> => resolveEntityIdWithFuzzyMatching(ctx, args),
});

// ── LLM-based entity extraction ───────────────────────────────────────────────

// Extracts person/company entities and their relation to the user from the
// generated text + page context. Runs as a fire-and-forget scheduled action
// from memoryExtract.ts — never blocks generation.

const ENTITY_EXTRACTION_PROMPT = `You are extracting entity relationships from AI-generated text to build a personal knowledge graph.

Focus ONLY on relationships between the USER and external entities (people, companies).

Allowed relations:
- "works_at" — user currently works at a company (exclusive: invalidates prior works_at)
- "worked_at" — user previously worked at a company
- "knows" — user has a professional or personal relationship with a person
- "studying_at" — user is enrolled at an educational institution

Return ONLY JSON in this shape:
{
  "entities": [
    {
      "name": "Google",
      "type": "company",
      "relation": "works_at",
      "confidence": 0.92
    }
  ]
}

Rules:
- Only extract if confidence >= 0.85
- type must be "person" or "company"
- Derive from the USER's perspective — not the recipient's
- Return {"entities":[]} if nothing qualifies`;

type ExtractedEntity = {
  name: string;
  type: "person" | "company";
  relation: string;
  confidence: number;
};

export const extractEntities = internalAction({
  args: {
    userId: v.id("users"),
    generatedText: v.string(),
    pageContext: v.optional(v.string()),
    platform: v.string(),
    provider: v.string(),
    apiKey: v.string(),
    model: v.string(),
    sessionId: v.optional(v.id("interactionSessions")),
  },
  handler: async (
    ctx,
    { userId, generatedText, pageContext, platform, provider, apiKey, model, sessionId }
  ) => {
    const userPrompt = [
      `Platform: ${platform}`,
      pageContext?.trim()
        ? `Page context:\n${pageContext.trim().slice(0, 600)}`
        : "",
      `Generated text (user's voice):\n${generatedText.trim().slice(0, 800)}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    let rawJson = "";
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
            max_tokens: 512,
            system: ENTITY_EXTRACTION_PROMPT,
            messages: [{ role: "user", content: userPrompt }],
          }),
        });
        const data = (await res.json()) as any;
        rawJson = data.content?.[0]?.text ?? "";
      } else if (provider === "gemini") {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [
                {
                  parts: [
                    { text: `${ENTITY_EXTRACTION_PROMPT}\n\n${userPrompt}` },
                  ],
                },
              ],
              generationConfig: { maxOutputTokens: 512, temperature: 0.1 },
            }),
          }
        );
        const data = (await res.json()) as any;
        rawJson = (data.candidates?.[0]?.content?.parts ?? [])
          .map((p: any) => p.text ?? "")
          .join("");
      } else {
        const res = await fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            instructions: ENTITY_EXTRACTION_PROMPT,
            input: userPrompt,
          }),
        });
        const data = (await res.json()) as any;
        rawJson =
          typeof data?.output_text === "string"
            ? data.output_text
            : (data?.output ?? [])
                .flatMap((item: any) =>
                  item?.type === "message"
                    ? (item.content ?? [])
                        .filter((c: any) => c?.type === "output_text")
                        .map((c: any) => c.text ?? "")
                    : []
                )
                .join("");
      }
    } catch {
      return; // non-fatal
    }

    let entities: ExtractedEntity[] = [];
    try {
      const fence = rawJson.match(/```(?:json)?\s*([\s\S]*?)```/);
      const parsed = JSON.parse((fence ? fence[1] : rawJson).trim()) as {
        entities: ExtractedEntity[];
      };
      entities = (parsed.entities ?? []).filter(
        (e) =>
          e.name &&
          ["person", "company"].includes(e.type) &&
          typeof e.confidence === "number" &&
          e.confidence >= 0.85
      );
    } catch {
      return; // malformed JSON — skip silently
    }

    if (entities.length === 0) return;

    const selfEntityId = await ctx.runMutation(
      internal.entities.getOrCreateSelfEntity,
      { userId }
    );

    const now = Date.now();
    for (const entity of entities) {
      const normalizedName = entity.name.trim().toLowerCase();
      const toEntityId = await resolveEntityIdWithFuzzyMatching(ctx, {
        userId,
        name: entity.name.trim(),
        type: entity.type,
        normalizedName,
      });
      await ctx.runMutation(internal.entities.upsertEdge, {
        userId,
        fromEntityId: selfEntityId,
        toEntityId,
        relation: entity.relation,
        validAt: now,
        sessionId,
      });
    }
  },
});
