const OPENAI_ENDPOINT = "https://api.openai.com/v1/responses";
const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models";

// ── Embedding Infrastructure ───────────────────────────────────────────────────
const EMBED_DIMS = 256;
const SEMANTIC_DEDUP_THRESHOLD = 0.92;
const ARCHIVE_THRESHOLD = 0.60;
const DELETE_THRESHOLD  = 0.85;

// Memory caps — each tier has its own limit.
// Storage cost at 700 total: ~1.75MB embeddings + ~560KB metadata = ~2.3MB.
// Chrome's chrome.storage.local limit is 10MB — we are well within it.
const ACTIVE_CAP   = 500;  // active (injectable) memories
const ARCHIVED_CAP = 200;  // archived (faded, kept for reference, not injected)

const normalizeVector = (v) => {
  const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return mag === 0 ? v : v.map((x) => x / mag);
};

const dotProduct = (a, b) => {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
};

// Returns a 256-dim pre-normalized vector, or null on failure.
// Anthropic has no embedding API — returns null (caller falls back to keyword matching).
const generateEmbedding = async (text, provider, apiKey) => {
  if (!apiKey || !text?.trim() || provider === "anthropic") return null;
  try {
    if (provider === "openai") {
      const res = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "text-embedding-3-small",
          input: text.slice(0, 1000),
          dimensions: EMBED_DIMS,
          encoding_format: "float",
        }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const vec = data?.data?.[0]?.embedding;
      return vec ? normalizeVector(vec) : null;
    }
    if (provider === "gemini") {
      const res = await fetch(
        `${GEMINI_ENDPOINT}/text-embedding-004:embedContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "models/text-embedding-004",
            content: { parts: [{ text: text.slice(0, 1000) }] },
            taskType: "SEMANTIC_SIMILARITY",
            outputDimensionality: EMBED_DIMS,
          }),
        }
      );
      if (!res.ok) return null;
      const data = await res.json();
      const vec = data?.embedding?.values;
      return vec ? normalizeVector(vec) : null;
    }
    return null;
  } catch (_) {
    return null;
  }
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

const getMemories = async () => {
  const { memories = [] } = await chrome.storage.local.get("memories");
  return memories;
};

const saveMemories = async (memories) => {
  await chrome.storage.local.set({ memories });
};

// Deduplicate check: same category + overlapping content
const isDuplicateMemory = (existing, candidate) => {
  if (existing.category !== candidate.category) return false;

  const existingWords = existing.content.toLowerCase().split(/\W+/).filter((w) => w.length > 4);
  const candidateWords = candidate.content.toLowerCase().split(/\W+/).filter((w) => w.length > 4);
  const wordOverlap = candidateWords.filter((w) => existingWords.includes(w)).length;

  // Persona has no proper-noun entities — deduplicate purely on word overlap (3+ shared words)
  if (candidate.category === "persona") return wordOverlap >= 3;

  // For all other categories: require entity overlap AND 2+ shared content words
  const existingEntities = (existing.entities || []).map((e) => e.toLowerCase());
  const candidateEntities = (candidate.entities || []).map((e) => e.toLowerCase());
  const entityOverlap = candidateEntities.some((e) => existingEntities.includes(e));
  return entityOverlap && wordOverlap >= 2;
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
// provider + apiKey are optional — if absent (or Anthropic), falls back to keyword dedup only.
const addMemory = async (memoryData, provider = null, apiKey = null) => {
  const memories = await getMemories();
  const embeddingIndex = await getEmbeddingIndex();

  // Step 1: Generate embedding for candidate (silently skipped if unavailable)
  let candidateEmbedding = null;
  if (provider && apiKey && provider !== "anthropic") {
    candidateEmbedding = await generateEmbedding(memoryData.content, provider, apiKey);
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
        memories[idx].mentions   = (memories[idx].mentions || 1) + 1;
        memories[idx].updatedAt  = Date.now();
        await saveMemories(memories);
        return { action: "reinforced", id: match.id };
      }
    }
  }

  // Step 3: Keyword dedup fallback (belt + suspenders)
  const existing = memories.find((m) => isDuplicateMemory(m, memoryData));
  if (existing) {
    existing.mentions  = (existing.mentions || 1) + 1;
    existing.updatedAt = Date.now();
    await saveMemories(memories);
    return { action: "reinforced", id: existing.id };
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
  return { action: "added", id: newMemory.id };
};

// Score a memory for relevance to current generation context
const scoreMemory = (memory, platformKey, contextKeywords) => {
  const daysSince = (Date.now() - (memory.updatedAt || memory.createdAt)) / 86400000;
  const recency = Math.exp(-daysSince / 60); // 60-day half-life
  const freq = Math.log(1 + (memory.mentions || 1));
  const importance = memory.importance || 2;

  let relevance = 0.5;
  // Same-platform boost
  if (memory.source && platformKey && memory.source.includes(platformKey)) relevance = 1.0;

  // Keyword match against page context
  const memKeys = [
    ...(memory.tags || []),
    ...(memory.entities || []).map((e) => e.toLowerCase()),
  ];
  const kwMatch = memKeys.some((k) => contextKeywords.some((w) => w.length > 3 && (w.includes(k) || k.includes(w))));
  if (kwMatch) relevance = Math.max(relevance, 1.4);

  return importance * freq * recency * relevance;
};

// getRelevantMemories: tries semantic retrieval first; falls back to keyword scoring.
// Only "active" tier memories are considered — archived memories are excluded.
const getRelevantMemories = async (platformKey, pageContextText = "", provider = null, apiKey = null) => {
  const memories = await getMemories();
  const active = memories.filter((m) => !m.private && m.tier !== "archived");

  // Persona = user's writing DNA — always injected, never scored out
  const persona = active.filter((m) => m.category === "persona");
  const nonPersona = active.filter((m) => m.category !== "persona");

  let contextual;

  // Try semantic retrieval when embeddings are available
  if (pageContextText && provider && apiKey && provider !== "anthropic") {
    const embeddingIndex = await getEmbeddingIndex();
    const queryEmbedding = await generateEmbedding(
      pageContextText.slice(0, 500), provider, apiKey
    );
    if (queryEmbedding) {
      contextual = nonPersona
        .map((m) => {
          const emb = embeddingIndex[m.id];
          const semanticScore = emb ? dotProduct(queryEmbedding, emb) : 0;
          const importanceBoost = (m.importance || 2) / 5;
          const recency = Math.exp(
            -(Date.now() - (m.updatedAt || m.createdAt)) / (86400000 * 60)
          );
          return { m, score: semanticScore * 0.6 + importanceBoost * 0.25 + recency * 0.15 };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, 6)
        .map(({ m }) => m);
    }
  }

  // Keyword fallback (also used when no page context or Anthropic provider)
  if (!contextual) {
    const contextWords = pageContextText.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    contextual = nonPersona
      .map((m) => ({ m, score: scoreMemory(m, platformKey, contextWords) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 6)
      .map(({ m }) => m);
  }

  return { persona, contextual };
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
      "You are writing an email in Gmail. Be professional yet personable. Match the conversation thread tone. Keep emails clear and concise. Use appropriate greeting and sign-off when the context calls for it.",
  },
  linkedin: {
    name: "LinkedIn",
    instructions:
      "You are writing on LinkedIn. Be professional yet authentic and genuinely human. For messages: warm, direct, and get to the point. For posts: insightful, genuine, thought-provoking. For comments: thoughtful and additive. Never sound like a corporate account or a recruiter template.",
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

// Single unified prompt builder — adapts to any platform/action
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
}) => {
  const profile =
    PLATFORM_PROFILES[platformKey] || PLATFORM_PROFILES.general;
  const taskInstruction =
    ACTION_INSTRUCTIONS[action] || ACTION_INSTRUCTIONS.generate;

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
      ].join(" ");

  // Persona voice is always appended — it is the user's writing DNA and must shape every response
  const system = personaVoice ? `${baseSystem}\n\n${personaVoice}` : baseSystem;

  const userParts = [];

  if (generalContext?.trim()) {
    userParts.push(`=== Your Background ===\n${generalContext.trim()}`);
  }

  if (learnedMemory?.trim()) {
    userParts.push(learnedMemory.trim());
  }

  if (Array.isArray(capturedContexts) && capturedContexts.length > 0) {
    capturedContexts.forEach((ctx) => {
      if (ctx?.text) {
        const label = ctx.title || ctx.hostname || ctx.url || "another page";
        userParts.push(`=== Context from: ${label} ===\n${ctx.text.trim()}`);
      }
    });
  }

  if (pageContext?.trim()) {
    userParts.push(`=== Current Page Context ===\n${pageContext.trim()}`);
  }

  if (question?.trim()) {
    userParts.push(`=== Field / Question ===\n${question.trim()}`);
  }

  if (fieldValue?.trim()) {
    userParts.push(`=== Existing Content ===\n${fieldValue.trim()}`);
  }

  if (instruction?.trim()) {
    userParts.push(`=== Additional Instruction ===\n${instruction.trim()}`);
  }

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

  // ── Append a confirmed memory insight from user action toast ────────────────
  if (message?.type === "appendToMemory") {
    (async () => {
      try {
        const { category: rawCat, content } = message;
        if (!content?.trim()) { sendResponse({ ok: false, error: "Empty content" }); return; }
        const validCats = new Set(["work", "social", "personal", "persona"]);
        const category = validCats.has(rawCat) ? rawCat : "persona";

        const { provider, openaiKey, geminiKey } = await chrome.storage.local.get([
          "provider", "openaiKey", "geminiKey",
        ]);
        const embedProvider = provider || "openai";
        const embedKey = embedProvider === "gemini" ? geminiKey : openaiKey;

        const result = await addMemory({
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
        }, embedProvider, embedKey);
        sendResponse({ ok: true, ...result });
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

  if (message?.type === "saveMemory") {
    (async () => {
      try {
        const { provider, openaiKey, geminiKey } = await chrome.storage.local.get([
          "provider", "openaiKey", "geminiKey",
        ]);
        const embedProvider = provider || "openai";
        const embedKey = embedProvider === "gemini" ? geminiKey : openaiKey;
        const result = await addMemory(message.memory, embedProvider, embedKey);
        sendResponse({ ok: true, ...result });
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
        memories[idx] = { ...memories[idx], ...message.changes, updatedAt: Date.now() };
        await saveMemories(memories);
        sendResponse({ ok: true });
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
            const result = await addMemory({
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
            });
            if (result.action === "added") {
              links.push({ type: "job_saved", content: `Saved: ${entity.company}`, action: "added" });
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
          "- Maximum 2 entries per call\n" +
          "- type: one of current_role, skill, job_target, project, relationship, interest, location, preference, writing_style, tone, voice_pattern\n\n" +
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
          const validMemories = (parsed.memories || []).filter(
            (m) => m.category && m.content && typeof m.confidence === "number" && m.confidence >= 0.85
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

      const structuredContext = buildContextBlock(platformKey, {
        workContext:   workContextText   || "",
        socialContext: socialContextText || "",
        alwaysContext: alwaysContextText || "",
      });

      // Retrieve relevant learned memories for this platform + context.
      // Pass provider/apiKey for semantic (embedding-based) retrieval when available.
      const embedKey = activeProvider === "gemini" ? geminiKey : openaiKey;
      const { persona, contextual } = await getRelevantMemories(
        platformKey, message.pageContext || "", activeProvider, embedKey
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

// Backfill: on startup, generate embeddings for any memory that lacks one.
// Uses 100ms delay between calls to avoid rate-limiting.
const backfillEmbeddings = async () => {
  const { provider, openaiKey, geminiKey } = await chrome.storage.local.get([
    "provider", "openaiKey", "geminiKey",
  ]);
  const embedProvider = provider || "openai";
  const apiKey = embedProvider === "gemini" ? geminiKey : openaiKey;
  if (!apiKey || embedProvider === "anthropic") return;

  const memories = await getMemories();
  const embeddingIndex = await getEmbeddingIndex();

  let changed = false;
  for (const m of memories) {
    if (embeddingIndex[m.id]) continue;
    try {
      const emb = await generateEmbedding(m.content, embedProvider, apiKey);
      if (emb) {
        embeddingIndex[m.id] = emb;
        changed = true;
      }
    } catch (_) { /* skip on error — will retry next startup */ }
    await new Promise((r) => setTimeout(r, 100)); // gentle rate limiting
  }

  if (changed) await setEmbeddingIndex(embeddingIndex);
};

// On startup: increment session counter, run forgetting cycle (max once/week), backfill embeddings
const onStartupInit = async () => {
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
  // Backfill runs every startup but is a no-op if all memories are already embedded
  backfillEmbeddings(); // fire-and-forget
};

chrome.runtime.onStartup.addListener(onStartupInit);
chrome.runtime.onInstalled.addListener(onStartupInit);
