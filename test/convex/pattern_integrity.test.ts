import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "../../convex/_generated/api";
import schema from "../../convex/schema";

async function setup() {
  const t = convexTest(schema, import.meta.glob("../../convex/**/*.*s"));
  const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
  return { t, userId };
}

describe("procedural pattern integrity", () => {
  test("new pattern stores support sessions and trigger count", async () => {
    const { t, userId } = await setup();
    const sessionIds = await Promise.all(
      [1, 2, 3].map((i) =>
        t.run(async (ctx) =>
          ctx.db.insert("interactionSessions", {
            userId: userId as any,
            sessionId: crypto.randomUUID(),
            platform: "linkedin",
            contextType: "dm",
            openedAt: Date.now() - i * 1000,
            closedAt: Date.now() - i * 500,
            outcome: "accepted",
            aiGeneratedAt: Date.now() - i * 750,
          })
        )
      )
    );

    await t.mutation(internal.patterns._upsertPattern, {
      userId: userId as any,
      platform: "linkedin",
      contextType: "dm",
      ruleText: "Keep LinkedIn DMs short.",
      supportingSessionIds: sessionIds as any,
    });

    const patterns = await t.run((ctx) => ctx.db.query("proceduralPatterns").collect());
    const supports = await t.run((ctx) => ctx.db.query("patternSupports").collect());
    expect(patterns).toHaveLength(1);
    expect(patterns[0].triggerCount).toBe(3);
    expect(supports).toHaveLength(3);
  });

  test("re-upserting the same supports does not duplicate support rows", async () => {
    const { t, userId } = await setup();
    const sessionId = await t.run(async (ctx) =>
      ctx.db.insert("interactionSessions", {
        userId: userId as any,
        sessionId: crypto.randomUUID(),
        platform: "linkedin",
        contextType: "dm",
        openedAt: Date.now() - 1000,
        closedAt: Date.now(),
        outcome: "accepted",
        aiGeneratedAt: Date.now() - 500,
      })
    );

    const patternId = await t.run(async (ctx) =>
      ctx.db.insert("proceduralPatterns", {
        userId: userId as any,
        platform: "linkedin",
        contextType: "dm",
        ruleText: "Old rule",
        confidence: 0.7,
        triggerCount: 1,
        pendingCount: 0,
        promotedAt: Date.now(),
        lastTriggeredAt: Date.now(),
      })
    );

    await t.mutation(internal.patterns._upsertPattern, {
      userId: userId as any,
      platform: "linkedin",
      contextType: "dm",
      ruleText: "Updated rule",
      patternId,
      supportingSessionIds: [sessionId] as any,
    });
    await t.mutation(internal.patterns._upsertPattern, {
      userId: userId as any,
      platform: "linkedin",
      contextType: "dm",
      ruleText: "Updated rule",
      patternId,
      supportingSessionIds: [sessionId] as any,
    });

    const supports = await t.run((ctx) =>
      ctx.db
        .query("patternSupports")
        .withIndex("by_pattern", (q) => q.eq("patternId", patternId))
        .collect()
    );
    expect(supports).toHaveLength(1);
  });
});
