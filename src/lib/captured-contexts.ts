export type GenerationCapturedContext = {
  id?: string;
  title?: string;
  url?: string;
  hostname?: string;
  text: string;
  time?: number;
  active?: boolean;
};

function normalizeText(value: unknown): string | undefined {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || undefined;
}

function normalizeTime(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function deriveHostname(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

export function normalizeCapturedGenerationContexts(
  value: unknown
): GenerationCapturedContext[] {
  if (!Array.isArray(value)) return [];
  const normalized: Array<GenerationCapturedContext | null> = value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const text = normalizeText((entry as any).text);
      if (!text) return null;
      const url = normalizeText((entry as any).url);
      return {
        id: normalizeText((entry as any).id),
        title: normalizeText((entry as any).title),
        url,
        hostname:
          normalizeText((entry as any).hostname) ?? deriveHostname(url),
        text,
        time:
          normalizeTime((entry as any).time) ??
          normalizeTime((entry as any).capturedAt),
        active:
          typeof (entry as any).active === "boolean"
            ? (entry as any).active
            : typeof (entry as any).isActive === "boolean"
              ? (entry as any).isActive
              : true,
      };
    });

  return normalized.filter((entry): entry is GenerationCapturedContext => {
    return !!entry && entry.active !== false && !!entry.text.trim();
  });
}

function buildContextIdentity(context: GenerationCapturedContext): string {
  return (
    context.id ||
    [
      context.url ?? "",
      context.title ?? "",
      context.text.slice(0, 160),
    ].join("::")
  );
}

export function mergeCapturedGenerationContexts(
  ...groups: Array<GenerationCapturedContext[] | null | undefined>
): GenerationCapturedContext[] {
  const merged: GenerationCapturedContext[] = [];
  const seen = new Set<string>();

  for (const group of groups) {
    for (const context of group ?? []) {
      if (!context?.text?.trim()) continue;
      const identity = buildContextIdentity(context);
      if (seen.has(identity)) continue;
      seen.add(identity);
      merged.push(context);
    }
  }

  return merged;
}
