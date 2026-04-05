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

describe("task batches", () => {
  test("createBatch returns batch and item ids for the authenticated user", async () => {
    const { authed, userId } = await setup();
    const result = await authed.mutation(api.tasks.createBatch, {
      batchType: "linkedin_connect",
      dailyLimit: 5,
      items: [
        { targetUrl: "https://www.linkedin.com/in/a", targetName: "A" },
        { targetUrl: "https://www.linkedin.com/in/b", targetName: "B" },
      ],
    });

    expect(result.itemIds).toHaveLength(2);

    const batch = await authed.query(api.tasks.getBatch, { batchId: result.batchId });
    expect(batch?.batch.userId).toBe(userId);
    expect(batch?.items).toHaveLength(2);
  });

  test("updateItemStatus increments completed count only once per terminal item", async () => {
    const { authed } = await setup();
    const { batchId, itemIds } = await authed.mutation(api.tasks.createBatch, {
      batchType: "linkedin_connect",
      dailyLimit: 5,
      items: [{ targetUrl: "https://www.linkedin.com/in/a", targetName: "A" }],
    });

    await authed.mutation(api.tasks.updateItemStatus, {
      itemId: itemIds[0],
      status: "sent",
    });
    await authed.mutation(api.tasks.updateItemStatus, {
      itemId: itemIds[0],
      status: "sent",
    });

    const batch = await authed.query(api.tasks.getBatch, { batchId });
    expect(batch?.batch.completedTasks).toBe(1);
    expect(batch?.batch.status).toBe("done");
  });

  test("attachGeneratedText persists the bounded generated message", async () => {
    const { authed } = await setup();
    const { batchId, itemIds } = await authed.mutation(api.tasks.createBatch, {
      batchType: "linkedin_connect",
      dailyLimit: 5,
      items: [{ targetUrl: "https://www.linkedin.com/in/a", targetName: "A" }],
    });

    await authed.mutation(api.tasks.attachGeneratedText, {
      itemId: itemIds[0],
      generatedText: "Hello there",
    });

    const batch = await authed.query(api.tasks.getBatch, { batchId });
    expect(batch?.items[0].generatedText).toBe("Hello there");
  });

  test("a different authenticated user cannot read or mutate another user's batch", async () => {
    const { t, authed } = await setup();
    const otherUserId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    const otherAuthed = t.withIdentity({ subject: `${otherUserId}|session` });

    const { batchId, itemIds } = await authed.mutation(api.tasks.createBatch, {
      batchType: "linkedin_connect",
      dailyLimit: 5,
      items: [{ targetUrl: "https://www.linkedin.com/in/a", targetName: "A" }],
    });

    await expect(
      otherAuthed.query(api.tasks.getBatch, { batchId })
    ).resolves.toBeNull();

    await expect(
      otherAuthed.mutation(api.tasks.attachGeneratedText, {
        itemId: itemIds[0],
        generatedText: "Not allowed",
      })
    ).rejects.toThrow("Forbidden");

    await expect(
      otherAuthed.mutation(api.tasks.updateItemStatus, {
        itemId: itemIds[0],
        status: "sent",
      })
    ).rejects.toThrow("Forbidden");
  });
});
