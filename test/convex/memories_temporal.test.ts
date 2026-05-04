import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../../convex/_generated/api";
import schema from "../../convex/schema";

async function setup() {
  const t = convexTest(schema, import.meta.glob("../../convex/**/*.*s"));
  const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
  const authed = t.withIdentity({ subject: `${userId}|session` });
  return { t, authed, userId };
}

describe("temporal memories", () => {
  test("listActive and getStats exclude invalidated memories", async () => {
    const { t, authed } = await setup();

    const activeResult = await authed.mutation(api.memories.save, {
      text: "I currently work at OpenAI.",
      tags: ["work"],
      platform: "linkedin",
    });
    const oldResult = await authed.mutation(api.memories.save, {
      text: "I currently work at Example Corp.",
      tags: ["work"],
      platform: "linkedin",
    });

    await t.run(async (ctx) => {
      await ctx.db.patch(oldResult.memoryId, {
        invalidAt: Date.now(),
      });
    });

    const active = await authed.query(api.memories.listActive, { limit: 10 });
    const stats = await authed.query(api.memories.getStats, {});

    expect(active).toHaveLength(1);
    expect(active[0]._id).toBe(activeResult.memoryId);
    expect(stats.active).toBe(1);
  });

  test("save persists a memory and it appears in listActive", async () => {
    const { authed } = await setup();

    const result = await authed.mutation(api.memories.save, {
      text: "I am a software engineer with 8 years of experience.",
      tags: ["career"],
      platform: "linkedin",
    });

    expect(result.memoryId).toBeTruthy();

    const active = await authed.query(api.memories.listActive, {});
    expect(active.some((m) => m._id === result.memoryId)).toBe(true);
  });

  test("getStats returns archived count separately from active count", async () => {
    const { t, authed } = await setup();

    const r1 = await authed.mutation(api.memories.save, {
      text: "Fact one that should stay active.",
      platform: "general",
    });
    const r2 = await authed.mutation(api.memories.save, {
      text: "Fact two that will be archived.",
      platform: "general",
    });

    await t.run(async (ctx) => {
      await ctx.db.patch(r2.memoryId, { status: "archived" });
    });

    const stats = await authed.query(api.memories.getStats, {});
    expect(stats.active).toBeGreaterThanOrEqual(1);
    expect(stats.archived).toBeGreaterThanOrEqual(1);
    expect(stats.archived).toBeGreaterThan(0);
  });

  test("invalidated memory is still accessible via listAll", async () => {
    const { t, authed } = await setup();

    const result = await authed.mutation(api.memories.save, {
      text: "I used to work at Example Corp.",
      platform: "linkedin",
    });

    await t.run(async (ctx) => {
      await ctx.db.patch(result.memoryId, { invalidAt: Date.now() });
    });

    const all = await authed.query(api.memories.listAll, { limit: 50 });
    const found = all.find((m) => m._id === result.memoryId);
    expect(found).toBeTruthy();

    const active = await authed.query(api.memories.listActive, {});
    expect(active.find((m) => m._id === result.memoryId)).toBeUndefined();
  });

  test("listActive respects limit parameter", async () => {
    const { authed } = await setup();

    for (let i = 0; i < 5; i++) {
      await authed.mutation(api.memories.save, {
        text: `Memory fact number ${i} about my background.`,
        platform: "general",
      });
    }

    const limited = await authed.query(api.memories.listActive, { limit: 2 });
    expect(limited.length).toBeLessThanOrEqual(2);
  });
});
