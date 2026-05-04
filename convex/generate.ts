import { v } from "convex/values";
import { action, type ActionCtx } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internal } from "./_generated/api";
import { resolveEmbeddingConfig } from "./embeddingConfig";
import { callProvider, resolveApiKey } from "./llmProvider";
import { getMemoryFingerprint } from "./memoryRules";
import type { Id } from "./_generated/dataModel";

const PLATFORM_CONTEXTS: Record<string, string[]> = {
  gmail: ["work", "always"],
  linkedin: ["work", "social", "always"],
  messenger: ["social", "always"],
  twitter: ["social", "always"],
  facebook: ["social", "always"],
  threads: ["social", "always"],
  reddit: ["social", "always"],
  youtube: ["social", "always"],
  instagram: ["social", "always"],
  slack: ["work", "always"],
  discord: ["social", "always"],
  canvas: [],
  googledocs: ["work", "always"],
  general: ["work", "social", "always"],
};

function buildContextBlock(
  platformKey: string,
  parsed: { work?: string; social?: string; always?: string } | null
): string | null {
  const keys = PLATFORM_CONTEXTS[platformKey] ?? PLATFORM_CONTEXTS.general;
  const parts: string[] = [];
  if (keys.includes("work") && parsed?.work?.trim()) {
    parts.push(`=== Career & Work ===\n${parsed.work.trim()}`);
  }
  if (keys.includes("social") && parsed?.social?.trim()) {
    parts.push(`=== Social & Personal ===\n${parsed.social.trim()}`);
  }
  if (keys.includes("always") && parsed?.always?.trim()) {
    parts.push(`=== General (always active) ===\n${parsed.always.trim()}`);
  }
  return parts.length ? parts.join("\n\n") : null;
}

function parseContextText(
  contextText: string | undefined
): { work?: string; social?: string; always?: string } | null {
  if (!contextText) return null;
  try {
    return JSON.parse(contextText);
  } catch {
    return { always: contextText };
  }
}

const PLATFORM_PROFILES: Record<
  string,
  { name: string; instructions: string; maxLength?: number }
> = {
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

interface CapturedCtx {
  id?: string;
  title?: string;
  url?: string;
  hostname?: string;
  text: string;
  time?: number;
  active?: boolean;
}

export function buildPrompt(opts: {
  instruction: string;
  action: string;
  pageContext: string;
  capturedContexts?: CapturedCtx[];
  memoryContext: string;
  proceduralContext?: string;
  episodicContext?: string;
  recipientContext?: string;
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
    proceduralContext,
    episodicContext,
    recipientContext,
    platform,
    userContextText,
    existingText,
    systemPromptOverride,
  } = opts;
  const activeCaptured = (capturedContexts ?? []).filter((c) => c.text?.trim());

  const profile = PLATFORM_PROFILES[platform] ?? PLATFORM_PROFILES.general;
  const academicMode = platform === "canvas";
  const hasCapturedContext = activeCaptured.length > 0;
  const taskInstruction =
    ACTION_INSTRUCTIONS[action] ?? ACTION_INSTRUCTIONS.generate;

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

  const userParts: string[] = [];

  if (pageContext?.trim()) {
    userParts.push(
      `=== Foreground Context (Highest Priority) ===\n${pageContext.trim().slice(0, 2000)}`
    );
  }

  if (instruction?.trim()) {
    userParts.push(
      `=== Additional Instruction (High Priority) ===\n${instruction.trim()}`
    );
  }

  if (hasCapturedContext) {
    userParts.push(
      "=== Required Use of User-selected Context ===\nUse concrete facts from the User-selected Context blocks below. Do not ignore them."
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

  if (!academicMode && proceduralContext?.trim()) {
    userParts.push(`=== Your Style Rules ===\n${proceduralContext.trim()}`);
  }

  if (!academicMode && episodicContext?.trim()) {
    userParts.push(`=== Recent Patterns ===\n${episodicContext.trim()}`);
  }

  if (!academicMode && recipientContext?.trim()) {
    userParts.push(
      `=== Recipient Context (transient) ===\n${recipientContext.trim()}`
    );
  }

  if (profile.maxLength) {
    userParts.push(
      `=== Field Guidance ===\nMax length: ${profile.maxLength} characters`
    );
  }

  userParts.push(`=== Task ===\n${taskInstruction}`);

  return { system: baseSystem, user: userParts.join("\n\n") };
}

export function deriveContextType(
  rawPageCtx: string,
  fieldMaxLength?: number,
  platform?: string
): string | undefined {
  if (rawPageCtx.startsWith("[CONNECT_NOTE_300]")) return "connection_req";
  if (
    rawPageCtx.includes("[INMAIL_MESSAGE]") ||
    rawPageCtx.includes("[INMAIL_SUBJECT]")
  ) {
    return "inmail";
  }
  if (rawPageCtx.includes("[DM_MESSAGE]")) return "dm";
  if (rawPageCtx.includes("[COMMENT]")) return "comment";
  if (rawPageCtx.includes("[POST_COMPOSE]")) return "post";
  if (platform === "linkedin" && fieldMaxLength === 300) {
    return "connection_req";
  }
  return undefined;
}

function buildPromptFingerprint(system: string, user: string): string {
  const text = `${system}\n---\n${user}`;
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a:${(hash >>> 0).toString(16)}`;
}

function shouldCaptureFullTraceArtifacts(): boolean {
  const env =
    typeof process !== "undefined" && process?.env ? process.env : undefined;
  if (
    env?.TRACE_FULL_PROMPT === "0" ||
    env?.TEXT_FILL_TRACE_FULL_PROMPT === "0"
  ) {
    return false;
  }
  return true;
}

const capturedCtxSchema = v.object({
  id: v.optional(v.string()),
  title: v.optional(v.string()),
  url: v.optional(v.string()),
  hostname: v.optional(v.string()),
  text: v.string(),
  time: v.optional(v.number()),
  active: v.optional(v.boolean()),
});

const TONE_MODIFIERS: Record<number, string> = {
  1: "extremely casual and conversational — like texting a close friend",
  2: "casual and relaxed, friendly and approachable",
  4: "professional and polished, business-appropriate",
  5: "formal and precise, suitable for official or legal correspondence",
};

const DOMAIN_MODIFIERS: Record<string, string> = {
  sales:
    "Persuasive sales framing: lead with value and benefits, end with a clear low-friction call to action. Be compelling but authentic, never pushy.",
  legal:
    "Legal/compliance precision: be unambiguous and definitive. Use clear language without colloquialisms. Avoid hedging unless factually necessary.",
  technical:
    "Technical domain: use accurate terminology. Be specific and concrete. Explain complex concepts clearly without dumbing down.",
  academic:
    "Academic writing: evidence-based reasoning, formal structure, avoid personal anecdotes unless instructed. Cite or acknowledge uncertainty where appropriate.",
};

type RetrievedMemory = {
  _id: string;
  text: string;
  platform?: string;
  status: string;
  createdAt: number;
  score: number;
  invalidAt?: number;
};

const EPHEMERAL_PATTERNS =
  /\b(applied to|submitted.*application|sent.*application|applying to|interviewing at|interview at|application.*to|outreach to|reached out to)\b/i;

async function loadRetrievalContext(
  ctx: ActionCtx,
  {
    userId,
    profile,
    platform,
    instruction,
    pageContext,
    existingText,
    contextType,
  }: {
    userId: Id<"users">;
    profile: any;
    platform: string;
    instruction: string;
    pageContext?: string;
    existingText?: string;
    contextType?: string;
  }
) {
  const searchQuery = [
    instruction,
    (pageContext ?? "").slice(0, 200),
    (existingText ?? "").slice(0, 200),
  ]
    .filter(Boolean)
    .join(" ");

  const embeddingConfig = resolveEmbeddingConfig(profile);
  const memories: RetrievedMemory[] =
    embeddingConfig.ok && searchQuery.trim()
      ? await ctx.runAction(internal.embeddings.vectorSearch, {
          userId,
          queryText: searchQuery,
          provider: embeddingConfig.provider,
          model: embeddingConfig.model,
          apiKey: embeddingConfig.apiKey,
          limit: 8,
        })
      : [];

  const relevantMemories = memories
    .filter(
      (memory) =>
        memory.status === "active" &&
        memory.invalidAt === undefined &&
        memory.score > 0.65
    )
    .filter((memory) => !EPHEMERAL_PATTERNS.test(memory.text))
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

  const memoryContext = relevantMemories
    .map((memory) => `- ${memory.text.slice(0, 120)}`)
    .join("\n")
    .slice(0, 600);

  const [proceduralRules, recentEpisodes] = await Promise.all([
    ctx.runQuery(internal.retrieval.getProceduralPatterns, {
      userId,
      platform,
      contextType,
    }),
    ctx.runQuery(internal.retrieval.getRecentEpisodes, {
      userId,
      platform,
      contextType,
      limit: 3,
    }),
  ]);

  const parsed = parseContextText(profile?.contextText);
  const userContextText = buildContextBlock(platform, parsed) ?? undefined;

  return {
    relevantMemories,
    memoryContext,
    proceduralRules,
    recentEpisodes,
    userContextText,
  };
}

async function executeTextAction(
  ctx: ActionCtx,
  args: {
    actionName: "generate" | "rewrite" | "shorten" | "expand";
    instruction: string;
    pageContext?: string;
    capturedContexts?: CapturedCtx[];
    platform?: string;
    threadId?: string;
    fieldMaxLength?: number;
    tone?: number;
    domain?: string;
    recipientContext?: string;
    existingText?: string;
  }
): Promise<{ text: string; threadId: string; traceId?: string }> {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("Not authenticated");

  const profile = await ctx.runQuery(internal.users._getProfileByUserId, {
    userId,
  });
  const { provider, apiKey } = resolveApiKey(profile);
  if (!apiKey) {
    throw new Error(`Missing API key for ${provider}. Add it in Settings.`);
  }

  const platform = args.platform ?? "general";
  const rawPageCtx = args.pageContext ?? "";
  const contextType = deriveContextType(
    rawPageCtx,
    args.fieldMaxLength,
    platform
  );

  const {
    relevantMemories,
    memoryContext,
    proceduralRules,
    recentEpisodes,
    userContextText,
  } = await loadRetrievalContext(ctx, {
    userId,
    profile,
    platform,
    instruction: args.instruction,
    pageContext: rawPageCtx,
    existingText: args.existingText,
    contextType,
  });

  const proceduralContext = proceduralRules.join("\n");
  const episodicContext = recentEpisodes.length
    ? recentEpisodes.join("\n")
    : "";

  const isConnectNote =
    rawPageCtx.trimStart().startsWith("[CONNECT_NOTE_300]") ||
    (args.fieldMaxLength === 300 && platform === "linkedin");
  const isInmail =
    rawPageCtx.includes("[INMAIL_MESSAGE]") ||
    rawPageCtx.includes("[INMAIL_SUBJECT]");
  const isDm = rawPageCtx.includes("[DM_MESSAGE]");
  const isComment = rawPageCtx.includes("[COMMENT]");
  const isPost = rawPageCtx.includes("[POST_COMPOSE]");
  const charLimit = args.fieldMaxLength ?? (isConnectNote ? 300 : null);

  let { system, user } = buildPrompt({
    instruction: args.instruction,
    action: args.actionName,
    pageContext: rawPageCtx,
    capturedContexts: args.capturedContexts,
    memoryContext,
    proceduralContext,
    episodicContext,
    recipientContext: args.recipientContext,
    platform,
    userContextText,
    existingText: args.existingText,
    systemPromptOverride: profile?.systemPrompt,
  });

  if (isConnectNote) {
    system +=
      "\n\nCRITICAL: This is a LinkedIn connection note with a HARD 300-character limit. Your entire response MUST be 300 characters or fewer. Count every character carefully. Base the note ONLY on the recipient's profile shown in Foreground Context. Do NOT reference specific past job applications, companies the writer has applied to, or past interactions from memory — those are from completely different contexts and would be false and embarrassing here.";
    user +=
      "\n\n=== HARD CHARACTER LIMIT ===\nMaximum 300 characters total. Write a brief, genuine connection note that stays strictly under 300 characters.";
  } else if (isInmail) {
    system +=
      "\n\nThis is a LinkedIn InMail message. Write 2-4 short paragraphs: open with a specific observation about the recipient from Foreground Context, then your relevant value or reason for reaching out, then a clear low-friction ask. Each paragraph should be 1-3 sentences. Use a blank line between paragraphs. Do NOT reference specific past job applications or companies from memory — focus on what you can see about this specific recipient.";
  } else if (isDm) {
    system +=
      "\n\nThis is a LinkedIn direct message in an ongoing conversation. Keep it conversational and concise — 1-3 short paragraphs at most.";
  } else if (isComment) {
    system +=
      "\n\nThis is a LinkedIn comment. Keep it to 1-3 sentences — thoughtful, specific, and additive. No paragraph breaks needed.";
  } else if (isPost) {
    system +=
      "\n\nThis is a LinkedIn post. Write in clear paragraphs with a blank line between each. Open strong, share a genuine insight or story, end with a thought or question. Avoid bullet points.";
  } else if (charLimit && charLimit > 0 && charLimit <= 600) {
    system += `\n\nThis field has a ${charLimit}-character limit. Keep your response under ${charLimit} characters.`;
    user += `\n\nField character limit: ${charLimit}. Stay under ${charLimit} characters.`;
  }

  if (args.actionName === "generate") {
    const toneKey = args.tone !== undefined ? Math.round(args.tone) : 3;
    const toneMod = TONE_MODIFIERS[toneKey];
    if (toneMod) {
      system += `\n\nTone instruction: Write in a ${toneMod} tone.`;
    }

    const domainMod =
      args.domain && args.domain !== "general"
        ? DOMAIN_MODIFIERS[args.domain]
        : null;
    if (domainMod) {
      system += `\n\nDomain instruction: ${domainMod}`;
    }
  }

  if (shouldCaptureFullTraceArtifacts()) {
    console.debug("[TFA Prompt]", {
      action: args.actionName,
      platform,
      contextType,
      systemPrompt: system,
      userPrompt: user,
    });
  }

  const modelId = profile?.model ?? "gpt-5-nano";
  const t0 = Date.now();
  const raw = await callProvider({
    provider,
    model: modelId,
    apiKey,
    system,
    user,
    maxOutputTokens: 2048,
    temperature: 0.7,
  });
  const latencyMs = Date.now() - t0;
  let text = normalizeAnswer(raw);

  if (charLimit && charLimit > 0 && text.length > charLimit) {
    text = text.slice(0, charLimit).replace(/\s+\S*$/, "").trim();
  }

  const accessedIds = relevantMemories.map((memory) => memory._id) as Id<"memories">[];
  if (accessedIds.length > 0) {
    await ctx.runMutation(internal.memories.recordAccess, {
      memoryIds: accessedIds,
    });
  }

  let traceId: Id<"traces"> | undefined;
  try {
    traceId = await ctx.runMutation(internal.traces.recordTrace, {
      userId,
      platform,
      modelId,
      promptFingerprint: buildPromptFingerprint(system, user),
      presentedOutput: text,
      hadLiveContext: !!args.recipientContext,
      retrievedPatternCount: proceduralRules.length,
      episodeExampleCount: recentEpisodes.length,
      latencyMs,
    });

    if (traceId && shouldCaptureFullTraceArtifacts()) {
      await ctx.runMutation(internal.traces.recordTraceArtifact, {
        traceId,
        systemPrompt: system,
        userPrompt: user,
        rawLlmOutput: raw,
      });
    }
  } catch {
    // Non-fatal
  }

  return {
    text,
    threadId: args.threadId ?? `${userId}-${Date.now()}`,
    traceId,
  };
}

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
    recipientContext: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args
  ): Promise<{ text: string; threadId: string; traceId?: string }> =>
    executeTextAction(ctx, {
      actionName: "generate",
      instruction: args.instruction,
      pageContext: args.pageContext,
      capturedContexts: args.capturedContexts,
      platform: args.platform,
      threadId: args.threadId,
      fieldMaxLength: args.fieldMaxLength,
      tone: args.tone,
      domain: args.domain,
      recipientContext: args.recipientContext,
    }),
});

export const rewrite = action({
  args: {
    existingText: v.string(),
    instruction: v.optional(v.string()),
    pageContext: v.optional(v.string()),
    capturedContexts: v.optional(v.array(capturedCtxSchema)),
    platform: v.optional(v.string()),
    threadId: v.optional(v.string()),
    fieldMaxLength: v.optional(v.number()),
    recipientContext: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args
  ): Promise<{ text: string; threadId: string; traceId?: string }> =>
    executeTextAction(ctx, {
      actionName: "rewrite",
      instruction: args.instruction ?? "Rewrite and improve this",
      pageContext: args.pageContext,
      capturedContexts: args.capturedContexts,
      platform: args.platform,
      threadId: args.threadId,
      fieldMaxLength: args.fieldMaxLength,
      recipientContext: args.recipientContext,
      existingText: args.existingText,
    }),
});

export const shorten = action({
  args: {
    existingText: v.string(),
    instruction: v.optional(v.string()),
    pageContext: v.optional(v.string()),
    capturedContexts: v.optional(v.array(capturedCtxSchema)),
    platform: v.optional(v.string()),
    threadId: v.optional(v.string()),
    fieldMaxLength: v.optional(v.number()),
    recipientContext: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args
  ): Promise<{ text: string; threadId: string; traceId?: string }> =>
    executeTextAction(ctx, {
      actionName: "shorten",
      instruction: args.instruction ?? "Shorten this",
      pageContext: args.pageContext,
      capturedContexts: args.capturedContexts,
      platform: args.platform,
      threadId: args.threadId,
      fieldMaxLength: args.fieldMaxLength,
      recipientContext: args.recipientContext,
      existingText: args.existingText,
    }),
});

export const expand = action({
  args: {
    existingText: v.string(),
    instruction: v.optional(v.string()),
    pageContext: v.optional(v.string()),
    capturedContexts: v.optional(v.array(capturedCtxSchema)),
    platform: v.optional(v.string()),
    threadId: v.optional(v.string()),
    fieldMaxLength: v.optional(v.number()),
    recipientContext: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args
  ): Promise<{ text: string; threadId: string; traceId?: string }> =>
    executeTextAction(ctx, {
      actionName: "expand",
      instruction:
        args.instruction ?? "Expand this with more detail and depth",
      pageContext: args.pageContext,
      capturedContexts: args.capturedContexts,
      platform: args.platform,
      threadId: args.threadId,
      fieldMaxLength: args.fieldMaxLength,
      recipientContext: args.recipientContext,
      existingText: args.existingText,
    }),
});
