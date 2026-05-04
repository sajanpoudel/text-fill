import { describe, expect, test } from "vitest";
import {
  isVoiceRuntimeActive,
  normalizeVoiceRuntimeState,
} from "../../../src/lib/voice-runtime.ts";

describe("voice runtime helpers", () => {
  test("normalizes invalid states to idle", () => {
    expect(normalizeVoiceRuntimeState("listening")).toBe("listening");
    expect(normalizeVoiceRuntimeState("bogus")).toBe("idle");
    expect(normalizeVoiceRuntimeState(undefined)).toBe("idle");
  });

  test("treats starting, listening, and stopping as active states", () => {
    expect(isVoiceRuntimeActive("starting")).toBe(true);
    expect(isVoiceRuntimeActive("listening")).toBe(true);
    expect(isVoiceRuntimeActive("stopping")).toBe(true);
    expect(isVoiceRuntimeActive("idle")).toBe(false);
    expect(isVoiceRuntimeActive("error")).toBe(false);
  });

  test("normalizes all valid VOICE_RUNTIME_STATES to themselves", () => {
    const validStates = ["idle", "starting", "listening", "stopping", "error"] as const;
    for (const state of validStates) {
      expect(normalizeVoiceRuntimeState(state)).toBe(state);
    }
  });

  test("normalizes non-string values to idle", () => {
    expect(normalizeVoiceRuntimeState(42)).toBe("idle");
    expect(normalizeVoiceRuntimeState(null)).toBe("idle");
    expect(normalizeVoiceRuntimeState({})).toBe("idle");
    expect(normalizeVoiceRuntimeState(true)).toBe("idle");
  });
});
