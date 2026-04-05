import type {
  BrowserCommandResultFor,
  BrowserExecutor,
} from "./browser-executor.ts";
import {
  materializeBrowserCommand,
  type SerializableBrowserCommand,
} from "./browser-command-spec.ts";

export const ACTIVE_AGENT_COMMAND_RELAY_POLL_MS = 1_500;
export const HIDDEN_AGENT_COMMAND_RELAY_POLL_MS = 5_000;

export function getAgentCommandRelayPollMs(documentHidden: boolean): number {
  return documentHidden
    ? HIDDEN_AGENT_COMMAND_RELAY_POLL_MS
    : ACTIVE_AGENT_COMMAND_RELAY_POLL_MS;
}

export function formatAgentRelayExecutorId(tabId: number): string {
  return `service-worker:${tabId}`;
}

export function shouldRunAgentCommandRelay(
  currentWindow: Pick<Window, "self" | "top"> = window
): boolean {
  try {
    return currentWindow.top === currentWindow.self;
  } catch {
    return false;
  }
}

export async function executeSerializableBrowserCommand<
  TCommand extends SerializableBrowserCommand,
>(
  executor: BrowserExecutor,
  command: TCommand
): Promise<BrowserCommandResultFor<ReturnType<typeof materializeBrowserCommand>>> {
  const materialized = materializeBrowserCommand(command);
  return executor.execute(materialized);
}

export function normalizeAgentCommandError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
