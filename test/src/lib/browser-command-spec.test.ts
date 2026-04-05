import { describe, expect, test } from "vitest";
import {
  commandEnvelopeTargetsTab,
  makeSerializableRunScriptCommand,
  materializeBrowserCommand,
  urlsMatchForCommandRouting,
} from "../../../src/lib/browser-command-spec.ts";

describe("browser command transport helpers", () => {
  test("materializeBrowserCommand maps script keys to executable run_script commands", () => {
    const materialized = materializeBrowserCommand(
      makeSerializableRunScriptCommand(
        42,
        "linkedin_fill_and_send_connect_dialog",
        ["Hello there"]
      )
    );

    expect(materialized).toMatchObject({
      kind: "run_script",
      tabId: 42,
      args: ["Hello there"],
      world: "MAIN",
    });
    expect(materialized.kind).toBe("run_script");
    if (materialized.kind !== "run_script") {
      throw new Error("Expected a run_script command");
    }
    expect(typeof materialized.func).toBe("function");
  });

  test("materializeBrowserCommand passes through serializable non-script commands unchanged", () => {
    const command = {
      kind: "scan_candidates" as const,
      tabId: 42,
      platform: "linkedin" as const,
      maxResults: 5,
      world: "ISOLATED" as const,
    };

    expect(materializeBrowserCommand(command)).toEqual(command);
  });

  test("commandEnvelopeTargetsTab enforces specific_tab routing", () => {
    expect(
      commandEnvelopeTargetsTab(
        {
          runId: "run-1",
          stepId: "step-1",
          commandId: "cmd-1",
          deliveryScope: "specific_tab",
          targetTabId: 7,
          completionEventId: "evt-1",
          command: { kind: "wait", durationMs: 1000 },
        },
        7,
        "https://www.linkedin.com/feed/"
      )
    ).toBe(true);

    expect(
      commandEnvelopeTargetsTab(
        {
          runId: "run-1",
          stepId: "step-1",
          commandId: "cmd-1",
          deliveryScope: "specific_tab",
          targetTabId: 7,
          completionEventId: "evt-1",
          command: { kind: "wait", durationMs: 1000 },
        },
        8,
        "https://www.linkedin.com/feed/"
      )
    ).toBe(false);
  });

  test("commandEnvelopeTargetsTab matches any_attached_tab by target url when present", () => {
    expect(
      commandEnvelopeTargetsTab(
        {
          runId: "run-1",
          stepId: "step-1",
          commandId: "cmd-1",
          deliveryScope: "any_attached_tab",
          targetUrl: "https://www.linkedin.com/in/example",
          completionEventId: "evt-1",
          command: { kind: "wait", durationMs: 1000 },
        },
        4,
        "https://www.linkedin.com/in/example/details/experience/"
      )
    ).toBe(true);

    expect(
      commandEnvelopeTargetsTab(
        {
          runId: "run-1",
          stepId: "step-1",
          commandId: "cmd-1",
          deliveryScope: "any_attached_tab",
          targetUrl: "https://www.linkedin.com/in/example",
          completionEventId: "evt-1",
          command: { kind: "wait", durationMs: 1000 },
        },
        4,
        "https://www.linkedin.com/in/different"
      )
    ).toBe(false);
  });

  test("urlsMatchForCommandRouting tolerates invalid urls and falls back to string equality", () => {
    expect(urlsMatchForCommandRouting("not-a-url", "not-a-url")).toBe(true);
    expect(urlsMatchForCommandRouting("not-a-url", "different")).toBe(false);
  });
});
