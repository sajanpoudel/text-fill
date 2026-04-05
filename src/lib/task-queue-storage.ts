export const LEGACY_TASK_QUEUE_KEY = "taskQueue";
export const TASK_QUEUE_ACTIVE_SCOPE_KEY = "taskQueueActiveScope";
export const DEFAULT_TASK_QUEUE_SCOPE = "anonymous";

type QueueScopedTask = {
  batchId?: string;
  type: string;
};

type JwtClaims = {
  tokenIdentifier?: string;
  sub?: string;
};

function decodeBase64Url(segment: string): string | null {
  try {
    const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(
      normalized.length + ((4 - (normalized.length % 4)) % 4),
      "="
    );
    return atob(padded);
  } catch {
    return null;
  }
}

export function parseJwtClaims(token: string | null | undefined): JwtClaims | null {
  if (!token) return null;
  const payloadSegment = token.split(".")[1];
  if (!payloadSegment) return null;
  const decoded = decodeBase64Url(payloadSegment);
  if (!decoded) return null;
  try {
    const parsed = JSON.parse(decoded) as JwtClaims;
    return typeof parsed === "object" && parsed ? parsed : null;
  } catch {
    return null;
  }
}

function encodeScopePart(value: string): string {
  return encodeURIComponent(value.trim()).slice(0, 160);
}

export function deriveTaskQueueScopeFromToken(
  token: string | null | undefined
): string {
  const claims = parseJwtClaims(token);
  const rawScope =
    typeof claims?.tokenIdentifier === "string" && claims.tokenIdentifier.trim()
      ? claims.tokenIdentifier
      : typeof claims?.sub === "string" && claims.sub.trim()
        ? claims.sub
        : null;

  return rawScope ? encodeScopePart(rawScope) : DEFAULT_TASK_QUEUE_SCOPE;
}

export function getTaskQueueStorageKey(scope: string): string {
  return `taskQueue:${scope || DEFAULT_TASK_QUEUE_SCOPE}`;
}

export function getTaskProgressStorageKey(
  scope: string,
  task: QueueScopedTask,
  dayKey = new Date().toISOString().slice(0, 10)
): string {
  return `task-progress:${scope || DEFAULT_TASK_QUEUE_SCOPE}:${task.batchId ?? task.type}:${dayKey}`;
}

export function normalizeStoredTaskQueue<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}
