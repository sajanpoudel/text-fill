import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import { createCompanionLogger } from "../../companion/live-logger.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

describe("live companion logger", () => {
  test("writes structured events to the live log file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "text-fill-live-log-"));
    tempDirs.push(dir);
    const filePath = join(dir, "live.log");
    const logger = createCompanionLogger(filePath);

    logger.event("info", "service", "start_run", {
      runId: "run_123",
      provider: "openai",
      model: "gpt-5-nano",
    });
    logger.log("[python-browser-runtime] runtime started");

    await new Promise((resolve) => setTimeout(resolve, 25));

    const raw = await readFile(filePath, "utf8");
    const entries = raw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(entries[0]).toMatchObject({
      level: "info",
      source: "service",
      event: "start_run",
      payload: {
        runId: "run_123",
        provider: "openai",
        model: "gpt-5-nano",
      },
    });
    expect(entries[1]).toMatchObject({
      level: "info",
      source: "raw",
      event: "log",
      message: "[python-browser-runtime] runtime started",
    });
  });
});
