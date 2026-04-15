type StructuredSettingsContext = Record<string, unknown> & {
  work?: string;
  social?: string;
  always?: string;
};

function normalizeSectionLabel(key: string): string {
  const normalized = key.replace(/[_-]+/g, " ").trim();
  if (!normalized) return "Additional Context";
  return normalized.replace(/\b\w/g, (char) => char.toUpperCase());
}

export function parseStructuredSettingsContext(
  raw: string | null | undefined
): StructuredSettingsContext | null {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

export function formatSavedSettingsContext(
  raw: string | null | undefined
): string | null {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return null;

  const parsed = parseStructuredSettingsContext(trimmed);
  if (!parsed) {
    return `Saved Settings Context:\n=== General Context ===\n${trimmed}`;
  }

  const preferredOrder = ["work", "social", "always"];
  const sections: string[] = [];
  const handledKeys = new Set<string>();

  for (const key of preferredOrder) {
    const value = parsed[key];
    if (typeof value !== "string" || !value.trim()) continue;
    sections.push(`=== ${normalizeSectionLabel(key)} Context ===\n${value.trim()}`);
    handledKeys.add(key);
  }

  for (const [key, value] of Object.entries(parsed)) {
    if (handledKeys.has(key)) continue;
    if (typeof value !== "string" || !value.trim()) continue;
    sections.push(`=== ${normalizeSectionLabel(key)} Context ===\n${value.trim()}`);
  }

  if (sections.length === 0) {
    return `Saved Settings Context:\n=== General Context ===\n${trimmed}`;
  }

  return `Saved Settings Context:\n${sections.join("\n\n")}`;
}
