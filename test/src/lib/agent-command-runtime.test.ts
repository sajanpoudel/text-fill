import { describe, expect, test, vi } from "vitest";
import {
  ACTIVE_AGENT_COMMAND_RELAY_POLL_MS,
  executeSerializableBrowserCommand,
  formatAgentRelayExecutorId,
  getAgentCommandRelayPollMs,
  HIDDEN_AGENT_COMMAND_RELAY_POLL_MS,
  normalizeAgentCommandError,
  shouldRunAgentCommandRelay,
} from "../../../src/lib/agent-command-runtime.ts";

describe("agent command runtime helpers", () => {
  test("returns shorter poll intervals for visible documents", () => {
    expect(getAgentCommandRelayPollMs(false)).toBe(
      ACTIVE_AGENT_COMMAND_RELAY_POLL_MS
    );
    expect(getAgentCommandRelayPollMs(true)).toBe(
      HIDDEN_AGENT_COMMAND_RELAY_POLL_MS
    );
  });

  test("formats deterministic relay executor ids", () => {
    expect(formatAgentRelayExecutorId(12)).toBe("service-worker:12");
  });

  test("only enables the relay for the top-level browsing context", () => {
    const topFrameWindow = {} as Window;
    (topFrameWindow as any).self = topFrameWindow;
    (topFrameWindow as any).top = topFrameWindow;
    expect(shouldRunAgentCommandRelay(topFrameWindow)).toBe(true);

    const childFrameWindow = { self: {}, top: {} } as Pick<Window, "self" | "top">;
    expect(shouldRunAgentCommandRelay(childFrameWindow)).toBe(false);
  });

  test("disables the relay when window.top access throws", () => {
    const crossOriginWindow = {
      self: {},
      get top() {
        throw new Error("cross-origin");
      },
    } as unknown as Pick<Window, "self" | "top">;
    expect(shouldRunAgentCommandRelay(crossOriginWindow)).toBe(false);
  });

  test("normalizes thrown values into strings", () => {
    expect(normalizeAgentCommandError(new Error("boom"))).toBe("boom");
    expect(normalizeAgentCommandError("raw")).toBe("raw");
  });

  test("materializes and executes serializable commands through the executor", async () => {
    const execute = vi.fn(async (command) => {
      expect(command.kind).toBe("run_script");
      return { kind: "run_script", tabId: 9, result: "sent" };
    });

    const result = await executeSerializableBrowserCommand(
      { execute } as any,
      {
        kind: "run_script",
        tabId: 9,
        scriptKey: "linkedin_fill_and_send_connect_dialog",
        args: ["Hello"],
        world: "MAIN",
      }
    );

    expect(execute).toHaveBeenCalledOnce();
    expect(result).toEqual({ kind: "run_script", tabId: 9, result: "sent" });
  });
});
