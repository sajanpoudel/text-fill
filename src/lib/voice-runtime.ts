export const VOICE_RUNTIME_STATES = [
  "idle",
  "starting",
  "listening",
  "stopping",
  "error",
] as const;

export type VoiceRuntimeState = (typeof VOICE_RUNTIME_STATES)[number];

export function normalizeVoiceRuntimeState(
  value: unknown
): VoiceRuntimeState {
  return typeof value === "string" &&
    (VOICE_RUNTIME_STATES as readonly string[]).includes(value)
    ? (value as VoiceRuntimeState)
    : "idle";
}

export function isVoiceRuntimeActive(state: VoiceRuntimeState): boolean {
  return (
    state === "starting" || state === "listening" || state === "stopping"
  );
}
