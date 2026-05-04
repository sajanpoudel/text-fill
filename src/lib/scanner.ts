// scanner.ts — Proactive opportunity scanner (Phase 7)
//
// ChangeThreshold debounces MutationObserver noise into meaningful "enough has
// changed to re-scan" signals, then dispatches to platform-specific scanners.
// The result is surfaced in App.tsx as the suggestion chip / queue panel.

import { scanLinkedInSearchResults } from "./platforms/linkedin.ts";
import type { LinkedInSearchResult } from "./platforms/linkedin.ts";

// ── ChangeThreshold ───────────────────────────────────────────────────────────

interface ChangeThresholdOptions {
  /** Minimum cumulative DOM additions before triggering an evaluate */
  minChanges?: number;
  /** Debounce window after last mutation before evaluating (ms) */
  debounceMs?: number;
  /** Minimum time between consecutive scans (ms) */
  cooldownMs?: number;
}

export class ChangeThreshold {
  private changeCount = 0;
  private lastScan = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly minChanges: number;
  private readonly debounceMs: number;
  private readonly cooldownMs: number;
  private readonly onTrigger: () => void;

  constructor(onTrigger: () => void, opts: ChangeThresholdOptions = {}) {
    this.onTrigger = onTrigger;
    this.minChanges = opts.minChanges ?? 5;
    this.debounceMs = opts.debounceMs ?? 2000;
    this.cooldownMs = opts.cooldownMs ?? 30_000;
  }

  record(addedNodeCount: number): void {
    this.changeCount += addedNodeCount;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.evaluate(), this.debounceMs);
  }

  private evaluate(): void {
    this.timer = null;
    const now = Date.now();
    if (
      this.changeCount >= this.minChanges &&
      now - this.lastScan > this.cooldownMs
    ) {
      this.lastScan = now;
      this.changeCount = 0;
      this.onTrigger();
    } else {
      this.changeCount = 0;
    }
  }

  /** Force an immediate scan regardless of thresholds */
  forceNow(): void {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    this.lastScan = Date.now();
    this.changeCount = 0;
    this.onTrigger();
  }
}

// ── Platform opportunity dispatchers ──────────────────────────────────────────

export type ScanResult =
  | { platform: "linkedin"; results: LinkedInSearchResult[] }
  | { platform: "none" };

/**
 * Runs the platform-appropriate opportunity scan.
 * Returns a typed result so callers can branch on platform without re-checking.
 */
export function scanForOpportunities(platform: string): ScanResult {
  if (platform === "linkedin") {
    const isSearchPage = window.location.pathname.startsWith("/search/");
    if (!isSearchPage) return { platform: "none" };
    try {
      return { platform: "linkedin", results: scanLinkedInSearchResults() };
    } catch {
      return { platform: "none" };
    }
  }
  // Other platforms (gmail, slack, etc.) — reserved for future phases
  return { platform: "none" };
}
