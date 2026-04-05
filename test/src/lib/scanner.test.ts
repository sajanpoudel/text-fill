import { describe, expect, test, vi } from "vitest";
import { ChangeThreshold } from "../../../src/lib/scanner.ts";

describe("ChangeThreshold", () => {
  test("triggers once after enough changes and debounce elapses", () => {
    vi.useFakeTimers();
    const onTrigger = vi.fn();
    const threshold = new ChangeThreshold(onTrigger, {
      minChanges: 3,
      debounceMs: 200,
      cooldownMs: 1000,
    });

    threshold.record(1);
    threshold.record(2);
    vi.advanceTimersByTime(199);
    expect(onTrigger).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onTrigger).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  test("does not trigger during cooldown", () => {
    vi.useFakeTimers();
    const onTrigger = vi.fn();
    const threshold = new ChangeThreshold(onTrigger, {
      minChanges: 1,
      debounceMs: 100,
      cooldownMs: 1000,
    });

    threshold.record(1);
    vi.advanceTimersByTime(100);
    expect(onTrigger).toHaveBeenCalledTimes(1);

    threshold.record(1);
    vi.advanceTimersByTime(100);
    expect(onTrigger).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1001);
    threshold.record(1);
    vi.advanceTimersByTime(100);
    expect(onTrigger).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  test("forceNow bypasses thresholds", () => {
    const onTrigger = vi.fn();
    const threshold = new ChangeThreshold(onTrigger, {
      minChanges: 99,
      debounceMs: 1000,
      cooldownMs: 5000,
    });

    threshold.forceNow();
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });
});
