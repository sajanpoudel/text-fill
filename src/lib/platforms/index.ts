import type { PlatformExtractor } from "./base.ts";
import { linkedInExtractor } from "./linkedin.ts";
import {
  greenhouseExtractor,
  ashbyExtractor,
  workdayExtractor,
  leverExtractor,
} from "./jobboard.ts";

const REGISTRY: PlatformExtractor[] = [
  linkedInExtractor,
  greenhouseExtractor,
  ashbyExtractor,
  workdayExtractor,
  leverExtractor,
  // Add gmail, slack, outlook, etc. here when platform-specific overrides are needed
];

export function getPlatformExtractor(key: string): PlatformExtractor | null {
  return REGISTRY.find((e) => e.key === key) ?? null;
}
