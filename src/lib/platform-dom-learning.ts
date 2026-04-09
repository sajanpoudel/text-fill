export type PlatformDomSurface = "linkedin_profile_connect";

export type PlatformDomObservation = {
  surface: PlatformDomSurface;
  finalState: string;
  succeeded: boolean;
  labels: string[];
  pageUrl?: string;
  resolutionPath?: string[];
  observedAt: number;
};

export type PlatformDomLearningState = {
  version: 1;
  history: PlatformDomObservation[];
};

export type PlatformDomHints = {
  preferredLabels: string[];
  avoidedLabels: string[];
};

const MAX_HISTORY = 50;

export function normalizePlatformDomLabels(labels: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const label of labels) {
    const next = label.replace(/\s+/g, " ").trim().toLowerCase();
    if (!next || seen.has(next)) continue;
    seen.add(next);
    normalized.push(next);
  }
  return normalized;
}

export function createEmptyPlatformDomLearningState(): PlatformDomLearningState {
  return {
    version: 1,
    history: [],
  };
}

export function normalizePlatformDomLearningState(
  value: unknown
): PlatformDomLearningState {
  if (!value || typeof value !== "object") {
    return createEmptyPlatformDomLearningState();
  }
  const history = Array.isArray((value as { history?: unknown[] }).history)
    ? (value as { history: unknown[] }).history
    : [];
  const normalizedHistory = history
    .map((entry): PlatformDomObservation | null => {
      if (!entry || typeof entry !== "object") return null;
      const candidate = entry as Partial<PlatformDomObservation>;
      if (candidate.surface !== "linkedin_profile_connect") return null;
      return {
        surface: candidate.surface,
        finalState:
          typeof candidate.finalState === "string"
            ? candidate.finalState
            : "unknown",
        succeeded: candidate.succeeded === true,
        labels: normalizePlatformDomLabels(
          Array.isArray(candidate.labels)
            ? candidate.labels.filter(
                (label): label is string => typeof label === "string"
              )
            : []
        ),
        pageUrl:
          typeof candidate.pageUrl === "string" ? candidate.pageUrl : undefined,
        resolutionPath: Array.isArray(candidate.resolutionPath)
          ? candidate.resolutionPath.filter(
              (label): label is string => typeof label === "string"
            )
          : undefined,
        observedAt:
          typeof candidate.observedAt === "number"
            ? candidate.observedAt
            : Date.now(),
      };
    })
    .filter((entry): entry is PlatformDomObservation => entry !== null)
    .slice(-MAX_HISTORY);

  return {
    version: 1,
    history: normalizedHistory,
  };
}

export function appendPlatformDomObservation(
  state: PlatformDomLearningState,
  observation: Omit<PlatformDomObservation, "labels"> & { labels: string[] }
): PlatformDomLearningState {
  const normalized = normalizePlatformDomLearningState(state);
  const nextEntry: PlatformDomObservation = {
    ...observation,
    labels: normalizePlatformDomLabels(observation.labels),
  };
  return {
    version: 1,
    history: [...normalized.history, nextEntry].slice(-MAX_HISTORY),
  };
}

export function derivePlatformDomHints(
  state: PlatformDomLearningState,
  surface: PlatformDomSurface
): PlatformDomHints {
  const normalized = normalizePlatformDomLearningState(state);
  const positive = new Map<string, number>();
  const negative = new Map<string, number>();

  for (const entry of normalized.history) {
    if (entry.surface !== surface) continue;
    const target = entry.succeeded ? positive : negative;
    for (const label of entry.labels) {
      target.set(label, (target.get(label) ?? 0) + 1);
    }
  }

  const preferredLabels = [...positive.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([label]) => label)
    .slice(0, 12);

  const avoidedLabels = [...negative.entries()]
    .filter(([label, failures]) => failures > (positive.get(label) ?? 0))
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([label]) => label)
    .slice(0, 12);

  return {
    preferredLabels,
    avoidedLabels,
  };
}
