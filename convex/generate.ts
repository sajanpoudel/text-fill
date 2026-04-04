import { v } from "convex/values";
import { action } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internal } from "./_generated/api";
import { resolveEmbeddingConfig } from "./embeddingConfig";
import { getMemoryFingerprint } from "./memoryRules";

// ── Platform → context routing ────────────────────────────────────────────────
// Which context types (work / social / always) are relevant per platform.
// Canvas gets nothing — academic mode ignores personal/career context.

const PLATFORM_CONTEXTS: Record<string, string[]> = {
  gmail:     ["work", "always"],
  linkedin:  ["work", "social", "always"],
  messenger: ["social", "always"],
  twitter:   ["social", "always"],
  facebook:  ["social", "always"],
  threads:   ["social", "always"],
  reddit:    ["social", "always"],
  youtube:   ["social", "always"],
  instagram: ["social", "always"],
  slack:     ["work", "always"],
  discord:   ["social", "always"],
  canvas:     [],
  googledocs: ["work", "always"],
  general:    ["work", "social", "always"],
};

// Build structured context block from the user's stored work/social/always text
function buildContextBlock(
  platformKey: string,
  parsed: { work?: string; social?: string; always?: string } | null
): string | null {
  const keys = PLATFORM_CONTEXTS[platformKey] ?? PLATFORM_CONTEXTS.general;
  const parts: string[] = [];
  if (keys.includes("work") && parsed?.work?.trim())
    parts.push(`=== Career & Work ===\n${parsed.work.trim()}`);
  if (keys.includes("social") && parsed?.social?.trim())
    parts.push(`=== Social & Personal ===\n${parsed.social.trim()}`);
  if (keys.includes("always") && parsed?.always?.trim())
    parts.push(`=== General (always active) ===\n${parsed.always.trim()}`);
  return parts.length ? parts.join("\n\n") : null;
}

function parseContextText(contextText: string | undefined): { work?: string; social?: string; always?: string } | null {
  if (!contextText) return null;
  try {
    return JSON.parse(contextText);
  } catch {
    return { always: contextText }; // legacy plain text
  }
}

// ── Platform writing profiles ─────────────────────────────────────────────────
// Domain-aware writing instructions — automatically applied based on the site

const PLATFORM_PROFILES: Record<string, { name: string; instructions: string; maxLength?: number }> = {
  gmail: {
    name: "Gmail",
    instructions:
      "You are writing an email in Gmail. Be professional yet personable. Be humane and genuine when needed. Match the conversation thread tone. Keep emails clear and concise. Use appropriate greeting and sign-off when the context calls for it.",
  },
  linkedin: {
    name: "LinkedIn",
    instructions:
      "You are writing on LinkedIn. Be authentic and genuinely human. For InMail and direct messages: structure with clear paragraphs (blank line between each paragraph) — never write a wall of text; open with a specific observation about the recipient, then your relevant value, then a clear ask. For posts: insightful, genuine, thought-provoking. For comments: thoughtful and additive. Never sound like a corporate recruiter template.",
  },
  messenger: {
    name: "Messenger",
    instructions:
      "You are writing in a private chat on Messenger. Sound like a real person texting someone they know. Be warm, direct, and natural. Use the thread context heavily. Do not sound professional, polished, or formal unless the conversation clearly is.",
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
  threads: {
    name: "Threads",
    instructions:
      "You are writing a Threads post or reply. Be casual, authentic, and conversational.",
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
  canvas: {
    name: "Canvas LMS",
    instructions:
      "You are writing for a class assignment or discussion in Canvas. Follow the prompt and rubric exactly. Prioritize clarity, structure, and evidence. Use the requested academic tone and citation style when specified.",
  },
  googledocs: {
    name: "Google Docs",
    instructions:
      "You are writing content for a Google Docs document. Structure your response with appropriate paragraphs. Match the document's existing style and tone. Use clear, well-organized prose.",
  },
  general: {
    name: "General",
    instructions:
      "You are a writing assistant. Adapt your tone to what the context calls for — professional for formal contexts, conversational for casual ones, concise for quick replies, detailed for complex questions.",
  },
};

// ── Action instructions ───────────────────────────────────────────────────────

const ACTION_INSTRUCTIONS: Record<string, string> = {
  generate:
    "Write the best possible response for this context. Match the length and tone to what the situation calls for.",
  rewrite:
    "Rewrite and improve the existing content. Keep the same core meaning and intent, but make it more polished, natural, and effective.",
  shorten:
    "Rewrite the existing content to be significantly more concise. Cut everything unnecessary while preserving all key points.",
  expand:
    "Expand the existing content with more detail, context, examples, and depth. Keep it coherent and on-point.",
};

// ── Normalize output text ─────────────────────────────────────────────────────
// Matches the original normalizeAnswer() from background.js

function normalizeAnswer(text: string): string {
  return text
    .replace(/[—–]/g, ",")
    .replace(/\*\s*\*\s*\*/g, "\n\n")
    .replace(/[ \t]*,[ \t]*/g, ", ")
    .replace(/\s+\./g, ".")
    .replace(/\s+\!/g, "!")
    .replace(/\s+\?/g, "?")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

// ── Prompt builder ────────────────────────────────────────────────────────────
// Ported from background.js buildPrompt() — same structure and priority rules

interface CapturedCtx {
  title?: string;
  url?: string;
  hostname?: string;
  text: string;
}

function buildPrompt(opts: {
  instruction: string;
  action: string;
  pageContext: string;
  capturedContexts?: CapturedCtx[];
  memoryContext: string;
  platform: string;
  userContextText?: string;
  existingText?: string;
  systemPromptOverride?: string;
}): { system: string; user: string } {
  const {
    instruction,
    action,
    pageContext,
    capturedContexts,
    memoryContext,
    platform,
    userContextText,
    existingText,
    systemPromptOverride,
  } = opts;
  const activeCaptured = (capturedContexts ?? []).filter((c) => c.text?.trim());

  const profile = PLATFORM_PROFILES[platform] ?? PLATFORM_PROFILES.general;
  const academicMode = platform === "canvas";
  const hasCapturedContext = activeCaptured.length > 0;
  const taskInstruction = ACTION_INSTRUCTIONS[action] ?? ACTION_INSTRUCTIONS.generate;

  // ── System prompt ──────────────────────────────────────────────────────────
  const baseSystem = systemPromptOverride?.trim()
    ? systemPromptOverride.trim()
    : [
        "You are a precise, helpful writing assistant.",
        profile.instructions,
        "Write clear, natural responses that sound authentically human — never AI-generated.",
        "Be specific and use details from the provided context.",
        "Match the expected length and structure to the context: short for chats/comments, properly structured with paragraph breaks for emails/messages/posts.",
        "For emails and messages: use paragraph breaks (blank line between paragraphs) — NEVER write a wall of text. For short fields (chats, comments, tweets): single block is fine.",
        "Use plain punctuation only — no em dashes, asterisks, or bullet points unless the field clearly expects them.",
        "Avoid: generic AI openers ('Certainly!', 'Sure!', 'I\\'d be happy to', 'I hope this finds you well'), disclaimers, filler, excessive politeness.",
        "Start directly. No preamble.",
        "Use active voice. Be confident, specific, and genuine.",
        "When personal context is provided, use it naturally without explicitly referencing it ('based on my background' → just use the background).",
        "Context priority: Foreground Context (the current page/recipient/situation) is ABSOLUTE — it defines who you are writing to right now and must not be contradicted. Additional Instruction is high priority. About the Writer and Writer's Known Facts provide background on the writer's voice, style, and general credentials ONLY — never use them to claim the writer is currently applying to a specific company, in a specific role, or in a past situation that may no longer apply. If a memory-based fact conflicts with what Foreground Context shows, discard the memory and trust Foreground Context.",
        hasCapturedContext
          ? "When User-selected Context exists, treat it as required source material and use concrete details from it unless it conflicts with explicit instructions."
          : "",
        academicMode
          ? "Academic mode: prioritize assignment prompt, rubric, and question only. Ignore unrelated personal/career memory unless the user explicitly asks to include it."
          : "",
      ]
        .filter(Boolean)
        .join(" ");

  // ── User prompt ────────────────────────────────────────────────────────────
  const userParts: string[] = [];

  if (pageContext?.trim()) {
    userParts.push(`=== Foreground Context (Highest Priority) ===\n${pageContext.trim().slice(0, 2000)}`);
  }

  if (instruction?.trim()) {
    userParts.push(`=== Additional Instruction (High Priority) ===\n${instruction.trim()}`);
  }

  if (hasCapturedContext) {
    userParts.push(
      `=== Required Use of User-selected Context ===\nUse concrete facts from the User-selected Context blocks below. Do not ignore them.`
    );
    activeCaptured.forEach((ctx) => {
      const label = ctx.title || ctx.hostname || ctx.url || "captured page";
      userParts.push(
        `=== User-selected Context (High Priority): ${label} ===\n${ctx.text.trim().slice(0, 2600)}`
      );
    });
  }

  if (existingText?.trim()) {
    userParts.push(`=== Existing Content ===\n${existingText.trim()}`);
  }

  if (!academicMode && userContextText?.trim()) {
    userParts.push(`=== About the Writer ===\n${userContextText.trim()}`);
  }

  if (!academicMode && memoryContext?.trim()) {
    userParts.push(`=== Writer's Known Facts ===\n${memoryContext.trim()}`);
  }

  if (profile.maxLength) {
    userParts.push(`=== Field Guidance ===\nMax length: ${profile.maxLength} characters`);
  }

  userParts.push(`=== Task ===\n${taskInstruction}`);

  return { system: baseSystem, user: userParts.join("\n\n") };
}

// ── Multi-provider LLM call ───────────────────────────────────────────────────

async function callProvider(opts: {
  provider: string;
  model: string;
  apiKey: string;
  system: string;
  user: string;
}): Promise<string> {
  const { provider, model, apiKey, system, user } = opts;

  if (provider === "anthropic") {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
    const data = await res.json() as any;
    if (!res.ok) throw new Error(`Anthropic error: ${data?.error?.message ?? JSON.stringify(data)}`);
    return (data.content?.[0]?.text ?? "").trim();
  }

  if (provider === "gemini") {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${system}\n\n${user}` }] }],
          generationConfig: {
            maxOutputTokens: 2048,
            temperature: 0.7,
          },
        }),
      }
    );
    const data = await res.json() as any;
    if (!res.ok) throw new Error(`Gemini error: ${data?.error?.message ?? JSON.stringify(data)}`);
    return (data.candidates?.[0]?.content?.parts ?? [])
      .map((p: any) => p.text ?? "")
      .join("")
      .trim();
  }

  // Default: OpenAI Responses API
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, instructions: system, input: user }),
  });
  const data = await res.json() as any;
  if (!res.ok) throw new Error(`OpenAI error: ${data?.error?.message ?? JSON.stringify(data)}`);

  if (typeof data?.output_text === "string" && data.output_text) {
    return data.output_text.trim();
  }
  const parts: string[] = [];
  for (const item of (data?.output ?? [])) {
    if (item?.type === "message" && Array.isArray(item?.content)) {
      for (const c of item.content) {
        if (c?.type === "output_text" && typeof c?.text === "string") parts.push(c.text);
      }
    }
  }
  if (parts.length > 0) return parts.join("\n").trim();
  throw new Error("Could not parse OpenAI response");
}

// ── Get API key for active provider ──────────────────────────────────────────

function resolveApiKey(profile: {
  provider?: string;
  openaiKey?: string;
  anthropicKey?: string;
  geminiKey?: string;
} | null): { provider: string; apiKey: string | null } {
  const provider = profile?.provider ?? "openai";
  const apiKey =
    provider === "anthropic" ? (profile?.anthropicKey ?? null)
    : provider === "gemini"  ? (profile?.geminiKey   ?? null)
    : (profile?.openaiKey ?? null);
  return { provider, apiKey };
}

// ── Main generation action ────────────────────────────────────────────────────

const capturedCtxSchema = v.object({
  id: v.optional(v.string()),
  title: v.optional(v.string()),
  url: v.optional(v.string()),
  hostname: v.optional(v.string()),
  text: v.string(),
  time: v.optional(v.number()),
  active: v.optional(v.boolean()),
});

// Tone (1=Casual … 5=Formal) and domain modifiers for the generate action
const TONE_MODIFIERS: Record<number, string> = {
  1: "extremely casual and conversational — like texting a close friend",
  2: "casual and relaxed, friendly and approachable",
  4: "professional and polished, business-appropriate",
  5: "formal and precise, suitable for official or legal correspondence",
};

const DOMAIN_MODIFIERS: Record<string, string> = {
  sales: "Persuasive sales framing: lead with value and benefits, end with a clear low-friction call to action. Be compelling but authentic, never pushy.",
  legal: "Legal/compliance precision: be unambiguous and definitive. Use clear language without colloquialisms. Avoid hedging unless factually necessary.",
  technical: "Technical domain: use accurate terminology. Be specific and concrete. Explain complex concepts clearly without dumbing down.",
  academic: "Academic writing: evidence-based reasoning, formal structure, avoid personal anecdotes unless instructed. Cite or acknowledge uncertainty where appropriate.",
};

export const generate = action({
  args: {
    instruction: v.string(),
    pageContext: v.optional(v.string()),
    capturedContexts: v.optional(v.array(capturedCtxSchema)),
    platform: v.optional(v.string()),
    threadId: v.optional(v.string()),
    fieldMaxLength: v.optional(v.number()),
    tone: v.optional(v.number()),
    domain: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ text: string; threadId: string }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const profile = await ctx.runQuery(internal.users._getProfileByUserId, { userId });
    const { provider, apiKey } = resolveApiKey(profile);
    if (!apiKey) throw new Error(`Missing API key for ${provider}. Add it in Settings.`);

    const platform = args.platform ?? "general";

    // Vector search for relevant memories
    const searchQuery = `${args.instruction} ${(args.pageContext ?? "").slice(0, 200)}`;
    const embeddingConfig = resolveEmbeddingConfig(profile);
    const memories: Array<{
      _id: string;
      text: string;
      platform?: string;
      status: string;
      createdAt: number;
      score: number;
    }> =
      embeddingConfig.ok
        ? await ctx.runAction(internal.embeddings.vectorSearch, {
            userId,
            queryText: searchQuery,
            provider: embeddingConfig.provider,
            model: embeddingConfig.model,
            apiKey: embeddingConfig.apiKey,
            limit: 8,
          })
        : [];

    // Patterns that indicate ephemeral application/outreach events — these
    // should never surface as "facts" when writing to a different person.
    const EPHEMERAL_PATTERNS =
      /\b(applied to|submitted.*application|sent.*application|applying to|interviewing at|interview at|application.*to|outreach to|reached out to)\b/i;

    const relevantMemories = memories
      .filter((m) => m.status === "active" && m.score > 0.65)
      // Drop ephemeral application-event memories that have no place in
      // connection notes, DMs, or any message to a specific recipient.
      .filter((m) => !EPHEMERAL_PATTERNS.test(m.text))
      .filter((memory, index, all) => {
        const fingerprint = getMemoryFingerprint({
          text: memory.text,
          tags: [],
          platform: memory.platform,
        });
        return (
          all.findIndex((candidate) =>
            getMemoryFingerprint({
              text: candidate.text,
              tags: [],
              platform: candidate.platform,
            }) === fingerprint
          ) === index
        );
      });
    // Cap each memory entry and the total block to avoid flooding the context
    const memoryContext = relevantMemories
      .map((m) => `- ${m.text.slice(0, 120)}`)
      .join("\n")
      .slice(0, 600);

    // Build platform-filtered context from user's work/social/always sections
    const parsed = parseContextText(profile?.contextText);
    const userContextText = buildContextBlock(platform, parsed) ?? undefined;

    const rawPageCtx = args.pageContext ?? "";
    const isConnectNote =
      rawPageCtx.trimStart().startsWith("[CONNECT_NOTE_300]") ||
      // Fallback: fieldMaxLength=300 sent directly from the content script
      (args.fieldMaxLength === 300 && platform === "linkedin");

    const isInmail = rawPageCtx.includes("[INMAIL_MESSAGE]") || rawPageCtx.includes("[INMAIL_SUBJECT]");
    const isDm = rawPageCtx.includes("[DM_MESSAGE]");
    const isComment = rawPageCtx.includes("[COMMENT]");
    const isPost = rawPageCtx.includes("[POST_COMPOSE]");

    // Effective char limit: prefer explicit fieldMaxLength over hardcoded 300
    const charLimit = args.fieldMaxLength ?? (isConnectNote ? 300 : null);

    let { system, user } = buildPrompt({
      instruction: args.instruction,
      action: "generate",
      pageContext: rawPageCtx,
      capturedContexts: args.capturedContexts,
      memoryContext,
      platform,
      userContextText,
      systemPromptOverride: profile?.systemPrompt,
    });

    if (isConnectNote) {
      system += "\n\nCRITICAL: This is a LinkedIn connection note with a HARD 300-character limit. Your entire response MUST be 300 characters or fewer. Count every character carefully. Base the note ONLY on the recipient's profile shown in Foreground Context. Do NOT reference specific past job applications, companies the writer has applied to, or past interactions from memory — those are from completely different contexts and would be false and embarrassing here.";
      user += "\n\n=== HARD CHARACTER LIMIT ===\nMaximum 300 characters total. Write a brief, genuine connection note that stays strictly under 300 characters.";
    } else if (isInmail) {
      system += "\n\nThis is a LinkedIn InMail message. Write 2-4 short paragraphs: open with a specific observation about the recipient from Foreground Context, then your relevant value or reason for reaching out, then a clear low-friction ask. Each paragraph should be 1-3 sentences. Use a blank line between paragraphs. Do NOT reference specific past job applications or companies from memory — focus on what you can see about this specific recipient.";
    } else if (isDm) {
      system += "\n\nThis is a LinkedIn direct message in an ongoing conversation. Keep it conversational and concise — 1-3 short paragraphs at most.";
    } else if (isComment) {
      system += "\n\nThis is a LinkedIn comment. Keep it to 1-3 sentences — thoughtful, specific, and additive. No paragraph breaks needed.";
    } else if (isPost) {
      system += "\n\nThis is a LinkedIn post. Write in clear paragraphs with a blank line between each. Open strong, share a genuine insight or story, end with a thought or question. Avoid bullet points.";
    } else if (charLimit && charLimit > 0 && charLimit <= 600) {
      // Other short-limit fields (Twitter, etc.) — soft guidance
      system += `\n\nThis field has a ${charLimit}-character limit. Keep your response under ${charLimit} characters.`;
      user += `\n\nField character limit: ${charLimit}. Stay under ${charLimit} characters.`;
    }

    // Tone modifier (1=Casual … 5=Formal; 3=Balanced is the default, no modifier needed)
    const toneKey = args.tone !== undefined ? Math.round(args.tone) : 3;
    const toneMod = TONE_MODIFIERS[toneKey];
    if (toneMod) {
      system += `\n\nTone instruction: Write in a ${toneMod} tone.`;
    }

    // Domain modifier
    const domainMod = args.domain && args.domain !== "general" ? DOMAIN_MODIFIERS[args.domain] : null;
    if (domainMod) {
      system += `\n\nDomain instruction: ${domainMod}`;
    }

    const raw = await callProvider({
      provider,
      model: profile?.model ?? "gpt-5-nano",
      apiKey,
      system,
      user,
    });
    let text = normalizeAnswer(raw);

    // Hard-truncate to the field's character limit when one is known
    if (charLimit && charLimit > 0 && text.length > charLimit) {
      text = text.slice(0, charLimit).replace(/\s+\S*$/, "").trim();
    }

    // Track memory access
    const accessedIds = relevantMemories.map((m) => m._id).filter(Boolean) as any[];
    if (accessedIds.length > 0) {
      await ctx.runMutation(internal.memories.recordAccess, { memoryIds: accessedIds });
    }

    const threadId = args.threadId ?? `${userId}-${Date.now()}`;
    return { text, threadId };
  },
});

// ── Rewrite ───────────────────────────────────────────────────────────────────

export const rewrite = action({
  args: {
    existingText: v.string(),
    instruction: v.optional(v.string()),
    pageContext: v.optional(v.string()),
    capturedContexts: v.optional(v.array(capturedCtxSchema)),
    platform: v.optional(v.string()),
    threadId: v.optional(v.string()),
    fieldMaxLength: v.optional(v.number()),
  },
  handler: async (ctx, { existingText, instruction, pageContext, capturedContexts, platform, threadId }): Promise<{ text: string; threadId: string }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const profile = await ctx.runQuery(internal.users._getProfileByUserId, { userId });
    const { provider, apiKey } = resolveApiKey(profile);
    if (!apiKey) throw new Error(`Missing API key for ${provider}.`);

    const plat = platform ?? "general";
    const parsed = parseContextText(profile?.contextText);
    const userContextText = buildContextBlock(plat, parsed) ?? undefined;

    const { system, user } = buildPrompt({
      instruction: instruction ?? "Rewrite and improve this",
      action: "rewrite",
      pageContext: pageContext ?? "",
      capturedContexts,
      memoryContext: "",
      platform: plat,
      userContextText,
      existingText,
      systemPromptOverride: profile?.systemPrompt,
    });

    const raw = await callProvider({ provider, model: profile?.model ?? "gpt-5-nano", apiKey, system, user });
    return { text: normalizeAnswer(raw), threadId: threadId ?? "" };
  },
});

// ── Shorten ───────────────────────────────────────────────────────────────────

export const shorten = action({
  args: {
    existingText: v.string(),
    instruction: v.optional(v.string()),
    pageContext: v.optional(v.string()),
    capturedContexts: v.optional(v.array(capturedCtxSchema)),
    platform: v.optional(v.string()),
    threadId: v.optional(v.string()),
    fieldMaxLength: v.optional(v.number()),
  },
  handler: async (ctx, { existingText, platform, threadId }): Promise<{ text: string; threadId: string }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const profile = await ctx.runQuery(internal.users._getProfileByUserId, { userId });
    const { provider, apiKey } = resolveApiKey(profile);
    if (!apiKey) throw new Error(`Missing API key for ${provider}.`);

    const plat = platform ?? "general";
    const { system, user } = buildPrompt({
      instruction: "Shorten this",
      action: "shorten",
      pageContext: "",
      memoryContext: "",
      platform: plat,
      existingText,
      systemPromptOverride: profile?.systemPrompt,
    });

    const raw = await callProvider({ provider, model: profile?.model ?? "gpt-5-nano", apiKey, system, user });
    return { text: normalizeAnswer(raw), threadId: threadId ?? "" };
  },
});

// ── Expand ────────────────────────────────────────────────────────────────────

export const expand = action({
  args: {
    existingText: v.string(),
    instruction: v.optional(v.string()),
    pageContext: v.optional(v.string()),
    capturedContexts: v.optional(v.array(capturedCtxSchema)),
    platform: v.optional(v.string()),
    threadId: v.optional(v.string()),
    fieldMaxLength: v.optional(v.number()),
  },
  handler: async (ctx, { existingText, platform, threadId }): Promise<{ text: string; threadId: string }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const profile = await ctx.runQuery(internal.users._getProfileByUserId, { userId });
    const { provider, apiKey } = resolveApiKey(profile);
    if (!apiKey) throw new Error(`Missing API key for ${provider}.`);

    const plat = platform ?? "general";
    const { system, user } = buildPrompt({
      instruction: "Expand this with more detail and depth",
      action: "expand",
      pageContext: "",
      memoryContext: "",
      platform: plat,
      existingText,
      systemPromptOverride: profile?.systemPrompt,
    });

    const raw = await callProvider({ provider, model: profile?.model ?? "gpt-5-nano", apiKey, system, user });
    return { text: normalizeAnswer(raw), threadId: threadId ?? "" };
  },
});
