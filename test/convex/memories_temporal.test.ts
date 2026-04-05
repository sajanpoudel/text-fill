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
});
