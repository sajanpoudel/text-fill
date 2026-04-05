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
});
