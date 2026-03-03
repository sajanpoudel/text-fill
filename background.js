const OPENAI_ENDPOINT = "https://api.openai.com/v1/responses";
const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models";

// ── Embedding Infrastructure ───────────────────────────────────────────────────
const EMBED_DIMS = 256;
const SEMANTIC_DEDUP_THRESHOLD = 0.92;
const ARCHIVE_THRESHOLD = 0.60;
const DELETE_THRESHOLD  = 0.85;
const MEMORY_SCHEMA_VERSION = 2;

// Memory caps — each tier has its own limit.
// Storage cost at 700 total: ~1.75MB embeddings + ~560KB metadata = ~2.3MB.
// Chrome's chrome.storage.local limit is 10MB — we are well within it.
const ACTIVE_CAP   = 500;  // active (injectable) memories
const ARCHIVED_CAP = 200;  // archived (faded, kept for reference, not injected)

const ACADEMIC_TAG_HINT_RE = /canvas|assignment|rubric|course/;
const GENERIC_PLATFORM_MEMORY_RE =
  /^(linkedin|gmail|google docs|canvas|facebook|instagram|twitter|x|reddit|discord|slack)$/;
const ACADEMIC_CONTEXT_RE =
  /\bassignment|rubric|discussion prompt|course|instructor|classmate|graded\b/;
const ASSIGNMENT_RESPONSE_RE =
  /\bassignment\b|\brubric\b|\bdiscussion prompt\b|\bthesis\b|\bcitation\b|\bannotated\b|\breflection\b|\bshort answer\b|\bessay\b|\brespond to prompt\b/;
const ACADEMIC_AUDIENCE_RE = /professor|instructor|ta|teacher|rubric|assignment|course|class/;
const SOCIAL_AUDIENCE_PLATFORMS = new Set([
  "messenger",
  "facebook",
  "instagram",
  "threads",
]);
const SUPPORTED_GEMINI_EMBED_MODELS = new Set(["gemini-embedding-001"]);

const normalizeVector = (v) => {
  const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return mag === 0 ? v : v.map((x) => x / mag);
};

const coerceEmbeddingDims = (vec = [], dims = EMBED_DIMS) => {
  if (!Array.isArray(vec) || vec.length === 0) return null;
  const normalizedNums = vec
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x));
  if (normalizedNums.length === 0) return null;
  if (normalizedNums.length === dims) return normalizedNums;
  if (normalizedNums.length > dims) return normalizedNums.slice(0, dims);
  return [...normalizedNums, ...new Array(dims - normalizedNums.length).fill(0)];
};

const dotProduct = (a, b) => {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || !b.length) return 0;
  const len = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < len; i++) dot += a[i] * b[i];
  return dot;
};

const requestGeminiEmbedding = async (apiKey, modelName, text) => {
  const body = {
    model: `models/${modelName}`,
    content: { parts: [{ text: text.slice(0, 1000) }] },
    taskType: "SEMANTIC_SIMILARITY",
    outputDimensionality: EMBED_DIMS,
  };

  const res = await fetch(
    `${GEMINI_ENDPOINT}/${modelName}:embedContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) {
    const payload = await res.text();
    throw new Error(
      `Gemini embedding failed [${res.status}] ${modelName}: ${payload.slice(0, 500)}`
    );
  }
  const data = await res.json();
  const vec =
    data?.embedding?.values ||
    data?.embeddings?.[0]?.values ||
    data?.data?.[0]?.embedding ||
    null;
  const coerced = coerceEmbeddingDims(vec, EMBED_DIMS);
  if (!coerced) {
    throw new Error(
      `Gemini embedding returned invalid vector for model ${modelName}.`
    );
  }
  return normalizeVector(coerced);
};

// Returns a 256-dim pre-normalized vector or throws with a detailed error.
const generateEmbedding = async (text, provider, apiKey, model) => {
  if (!text?.trim()) throw new Error("Embedding text is empty.");
  if (!provider) throw new Error("Embedding provider is not set.");
  if (!apiKey) throw new Error(`Missing API key for ${provider}.`);
  if (!model) throw new Error(`Missing embedding model for ${provider}.`);
  if (provider === "anthropic") {
    throw new Error("Anthropic does not provide embeddings.");
  }

  if (provider === "openai") {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: text.slice(0, 1000),
        dimensions: EMBED_DIMS,
        encoding_format: "float",
      }),
    });
    if (!res.ok) {
      const payload = await res.text();
      throw new Error(
        `OpenAI embedding failed [${res.status}] ${model}: ${payload.slice(0, 500)}`
      );
    }
    const data = await res.json();
    const vec = coerceEmbeddingDims(data?.data?.[0]?.embedding, EMBED_DIMS);
    if (!vec) {
      throw new Error(`OpenAI embedding returned invalid vector for model ${model}.`);
    }
    return normalizeVector(vec);
  }

  if (provider === "gemini") {
    return requestGeminiEmbedding(apiKey, model, text);
  }

  throw new Error(`Unsupported embedding provider: ${provider}`);
};

const resolveEmbeddingConfig = ({
  preferredProvider,
  openaiKey,
  geminiKey,
  openaiEmbeddingModel,
  geminiEmbeddingModel,
}) => {
  const provider = preferredProvider;

  if (!provider) {
    return {
      ok: false,
      provider: null,
      apiKey: null,
      model: null,
      error: "Provider is not configured in settings.",
    };
  }

  if (provider === "anthropic") {
    return {
      ok: false,
      provider: null,
      apiKey: null,
      model: null,
      error:
        "Embeddings are unavailable when active provider is Anthropic. Switch provider to OpenAI or Gemini for embedding/backfill.",
    };
  }

  if (provider === "openai") {
    if (!openaiKey) {
      return {
        ok: false,
        provider: "openai",
        apiKey: null,
        model: null,
        error: "Missing OpenAI API key for embeddings.",
      };
    }
    if (!openaiEmbeddingModel) {
      return {
        ok: false,
        provider: "openai",
        apiKey: openaiKey,
        model: null,
        error: "Missing OpenAI embedding model in settings.",
      };
    }
    return {
      ok: true,
      provider: "openai",
      apiKey: openaiKey,
      model: openaiEmbeddingModel,
      error: null,
    };
  }

  if (provider === "gemini") {
    if (!geminiKey) {
      return {
        ok: false,
        provider: "gemini",
        apiKey: null,
        model: null,
        error: "Missing Gemini API key for embeddings.",
      };
    }
    if (!geminiEmbeddingModel) {
      return {
        ok: false,
        provider: "gemini",
        apiKey: geminiKey,
        model: null,
        error: "Missing Gemini embedding model in settings.",
      };
    }
    if (!SUPPORTED_GEMINI_EMBED_MODELS.has(geminiEmbeddingModel)) {
      return {
        ok: false,
        provider: "gemini",
        apiKey: geminiKey,
        model: geminiEmbeddingModel,
        error:
          `Unsupported Gemini embedding model: ${geminiEmbeddingModel}. Use gemini-embedding-001.`,
      };
    }
    return {
      ok: true,
      provider: "gemini",
      apiKey: geminiKey,
      model: geminiEmbeddingModel,
      error: null,
    };
  }

  return {
    ok: false,
    provider: null,
    apiKey: null,
    model: null,
    error: `Unsupported provider for embeddings: ${provider}`,
  };
};

const withEmbeddingWarning = (result, embedConfig) => {
  if (!embedConfig?.ok && embedConfig?.error) {
    return { ...result, embeddingError: result.embeddingError || embedConfig.error };
  }
  return result;
};

const EMBEDDING_CONFIG_STORAGE_KEYS = [
  "provider",
  "openaiKey",
  "geminiKey",
  "openaiEmbeddingModel",
  "geminiEmbeddingModel",
];

const getEmbeddingConfigFromStorage = async (preferredProvider = null) => {
  const stored = await chrome.storage.local.get(EMBEDDING_CONFIG_STORAGE_KEYS);
  return resolveEmbeddingConfig({
    preferredProvider: preferredProvider || stored.provider,
    openaiKey: stored.openaiKey,
    geminiKey: stored.geminiKey,
    openaiEmbeddingModel: stored.openaiEmbeddingModel,
    geminiEmbeddingModel: stored.geminiEmbeddingModel,
  });
};

const getEmbeddingArgs = (embedConfig) => ({
  provider: embedConfig?.ok ? embedConfig.provider : null,
  apiKey: embedConfig?.ok ? embedConfig.apiKey : null,
  model: embedConfig?.ok ? embedConfig.model : null,
});

const addMemoryWithEmbeddingConfig = (memoryData, embedConfig) => {
  const args = getEmbeddingArgs(embedConfig);
  return addMemory(memoryData, args.provider, args.apiKey, args.model);
};

const getEmbeddingIndex = async () => {
  const { memoryEmbeddings = {} } = await chrome.storage.local.get("memoryEmbeddings");
  return memoryEmbeddings;
};

const setEmbeddingIndex = async (index) => {
  await chrome.storage.local.set({ memoryEmbeddings: index });
};

// Find top-K semantically similar memories. Stored embeddings must be pre-normalized.
const findSimilarMemories = (queryEmbedding, memories, embeddingIndex, topK = 6, threshold = 0) =>
  memories
    .map((m) => {
      const emb = embeddingIndex[m.id];
      if (!emb) return { m, score: 0 };
      return { m, score: dotProduct(queryEmbedding, emb) };
    })
    .filter(({ score }) => score > threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(({ m, score }) => ({ ...m, _similarity: score }));

// ── Memory Storage Layer ──────────────────────────────────────────────────────
// Memory types by category
const MEMORY_CATEGORY_LABELS = {
  work: "Work",
  social: "Social",
  personal: "Personal",
  persona: "Persona",
};

const VALID_MEMORY_CATEGORIES = new Set(["work", "social", "personal", "persona"]);
const WORK_TYPES = new Set([
  "current_role",
  "role",
  "employer",
  "skill",
  "project",
  "job_target",
  "education",
  "graduation_date",
]);
const PERSONAL_TYPES = new Set(["name", "location", "relationship", "graduation_date"]);
const SOCIAL_TYPES = new Set(["interest", "community", "relationship", "hobby"]);
const SINGULAR_MEMORY_TYPES = new Set(["name", "current_role", "location", "graduation_date"]);

const collapseWhitespace = (text = "") => String(text).replace(/\s+/g, " ").trim();

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const uniqueStrings = (values = []) => {
  const out = [];
  const seen = new Set();
  values.forEach((v) => {
    const s = collapseWhitespace(v);
    if (!s) return;
    const key = s.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(s);
  });
  return out;
};

const tokenize = (text = "") =>
  collapseWhitespace(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3);

const tokenOverlapCount = (a = "", b = "") => {
  const sa = new Set(tokenize(a));
  const sb = new Set(tokenize(b));
  let overlap = 0;
  sa.forEach((w) => { if (sb.has(w)) overlap += 1; });
  return overlap;
};

const jaccardSimilarity = (a = "", b = "") => {
  const sa = new Set(tokenize(a));
  const sb = new Set(tokenize(b));
  if (sa.size === 0 && sb.size === 0) return 1;
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  sa.forEach((w) => { if (sb.has(w)) inter += 1; });
  const union = new Set([...sa, ...sb]).size;
  return union > 0 ? inter / union : 0;
};

const normalizeTag = (tag = "") =>
  collapseWhitespace(tag)
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, "")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

const normalizeEntity = (entity = "") =>
  collapseWhitespace(entity)
    .replace(/[^\w\s&.,'/-]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const extractEntitiesFromContent = (content = "") => {
  const entities = [];
  const companyMatch = content.match(/\b(?:at|@)\s+([A-Z][A-Za-z0-9&.,' -]{1,60})/);
  if (companyMatch?.[1]) entities.push(companyMatch[1]);

  const titleCasePhrases =
    content.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2}\b/g) || [];
  titleCasePhrases.forEach((phrase) => {
    if (phrase.length > 2 && phrase.length < 64) entities.push(phrase);
  });

  return uniqueStrings(entities.map(normalizeEntity)).slice(0, 8);
};

const extractTagsFromContent = (content = "", type = "preference") => {
  const lower = content.toLowerCase();
  const tags = [];

  const hashTags = content.match(/#([a-zA-Z0-9_]+)/g) || [];
  hashTags.forEach((t) => tags.push(t.replace("#", "")));

  if (/\bai\b|\bml\b|machine learning|agent/.test(lower)) tags.push("ai");
  if (/full[-\s]?stack|software|engineering|engineer|developer/.test(lower)) {
    tags.push("software_engineering");
  }
  if (/startup|saas|mrr|founder/.test(lower)) tags.push("startup");
  if (/linkedin/.test(lower)) tags.push("linkedin");
  if (/gmail|email/.test(lower)) tags.push("email");
  if (ACADEMIC_TAG_HINT_RE.test(lower)) tags.push("academic");
  if (type) tags.push(type);

  return uniqueStrings(tags.map(normalizeTag).filter(Boolean)).slice(0, 10);
};

const inferMemoryType = (providedType = "", content = "") => {
  const known = collapseWhitespace(providedType).toLowerCase();
  if (known) return known;

  const c = content.toLowerCase();
  if (/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2}$/.test(content)) return "name";
  if (/\bgraduat(?:ing|ion)\b|\bmay\s+\d{4}\b/.test(c)) return "graduation_date";
  if (/\b(?:at|@)\s+[A-Z]/.test(content) || /\bengineer|developer|manager|founder|lead\b/.test(c)) {
    return "current_role";
  }
  if (/\bproject\b|\bbuilt\b|\bbuilding\b|\blaunched\b/.test(c)) return "project";
  if (/\bfriend|knows|met|colleague|mentor\b/.test(c)) return "relationship";
  if (/\bskill|experienced|proficient|expert\b/.test(c)) return "skill";
  if (/\blive|based in|from\b/.test(c)) return "location";
  return "preference";
};

const isLowSignalMemoryContent = (content = "", type = "preference") => {
  const text = collapseWhitespace(content);
  if (!text) return true;
  const tokenCount = tokenize(text).length;
  const lower = text.toLowerCase();

  const genericPlatformOnly = GENERIC_PLATFORM_MEMORY_RE.test(lower);
  if (genericPlatformOnly) return true;

  const genericRoleTemplate = /^(role|position|job)\s+(at|in)\s+[a-z0-9&.,' -]+$/i.test(text);
  if (genericRoleTemplate) return true;

  if (["name", "location", "employer", "graduation_date"].includes(type)) {
    return tokenCount < 1;
  }

  return tokenCount < 2;
};

const inferMemoryCategory = ({ category, type, content, tags, entities, source }) => {
  const normalizedType = collapseWhitespace(type).toLowerCase();
  const normalizedSource = collapseWhitespace(source).toLowerCase();
  const lower = content.toLowerCase();

  if (normalizedType === "writing_style" || normalizedType === "tone" || normalizedType === "voice_pattern") {
    return "persona";
  }
  if (WORK_TYPES.has(normalizedType)) return "work";
  if (SOCIAL_TYPES.has(normalizedType)) return "social";
  if (PERSONAL_TYPES.has(normalizedType)) return "personal";

  if (/\bengineer|developer|software|ai|ml|project|startup|saas|role|position|company|job|career|intern\b/.test(lower)) {
    return "work";
  }
  if (/\bfriend|hobby|community|club|gaming|music|travel|discord|reddit|instagram|facebook\b/.test(lower)) {
    return "social";
  }
  if (/\bname|from|based in|live in|location|graduat(?:ing|ion)|family|relationship|mentor\b/.test(lower)) {
    return "personal";
  }

  const joinedTags = (tags || []).join(" ").toLowerCase();
  if (/job|company|project|skill|engineering|software|startup/.test(joinedTags)) return "work";
  if (/social|community|friend|hobby/.test(joinedTags)) return "social";

  if (normalizedSource.includes("linkedin") || normalizedSource.includes("job")) {
    if (entities?.length && /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2}\b/.test(content)) {
      return "personal";
    }
    return "work";
  }

  if (VALID_MEMORY_CATEGORIES.has(category)) return category;
  return "personal";
};

const sanitizeMemoryInput = (memoryData = {}, sourceHint = "") => {
  const cleanedContent = collapseWhitespace(memoryData.content || "").replace(/[.,;:!?]+$/g, "");
  if (!cleanedContent || cleanedContent.length < 3) return null;

  const type = inferMemoryType(memoryData.type, cleanedContent);
  if (isLowSignalMemoryContent(cleanedContent, type)) return null;
  const entities = uniqueStrings([
    ...((Array.isArray(memoryData.entities) ? memoryData.entities : []).map(normalizeEntity)),
    ...extractEntitiesFromContent(cleanedContent),
  ]).slice(0, 10);

  const tags = uniqueStrings([
    ...((Array.isArray(memoryData.tags) ? memoryData.tags : []).map(normalizeTag)),
    ...extractTagsFromContent(cleanedContent, type),
  ]).filter(Boolean).slice(0, 12);

  const source = collapseWhitespace(memoryData.source || sourceHint || "auto");
  const candidate = {
    ...memoryData,
    content: cleanedContent.slice(0, 200),
    type,
    tags,
    entities,
    source,
    confidence: clamp(Number(memoryData.confidence || 0.85), 0, 1),
    importance: clamp(Number(memoryData.importance || 2), 1, 5),
    related: Array.isArray(memoryData.related) ? uniqueStrings(memoryData.related) : [],
  };

  candidate.category = inferMemoryCategory(candidate);
  if (!VALID_MEMORY_CATEGORIES.has(candidate.category)) candidate.category = "personal";
  if (candidate.category === "persona") {
    candidate.entities = [];
    candidate.tags = uniqueStrings(candidate.tags.filter((t) => !t.includes("company"))).slice(0, 12);
  }

  return candidate;
};

const normalizeExtractedMemories = (rawMemories = [], sourceHint = "") => {
  const out = [];
  const seen = new Set();

  for (const raw of rawMemories) {
    if (!raw || typeof raw !== "object") continue;
    if (typeof raw.confidence !== "number" || raw.confidence < 0.85) continue;

    const normalized = sanitizeMemoryInput(raw, sourceHint);
    if (!normalized) continue;

    const key = [
      normalized.category,
      normalized.type,
      collapseWhitespace(normalized.content).toLowerCase(),
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= 4) break;
  }

  return out;
};

const shouldReplaceContent = (existingContent = "", candidateContent = "") => {
  if (!candidateContent) return false;
  if (!existingContent) return true;
  if (existingContent.toLowerCase() === candidateContent.toLowerCase()) return false;

  const existingScore =
    tokenize(existingContent).length +
    (/\b(?:at|@)\s+[A-Z]/.test(existingContent) ? 2 : 0) +
    (/\d/.test(existingContent) ? 1 : 0);
  const candidateScore =
    tokenize(candidateContent).length +
    (/\b(?:at|@)\s+[A-Z]/.test(candidateContent) ? 2 : 0) +
    (/\d/.test(candidateContent) ? 1 : 0);
  return candidateScore > existingScore;
};

const mergeMemoryFields = (existing, incoming) => {
  const merged = { ...existing };
  if (shouldReplaceContent(existing.content, incoming.content)) {
    merged.content = incoming.content;
  }
  if (!merged.type || merged.type === "preference") merged.type = incoming.type || merged.type;
  merged.tags = uniqueStrings([...(existing.tags || []), ...(incoming.tags || [])]).slice(0, 12);
  merged.entities = uniqueStrings([...(existing.entities || []), ...(incoming.entities || [])]).slice(0, 10);
  merged.related = uniqueStrings([...(existing.related || []), ...(incoming.related || [])]).slice(0, 16);
  merged.importance = Math.max(existing.importance || 2, incoming.importance || 2);
  merged.confidence = Math.max(existing.confidence || 0, incoming.confidence || 0);
  merged.category = inferMemoryCategory({
    ...merged,
    category: incoming.category || existing.category,
  });
  merged.source = incoming.source || existing.source;
  merged.updatedAt = Date.now();
  merged.mentions = (existing.mentions || 1) + 1;
  return merged;
};

const updateRelatedLinks = (memories, memoryId) => {
  const target = memories.find((m) => m.id === memoryId);
  if (!target) return;

  const scored = memories
    .filter((m) => m.id !== memoryId)
    .map((m) => {
      const sharedEntities = (target.entities || []).filter((e) =>
        (m.entities || []).map((x) => x.toLowerCase()).includes(e.toLowerCase())
      ).length;
      const sharedTags = (target.tags || []).filter((t) =>
        (m.tags || []).map((x) => x.toLowerCase()).includes(t.toLowerCase())
      ).length;
      const lexical = jaccardSimilarity(target.content, m.content);
      const sharedType = target.type && m.type && target.type === m.type ? 0.8 : 0;
      const sameSource = target.source && m.source && target.source === m.source ? 0.25 : 0;
      const score = sharedEntities * 3 + sharedTags * 2 + lexical + sharedType + sameSource;
      return { id: m.id, score };
    })
    .filter((x) => x.score >= 1.8)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map((x) => x.id);

  target.related = uniqueStrings([...(target.related || []), ...scored]).slice(0, 12);
  scored.forEach((id) => {
    const rel = memories.find((m) => m.id === id);
    if (!rel) return;
    rel.related = uniqueStrings([...(rel.related || []), memoryId]).slice(0, 12);
  });
};

const isStrongSingularCollision = (a, b) => {
  if (!a || !b) return false;
  if (a.type !== b.type) return false;
  if (!SINGULAR_MEMORY_TYPES.has(a.type)) return false;

  const lexical = jaccardSimilarity(a.content, b.content);
  const overlap = tokenOverlapCount(a.content, b.content);

  if (a.type === "graduation_date") return lexical >= 0.25 || overlap >= 1;
  if (a.type === "name") return lexical >= 0.5 || overlap >= 1;
  return lexical >= 0.4 || overlap >= 2;
};

const getMemories = async () => {
  const { memories = [] } = await chrome.storage.local.get("memories");
  return memories;
};

const saveMemories = async (memories) => {
  await chrome.storage.local.set({ memories });
};

const finiteNumberOr = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const normalizeStoredMemoryRecord = (raw) => {
  if (!raw || typeof raw !== "object") return null;
  const normalized = sanitizeMemoryInput(raw, raw.source || "migration");
  if (!normalized) return null;

  const now = Date.now();
  const createdAt = Math.max(0, finiteNumberOr(raw.createdAt, now));
  const updatedAt = Math.max(createdAt, finiteNumberOr(raw.updatedAt, createdAt));
  const lastAccessedAt = Math.max(createdAt, finiteNumberOr(raw.lastAccessedAt, updatedAt));

  return {
    ...raw,
    ...normalized,
    id: collapseWhitespace(raw.id || `mem_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`),
    mentions: clamp(Math.round(finiteNumberOr(raw.mentions, 1)), 1, 200),
    createdAt,
    updatedAt,
    lastAccessedAt,
    accessCount: clamp(Math.round(finiteNumberOr(raw.accessCount, 0)), 0, 50000),
    sessionsSinceAccess: clamp(
      Math.round(finiteNumberOr(raw.sessionsSinceAccess, 0)),
      0,
      10000
    ),
    tier: raw.tier === "archived" ? "archived" : "active",
    forgetScore: clamp(finiteNumberOr(raw.forgetScore, 0), 0, 1),
    private: Boolean(raw.private),
    related: uniqueStrings(
      Array.isArray(raw.related) ? raw.related : normalized.related || []
    ).slice(0, 12),
  };
};

const mergeStoredMemoryRecords = (existing, incoming) => {
  const merged = { ...existing };
  if (shouldReplaceContent(existing.content, incoming.content)) {
    merged.content = incoming.content;
  }
  if (!merged.type || merged.type === "preference") merged.type = incoming.type || merged.type;

  merged.tags = uniqueStrings([...(existing.tags || []), ...(incoming.tags || [])]).slice(0, 12);
  merged.entities = uniqueStrings([...(existing.entities || []), ...(incoming.entities || [])]).slice(0, 10);
  merged.related = uniqueStrings([...(existing.related || []), ...(incoming.related || [])]).slice(0, 12);
  merged.importance = Math.max(existing.importance || 2, incoming.importance || 2);
  merged.confidence = Math.max(existing.confidence || 0, incoming.confidence || 0);
  merged.category = inferMemoryCategory({ ...merged, category: existing.category || incoming.category });

  if (!merged.source || merged.source === "auto") merged.source = incoming.source || merged.source;
  merged.private = Boolean(existing.private || incoming.private);
  merged.tier = existing.tier === "archived" && incoming.tier === "archived" ? "archived" : "active";
  merged.forgetScore = Math.min(existing.forgetScore || 0, incoming.forgetScore || 0);
  merged.createdAt = Math.min(existing.createdAt || Date.now(), incoming.createdAt || Date.now());
  merged.updatedAt = Math.max(existing.updatedAt || 0, incoming.updatedAt || 0);
  merged.lastAccessedAt = Math.max(existing.lastAccessedAt || 0, incoming.lastAccessedAt || 0);
  merged.accessCount = (existing.accessCount || 0) + (incoming.accessCount || 0);
  merged.sessionsSinceAccess = Math.min(
    finiteNumberOr(existing.sessionsSinceAccess, 0),
    finiteNumberOr(incoming.sessionsSinceAccess, 0)
  );
  merged.mentions = clamp((existing.mentions || 1) + (incoming.mentions || 1), 1, 500);
  return merged;
};

const runMemoryStoreMaintenance = async (force = false) => {
  const { memorySchemaVersion = 0 } = await chrome.storage.local.get("memorySchemaVersion");
  if (!force && memorySchemaVersion >= MEMORY_SCHEMA_VERSION) {
    return { ran: false, changed: false, memories: await getMemories(), stats: null };
  }

  const memories = await getMemories();
  const embeddingIndex = await getEmbeddingIndex();
  const repaired = [];
  const idRemap = new Map();
  let changed = false;
  let mergedCount = 0;
  let droppedCount = 0;

  for (const raw of memories) {
    const normalized = normalizeStoredMemoryRecord(raw);
    const rawId = raw?.id;
    if (!normalized) {
      droppedCount += 1;
      if (rawId && embeddingIndex[rawId]) {
        delete embeddingIndex[rawId];
        changed = true;
      }
      continue;
    }

    const matchIdx = repaired.findIndex(
      (m) =>
        isDuplicateMemory(m, normalized) ||
        isStrongSingularCollision(m, normalized)
    );

    if (matchIdx >= 0) {
      const canonicalId = repaired[matchIdx].id;
      if (normalized.id !== canonicalId) {
        idRemap.set(normalized.id, canonicalId);
        if (embeddingIndex[normalized.id] && !embeddingIndex[canonicalId]) {
          embeddingIndex[canonicalId] = embeddingIndex[normalized.id];
        }
        if (embeddingIndex[normalized.id]) delete embeddingIndex[normalized.id];
      }
      repaired[matchIdx] = mergeStoredMemoryRecords(repaired[matchIdx], normalized);
      repaired[matchIdx].id = canonicalId;
      mergedCount += 1;
      changed = true;
      continue;
    }

    repaired.push(normalized);
    if (rawId && rawId !== normalized.id) {
      idRemap.set(rawId, normalized.id);
      if (embeddingIndex[rawId] && !embeddingIndex[normalized.id]) {
        embeddingIndex[normalized.id] = embeddingIndex[rawId];
      }
      if (embeddingIndex[rawId]) delete embeddingIndex[rawId];
      changed = true;
    }
  }

  const validIds = new Set(repaired.map((m) => m.id));
  Object.keys(embeddingIndex).forEach((id) => {
    if (!validIds.has(id)) {
      delete embeddingIndex[id];
      changed = true;
    }
  });

  repaired.forEach((m) => {
    const remapped = uniqueStrings(
      (m.related || [])
        .map((id) => idRemap.get(id) || id)
        .filter((id) => id && id !== m.id && validIds.has(id))
    ).slice(0, 12);
    if (JSON.stringify(remapped) !== JSON.stringify(m.related || [])) changed = true;
    m.related = remapped;
  });
  repaired.forEach((m) => updateRelatedLinks(repaired, m.id));

  if (changed || repaired.length !== memories.length) {
    await saveMemories(repaired);
    await setEmbeddingIndex(embeddingIndex);
  }

  await chrome.storage.local.set({
    memorySchemaVersion: MEMORY_SCHEMA_VERSION,
    lastMemoryMaintenance: Date.now(),
  });

  return {
    ran: true,
    changed: changed || repaired.length !== memories.length,
    memories: repaired,
    stats: {
      before: memories.length,
      after: repaired.length,
      merged: mergedCount,
      dropped: droppedCount,
    },
  };
};

// Deduplicate check: same category + high semantic/lexical overlap
const isDuplicateMemory = (existing, candidate) => {
  if (existing.category !== candidate.category) return false;
  const ex = collapseWhitespace(existing.content).toLowerCase();
  const ca = collapseWhitespace(candidate.content).toLowerCase();
  if (!ex || !ca) return false;
  if (ex === ca) return true;
  if (ex.includes(ca) || ca.includes(ex)) return true;

  const lexical = jaccardSimilarity(existing.content, candidate.content);
  const overlap = tokenOverlapCount(existing.content, candidate.content);
  if (candidate.category === "persona") return lexical >= 0.45 || overlap >= 3;

  const existingEntities = (existing.entities || []).map((e) => e.toLowerCase());
  const candidateEntities = (candidate.entities || []).map((e) => e.toLowerCase());
  const entityOverlap = candidateEntities.some((e) => existingEntities.includes(e));

  if (existing.type && candidate.type && existing.type === candidate.type && lexical >= 0.45) {
    return true;
  }
  if (entityOverlap && (lexical >= 0.28 || overlap >= 2)) return true;
  return lexical >= 0.7;
};

// Forgetting score (0 = keep forever, 1 = delete immediately).
// Stability grows with each mention — spaced-repetition-inspired (doubles every ~3 reinforcements).
// Persona memories: always score 0 (never auto-archived or deleted).
const computeForgetScore = (memory) => {
  if (memory.category === "persona") return 0;
  const now = Date.now();
  const daysSinceUpdate = (now - (memory.updatedAt || memory.createdAt || now)) / 86400000;
  const daysSinceAccess = (now - (memory.lastAccessedAt || memory.createdAt || now)) / 86400000;

  // Stability: base 7 days, multiplied by 1.8 per mention (capped at 10 mentions)
  const stability = 7 * Math.pow(1.8, Math.min(memory.mentions || 1, 10) - 1);
  const updateRetention = Math.exp(-daysSinceUpdate / stability);
  const accessRetention = Math.exp(-daysSinceAccess / (stability * 1.5));
  const retention = updateRetention * 0.4 + accessRetention * 0.6;

  const importanceShield = (memory.importance || 2) / 5;
  const sessionPenalty   = Math.min((memory.sessionsSinceAccess || 0) / 20, 1.0);
  const contradictionBoost = memory.contradictedBy ? 0.5 : 0;

  const rawForget = (1 - retention) * (1 - importanceShield * 0.7) + sessionPenalty * 0.3;
  return Math.min(1, rawForget + contradictionBoost);
};

// addMemory supports optional semantic dedup via embeddings.
// If embedding generation fails, memory save still proceeds and returns embeddingError.
const addMemory = async (memoryData, provider = null, apiKey = null, embedModel = null) => {
  const memories = await getMemories();
  const embeddingIndex = await getEmbeddingIndex();
  const sanitized = sanitizeMemoryInput(memoryData, memoryData?.source || "auto");
  if (!sanitized) return { action: "skipped", id: null, embeddingError: null };
  memoryData = sanitized;

  // Step 1: Generate embedding for candidate
  let candidateEmbedding = null;
  let embeddingError = null;
  if (provider && apiKey && embedModel) {
    try {
      candidateEmbedding = await generateEmbedding(
        memoryData.content,
        provider,
        apiKey,
        embedModel
      );
    } catch (err) {
      embeddingError = err?.message || String(err);
    }
  }

  // Step 2: Semantic dedup — reinforce instead of adding near-duplicate
  if (candidateEmbedding) {
    const similar = findSimilarMemories(
      candidateEmbedding, memories, embeddingIndex, 3, SEMANTIC_DEDUP_THRESHOLD
    );
    if (similar.length > 0) {
      const match = similar[0];
      const idx = memories.findIndex((m) => m.id === match.id);
      if (idx >= 0) {
        memories[idx] = mergeMemoryFields(memories[idx], memoryData);
        if (candidateEmbedding) {
          embeddingIndex[memories[idx].id] = candidateEmbedding;
          await setEmbeddingIndex(embeddingIndex);
        }
        updateRelatedLinks(memories, memories[idx].id);
        await saveMemories(memories);
        return { action: "reinforced", id: match.id, embeddingError };
      }
    }
  }

  // Step 3: Keyword dedup fallback (belt + suspenders)
  const existing = memories.find((m) => isDuplicateMemory(m, memoryData));
  if (existing) {
    const idx = memories.findIndex((m) => m.id === existing.id);
    if (idx >= 0) {
      memories[idx] = mergeMemoryFields(memories[idx], memoryData);
      if (candidateEmbedding) {
        embeddingIndex[memories[idx].id] = candidateEmbedding;
        await setEmbeddingIndex(embeddingIndex);
      }
      updateRelatedLinks(memories, memories[idx].id);
    }
    await saveMemories(memories);
    return { action: "reinforced", id: existing.id, embeddingError };
  }

  // Step 3.5: For singular facts, upsert instead of creating noisy duplicates.
  // Allow cross-category correction (e.g., misfiled name/current_role).
  if (SINGULAR_MEMORY_TYPES.has(memoryData.type)) {
    const sameTypeIdx = memories.findIndex(
      (m) =>
        m.tier !== "archived" &&
        isStrongSingularCollision(m, memoryData)
    );
    if (sameTypeIdx >= 0) {
      memories[sameTypeIdx] = mergeMemoryFields(memories[sameTypeIdx], memoryData);
      if (candidateEmbedding) {
        embeddingIndex[memories[sameTypeIdx].id] = candidateEmbedding;
        await setEmbeddingIndex(embeddingIndex);
      }
      updateRelatedLinks(memories, memories[sameTypeIdx].id);
      await saveMemories(memories);
      return { action: "updated", id: memories[sameTypeIdx].id, embeddingError };
    }
  }

  // Step 4: New memory — add with full schema
  const newMemory = {
    id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    mentions: 1,
    createdAt:          Date.now(),
    updatedAt:          Date.now(),
    lastAccessedAt:     Date.now(),
    accessCount:        0,
    sessionsSinceAccess: 0,
    tier:               "active",
    forgetScore:        0,
    private:            false,
    related:            [],
    ...memoryData,
  };
  memories.push(newMemory);
  updateRelatedLinks(memories, newMemory.id);

  // Store embedding separately so the memories array stays lean
  if (candidateEmbedding) {
    embeddingIndex[newMemory.id] = candidateEmbedding;
    await setEmbeddingIndex(embeddingIndex);
  }

  // ── Eviction when active cap is hit ─────────────────────────────────────────
  // Sort ASCENDING by forgetScore so index 0 = most valuable (keep these).
  // Evict from the tail: high-importance ones get archived (second chance),
  // low-importance ones are hard-deleted to free space.
  const activeMemories = memories.filter((m) => m.tier !== "archived");
  if (activeMemories.length > ACTIVE_CAP) {
    // Sort ascending: lowest forgetScore (most valuable) first
    activeMemories.sort((a, b) => computeForgetScore(a) - computeForgetScore(b));
    const keep    = activeMemories.slice(0, ACTIVE_CAP);  // keep up to cap
    const toEvict = activeMemories.slice(ACTIVE_CAP);     // evict the rest

    const newlyArchived = [];
    toEvict.forEach((m) => {
      if ((m.importance || 2) >= 3) {
        // Worth keeping — demote to archived instead of deleting
        newlyArchived.push({ ...m, tier: "archived" });
      } else {
        // Low value — hard delete + remove embedding
        delete embeddingIndex[m.id];
      }
    });

    // Merge archived + newlyArchived; trim if archived cap is also exceeded
    let archived = memories.filter((m) => m.tier === "archived").concat(newlyArchived);
    if (archived.length > ARCHIVED_CAP) {
      archived.sort(
        (a, b) =>
          (b.importance || 2) * Math.log(1 + (b.mentions || 1)) -
          (a.importance || 2) * Math.log(1 + (a.mentions || 1))
      );
      archived.slice(ARCHIVED_CAP).forEach((m) => delete embeddingIndex[m.id]);
      archived = archived.slice(0, ARCHIVED_CAP);
    }

    memories.length = 0;
    memories.push(...keep, ...archived);
    await setEmbeddingIndex(embeddingIndex);
  }

  await saveMemories(memories);
  return { action: "added", id: newMemory.id, embeddingError };
};

// getRelevantMemories: semantic retrieval only (no keyword fallback).
// Only "active" tier memories are considered — archived memories are excluded.
const isAcademicContext = (platformKey = "", text = "") =>
  platformKey === "canvas" || ACADEMIC_CONTEXT_RE.test((text || "").toLowerCase());

const shouldSuppressContextualMemory = (platformKey = "", pageContextText = "") => {
  return isAcademicContext(platformKey, pageContextText);
};

const getRelevantMemories = async (
  platformKey,
  pageContextText = "",
  provider = null,
  apiKey = null,
  embedModel = null
) => {
  const memories = await getMemories();
  const active = memories.filter((m) => !m.private && m.tier !== "archived");

  // Persona = user's writing DNA — always injected, never scored out
  const persona = active.filter((m) => m.category === "persona");
  const nonPersona = active.filter((m) => m.category !== "persona");

  if (shouldSuppressContextualMemory(platformKey, pageContextText)) {
    return { persona, contextual: [], embeddingError: null };
  }

  if (!pageContextText?.trim()) {
    return { persona, contextual: [], embeddingError: null };
  }

  if (!provider || !apiKey || !embedModel) {
    return {
      persona,
      contextual: [],
      embeddingError: "Embeddings not configured for memory retrieval.",
    };
  }

  const embeddingIndex = await getEmbeddingIndex();
  let queryEmbedding;
  try {
    queryEmbedding = await generateEmbedding(
      pageContextText.slice(0, 500),
      provider,
      apiKey,
      embedModel
    );
  } catch (err) {
    return {
      persona,
      contextual: [],
      embeddingError: err?.message || String(err),
    };
  }

  const contextual = nonPersona
    .filter((m) => embeddingIndex[m.id])
    .map((m) => {
      const emb = embeddingIndex[m.id];
      const semanticScore = dotProduct(queryEmbedding, emb);
      const importanceBoost = (m.importance || 2) / 5;
      const recency = Math.exp(
        -(Date.now() - (m.updatedAt || m.createdAt)) / (86400000 * 60)
      );
      return { m, score: semanticScore * 0.6 + importanceBoost * 0.25 + recency * 0.15 };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map(({ m }) => m);

  return { persona, contextual, embeddingError: null };
};

// Format the persona voice block — goes into the system prompt
const formatPersonaVoice = (persona) => {
  if (!persona.length) return null;
  const lines = persona.map((m) => `- ${m.content}`);
  return `The user's voice & style — internalize completely, do not mention:\n${lines.join("\n")}`;
};

// Format contextual facts — go into user parts
const formatContextualMemories = (contextual) => {
  if (!contextual.length) return null;
  const lines = contextual.map((m) => {
    const cat = MEMORY_CATEGORY_LABELS[m.category] || m.category;
    return `[${cat}] ${m.content}`;
  });
  return `=== Known Context ===\n${lines.join("\n")}`;
};

// Which context types to pull in for each platform.
// Users store Career, Social, and Always-active info separately —
// only the relevant ones are sent to the AI based on the current site.
const PLATFORM_CONTEXTS = {
  gmail:           ["work", "always"],
  linkedin:        ["work", "social", "always"],
  twitter:         ["social", "always"],
  facebook:        ["social", "always"],
  messenger:       ["social", "always"],
  reddit:          ["social", "always"],
  youtube:         ["social", "always"],
  instagram:       ["social", "always"],
  threads:         ["social", "always"],
  slack:           ["work", "always"],
  discord:         ["social", "always"],
  notion:          ["work", "always"],
  google_docs:     ["work", "always"],
  canvas:          [],
  job_application: ["work", "always"],
  general:         ["work", "social", "always"],
};

const buildContextBlock = (platformKey, { workContext, socialContext, alwaysContext }) => {
  const keys = PLATFORM_CONTEXTS[platformKey] || PLATFORM_CONTEXTS.general;
  const parts = [];
  if (keys.includes("work") && workContext?.trim()) {
    parts.push(`=== Career & Work ===\n${workContext.trim()}`);
  }
  if (keys.includes("social") && socialContext?.trim()) {
    parts.push(`=== Social & Personal ===\n${socialContext.trim()}`);
  }
  if (keys.includes("always") && alwaysContext?.trim()) {
    parts.push(`=== General (always active) ===\n${alwaysContext.trim()}`);
  }
  return parts.join("\n\n") || null;
};

// Domain-aware writing profiles — automatically applied based on the site
const PLATFORM_PROFILES = {
  gmail: {
    name: "Gmail",
    instructions:
      "You are writing an email in Gmail. Be professional yet personable. Be humane and genuine when needed. Match the conversation thread tone. Keep emails clear and concise. Use appropriate greeting and sign-off when the context calls for it.",
  },
  linkedin: {
    name: "LinkedIn",
    instructions:
      "You are writing on LinkedIn. Be authentic and genuinely human. For posts: insightful, genuine, thought-provoking. For comments: thoughtful and additive. Never sound like a corporate account or a recruiter template.",
  },
  twitter: {
    name: "Twitter/X",
    instructions:
      "You are writing a tweet. Be punchy, genuine, and worth reading. 280 character limit — keep it tight. Say something worth saying. Authentic voice. No forced hashtags. No corporate fluff.",
    maxLength: 280,
  },
  facebook: {
    name: "Facebook",
    instructions:
      "You are writing on Facebook. Match the social, casual tone. Be genuine, warm, and personal.",
  },
  messenger: {
    name: "Messenger",
    instructions:
      "You are writing a chat message. Be casual and conversational. Match the thread tone naturally — like texting a friend. Keep it short unless the context calls for more.",
  },
  reddit: {
    name: "Reddit",
    instructions:
      "You are writing a Reddit post or comment. Match the subreddit community tone. Be genuine, informative, and add real value. Be direct — Reddit readers spot BS quickly.",
  },
  youtube: {
    name: "YouTube",
    instructions:
      "You are writing a YouTube comment. Be genuine and relevant to the video content. Add something worthwhile to the discussion.",
  },
  instagram: {
    name: "Instagram",
    instructions:
      "You are writing an Instagram comment or caption. Be engaging, authentic, and visually vivid. Keep it punchy.",
  },
  threads: {
    name: "Threads",
    instructions:
      "You are writing a Threads post or reply. Be casual, authentic, and conversational.",
  },
  slack: {
    name: "Slack",
    instructions:
      "You are writing a Slack message. Professional yet casual work communication. Be clear, concise, and actionable.",
  },
  discord: {
    name: "Discord",
    instructions:
      "You are writing a Discord message. Match the server and channel tone. Be genuine and community-appropriate.",
  },
  notion: {
    name: "Notion",
    instructions:
      "You are writing in Notion. Be clear, well-structured, and useful. Match the document context.",
  },
  google_docs: {
    name: "Google Docs",
    instructions:
      "You are writing in Google Docs. Be clear, professional, and appropriate for the document context.",
  },
  canvas: {
    name: "Canvas LMS",
    instructions:
      "You are writing for a class assignment or discussion in Canvas. Follow the prompt and rubric exactly. Prioritize clarity, structure, and evidence. Use the requested academic tone and citation style when specified.",
  },
  job_application: {
    name: "Job Application",
    instructions:
      "You are writing a job application response. Be professional and specific. Draw clear connections between experience and job requirements. Use concrete examples with measurable outcomes when possible. Sound genuinely human — avoid 'I am excited to', 'leveraged', 'spearheaded', 'passionate about'. Be confident without being arrogant. Start directly without any preamble.",
  },
  general: {
    name: "General",
    instructions:
      "You are a writing assistant. Adapt your tone to what the context calls for — professional for formal contexts, conversational for casual ones, concise for quick replies, detailed for complex questions.",
  },
};

// ─── Field-Type Classification ─────────────────────────────────────────────────

// Classify what kind of response a field expects based on its label/question text
// and structural hints (size, maxLength). Returns a type key used to inject
// targeted writing guidance into the prompt.
const classifyFieldType = (
  question = "",
  fieldHints = {},
  platformKey = "general",
  contextPack = null
) => {
  const q = question.toLowerCase();
  const labels = (fieldHints.nearbyLabels || []).join(" ").toLowerCase();
  const assignmentSignals = contextPack?.assignmentContext
    ? contextPack.assignmentContext.toLowerCase().slice(0, 1200)
    : "";
  const text = `${q} ${labels} ${assignmentSignals}`;

  if (/cover letter|motivation letter/.test(text)) return "cover_letter";
  if (/tell me about a time|describe a (situation|time|moment)|give (me )?an example|star (method|format)/.test(text)) return "behavioral";
  if (/why (do you want|are you (interested|applying|excited)|this (role|position|company|job|team|opportunity))|what (drew|attracted) you/.test(text)) return "why_role";
  if (/where do you see yourself|career goal|5.year|five.year|long.term|short.term goal|aspiration/.test(text)) return "goals_ambition";
  if (/\bstrength(s)?\b|what (are you|makes you) good|best qualit|proud of|\bexcel\b/.test(text)) return "strengths";
  if (/\bweakness(es)?\b|area(s)? (for|of) improvement|\bfailure\b|\bmistake\b|overcome|struggle/.test(text)) return "challenges";
  if (/what (will|would|can) you bring|how (will|would) you contribute|value you (add|bring)|your impact/.test(text)) return "contribution";
  if (/experience|background|qualif|worked (with|on|at)|expertise|\bskill(s)?\b/.test(text)) return "skills_experience";
  if (/about (you|yourself)|\bbio\b|\bsummary\b|\bheadline\b|introduce yourself|who are you/.test(text)) return "bio_summary";
  if (ASSIGNMENT_RESPONSE_RE.test(text)) {
    return "assignment_response";
  }
  if (/\btweet\b|\bpost\b|share.*update|what('s| is) on your mind/.test(text)) return "post";
  if (/\bcomment\b/.test(text)) return "comment";
  if (/\bmessage\b|\breply\b|\brespond\b|write to|direct message/.test(text)) return "message";

  // Infer from structural hints when text classification is ambiguous
  if (fieldHints.maxLength && fieldHints.maxLength <= 320) return "post";
  if (fieldHints.expectedLength === "very_long") return "cover_letter";
  if (platformKey === "canvas") return "assignment_response";

  return "general";
};

// Per-type writing directives injected into the prompt — specific, actionable guidance
const FIELD_TYPE_INSTRUCTIONS = {
  cover_letter:
    "Write a tailored cover letter. Open with a specific statement of why you're a strong fit — not a generic intro. Connect your concrete experience to the role's key requirements in 2–3 focused paragraphs. Close with genuine enthusiasm and a brief call to action. Aim for 250–400 words. Skip 'Dear Hiring Manager' and openers like 'I am writing to express interest.'",

  behavioral:
    "Answer using the STAR structure (Situation → Task → Action → Result) written as natural prose, not labeled sections. Lead with a specific scenario. Describe what you did concretely — tools, decisions, skills — and close with a measurable or meaningful result. 150–250 words. Be specific, not generic.",

  why_role:
    "Explain genuine motivation in 2–3 short paragraphs: (1) something specific about this company/team/mission that resonates, (2) how this role fits your trajectory, (3) what you'll bring. Avoid generic praise. Be specific about why *this* place.",

  goals_ambition:
    "Describe career goals concisely. Name what you want to work on, where you want to grow, and why this role is a meaningful step. Avoid clichés like 'I want to grow' or 'I see myself in leadership.' Ground it in actual interests and background. 3–5 sentences.",

  strengths:
    "Name 1–2 genuine strengths with a brief concrete example. Connect to what makes you effective professionally. 3–5 sentences. Be specific — not 'I'm a fast learner' but what that looks like in practice.",

  challenges:
    "Pick a real weakness or challenge you've worked on. Describe the gap, what you did about it, and where you are now. Show self-awareness and growth. 3–5 sentences. Don't use a 'weakness that's really a strength.'",

  contribution:
    "State your specific, concrete value-add in 2–3 sentences. Connect your strongest skills/experience directly to what this team needs. Be bold — not 'I'll bring my passion' but what you'll actually do or improve.",

  skills_experience:
    "Describe relevant experience clearly. Highlight the most applicable skills, tools, and achievements. Use numbers or specifics where possible. 2–4 sentences or a brief list if multiple items. Match depth to field size.",

  bio_summary:
    "Write a crisp professional bio. Cover: current role/focus, key expertise, one differentiating detail. Match person/voice to context (first vs third). No fluff. If it's a short headline field: one tight sentence.",

  assignment_response:
    "Answer the assignment prompt directly and completely. Follow any stated rubric, constraints, and required format. If evidence is expected, ground claims in concrete examples or cited material. Prefer clear structure: direct answer first, then explanation. Avoid fluff and generic filler.",

  message:
    "Write a natural, direct message. Match tone to relationship (professional, casual, etc.). Get to the point quickly. End with a clear ask or next step if needed. Sound like a real person.",

  post:
    "Write a punchy, engaging post. Lead with the most interesting point — no warm-up. Twitter/X: sharp and under 280 chars. LinkedIn: direct with real substance. Reddit: conversational and genuinely helpful. No filler, no 'Excited to share.'",

  comment:
    "Write a brief, genuine reply that adds real value. React to a specific point. Be direct and natural. 1–3 sentences.",

  general:
    "Write the most appropriate response for this context. Match tone, length, and format to what the field and situation call for.",
};

const LENGTH_HINT_GUIDANCE = {
  very_short: "Keep this very short: 1 sentence, no filler.",
  short: "Keep this concise: 2-4 sentences.",
  medium: "Use a medium length response: one focused paragraph.",
  long: "Use a longer, well-structured response with clear flow.",
  very_long: "Use a multi-paragraph response with strong structure and transitions.",
};

const AUDIENCE_STYLE_GUIDANCE = {
  academic:
    "Audience appears academic. Use precise language, explicit reasoning, and evidence-backed claims. Avoid slang.",
  hiring:
    "Audience appears hiring-oriented. Focus on concrete outcomes, role fit, and credibility signals.",
  client:
    "Audience appears client-facing. Be clear, professional, and outcome-oriented with concrete next steps.",
  social:
    "Audience appears social/casual. Keep it warm, natural, and conversational.",
  professional:
    "Audience appears professional. Be direct, respectful, and specific.",
};

const inferAudienceType = (platformKey, question = "", contextPack = null) => {
  const hints = [
    question,
    contextPack?.counterpart?.name || "",
    contextPack?.counterpart?.roleHint || "",
    contextPack?.foregroundContext?.slice(0, 600) || "",
    contextPack?.assignmentContext?.slice(0, 400) || "",
  ]
    .join(" ")
    .toLowerCase();

  if (ACADEMIC_AUDIENCE_RE.test(hints)) {
    return "academic";
  }
  if (/recruiter|hiring manager|interviewer|talent|job/.test(hints)) {
    return "hiring";
  }
  if (/client|customer|stakeholder|vendor|account/.test(hints)) {
    return "client";
  }
  if (SOCIAL_AUDIENCE_PLATFORMS.has(platformKey)) {
    return "social";
  }
  return "professional";
};

// What each action mode means
const ACTION_INSTRUCTIONS = {
  generate:
    "Write the best possible response for this context. Match the length and tone to what the situation calls for.",
  rewrite:
    "Rewrite and improve the existing content. Keep the same core meaning and intent, but make it more polished, natural, and effective.",
  shorten:
    "Rewrite the existing content to be significantly more concise. Cut everything unnecessary while preserving all key points.",
  expand:
    "Expand the existing content with more detail, context, examples, and depth. Keep it coherent and on-point.",
};

const normalizeAnswer = (text) => {
  return text
    .replace(/[—–]/g, ",")
    .replace(/\*\s*\*\s*\*/g, "\n\n")
    .replace(/\s*,\s*/g, ", ")
    .replace(/\s+\./g, ".")
    .replace(/\s+\!/g, "!")
    .replace(/\s+\?/g, "?")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();
};

// Single unified prompt builder — adapts to any platform/action/field type
const buildPrompt = ({
  systemPrompt,
  personaVoice,
  generalContext,
  learnedMemory,
  pageContext,
  question,
  fieldValue,
  platformKey,
  action,
  instruction,
  capturedContexts,
  fieldHints,
  contextPack,
}) => {
  const profile =
    PLATFORM_PROFILES[platformKey] || PLATFORM_PROFILES.general;
  const selectedContexts = Array.isArray(capturedContexts)
    ? capturedContexts
        .filter(
          (ctx) =>
            ctx &&
            ctx.active !== false &&
            typeof ctx.text === "string" &&
            ctx.text.trim()
        )
        .slice(-4)
    : [];
  const taskInstruction =
    ACTION_INSTRUCTIONS[action] || ACTION_INSTRUCTIONS.generate;
  const fieldType = classifyFieldType(
    question || "",
    fieldHints || {},
    platformKey,
    contextPack
  );
  const fieldTypeInstruction =
    FIELD_TYPE_INSTRUCTIONS[fieldType] || FIELD_TYPE_INSTRUCTIONS.general;
  const audienceType = inferAudienceType(
    platformKey,
    question || "",
    contextPack
  );
  const academicMode =
    platformKey === "canvas" ||
    audienceType === "academic" ||
    fieldType === "assignment_response";
  const includeLongTermMemory = !academicMode;
  const lengthGuidance = fieldHints?.expectedLength
    ? LENGTH_HINT_GUIDANCE[fieldHints.expectedLength] || ""
    : "";
  const audienceGuidance = AUDIENCE_STYLE_GUIDANCE[audienceType] || "";

  const baseSystem = systemPrompt?.trim()
    ? systemPrompt.trim()
    : [
        "You are a precise, helpful writing assistant.",
        profile.instructions,
        "Write clear, natural responses that sound authentically human — never AI-generated.",
        "Be specific and use details from the provided context.",
        "Match the expected length to the context: short for chats/comments, longer for emails/posts/applications.",
        "Use plain punctuation only — no em dashes, asterisks, or bullet points unless the field clearly expects them.",
        "Avoid: generic AI openers ('Certainly!', 'Sure!', 'I'd be happy to', 'I hope this finds you well'), disclaimers, filler, excessive politeness.",
        "Start directly. No preamble.",
        "Use active voice. Be confident, specific, and genuine.",
        "When personal context is provided, use it naturally without explicitly referencing it ('based on my background' → just use the background).",
        "Context priority rule: follow Foreground Context first, then Field/Question, then User-selected Context, then Background Context, then long-term memory.",
        "If Foreground and Background conflict, trust Foreground.",
        selectedContexts.length > 0
          ? "When User-selected Context exists, treat it as required source material and use concrete details from it unless it conflicts with explicit instructions."
          : "",
        academicMode
          ? "Academic mode: prioritize assignment prompt, rubric, and question only. Ignore unrelated personal/career memory unless the user explicitly asks to include it."
          : "",
      ].join(" ");

  // Persona voice is always appended — it is the user's writing DNA and must shape every response
  const system = personaVoice ? `${baseSystem}\n\n${personaVoice}` : baseSystem;

  const userParts = [];

  // Highest-priority context first: foreground + user query/instruction + user-selected contexts.
  if (contextPack?.foregroundContext?.trim()) {
    userParts.push(
      `=== Foreground Context (Highest Priority) ===\n${contextPack.foregroundContext.trim()}`
    );
  }

  if (question?.trim()) {
    userParts.push(`=== Field / Question (High Priority) ===\n${question.trim()}`);
  }

  if (instruction?.trim()) {
    userParts.push(`=== Additional Instruction (High Priority) ===\n${instruction.trim()}`);
  }

  if (selectedContexts.length > 0) {
    userParts.push(
      "=== Required Use of User-selected Context ===\nUse concrete facts from the User-selected Context blocks below. Do not ignore them."
    );
    selectedContexts.forEach((ctx) => {
      const label = ctx.title || ctx.hostname || ctx.url || "another page";
      userParts.push(
        `=== User-selected Context (High Priority): ${label} ===\n${ctx.text.trim().slice(0, 2600)}`
      );
    });
  }

  if (contextPack?.counterpart?.name || audienceType !== "professional") {
    userParts.push(
      [
        "=== Audience ===",
        contextPack?.counterpart?.name
          ? `Counterparty: ${contextPack.counterpart.name}`
          : "",
        audienceType ? `Audience type: ${audienceType}` : "",
        audienceGuidance ? `Guidance: ${audienceGuidance}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    );
  }

  if (contextPack?.assignmentContext?.trim()) {
    userParts.push(
      `=== Assignment / Rubric Context ===\n${contextPack.assignmentContext.trim()}`
    );
  }

  const backgroundContextText = contextPack?.backgroundContext?.trim();
  if (backgroundContextText) {
    const clippedBackground = selectedContexts.length
      ? backgroundContextText.slice(0, 1800)
      : backgroundContextText;
    userParts.push(
      `=== Background Context (Secondary) ===\n${clippedBackground}`
    );
  } else if (pageContext?.trim()) {
    userParts.push(`=== Current Page Context ===\n${pageContext.trim()}`);
  }

  // Existing content is important for rewrite/expand/shorten actions.
  if (fieldValue?.trim()) {
    userParts.push(`=== Existing Content ===\n${fieldValue.trim()}`);
  }

  // Lower-priority long-term memories/context.
  if (includeLongTermMemory && generalContext?.trim()) {
    userParts.push(`=== Your Background (Lower Priority) ===\n${generalContext.trim()}`);
  }

  if (includeLongTermMemory && learnedMemory?.trim()) {
    userParts.push(learnedMemory.trim());
  }

  userParts.push(
    [
      "=== Field Guidance ===",
      `Detected field type: ${fieldType}`,
      `Guidance: ${fieldTypeInstruction}`,
      fieldHints?.maxLength ? `Max length: ${fieldHints.maxLength}` : "",
      lengthGuidance,
      fieldHints?.nearbyLabels?.length
        ? `Nearby labels: ${fieldHints.nearbyLabels.join(" | ")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n")
  );

  userParts.push(`=== Task ===\n${taskInstruction}`);

  return {
    system,
    user: userParts.join("\n\n"),
  };
};

const sanitizeError = (errorText) => {
  const firstLine = errorText.split("\n")[0];
  return firstLine
    .replace(/sk-[a-zA-Z0-9]+/g, "sk-***")
    .substring(0, 200);
};

const requestOpenAI = async ({ apiKey, model, system, user }) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(OPENAI_ENDPOINT, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        instructions: system,
        input: user,
      }),
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `OpenAI request failed: ${sanitizeError(errorText)}`
      );
    }

    const data = await response.json();

    let answer = null;

    if (typeof data?.output_text === "string" && data.output_text) {
      answer = data.output_text;
    } else if (Array.isArray(data?.output)) {
      const textParts = [];
      for (const item of data.output) {
        if (item?.type === "message" && Array.isArray(item?.content)) {
          for (const content of item.content) {
            if (
              content?.type === "output_text" &&
              typeof content?.text === "string"
            ) {
              textParts.push(content.text);
            }
          }
        }
      }
      if (textParts.length > 0) {
        answer = textParts.join("\n");
      }
    }

    if (!answer) {
      console.error(
        "OpenAI API response:",
        JSON.stringify(data, null, 2)
      );
      throw new Error(
        "Could not parse API response. Check browser console for details."
      );
    }

    return answer.trim();
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === "AbortError") {
      throw new Error("Request timed out after 30 seconds");
    }
    throw err;
  }
};

const requestAnthropic = async ({ apiKey, model, system, user }) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(ANTHROPIC_ENDPOINT, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        temperature: 0.5,
        max_tokens: 1024,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Anthropic request failed: ${sanitizeError(errorText)}`
      );
    }

    const data = await response.json();
    const content = data?.content?.[0]?.text;
    return content?.trim();
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === "AbortError") {
      throw new Error("Request timed out after 30 seconds");
    }
    throw err;
  }
};

const requestGemini = async ({ apiKey, model, system, user }) => {
  const fullPrompt = `${system}\n\n${user}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(
      `${GEMINI_ENDPOINT}/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: fullPrompt }],
            },
          ],
          generationConfig: {
            maxOutputTokens: 2048,
            temperature: 0.7,
          },
        }),
      }
    );

    clearTimeout(timeout);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Gemini request failed: ${sanitizeError(errorText)}`
      );
    }

    const data = await response.json();

    const finishReason = data?.candidates?.[0]?.finishReason;
    if (finishReason && finishReason !== "STOP") {
      console.warn(
        "[TextFill] Gemini response may be incomplete. Finish reason:",
        finishReason
      );
    }

    let answer = null;
    const parts = data?.candidates?.[0]?.content?.parts;
    if (parts && Array.isArray(parts)) {
      answer = parts.map((p) => p.text || "").join("");
    }

    if (!answer) {
      answer = data?.text;
    }

    if (!answer) {
      console.error(
        "[TextFill] Gemini response parsing failed:",
        JSON.stringify(data, null, 2)
      );
      throw new Error("Could not parse Gemini response");
    }

    answer = answer
      .replace(/\*\s*\*\s*\*/g, "\n\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    return answer;
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === "AbortError") {
      throw new Error("Request timed out after 30 seconds");
    }
    throw err;
  }
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "openSettings") {
    chrome.runtime.openOptionsPage();
    return false;
  }

  if (message?.type === "backfillEmbeddings") {
    (async () => {
      try {
        const stats = await backfillEmbeddings();
        sendResponse({ ok: true, stats });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  // ── Append a confirmed memory insight from user action toast ────────────────
  if (message?.type === "appendToMemory") {
    (async () => {
      try {
        const { category: rawCat, content } = message;
        if (!content?.trim()) { sendResponse({ ok: false, error: "Empty content" }); return; }
        const validCats = new Set(["work", "social", "personal", "persona"]);
        const category = validCats.has(rawCat) ? rawCat : "persona";

        const embed = await getEmbeddingConfigFromStorage();

        const result = await addMemoryWithEmbeddingConfig({
          category,
          type:       "preference",
          content:    content.trim().slice(0, 150),
          tags:       [],
          entities:   [],
          importance: 2,
          confidence: 0.85,
          source:     "user_confirm",
          private:    false,
          related:    [],
        }, embed);
        sendResponse(withEmbeddingWarning({ ok: true, ...result }, embed));
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  // ── Memory CRUD handlers ────────────────────────────────────────────────────
  if (message?.type === "getMemories") {
    (async () => {
      try { sendResponse({ ok: true, memories: await getMemories() }); }
      catch (err) { sendResponse({ ok: false, error: err.message }); }
    })();
    return true;
  }

  if (message?.type === "repairMemories") {
    (async () => {
      try {
        const result = await runMemoryStoreMaintenance(Boolean(message.force));
        sendResponse({ ok: true, ...result });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (message?.type === "saveMemory") {
    (async () => {
      try {
        const embed = await getEmbeddingConfigFromStorage();
        const result = await addMemoryWithEmbeddingConfig(message.memory, embed);
        sendResponse(withEmbeddingWarning({ ok: true, ...result }, embed));
      } catch (err) { sendResponse({ ok: false, error: err.message }); }
    })();
    return true;
  }

  if (message?.type === "updateMemory") {
    (async () => {
      try {
        const memories = await getMemories();
        const idx = memories.findIndex((m) => m.id === message.id);
        if (idx === -1) { sendResponse({ ok: false, error: "Not found" }); return; }
        const oldContent = memories[idx].content || "";

        const mergedInput = {
          ...memories[idx],
          ...(message.changes || {}),
          source: memories[idx].source || "manual_edit",
        };
        const sanitized = sanitizeMemoryInput(mergedInput, mergedInput.source || "manual_edit");
        if (!sanitized) { sendResponse({ ok: false, error: "Invalid memory content" }); return; }

        memories[idx] = {
          ...memories[idx],
          ...sanitized,
          id: memories[idx].id,
          mentions: memories[idx].mentions || 1,
          createdAt: memories[idx].createdAt || Date.now(),
          updatedAt: Date.now(),
        };

        // If content changed, refresh embedding so clustering/retrieval stays accurate.
        let embeddingError = null;
        if (typeof message?.changes?.content === "string" && memories[idx].content !== oldContent) {
          const embed = await getEmbeddingConfigFromStorage();
          if (embed.ok) {
            try {
              const emb = await generateEmbedding(
                memories[idx].content,
                embed.provider,
                embed.apiKey,
                embed.model
              );
              const embeddingIndex = await getEmbeddingIndex();
              embeddingIndex[memories[idx].id] = emb;
              await setEmbeddingIndex(embeddingIndex);
            } catch (err) {
              embeddingError = err?.message || String(err);
            }
          } else {
            embeddingError = embed.error;
          }
        }

        updateRelatedLinks(memories, memories[idx].id);
        await saveMemories(memories);
        sendResponse({ ok: true, memory: memories[idx], embeddingError });
      } catch (err) { sendResponse({ ok: false, error: err.message }); }
    })();
    return true;
  }

  if (message?.type === "deleteMemory") {
    (async () => {
      try {
        const memories = await getMemories();
        // Also clean up the embedding index when a memory is deleted
        const embeddingIndex = await getEmbeddingIndex();
        delete embeddingIndex[message.id];
        await setEmbeddingIndex(embeddingIndex);
        await saveMemories(memories.filter((m) => m.id !== message.id));
        sendResponse({ ok: true });
      } catch (err) { sendResponse({ ok: false, error: err.message }); }
    })();
    return true;
  }

  // ── Entity linking: check if person/company matches stored job targets ────
  if (message?.type === "checkEntityLinks") {
    (async () => {
      try {
        const { entities = [] } = message;
        const memories = await getMemories();
        const links = [];
        const embed = await getEmbeddingConfigFromStorage();

        for (const entity of entities) {
          if (entity.type === "person" && entity.employer) {
            // Find if employer is a job target
            const match = memories.find(
              (m) =>
                m.category === "work" &&
                m.entities?.some(
                  (e) =>
                    entity.employer.toLowerCase().includes(e.toLowerCase()) ||
                    e.toLowerCase().includes(entity.employer.toLowerCase())
                )
            );
            if (match) {
              links.push({
                type: "contact_at_target",
                content: `${entity.name} works at ${entity.employer} — noted in your work memory`,
                relatedId: match.id,
              });
            }
          }

          if (entity.type === "job_posting" && entity.company) {
            // Auto-save job targets from job boards
            const result = await addMemoryWithEmbeddingConfig({
              category: "work",
              type: "job_target",
              content: entity.role
                ? `Targeting ${entity.role} at ${entity.company}`
                : `Exploring roles at ${entity.company}`,
              tags: [entity.company.toLowerCase().replace(/\s+/g, "_"), "job_target"],
              entities: [entity.company],
              importance: 3,
              confidence: 0.92,
              source: entity.source || "job_board",
              private: false,
              related: [],
            }, embed);
            if (result.action === "added") {
              links.push({ type: "job_saved", content: `Saved: ${entity.company}`, action: "added" });
            }
            if (result.embeddingError) {
              links.push({
                type: "embedding_error",
                content: result.embeddingError,
                action: "error",
              });
            } else if (!embed.ok) {
              links.push({
                type: "embedding_error",
                content: embed.error,
                action: "error",
              });
            }
          }
        }

        sendResponse({ ok: true, links });
      } catch (err) { sendResponse({ ok: false, error: err.message, links: [] }); }
    })();
    return true;
  }

  // ── Extract memorable facts from generated text ─────────────────────────────
  if (message?.type === "extractMemory") {
    (async () => {
      try {
        const { generatedText, userInput, platformKey, pageContext, existingContext } = message;

        // Skip only if text is too short — platform gate removed (any site can yield memory)
        if (!generatedText || generatedText.trim().length < 100) {
          sendResponse({ ok: true, memories: [] }); return;
        }

        const {
          provider, openaiKey, anthropicKey, geminiKey,
          openaiMemoryModel, anthropicMemoryModel, geminiMemoryModel,
        } = await chrome.storage.local.get([
          "provider", "openaiKey", "anthropicKey", "geminiKey",
          "openaiMemoryModel", "anthropicMemoryModel", "geminiMemoryModel",
        ]);

        const activeProvider = provider || "openai";
        const apiKey = activeProvider === "anthropic" ? anthropicKey
                     : activeProvider === "gemini"    ? geminiKey
                     : openaiKey;
        if (!apiKey) { sendResponse({ ok: true, memories: [] }); return; }

        // Use the dedicated memory model (cheaper/faster) — falls back to sensible defaults
        const activeModel =
          activeProvider === "anthropic" ? (anthropicMemoryModel || "claude-haiku-3-5")
        : activeProvider === "gemini"    ? (geminiMemoryModel    || "gemini-2.5-flash-lite")
        :                                   (openaiMemoryModel   || "gpt-5-nano");

        const PRECISE_MEMORY_PROMPT =
          "You are a high-precision personal memory assistant embedded in a writing tool. Extract ONLY facts that belong to ONE of these two buckets:\n" +
          "  A) About the USER themselves (their job, skills, goals, preferences, relationships, location, personality).\n" +
          "  B) About a SPECIFIC person or company DIRECTLY relevant to the user right now (e.g. a hiring manager they are writing to, a company they are targeting, a contact they know).\n\n" +
          "CATEGORY DEFINITIONS:\n" +
          "- 'work'     — Professional facts: job title, employer, skills, projects, career goals, work history, job targets, colleagues.\n" +
          "- 'social'   — Social life facts: friends, hobbies, interests, communities, how they spend time, platforms they use.\n" +
          "- 'personal' — Personal life facts: name, location, relationships, values, significant life events, personal goals.\n" +
          "- 'persona'  — The user's WRITING IDENTITY: their unique voice, tone, language patterns, sentence rhythm, formatting habits, words or phrases they always/never use, communication style across platforms, what makes their writing distinctly theirs. FOR PERSONA ONLY: use \"User's own words\" section as your primary signal — that is the user's natural unfiltered language. The AI-generated text was shaped by the extension and is NOT a reliable persona signal. EXTREMELY RARE to extract — only save if the pattern is unmistakable and 95%+ confident. When in doubt, return nothing for this category.\n\n" +
          "STRICT rules — violating any means return nothing:\n" +
          "- confidence ≥ 0.85 ONLY — discard anything ambiguous or generic\n" +
          "- Must be stable for weeks/months (not ephemeral filler)\n" +
          "- Must be personally actionable: would change what an AI writer produces for this user\n" +
          "- Do NOT save generic facts, public knowledge, or content unrelated to the user\n" +
          "- Prefer concrete facts over vague labels (example: 'Full-stack & AI Engineer at Flamel.AI' is valid, 'Role at Flamel.AI' is weak)\n" +
          "- Include tags and entities whenever possible for retrieval + clustering\n" +
          "- Maximum 2 entries per call\n" +
          "- type: one of name, current_role, role, employer, skill, job_target, project, relationship, interest, location, education, graduation_date, preference, writing_style, tone, voice_pattern\n\n" +
          'Return ONLY JSON: {"memories":[{"category":"...","type":"...","content":"under 120 chars","tags":["tag1"],"entities":["ProperNoun"],"importance":1-3,"confidence":0.0}]}\n' +
          'Return {"memories":[]} if nothing qualifies.';

        const userPrompt = [
          `Platform: ${platformKey}`,
          pageContext ? `Page: ${pageContext.slice(0, 250)}` : "",
          existingContext ? `Already stored (skip duplicates):\n${existingContext.slice(0, 350)}` : "",
          userInput?.trim() ? `\nUser's own words (instruction + what they typed — PRIMARY signal for persona):\n${userInput.trim().slice(0, 400)}` : "",
          `\nAI-generated text (for work/social/personal facts only — NOT for persona):\n${generatedText.trim().slice(0, 800)}`,
        ].filter(Boolean).join("\n");

        let rawResponse = "";
        try {
          if (activeProvider === "anthropic") {
            rawResponse = await requestAnthropic({ apiKey, model: activeModel, system: PRECISE_MEMORY_PROMPT, user: userPrompt });
          } else if (activeProvider === "gemini") {
            rawResponse = await requestGemini({ apiKey, model: activeModel, system: PRECISE_MEMORY_PROMPT, user: userPrompt });
          } else {
            rawResponse = await requestOpenAI({ apiKey, model: activeModel, system: PRECISE_MEMORY_PROMPT, user: userPrompt });
          }
        } catch (_) {
          sendResponse({ ok: true, memories: [] }); return;
        }

        const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
        if (!jsonMatch) { sendResponse({ ok: true, memories: [] }); return; }

        try {
          const parsed = JSON.parse(jsonMatch[0]);
          const validMemories = normalizeExtractedMemories(
            parsed.memories || [],
            platformKey || "auto"
          );
          sendResponse({ ok: true, memories: validMemories });
        } catch (_) {
          sendResponse({ ok: true, memories: [] });
        }
      } catch (err) {
        sendResponse({ ok: true, memories: [] });
      }
    })();
    return true;
  }

  if (message?.type !== "generateAnswer") {
    return false;
  }

  (async () => {
    try {
      const {
        provider,
        model,
        systemPrompt,
        workContextText,
        socialContextText,
        alwaysContextText,
        openaiKey,
        anthropicKey,
        geminiKey,
        openaiEmbeddingModel,
        geminiEmbeddingModel,
      } = await chrome.storage.local.get([
        "provider",
        "model",
        "systemPrompt",
        "workContextText",
        "socialContextText",
        "alwaysContextText",
        "openaiKey",
        "anthropicKey",
        "geminiKey",
        "openaiEmbeddingModel",
        "geminiEmbeddingModel",
      ]);

      const activeProvider = provider || "openai";
      const activeModel =
        model ||
        (activeProvider === "anthropic"
          ? "claude-sonnet-4-5"
          : activeProvider === "gemini"
          ? "gemini-3-pro-preview"
          : "gpt-5-nano");

      const apiKey =
        activeProvider === "anthropic"
          ? anthropicKey
          : activeProvider === "gemini"
          ? geminiKey
          : openaiKey;

      if (!apiKey) {
        sendResponse({
          ok: false,
          error: "Missing API key. Add it in the extension options.",
        });
        return;
      }

      const platformKey = message.platformKey || "general";
      const capturedContextCount = Array.isArray(message.capturedContexts)
        ? message.capturedContexts.filter(
            (ctx) =>
              ctx &&
              ctx.active !== false &&
              typeof ctx.text === "string" &&
              ctx.text.trim()
          ).length
        : 0;
      if (platformKey === "gmail" || capturedContextCount > 0) {
        console.debug("[TextFill] generateAnswer request", {
          platformKey,
          capturedContextCount,
          questionChars: (message.question || "").length,
          fieldValueChars: (message.fieldValue || "").length,
          foregroundChars: message.contextPack?.foregroundContext?.length || 0,
          backgroundChars: message.contextPack?.backgroundContext?.length || 0,
        });
      }

      const structuredContext = buildContextBlock(platformKey, {
        workContext:   workContextText   || "",
        socialContext: socialContextText || "",
        alwaysContext: alwaysContextText || "",
      });

      // Retrieve relevant learned memories for this platform + context.
      // Pass provider/apiKey for semantic (embedding-based) retrieval when available.
      const embed = resolveEmbeddingConfig({
        preferredProvider: activeProvider,
        openaiKey,
        geminiKey,
        openaiEmbeddingModel,
        geminiEmbeddingModel,
      });
      const { persona, contextual } = await getRelevantMemories(
        platformKey,
        message.pageContext || "",
        embed.ok ? embed.provider : null,
        embed.ok ? embed.apiKey : null,
        embed.ok ? embed.model : null
      );
      const personaVoice = formatPersonaVoice(persona);
      const learnedMemory = formatContextualMemories(contextual);

      // Track memory access — update lastAccessedAt, accessCount, reset sessionsSinceAccess
      if (contextual.length > 0) {
        const allMemories = await getMemories();
        const usedIds = new Set(contextual.map((m) => m.id));
        let changed = false;
        for (const m of allMemories) {
          if (usedIds.has(m.id)) {
            m.lastAccessedAt = Date.now();
            m.accessCount = (m.accessCount || 0) + 1;
            m.sessionsSinceAccess = 0;
            changed = true;
          }
        }
        if (changed) await saveMemories(allMemories);
      }

      const promptPayload = buildPrompt({
        systemPrompt,
        personaVoice,
        generalContext: structuredContext,
        learnedMemory,
        pageContext: message.pageContext,
        question: message.question,
        fieldValue: message.fieldValue,
        platformKey,
        action: message.action || "generate",
        instruction: message.instruction || "",
        capturedContexts: message.capturedContexts || null,
        fieldHints: message.fieldHints || {},
        contextPack: message.contextPack || null,
      });

      let answer = "";
      if (activeProvider === "anthropic") {
        answer = await requestAnthropic({
          apiKey,
          model: activeModel,
          ...promptPayload,
        });
      } else if (activeProvider === "gemini") {
        answer = await requestGemini({
          apiKey,
          model: activeModel,
          ...promptPayload,
        });
      } else {
        answer = await requestOpenAI({
          apiKey,
          model: activeModel,
          ...promptPayload,
        });
      }

      if (!answer) {
        sendResponse({ ok: false, error: "No answer returned." });
        return;
      }

      sendResponse({ ok: true, answer: normalizeAnswer(answer) });
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
    }
  })();

  return true;
});

// ── Lifecycle: Forgetting Cycle & Embedding Backfill ─────────────────────────

// Forgetting cycle: compute forgetScore for every memory.
// Archive high-score memories; delete ones past the deletion threshold.
// Runs once per week via alarm.
const runForgettingCycle = async () => {
  const memories = await getMemories();
  const embeddingIndex = await getEmbeddingIndex();

  const toDelete = new Set();
  const updated = memories.map((m) => {
    const score = computeForgetScore(m);
    const mem = { ...m, forgetScore: parseFloat(score.toFixed(3)) };

    if (score > DELETE_THRESHOLD && (m.importance || 2) <= 2) {
      toDelete.add(m.id);
    } else if (score > ARCHIVE_THRESHOLD && m.tier !== "archived") {
      mem.tier = "archived";
    } else if (score <= ARCHIVE_THRESHOLD && m.tier === "archived") {
      // Memory was accessed again — restore to active
      mem.tier = "active";
    }
    return mem;
  }).filter((m) => !toDelete.has(m.id));

  toDelete.forEach((id) => delete embeddingIndex[id]);

  // Cap archived tier: keep only the ARCHIVED_CAP highest-importance ones
  const archived = updated.filter((m) => m.tier === "archived");
  if (archived.length > ARCHIVED_CAP) {
    archived.sort(
      (a, b) =>
        (b.importance || 2) * Math.log(1 + (b.mentions || 1)) -
        (a.importance || 2) * Math.log(1 + (a.mentions || 1))
    );
    const toPurge = archived.slice(ARCHIVED_CAP);
    const purgeIds = new Set(toPurge.map((m) => m.id));
    purgeIds.forEach((id) => delete embeddingIndex[id]);
    const active = updated.filter((m) => m.tier !== "archived");
    updated.length = 0;
    updated.push(...active, ...archived.slice(0, ARCHIVED_CAP));
  }

  await saveMemories(updated);
  await setEmbeddingIndex(embeddingIndex);
  await chrome.storage.local.set({ lastForgettingCycle: Date.now() });
};

// Backfill: generate embeddings for any memory that lacks one.
// Returns per-memory error details when embedding fails.
const backfillEmbeddings = async () => {
  const embed = await getEmbeddingConfigFromStorage();

  const memories = await getMemories();
  const embeddingIndex = await getEmbeddingIndex();
  const missingMemories = memories.filter((m) => !embeddingIndex[m.id]);

  if (!embed.ok) {
    return {
      provider: embed.provider,
      model: embed.model,
      error: embed.error,
      total: memories.length,
      missing: missingMemories.length,
      attempted: 0,
      embedded: 0,
      errors: missingMemories.length > 0 ? 1 : 0,
      changed: false,
      errorDetails: missingMemories.length > 0
        ? [{ id: null, content: null, error: embed.error }]
        : [],
    };
  }

  let changed = false;
  let attempted = 0;
  let embedded = 0;
  let errors = 0;
  const errorDetails = [];
  for (const m of missingMemories) {
    attempted += 1;
    try {
      const emb = await generateEmbedding(
        m.content,
        embed.provider,
        embed.apiKey,
        embed.model
      );
      embeddingIndex[m.id] = emb;
      changed = true;
      embedded += 1;
    } catch (err) {
      errors += 1;
      errorDetails.push({
        id: m.id,
        content: (m.content || "").slice(0, 120),
        error: err?.message || String(err),
      });
    }
    await new Promise((r) => setTimeout(r, 100)); // gentle rate limiting
  }

  if (changed) await setEmbeddingIndex(embeddingIndex);
  return {
    provider: embed.provider,
    model: embed.model,
    error: null,
    total: memories.length,
    missing: missingMemories.length,
    attempted,
    embedded,
    errors,
    changed,
    errorDetails,
  };
};

// On startup: increment session counter and run forgetting cycle (max once/week)
const onStartupInit = async () => {
  await runMemoryStoreMaintenance(false);

  // Increment sessionsSinceAccess for every memory — memories used this session
  // will have theirs reset back to 0 in generateAnswer. This powers the session-based
  // forgetting penalty in computeForgetScore.
  const allMems = await getMemories();
  if (allMems.length > 0) {
    for (const m of allMems) {
      m.sessionsSinceAccess = (m.sessionsSinceAccess || 0) + 1;
    }
    await saveMemories(allMems);
  }

  const { lastForgettingCycle = 0 } = await chrome.storage.local.get("lastForgettingCycle");
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  if (Date.now() - lastForgettingCycle > weekMs) {
    await runForgettingCycle();
  }
};

chrome.runtime.onStartup.addListener(onStartupInit);
chrome.runtime.onInstalled.addListener(onStartupInit);
