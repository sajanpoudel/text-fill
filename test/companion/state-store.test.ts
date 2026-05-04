import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import { CompanionStateStore } from "../../companion/state-store.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) =>
      rm(dir, { recursive: true, force: true }).catch(() => {})
    )
  );
});

describe("CompanionStateStore", () => {
  test("does not share empty cached state across store instances", async () => {
    const dir1 = await mkdtemp(join(tmpdir(), "text-fill-state-store-a-"));
    const dir2 = await mkdtemp(join(tmpdir(), "text-fill-state-store-b-"));
    tempDirs.push(dir1, dir2);

    const store1 = new CompanionStateStore(join(dir1, "state.json"));
    const store2 = new CompanionStateStore(join(dir2, "state.json"));

    await store1.listRuns("user:isolation");
    await store2.listRuns("user:isolation");

    await store1.createRun({
      userScope: "user:isolation",
      goal: "First store should not leak into the second",
      pageUrl: "https://example.com/a",
    });

    const runs1 = await store1.listRuns("user:isolation");
    const runs2 = await store2.listRuns("user:isolation");

    expect(runs1).toHaveLength(1);
    expect(runs2).toHaveLength(0);
  });
});
