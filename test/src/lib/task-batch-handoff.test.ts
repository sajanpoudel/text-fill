import { describe, expect, test } from "vitest";
import {
  buildQueueTasksFromBatch,
  getTaskIdentity,
  isHydratableBatchStatus,
  mergeApprovedBatchTasks,
  syncQueuedTasksWithBatchDetails,
  type ExecutableTaskBatch,
  type TaskQueueTask,
} from "../../../src/lib/task-batch-handoff.ts";

function makeBatch(overrides?: Partial<ExecutableTaskBatch>): ExecutableTaskBatch {
  return {
    batch: {
      _id: "batch-1",
      batchType: "linkedin_connect",
      status: "approved",
      dailyLimit: 3,
      ...(overrides?.batch ?? {}),
    },
    items: overrides?.items ?? [
      {
        _id: "item-1",
        targetUrl: "https://www.linkedin.com/in/example",
        targetName: "Example Person",
        status: "approved",
        generatedText: "Generated hello",
      },
    ],
  };
}

describe("task batch handoff helpers", () => {
  test("recognizes hydratable batch statuses", () => {
    expect(isHydratableBatchStatus("approved")).toBe(true);
    expect(isHydratableBatchStatus("running")).toBe(true);
    expect(isHydratableBatchStatus("paused")).toBe(false);
    expect(isHydratableBatchStatus("pending")).toBe(false);
  });

  test("builds queue tasks from approved batch items and carries approved text", () => {
    const tasks = buildQueueTasksFromBatch(
      makeBatch({
        items: [
          {
            _id: "item-1",
            targetUrl: "https://www.linkedin.com/in/example",
            targetName: "Example Person",
            status: "approved",
            generatedText: "Generated hello",
            userEditedText: "Edited hello",
          },
          {
            _id: "item-2",
            targetUrl: "https://www.linkedin.com/in/skipped",
            targetName: "Skipped Person",
            status: "sent",
          },
        ],
      })
    );

    expect(tasks).toEqual([
      {
        type: "linkedin_connect",
        targetUrl: "https://www.linkedin.com/in/example",
        targetName: "Example Person",
        batchId: "batch-1",
        itemId: "item-1",
        dailyLimit: 3,
        generatedText: "Generated hello",
        userEditedText: "Edited hello",
      },
    ]);
  });

  test("returns no tasks for non-hydratable batch statuses", () => {
    const tasks = buildQueueTasksFromBatch(
      makeBatch({
        batch: {
          _id: "batch-1",
          batchType: "linkedin_connect",
          status: "paused",
          dailyLimit: 3,
        },
      })
    );

    expect(tasks).toEqual([]);
  });

  test("merges only missing batch tasks into the local queue", () => {
    const existingQueue: TaskQueueTask[] = [
      {
        type: "linkedin_connect",
        targetUrl: "https://www.linkedin.com/in/example",
        batchId: "batch-1",
        itemId: "item-1",
        dailyLimit: 3,
      },
    ];

    const merged = mergeApprovedBatchTasks(
      existingQueue,
      makeBatch({
        items: [
          {
            _id: "item-1",
            targetUrl: "https://www.linkedin.com/in/example",
            targetName: "Example Person",
            status: "approved",
          },
          {
            _id: "item-2",
            targetUrl: "https://www.linkedin.com/in/second",
            targetName: "Second Person",
            status: "approved",
          },
        ],
      })
    );

    expect(merged).toHaveLength(2);
    expect(merged[1]).toMatchObject({
      itemId: "item-2",
      targetName: "Second Person",
    });
  });

  test("uses stable identities for queued items", () => {
    expect(
      getTaskIdentity({
        type: "linkedin_connect",
        targetUrl: "https://www.linkedin.com/in/example",
        itemId: "item-1",
      })
    ).toBe("item:item-1");
    expect(
      getTaskIdentity({
        type: "linkedin_connect",
        targetUrl: "https://www.linkedin.com/in/example",
      })
    ).toBe("fallback:linkedin_connect:https://www.linkedin.com/in/example");
  });

  test("syncs queued tasks with latest batch details and drops paused batch work", () => {
    const synced = syncQueuedTasksWithBatchDetails(
      [
        {
          type: "linkedin_connect",
          targetUrl: "https://www.linkedin.com/in/old",
          targetName: "Old Name",
          batchId: "batch-1",
          itemId: "item-1",
          dailyLimit: 3,
          generatedText: "Old text",
        },
        {
          type: "linkedin_connect",
          targetUrl: "https://www.linkedin.com/in/paused",
          targetName: "Paused Person",
          batchId: "batch-2",
          itemId: "item-2",
          dailyLimit: 1,
        },
      ],
      [
        makeBatch({
          items: [
            {
              _id: "item-1",
              targetUrl: "https://www.linkedin.com/in/new",
              targetName: "New Name",
              status: "approved",
              generatedText: "New text",
              userEditedText: "Edited text",
            },
          ],
        }),
        makeBatch({
          batch: {
            _id: "batch-2",
            batchType: "linkedin_connect",
            status: "paused",
            dailyLimit: 1,
          },
          items: [
            {
              _id: "item-2",
              targetUrl: "https://www.linkedin.com/in/paused",
              targetName: "Paused Person",
              status: "approved",
            },
          ],
        }),
      ]
    );

    expect(synced).toEqual([
      {
        type: "linkedin_connect",
        targetUrl: "https://www.linkedin.com/in/new",
        targetName: "New Name",
        batchId: "batch-1",
        itemId: "item-1",
        dailyLimit: 3,
        generatedText: "New text",
        userEditedText: "Edited text",
        payload: undefined,
      },
    ]);
  });
});
