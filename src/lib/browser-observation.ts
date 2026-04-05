export type BrowserObservationScope = "viewport" | "main" | "dialog";

export type InteractiveElementSnapshot = {
  id: string;
  selector: string;
  tag: string;
  role: string | null;
  type: string | null;
  href: string | null;
  label: string | null;
  text: string | null;
  disabled: boolean;
};

export type AccessibilityNodeSnapshot = {
  tag: string;
  role: string | null;
  label: string | null;
  text: string | null;
  children: AccessibilityNodeSnapshot[];
};

export type StructuredFieldSnapshot = {
  selector: string;
  tag: string;
  type: string | null;
  label: string | null;
  value: string | boolean | string[] | null;
};

export type StructuredDataSnapshot = {
  text: string;
  headings: string[];
  fields: StructuredFieldSnapshot[];
  interactives: InteractiveElementSnapshot[];
};

export type StructuredDataExtractionResult = {
  data: Record<string, string | boolean | string[] | null>;
  matchedFields: string[];
  unmatchedFields: string[];
  headings: string[];
  text: string;
};

type JsonSchemaProperties = Record<string, unknown>;

function normalizeLookupValue(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function buildLookupAliases(propertyName: string): string[] {
  const normalized = normalizeLookupValue(propertyName);
  if (!normalized) return [];
  return uniqueStrings([
    normalized,
    normalized.replace(/\burl\b/g, "link"),
    normalized.replace(/\bfull name\b/g, "name"),
    normalized.replace(/\be-?mail\b/g, "email"),
  ]);
}

function parseSchemaProperties(schema: string): JsonSchemaProperties {
  try {
    const parsed = JSON.parse(schema) as { properties?: JsonSchemaProperties } | null;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    return parsed.properties && typeof parsed.properties === "object"
      ? parsed.properties
      : {};
  } catch {
    return {};
  }
}

function coerceStructuredValue(
  value: StructuredFieldSnapshot["value"]
): string | boolean | string[] | null {
  if (typeof value === "string") {
    const trimmed = value.replace(/\s+/g, " ").trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const normalized = value
      .map((entry) => entry.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    return normalized.length > 0 ? normalized : null;
  }
  return null;
}

function extractValueFromText(text: string, aliases: string[]): string | null {
  for (const alias of aliases) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = text.match(new RegExp(`${escaped}\\s*[:\\-]\\s*([^\\n]+)`, "i"));
    if (match?.[1]) {
      const candidate = match[1].replace(/\s+/g, " ").trim();
      if (candidate) return candidate;
    }
  }
  return null;
}

function findBestFieldMatch(
  fields: StructuredFieldSnapshot[],
  aliases: string[]
): StructuredFieldSnapshot | null {
  let best: { score: number; field: StructuredFieldSnapshot } | null = null;

  for (const field of fields) {
    const haystack = normalizeLookupValue(
      [field.label ?? "", field.selector, field.tag, field.type ?? ""].join(" ")
    );
    if (!haystack) continue;

    let score = 0;
    for (const alias of aliases) {
      if (!alias) continue;
      if (haystack === alias) score += 6;
      else if (haystack.startsWith(alias)) score += 4;
      else if (haystack.includes(alias)) score += 2;
    }

    if (score === 0) continue;
    if (!best || score > best.score) {
      best = { score, field };
    }
  }

  return best?.field ?? null;
}

function fallbackValueForProperty(
  propertyName: string,
  headings: string[],
  text: string
): string | null {
  const normalized = normalizeLookupValue(propertyName);
  if (
    normalized === "title" ||
    normalized === "subject" ||
    normalized === "headline"
  ) {
    return headings[0] ?? null;
  }
  if (normalized === "summary" || normalized === "description") {
    return text.slice(0, 280) || null;
  }
  return null;
}

export function projectStructuredDataFromSnapshot(
  snapshot: StructuredDataSnapshot,
  schema: string,
  _promptHint?: string
): StructuredDataExtractionResult {
  const properties = parseSchemaProperties(schema);
  const propertyNames = Object.keys(properties);
  const data: Record<string, string | boolean | string[] | null> = {};
  const matchedFields: string[] = [];
  const unmatchedFields: string[] = [];
  const normalizedText = snapshot.text.replace(/\s+/g, " ").trim();

  for (const propertyName of propertyNames) {
    const aliases = buildLookupAliases(propertyName);
    const fieldMatch = findBestFieldMatch(snapshot.fields, aliases);
    const matchedValue = fieldMatch ? coerceStructuredValue(fieldMatch.value) : null;

    if (matchedValue !== null) {
      data[propertyName] = matchedValue;
      matchedFields.push(propertyName);
      continue;
    }

    const extractedFromText = extractValueFromText(normalizedText, aliases);
    if (extractedFromText !== null) {
      data[propertyName] = extractedFromText;
      matchedFields.push(propertyName);
      continue;
    }

    const fallback = fallbackValueForProperty(
      propertyName,
      snapshot.headings,
      normalizedText
    );
    if (fallback !== null) {
      data[propertyName] = fallback;
      matchedFields.push(propertyName);
      continue;
    }

    data[propertyName] = null;
    unmatchedFields.push(propertyName);
  }

  return {
    data,
    matchedFields,
    unmatchedFields,
    headings: snapshot.headings,
    text: normalizedText,
  };
}
