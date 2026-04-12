import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "../../convex/_generated/api";
import schema from "../../convex/schema";

async function setup() {
  const t = convexTest(schema, import.meta.glob("../../convex/**/*.*s"));
  const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
  return { t, userId };
}

describe("entity graph", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("getOrCreateSelfEntity is idempotent", async () => {
    const { t, userId } = await setup();
    const first = await t.mutation(internal.entities.getOrCreateSelfEntity, {
      userId: userId as any,
    });
    const second = await t.mutation(internal.entities.getOrCreateSelfEntity, {
      userId: userId as any,
    });
    expect(first).toBe(second);
  });

  test("exclusive works_at edge invalidates prior active edge", async () => {
    const { t, userId } = await setup();
    const selfId = await t.mutation(internal.entities.getOrCreateSelfEntity, {
      userId: userId as any,
    });
    const acmeId = await t.mutation(internal.entities.upsertEntity, {
      userId: userId as any,
      name: "Acme",
      type: "company",
      normalizedName: "acme",
    });
    const globexId = await t.mutation(internal.entities.upsertEntity, {
      userId: userId as any,
      name: "Globex",
      type: "company",
      normalizedName: "globex",
    });

    const firstEdge = await t.mutation(internal.entities.upsertEdge, {
      userId: userId as any,
      fromEntityId: selfId,
      toEntityId: acmeId,
      relation: "works_at",
      validAt: 1000,
    });
    const secondEdge = await t.mutation(internal.entities.upsertEdge, {
      userId: userId as any,
      fromEntityId: selfId,
      toEntityId: globexId,
      relation: "works_at",
      validAt: 2000,
    });

    const firstDoc = (await t.run((ctx) => ctx.db.get(firstEdge))) as
      | { invalidAt?: number }
      | null;
    const secondDoc = (await t.run((ctx) => ctx.db.get(secondEdge))) as
      | { invalidAt?: number }
      | null;

    expect(firstDoc?.invalidAt).toBe(2000);
    expect(secondDoc?.invalidAt).toBeUndefined();
  });

  test("edge supports are deduplicated per edge and session", async () => {
    const { t, userId } = await setup();
    const selfId = await t.mutation(internal.entities.getOrCreateSelfEntity, {
      userId: userId as any,
    });
    const companyId = await t.mutation(internal.entities.upsertEntity, {
      userId: userId as any,
      name: "Acme",
      type: "company",
      normalizedName: "acme",
    });
    const sessionId = await t.run(async (ctx) =>
      ctx.db.insert("interactionSessions", {
        userId: userId as any,
        sessionId: crypto.randomUUID(),
        platform: "linkedin",
        openedAt: Date.now() - 1000,
        closedAt: Date.now(),
        outcome: "accepted",
        aiGeneratedAt: Date.now() - 500,
      })
    );

    const edgeId = await t.mutation(internal.entities.upsertEdge, {
      userId: userId as any,
      fromEntityId: selfId,
      toEntityId: companyId,
      relation: "works_at",
      validAt: Date.now(),
      sessionId,
    });
    await t.mutation(internal.entities.upsertEdge, {
      userId: userId as any,
      fromEntityId: selfId,
      toEntityId: companyId,
      relation: "works_at",
      validAt: Date.now(),
      sessionId,
    });

    const supports = await t.run((ctx) =>
      ctx.db
        .query("edgeSupports")
        .withIndex("by_edge", (q) => q.eq("edgeId", edgeId))
        .collect()
    );
    expect(supports).toHaveLength(1);
  });

  test("resolveEntity deduplicates close company variants via canonical matching", async () => {
    const { t, userId } = await setup();
    const companyId = await t.mutation(internal.entities.upsertEntity, {
      userId: userId as any,
      name: "Acme Inc.",
      type: "company",
      normalizedName: "acme inc.",
    });

    const resolvedId = await t.action(internal.entities.resolveEntity, {
      userId: userId as any,
      name: "Acme Incorporated",
      type: "company",
      normalizedName: "acme incorporated",
    });

    expect(resolvedId).toBe(companyId);
  });

  test("upsertEntity is idempotent — returns the same id on repeated calls with same normalizedName", async () => {
    const { t, userId } = await setup();
    const firstId = await t.mutation(internal.entities.upsertEntity, {
      userId: userId as any,
      name: "Acme Corp",
      type: "company",
      normalizedName: "acme corp",
    });
    const secondId = await t.mutation(internal.entities.upsertEntity, {
      userId: userId as any,
      name: "Acme Corp",
      type: "company",
      normalizedName: "acme corp",
    });
    expect(firstId).toBe(secondId);
  });

  test("non-exclusive knows edges do not invalidate each other", async () => {
    const { t, userId } = await setup();
    const selfId = await t.mutation(internal.entities.getOrCreateSelfEntity, {
      userId: userId as any,
    });
    const personAId = await t.mutation(internal.entities.upsertEntity, {
      userId: userId as any,
      name: "Alice",
      type: "person",
      normalizedName: "alice",
    });
    const personBId = await t.mutation(internal.entities.upsertEntity, {
      userId: userId as any,
      name: "Bob",
      type: "person",
      normalizedName: "bob",
    });

    const edgeAId = await t.mutation(internal.entities.upsertEdge, {
      userId: userId as any,
      fromEntityId: selfId,
      toEntityId: personAId,
      relation: "knows",
      validAt: 1000,
    });
    const edgeBId = await t.mutation(internal.entities.upsertEdge, {
      userId: userId as any,
      fromEntityId: selfId,
      toEntityId: personBId,
      relation: "knows",
      validAt: 2000,
    });

    const edgeADoc = (await t.run((ctx) => ctx.db.get(edgeAId))) as
      | { invalidAt?: number }
      | null;
    const edgeBDoc = (await t.run((ctx) => ctx.db.get(edgeBId))) as
      | { invalidAt?: number }
      | null;

    // Both knows edges should remain active — knows is not exclusive
    expect(edgeADoc?.invalidAt).toBeUndefined();
    expect(edgeBDoc?.invalidAt).toBeUndefined();
  });

  test("resolveEntity stores an embedding row for newly created entities when embeddings are configured", async () => {
    const { t, userId } = await setup();
    await t.run(async (ctx) => {
      await ctx.db.insert("userProfiles", {
        userId: userId as any,
        provider: "openai",
        model: "gpt-4o",
        embeddingProvider: "openai",
        embeddingModel: "text-embedding-3-small",
        openaiKey: "test-key",
      });
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: [{ embedding: Array.from({ length: 1536 }, () => 0.01) }],
        }),
      }))
    );

    const entityId = await t.action(internal.entities.resolveEntity, {
      userId: userId as any,
      name: "Globex",
      type: "company",
      normalizedName: "globex",
    });

    const embeddingRow = await t.run((ctx) =>
      ctx.db
        .query("entityEmbeddings")
        .withIndex("by_entity", (q) => q.eq("entityId", entityId))
        .first()
    );

    expect(embeddingRow?.userId).toBe(userId);
    expect(embeddingRow?.embedding).toHaveLength(1536);
  });
});
