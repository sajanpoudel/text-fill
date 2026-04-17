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

describe("captured context expiry", () => {
  test("getActive hides expired active context rows", async () => {
    const { t, authed, userId } = await setup();
    const now = Date.now();

    await t.run(async (ctx) => {
      await ctx.db.insert("capturedContexts", {
        userId,
        title: "Expired context",
        url: "https://example.com",
        text: "old data",
        capturedAt: now - 5_000,
        expiresAt: now - 1,
        isActive: true,
      });
    });

    const active = await authed.query(api.context.getActive, {});
    expect(active).toBeNull();
  });

  test("expireActive deactivates expired rows but keeps fresh rows active", async () => {
    const { t, authed, userId } = await setup();
    const now = Date.now();

    const expiredId = await t.run(async (ctx) =>
      ctx.db.insert("capturedContexts", {
        userId,
        title: "Expired context",
        url: "https://expired.example.com",
        text: "expired",
        capturedAt: now - 10_000,
        expiresAt: now - 1,
        isActive: true,
      })
    );

    const freshId = await t.run(async (ctx) =>
      ctx.db.insert("capturedContexts", {
        userId,
        title: "Fresh context",
        url: "https://fresh.example.com",
        text: "fresh",
        capturedAt: now,
        expiresAt: now + 30 * 60 * 1000,
        isActive: true,
      })
    );

    await authed.mutation(api.context.expireActive, {});

    const { expired, fresh } = await t.run(async (ctx) => ({
      expired: await ctx.db.get(expiredId),
      fresh: await ctx.db.get(freshId),
    }));

    expect(expired?.isActive).toBe(false);
    expect(fresh?.isActive).toBe(true);
  });
});
