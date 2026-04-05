export interface TaskQueueTask {
  type: string;
  targetUrl: string;
  targetName?: string;
  batchId?: string;
  itemId?: string;
  dailyLimit?: number;
  generatedText?: string;
  userEditedText?: string;
  payload?: Record<string, unknown>;
}

export interface ExecutableTaskBatch {
  batch: {
    _id: string;
    batchType: string;
    status: string;
    dailyLimit: number;
  };
  items: Array<{
    _id: string;
    targetUrl: string;
    targetName?: string;
    status: string;
    generatedText?: string;
    userEditedText?: string;
  }>;
}

export function isHydratableBatchStatus(status: string): boolean {
  return status === "approved" || status === "running";
}

export function getTaskIdentity(task: TaskQueueTask): string {
  if (typeof task.itemId === "string" && task.itemId) {
    return `item:${task.itemId}`;
  }
  return `fallback:${task.type}:${task.targetUrl}`;
}

export function buildQueueTasksFromBatch(
  batchDetails: ExecutableTaskBatch
): TaskQueueTask[] {
  if (!isHydratableBatchStatus(batchDetails.batch.status)) {
    return [];
  }

  return batchDetails.items
    .filter((item) => item.status === "approved")
    .map((item) => ({
      type: batchDetails.batch.batchType,
      targetUrl: item.targetUrl,
      targetName: item.targetName,
      batchId: batchDetails.batch._id,
      itemId: item._id,
      dailyLimit: batchDetails.batch.dailyLimit,
      generatedText: item.generatedText,
      userEditedText: item.userEditedText,
    }));
}

export function mergeApprovedBatchTasks(
  existingQueue: TaskQueueTask[],
  batchDetails: ExecutableTaskBatch
): TaskQueueTask[] {
  const nextQueue = [...existingQueue];
  const seen = new Set(existingQueue.map(getTaskIdentity));

  for (const task of buildQueueTasksFromBatch(batchDetails)) {
    const identity = getTaskIdentity(task);
    if (seen.has(identity)) {
      continue;
    }
    seen.add(identity);
    nextQueue.push(task);
  }

  return nextQueue;
}

export function syncQueuedTasksWithBatchDetails(
  existingQueue: TaskQueueTask[],
  batchDetailsList: ExecutableTaskBatch[]
): TaskQueueTask[] {
  const managedBatchIds = new Set(batchDetailsList.map((batch) => batch.batch._id));
  const latestTasks = new Map<string, TaskQueueTask>();

  for (const batchDetails of batchDetailsList) {
    for (const task of buildQueueTasksFromBatch(batchDetails)) {
      latestTasks.set(getTaskIdentity(task), task);
    }
  }

  const nextQueue: TaskQueueTask[] = [];

  for (const existingTask of existingQueue) {
    const identity = getTaskIdentity(existingTask);
    const latestTask = latestTasks.get(identity);
    if (latestTask) {
      nextQueue.push({
        ...existingTask,
        ...latestTask,
        payload: existingTask.payload,
      });
      latestTasks.delete(identity);
      continue;
    }

    if (
      (existingTask.batchId && managedBatchIds.has(existingTask.batchId)) ||
      (typeof existingTask.itemId === "string" &&
        Array.from(latestTasks.keys()).some((key) => key === `item:${existingTask.itemId}`))
    ) {
      continue;
    }

    nextQueue.push(existingTask);
  }

  nextQueue.push(...latestTasks.values());
  return nextQueue;
}
