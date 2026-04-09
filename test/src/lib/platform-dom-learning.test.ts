import { describe, expect, test } from "vitest";
import {
  appendPlatformDomObservation,
  createEmptyPlatformDomLearningState,
  derivePlatformDomHints,
  normalizePlatformDomLabels,
  normalizePlatformDomLearningState,
} from "../../../src/lib/platform-dom-learning.ts";

describe("platform dom learning helpers", () => {
  test("normalizes and dedupes labels", () => {
    expect(
      normalizePlatformDomLabels([" Connect ", "connect", "More Actions"])
    ).toEqual(["connect", "more actions"]);
  });

  test("derives preferred and avoided labels from history", () => {
    let state = createEmptyPlatformDomLearningState();
    state = appendPlatformDomObservation(state, {
      surface: "linkedin_profile_connect",
      finalState: "sent",
      succeeded: true,
      labels: ["Connect", "Message", "More"],
      observedAt: 1,
    });
    state = appendPlatformDomObservation(state, {
      surface: "linkedin_profile_connect",
      finalState: "dialog_not_found",
      succeeded: false,
      labels: ["Home", "Jobs", "Me", "More"],
      observedAt: 2,
    });

    expect(derivePlatformDomHints(state, "linkedin_profile_connect")).toEqual({
      preferredLabels: ["connect", "message", "more"],
      avoidedLabels: ["home", "jobs", "me"],
    });
  });

  test("normalizes malformed stored state", () => {
    expect(normalizePlatformDomLearningState(null).history).toEqual([]);
    expect(
      normalizePlatformDomLearningState({
        history: [{ surface: "linkedin_profile_connect", labels: ["Connect"] }],
      }).history[0]?.labels
    ).toEqual(["connect"]);
  });
});
