import { describe, expect, test } from "vitest";
import {
  DEFAULT_TASK_QUEUE_SCOPE,
  deriveTaskQueueScopeFromToken,
  getTaskProgressStorageKey,
  getTaskQueueStorageKey,
  parseJwtClaims,
} from "../../../src/lib/task-queue-storage.ts";

function makeToken(payload: Record<string, unknown>) {
  const encoded = Buffer.from(JSON.stringify(payload))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `header.${encoded}.sig`;
}

describe("task queue storage helpers", () => {
  test("prefers tokenIdentifier when deriving the queue scope", () => {
    const token = makeToken({
      tokenIdentifier: "user|session:123",
      sub: "fallback-subject",
    });

    expect(parseJwtClaims(token)?.tokenIdentifier).toBe("user|session:123");
    expect(deriveTaskQueueScopeFromToken(token)).toContain(
      encodeURIComponent("user|session:123")
    );
  });

  test("falls back to anonymous scope for invalid tokens", () => {
    expect(deriveTaskQueueScopeFromToken("not-a-jwt")).toBe(
      DEFAULT_TASK_QUEUE_SCOPE
    );
    expect(deriveTaskQueueScopeFromToken(null)).toBe(DEFAULT_TASK_QUEUE_SCOPE);
  });

  test("builds user-scoped queue and progress keys", () => {
    expect(getTaskQueueStorageKey("scope-1")).toBe("taskQueue:scope-1");
    expect(
      getTaskProgressStorageKey(
        "scope-1",
        { batchId: "batch-123", type: "linkedin_connect" },
        "2026-04-05"
      )
    ).toBe("task-progress:scope-1:batch-123:2026-04-05");
  });
});
