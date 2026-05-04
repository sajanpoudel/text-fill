/**
 * Layer 2 — Memory System tests
 *
 * Covers:
 *  - retrieval.getRecentEpisodes
 *  - retrieval.getProceduralPatterns
 *  - patterns.checkPromotion
 *  - patterns._upsertPattern
 *  - patterns.decayConfidence
 *
 * Does NOT test promoteAsync (makes real HTTP/LLM calls).
 * Does NOT test the generate action end-to-end (requires live API key).
 */

import { convexTest } from "convex-test";
import { expect, test, describe, beforeEach, vi, afterEach } from "vitest";
import { internal } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import schema from "../../convex/schema";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Create a minimal test harness and seed a user row, returning userId */
async function setup() {
  const t = convexTest(schema, import.meta.glob("../../convex/**/*.*s"));
  // Insert a bare user row (authTables users table)
  const userId = await t.run(async (ctx) => {
    return await ctx.db.insert("users", {});
  });
  return { t, userId };
}

async function getPattern(
  t: ReturnType<typeof convexTest>,
  patternId: Id<"proceduralPatterns">
): Promise<Doc<"proceduralPatterns"> | null> {
  return t.run(async (ctx) => ctx.db.get(patternId));
}

/** Insert an interactionSession directly for testing */
async function insertSession(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  overrides: Record<string, unknown> = {}
) {
  return t.run(async (ctx) => {
    return await ctx.db.insert("interactionSessions", {
      userId: userId as any,
      sessionId: crypto.randomUUID(),
      platform: "linkedin",
      openedAt: Date.now() - 1000,
      closedAt: Date.now(),
      outcome: "lightly_edited",
      aiGeneratedAt: Date.now() - 500,
      ...overrides,
    });
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// retrieval.getRecentEpisodes
// ═════════════════════════════════════════════════════════════════════════════

describe("retrieval.getRecentEpisodes", () => {
  test("returns empty array when no sessions exist", async () => {
    const { t, userId } = await setup();
    const result = await t.query(internal.retrieval.getRecentEpisodes, {
      userId: userId as any,
      platform: "linkedin",
      limit: 3,
    });
    expect(result).toEqual([]);
  });

  test("filters out abandoned sessions", async () => {
    const { t, userId } = await setup();
    await insertSession(t, userId, { outcome: "abandoned" });
    await insertSession(t, userId, { outcome: "accepted" });

    const result = await t.query(internal.retrieval.getRecentEpisodes, {
      userId: userId as any,
      platform: "linkedin",
      limit: 10,
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("accepted");
  });

  test("respects the limit parameter", async () => {
    const { t, userId } = await setup();
    for (let i = 0; i < 5; i++) {
      await insertSession(t, userId, { outcome: "accepted" });
    }
    const result = await t.query(internal.retrieval.getRecentEpisodes, {
      userId: userId as any,
      platform: "linkedin",
      limit: 2,
    });
    expect(result).toHaveLength(2);
  });

  test("filters by contextType when specified", async () => {
    const { t, userId } = await setup();
    await insertSession(t, userId, { contextType: "dm", outcome: "accepted" });
    await insertSession(t, userId, { contextType: "inmail", outcome: "accepted" });
    await insertSession(t, userId, { outcome: "accepted" }); // no contextType

    const result = await t.query(internal.retrieval.getRecentEpisodes, {
      userId: userId as any,
      platform: "linkedin",
      contextType: "dm",
      limit: 10,
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("accepted");
  });

  test("returns all sessions when contextType is not specified", async () => {
    const { t, userId } = await setup();
    await insertSession(t, userId, { contextType: "dm", outcome: "accepted" });
    await insertSession(t, userId, { contextType: "inmail", outcome: "accepted" });

    const result = await t.query(internal.retrieval.getRecentEpisodes, {
      userId: userId as any,
      platform: "linkedin",
      limit: 10,
    });
    expect(result).toHaveLength(2);
  });

  test("only returns sessions for the specified platform", async () => {
    const { t, userId } = await setup();
    await insertSession(t, userId, { platform: "gmail", outcome: "accepted" });
    await insertSession(t, userId, { platform: "linkedin", outcome: "accepted" });

    const result = await t.query(internal.retrieval.getRecentEpisodes, {
      userId: userId as any,
      platform: "linkedin",
      limit: 10,
    });
    expect(result).toHaveLength(1);
  });

  test("summary includes editFraction as percentage", async () => {
    const { t, userId } = await setup();
    await insertSession(t, userId, {
      outcome: "lightly_edited",
      editFraction: 0.23,
      charDelta: -45,
    });

    const result = await t.query(internal.retrieval.getRecentEpisodes, {
      userId: userId as any,
      platform: "linkedin",
      limit: 1,
    });
    expect(result[0]).toContain("23%");
    expect(result[0]).toContain("shortened");
    expect(result[0]).toContain("45");
  });

  test("summary shows expanded for positive charDelta", async () => {
    const { t, userId } = await setup();
    await insertSession(t, userId, { outcome: "heavily_edited", charDelta: 80 });

    const [summary] = await t.query(internal.retrieval.getRecentEpisodes, {
      userId: userId as any,
      platform: "linkedin",
      limit: 1,
    });
    expect(summary).toContain("expanded");
  });

  test("summary omits editFraction when zero", async () => {
    const { t, userId } = await setup();
    await insertSession(t, userId, { outcome: "accepted", editFraction: 0 });

    const [summary] = await t.query(internal.retrieval.getRecentEpisodes, {
      userId: userId as any,
      platform: "linkedin",
      limit: 1,
    });
    expect(summary).not.toContain("%");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// retrieval.getProceduralPatterns
// ═════════════════════════════════════════════════════════════════════════════

describe("retrieval.getProceduralPatterns", () => {
  async function insertPattern(
    t: ReturnType<typeof convexTest>,
    userId: string,
    overrides: Record<string, unknown> = {}
  ) {
    return t.run(async (ctx) => {
      return ctx.db.insert("proceduralPatterns", {
        userId: userId as any,
        platform: "linkedin",
        ruleText: "Keep it short",
        confidence: 0.8,
        triggerCount: 5,
        pendingCount: 0,
        promotedAt: Date.now(),
        lastTriggeredAt: Date.now(),
        ...overrides,
      });
    });
  }

  test("returns empty when no patterns exist", async () => {
    const { t, userId } = await setup();
    const result = await t.query(internal.retrieval.getProceduralPatterns, {
      userId: userId as any,
      platform: "linkedin",
    });
    expect(result).toEqual([]);
  });

  test("returns rule text for active patterns", async () => {
    const { t, userId } = await setup();
    await insertPattern(t, userId, { ruleText: "Always end with a question" });

    const result = await t.query(internal.retrieval.getProceduralPatterns, {
      userId: userId as any,
      platform: "linkedin",
    });
    expect(result).toContain("Always end with a question");
  });

  test("excludes soft-deleted patterns", async () => {
    const { t, userId } = await setup();
    await insertPattern(t, userId, { deletedAt: Date.now() });

    const result = await t.query(internal.retrieval.getProceduralPatterns, {
      userId: userId as any,
      platform: "linkedin",
    });
    expect(result).toHaveLength(0);
  });

  test("excludes patterns with confidence below 0.3", async () => {
    const { t, userId } = await setup();
    await insertPattern(t, userId, { confidence: 0.2, ruleText: "Low confidence rule" });
    await insertPattern(t, userId, { confidence: 0.5, ruleText: "High confidence rule" });

    const result = await t.query(internal.retrieval.getProceduralPatterns, {
      userId: userId as any,
      platform: "linkedin",
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toBe("High confidence rule");
  });

  test("excludes patterns for other platforms", async () => {
    const { t, userId } = await setup();
    await insertPattern(t, userId, { platform: "gmail" });

    const result = await t.query(internal.retrieval.getProceduralPatterns, {
      userId: userId as any,
      platform: "linkedin",
    });
    expect(result).toHaveLength(0);
  });

  test("includes contextType-specific patterns when contextType matches", async () => {
    const { t, userId } = await setup();
    await insertPattern(t, userId, { contextType: "dm", ruleText: "DM rule" });

    const result = await t.query(internal.retrieval.getProceduralPatterns, {
      userId: userId as any,
      platform: "linkedin",
      contextType: "dm",
    });
    expect(result).toContain("DM rule");
  });

  test("excludes contextType-specific patterns when contextType doesn't match", async () => {
    const { t, userId } = await setup();
    await insertPattern(t, userId, { contextType: "inmail", ruleText: "InMail rule" });

    const result = await t.query(internal.retrieval.getProceduralPatterns, {
      userId: userId as any,
      platform: "linkedin",
      contextType: "dm",
    });
    expect(result).toHaveLength(0);
  });

  test("platform-wide patterns (no contextType) are included even when contextType is specified", async () => {
    const { t, userId } = await setup();
    await insertPattern(t, userId, { ruleText: "Platform-wide rule" }); // no contextType

    const result = await t.query(internal.retrieval.getProceduralPatterns, {
      userId: userId as any,
      platform: "linkedin",
      contextType: "dm",
    });
    expect(result).toContain("Platform-wide rule");
  });

  test("sorts by confidence descending and caps at 5 results", async () => {
    const { t, userId } = await setup();
    for (let i = 1; i <= 7; i++) {
      await insertPattern(t, userId, {
        confidence: i * 0.1,
        ruleText: `Rule with confidence ${i * 0.1}`,
      });
    }

    const result = await t.query(internal.retrieval.getProceduralPatterns, {
      userId: userId as any,
      platform: "linkedin",
    });
    expect(result).toHaveLength(5);
    // First result should be highest confidence
    expect(result[0]).toContain("0.7");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// patterns._upsertPattern
// ═════════════════════════════════════════════════════════════════════════════

describe("patterns._upsertPattern", () => {
  test("creates a new pattern with correct fields", async () => {
    const { t, userId } = await setup();

    await t.mutation(internal.patterns._upsertPattern, {
      userId: userId as any,
      platform: "linkedin",
      ruleText: "Keep DMs under 3 sentences",
    });

    const patterns = await t.run(async (ctx) => {
      return ctx.db.query("proceduralPatterns").collect();
    });
    expect(patterns).toHaveLength(1);
    const p = patterns[0];
    expect(p.ruleText).toBe("Keep DMs under 3 sentences");
    expect(p.platform).toBe("linkedin");
    expect(p.confidence).toBe(0.7);
    expect(p.triggerCount).toBe(0);
    expect(p.pendingCount).toBe(0);
    expect(p.deletedAt).toBeUndefined();
  });

  test("creates a pattern without contextType when omitted", async () => {
    const { t, userId } = await setup();
    await t.mutation(internal.patterns._upsertPattern, {
      userId: userId as any,
      platform: "gmail",
      ruleText: "Platform-wide email rule",
    });

    const [pattern] = await t.run(async (ctx) => ctx.db.query("proceduralPatterns").collect());
    expect(pattern.contextType).toBeUndefined();
  });

  test("updates existing pattern: ruleText, confidence bump, pendingCount reset", async () => {
    const { t, userId } = await setup();

    // Create initial pattern
    const patternId = await t.run(async (ctx) => {
      return ctx.db.insert("proceduralPatterns", {
        userId: userId as any,
        platform: "linkedin",
        ruleText: "Old rule",
        confidence: 0.6,
        triggerCount: 3,
        pendingCount: 5,
        promotedAt: Date.now() - 10000,
        lastTriggeredAt: Date.now() - 5000,
      });
    });

    await t.mutation(internal.patterns._upsertPattern, {
      userId: userId as any,
      platform: "linkedin",
      ruleText: "Updated rule",
      patternId: patternId as any,
    });

    const updated = await getPattern(
      t,
      patternId as Id<"proceduralPatterns">
    );
    expect(updated!.ruleText).toBe("Updated rule");
    expect(updated!.confidence).toBeCloseTo(0.8); // 0.6 + 0.2
    expect(updated!.pendingCount).toBe(0);
  });

  test("caps confidence at 1.0 when bumping", async () => {
    const { t, userId } = await setup();

    const patternId = await t.run(async (ctx) => {
      return ctx.db.insert("proceduralPatterns", {
        userId: userId as any,
        platform: "linkedin",
        ruleText: "High confidence rule",
        confidence: 0.95,
        triggerCount: 10,
        pendingCount: 5,
        promotedAt: Date.now(),
        lastTriggeredAt: Date.now(),
      });
    });

    await t.mutation(internal.patterns._upsertPattern, {
      userId: userId as any,
      platform: "linkedin",
      ruleText: "Still high confidence",
      patternId: patternId as any,
    });

    const updated = await getPattern(
      t,
      patternId as Id<"proceduralPatterns">
    );
    expect(updated!.confidence).toBe(1.0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// patterns.checkPromotion
// ═════════════════════════════════════════════════════════════════════════════

describe("patterns.checkPromotion", () => {
  test("skips abandoned sessions — no effect", async () => {
    const { t, userId } = await setup();
    const sessionRowId = await insertSession(t, userId, { outcome: "abandoned" });

    await t.mutation(internal.patterns.checkPromotion, {
      userId: userId as any,
      platform: "linkedin",
      sessionRowId: sessionRowId as any,
      outcome: "abandoned",
    });

    const patterns = await t.run(async (ctx) => ctx.db.query("proceduralPatterns").collect());
    expect(patterns).toHaveLength(0);
  });

  test("does not promote when fewer than 3 sessions exist", async () => {
    const { t, userId } = await setup();
    await insertSession(t, userId, { outcome: "accepted" });
    const sessionRowId = await insertSession(t, userId, { outcome: "accepted" });

    await t.mutation(internal.patterns.checkPromotion, {
      userId: userId as any,
      platform: "linkedin",
      sessionRowId: sessionRowId as any,
      outcome: "accepted",
    });

    // No promoteAsync should have been scheduled
    const patterns = await t.run(async (ctx) => ctx.db.query("proceduralPatterns").collect());
    expect(patterns).toHaveLength(0);
  });

  test("does not promote when 3+ sessions are all on the same calendar day", async () => {
    const { t, userId } = await setup();
    const sameDay = new Date("2026-01-15T10:00:00Z").getTime();

    for (let i = 0; i < 3; i++) {
      await insertSession(t, userId, {
        outcome: "lightly_edited",
        aiGeneratedAt: sameDay + i * 1000,
        openedAt: sameDay + i * 1000,
      });
    }
    const sessionRowId = await insertSession(t, userId, {
      outcome: "lightly_edited",
      openedAt: sameDay + 5000,
    });

    await t.mutation(internal.patterns.checkPromotion, {
      userId: userId as any,
      platform: "linkedin",
      sessionRowId: sessionRowId as any,
      outcome: "lightly_edited",
    });

    const patterns = await t.run(async (ctx) => ctx.db.query("proceduralPatterns").collect());
    expect(patterns).toHaveLength(0);
  });

  test("increments counts on an existing pattern", async () => {
    const { t, userId } = await setup();

    // Pre-create a pattern
    const patternId = await t.run(async (ctx) => {
      return ctx.db.insert("proceduralPatterns", {
        userId: userId as any,
        platform: "linkedin",
        contextType: "dm",
        ruleText: "Existing rule",
        confidence: 0.7,
        triggerCount: 2,
        pendingCount: 2,
        promotedAt: Date.now(),
        lastTriggeredAt: Date.now(),
      });
    });

    const sessionRowId = await insertSession(t, userId, {
      outcome: "accepted",
      contextType: "dm",
    });

    await t.mutation(internal.patterns.checkPromotion, {
      userId: userId as any,
      platform: "linkedin",
      contextType: "dm",
      sessionRowId: sessionRowId as any,
      outcome: "accepted",
    });

    const updated = await getPattern(
      t,
      patternId as Id<"proceduralPatterns">
    );
    expect(updated!.triggerCount).toBe(3);
    expect(updated!.pendingCount).toBe(3);
  });

  test("links session to existing pattern via patternSupports", async () => {
    const { t, userId } = await setup();

    const patternId = await t.run(async (ctx) => {
      return ctx.db.insert("proceduralPatterns", {
        userId: userId as any,
        platform: "linkedin",
        ruleText: "Existing rule",
        confidence: 0.7,
        triggerCount: 1,
        pendingCount: 1,
        promotedAt: Date.now(),
        lastTriggeredAt: Date.now(),
      });
    });

    const sessionRowId = await insertSession(t, userId, { outcome: "accepted" });

    await t.mutation(internal.patterns.checkPromotion, {
      userId: userId as any,
      platform: "linkedin",
      sessionRowId: sessionRowId as any,
      outcome: "accepted",
    });

    const supports = await t.run(async (ctx) => ctx.db.query("patternSupports").collect());
    expect(supports).toHaveLength(1);
    expect(supports[0].patternId).toBe(patternId);
    expect(supports[0].sessionId).toBe(sessionRowId);
  });

  test("contextType-specific matching: does not increment pattern for different contextType", async () => {
    const { t, userId } = await setup();

    await t.run(async (ctx) => {
      return ctx.db.insert("proceduralPatterns", {
        userId: userId as any,
        platform: "linkedin",
        contextType: "inmail",
        ruleText: "InMail rule",
        confidence: 0.7,
        triggerCount: 1,
        pendingCount: 1,
        promotedAt: Date.now(),
        lastTriggeredAt: Date.now(),
      });
    });

    const sessionRowId = await insertSession(t, userId, {
      outcome: "accepted",
      contextType: "dm", // different contextType
    });

    await t.mutation(internal.patterns.checkPromotion, {
      userId: userId as any,
      platform: "linkedin",
      contextType: "dm",
      sessionRowId: sessionRowId as any,
      outcome: "accepted",
    });

    // Should have no patternSupports (no match found)
    const supports = await t.run(async (ctx) => ctx.db.query("patternSupports").collect());
    expect(supports).toHaveLength(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// patterns.decayConfidence
// ═════════════════════════════════════════════════════════════════════════════

describe("patterns.decayConfidence", () => {
  async function insertActivePattern(
    t: ReturnType<typeof convexTest>,
    userId: string,
    confidence: number,
    lastTriggeredAt: number
  ) {
    return t.run(async (ctx) => {
      return ctx.db.insert("proceduralPatterns", {
        userId: userId as any,
        platform: "linkedin",
        ruleText: "Some rule",
        confidence,
        triggerCount: 3,
        pendingCount: 0,
        promotedAt: Date.now() - 100000,
        lastTriggeredAt,
      });
    });
  }

  test("does NOT decay patterns triggered within 7 days", async () => {
    const { t, userId } = await setup();
    const recentTrigger = Date.now() - 2 * 24 * 60 * 60 * 1000; // 2 days ago
    const id = await insertActivePattern(t, userId, 0.8, recentTrigger);

    await t.mutation(internal.patterns.decayConfidence, {});

    const pattern = await getPattern(t, id as Id<"proceduralPatterns">);
    expect(pattern!.confidence).toBeCloseTo(0.8);
    expect(pattern!.deletedAt).toBeUndefined();
  });

  test("decays confidence by 10% for patterns not triggered in 7+ days", async () => {
    const { t, userId } = await setup();
    const oldTrigger = Date.now() - 10 * 24 * 60 * 60 * 1000; // 10 days ago
    const id = await insertActivePattern(t, userId, 0.8, oldTrigger);

    await t.mutation(internal.patterns.decayConfidence, {});

    const pattern = await getPattern(t, id as Id<"proceduralPatterns">);
    expect(pattern!.confidence).toBeCloseTo(0.72); // 0.8 * 0.9
    expect(pattern!.deletedAt).toBeUndefined();
  });

  test("soft-deletes patterns when decayed confidence drops below 0.1", async () => {
    const { t, userId } = await setup();
    const oldTrigger = Date.now() - 10 * 24 * 60 * 60 * 1000;
    const id = await insertActivePattern(t, userId, 0.09, oldTrigger); // 0.09 * 0.9 = 0.081 < 0.1

    await t.mutation(internal.patterns.decayConfidence, {});

    const pattern = await getPattern(t, id as Id<"proceduralPatterns">);
    expect(pattern!.deletedAt).toBeDefined();
  });

  test("skips already soft-deleted patterns", async () => {
    const { t, userId } = await setup();
    const oldTrigger = Date.now() - 10 * 24 * 60 * 60 * 1000;
    const id = await t.run(async (ctx) => {
      return ctx.db.insert("proceduralPatterns", {
        userId: userId as any,
        platform: "linkedin",
        ruleText: "Already deleted",
        confidence: 0.8,
        triggerCount: 3,
        pendingCount: 0,
        promotedAt: Date.now(),
        lastTriggeredAt: oldTrigger,
        deletedAt: Date.now() - 1000, // already deleted
      });
    });

    await t.mutation(internal.patterns.decayConfidence, {});

    const pattern = await getPattern(t, id as Id<"proceduralPatterns">);
    // confidence should remain 0.8 — filter skipped it
    expect(pattern!.confidence).toBeCloseTo(0.8);
  });

  test("handles patterns with no lastTriggeredAt (treated as 0, i.e. very old)", async () => {
    const { t, userId } = await setup();
    const id = await t.run(async (ctx) => {
      return ctx.db.insert("proceduralPatterns", {
        userId: userId as any,
        platform: "linkedin",
        ruleText: "Never triggered",
        confidence: 0.5,
        triggerCount: 0,
        pendingCount: 0,
        promotedAt: Date.now() - 1000,
        // no lastTriggeredAt
      });
    });

    await t.mutation(internal.patterns.decayConfidence, {});

    const pattern = await getPattern(t, id as Id<"proceduralPatterns">);
    expect(pattern!.confidence).toBeCloseTo(0.45); // 0.5 * 0.9
  });
});
