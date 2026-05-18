import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import {
  action,
  type ActionCtx,
  internalAction,
  internalQuery,
} from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internal } from "./_generated/api";
import {
  canonicalizeMemoryText,
  getMemoryFingerprint,
  isLowSignalMemory,
  sanitizeMemoryText,
  scoreMemoryText,
} from "./memoryRules";

const EXTRACTION_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

// Get the most recent memory creation time for cooldown enforcement
export const _getLastMemoryTime = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const last = await ctx.db
      .query("memories")
      .withIndex("by_user_created", (q) => q.eq("userId", userId))
      .order("desc")
      .first();
    return last?.createdAt ?? null;
  },
});

export const _getExistingMemoryContext = internalQuery({
  args: {
    userId: v.id("users"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { userId, limit = 12 }) => {
    const memories = await ctx.db
      .query("memories")
      .withIndex("by_user_status", (q) =>
        q.eq("userId", userId).eq("status", "active")
      )
      .order("desc")
      .take(limit);

    return memories
      .map((memory) => {
        const category = memory.platform ? `[${memory.platform}] ` : "";
        return `- ${category}${memory.text}`;
      })
      .join("\n");
  },
});

// ── Extraction prompt ─────────────────────────────────────────────────────────

const EXTRACTION_PROMPT = `You are a high-precision personal memory extractor for a writing assistant.
Extract ONLY durable facts that will materially improve future writing for this same user.

Allowed categories:
- "work"     — employer, role, work history, skills, projects, career goals, job targets
- "social"   — durable relationships, communities, recurring social activities
- "personal" — name, location, stable life facts, long-term preferences or goals
- "persona"  — writing identity or tone preferences, but ONLY if unmistakable

Return ONLY JSON in this exact shape:
{
  "memories": [
    {
      "content": "User previously worked at Uber.",
      "category": "work",
      "tags": ["uber", "previous employer"],
      "importance": 0.9,
      "confidence": 0.96
    }
  ]
}

Strict rules:
- Extract facts about the USER, not generic summaries of this one message
- Page context may help resolve names, companies, or roles, but do not save facts only about the recipient unless they reveal a durable user fact
- Use "User's own words" as the primary signal for persona and explicit preferences
- Do NOT infer persona from AI-polished output alone
- Persona is extremely rare. Only emit persona if confidence >= 0.95 and the style signal is concrete
- Never emit placeholders or templates such as [Name], [Company], <name>, or blank variables
- Never emit vague abstractions like "User is interested in connecting through values and dialogue"
- Never emit generic networking facts like "User is familiar with the recipient's work"
- NEVER save ephemeral events: job application submissions ("applied to X", "submitted application to Y"), one-off messages sent, or outreach attempts. These change constantly and will corrupt future context with false assumptions.
- Only save DURABLE facts: current employer, confirmed past employer, education, stable skills, explicit long-term goals.
- "User is applying to / interviewing at X" is NOT a durable fact — omit it.
- Prefer concrete facts over vague labels
- Use canonical phrasing for employer facts:
  - current employer (confirmed): "User currently works at X as [role]."
  - prior employer (confirmed left): "User previously worked at X."
  - upcoming employer (accepted offer): "User will be joining X."
- Do not emit multiple memories for the same underlying fact
- Maximum 2 memories
- confidence must be >= 0.85 or return nothing
- Return {"memories":[]} if nothing truly useful qualifies`;

type ExtractedMemory = {
  content: string;
  category: string;
  tags: string[];
  importance: number;
  confidence: number;
};

type MemoryUpdateSummary = {
  category: string;
  action: "created" | "reinforced";
  text: string;
};

function resolveGenerationProvider(profile: {
  provider?: string | null;
  openaiKey?: string | null;
  anthropicKey?: string | null;
  geminiKey?: string | null;
  memoryModel?: string | null;
} | null): { provider: string; apiKey: string | null; model: string } {
  const provider = profile?.provider ?? "openai";
  const apiKey =
    provider === "anthropic"
      ? profile?.anthropicKey?.trim() || null
      : provider === "gemini"
        ? profile?.geminiKey?.trim() || null
        : profile?.openaiKey?.trim() || null;
  const model =
    profile?.memoryModel?.trim() ||
    (provider === "anthropic"
      ? "claude-haiku-3-5"
      : provider === "gemini"
        ? "gemini-3.1-flash-lite"
        : "gpt-5-nano");
  return { provider, apiKey, model };
}

function dedupeExtractedMemories(memories: ExtractedMemory[]): ExtractedMemory[] {
  const bestByFingerprint = new Map<string, ExtractedMemory>();

  for (const memory of memories) {
    if (typeof memory.confidence !== "number" || memory.confidence < 0.85) continue;
    if (!["work", "social", "personal", "persona"].includes(memory.category)) continue;
    if (memory.category === "persona" && memory.confidence < 0.95) continue;

    const canonicalContent = canonicalizeMemoryText({
      text: memory.content,
      tags: Array.isArray(memory.tags) ? memory.tags : [],
      platform: memory.category,
    });
    if (!canonicalContent) continue;

    const normalized: ExtractedMemory = {
      ...memory,
      content: canonicalContent,
      tags: Array.isArray(memory.tags) ? memory.tags.slice(0, 8) : [],
    };
    if (
      isLowSignalMemory({
        text: normalized.content,
        tags: normalized.tags,
        platform: normalized.category,
      })
    ) {
      continue;
    }

    const fingerprint = getMemoryFingerprint({
      text: normalized.content,
      tags: normalized.tags,
      platform: normalized.category,
    });
    const current = bestByFingerprint.get(fingerprint);
    const nextScore =
      scoreMemoryText(normalized.content) +
      (normalized.importance ?? 0) * 10 +
      (normalized.confidence ?? 0) * 10;
    const currentScore = current
      ? scoreMemoryText(current.content) +
        (current.importance ?? 0) * 10 +
        (current.confidence ?? 0) * 10
      : -Infinity;
    if (!current || nextScore > currentScore) {
      bestByFingerprint.set(fingerprint, normalized);
    }
  }

  return Array.from(bestByFingerprint.values()).slice(0, 2);
}

async function extractAndPersistMemories(
  ctx: ActionCtx,
  {
    userId,
    generatedText,
    instruction,
    platform,
    provider,
    apiKey,
    model,
    enforceCooldown,
    pageContext,
    existingText,
  }: {
    userId: Id<"users">;
    generatedText: string;
    instruction: string;
    platform: string;
    provider: string;
    apiKey: string;
    model: string;
    enforceCooldown: boolean;
    pageContext?: string;
    existingText?: string;
  }
): Promise<MemoryUpdateSummary[]> {
  if (enforceCooldown) {
    const lastTime = await ctx.runQuery(
      internal.memoryExtract._getLastMemoryTime,
      { userId }
    );
    if (lastTime && Date.now() - lastTime < EXTRACTION_COOLDOWN_MS) {
      return [];
    }
  }

  const existingMemoryContext = await ctx.runQuery(
    internal.memoryExtract._getExistingMemoryContext,
    { userId, limit: 12 }
  );

  const userSignals = [instruction, existingText]
    .map((value) => value?.trim() ?? "")
    .filter(Boolean)
    .join("\n")
    .slice(0, 450);

  const userPrompt = [
    `Platform: ${platform}`,
    pageContext?.trim()
      ? `Page context (use only to resolve specific names/orgs or durable user targets):\n${pageContext
          .trim()
          .slice(0, 1400)}`
      : "",
    existingMemoryContext
      ? `Already stored memories (do not restate these unless the new fact is meaningfully better):\n${existingMemoryContext.slice(
          0,
          900
        )}`
      : "",
    userSignals
      ? `User's own words (primary signal for persona, preferences, explicit goals):\n${userSignals}`
      : "",
    `AI-generated text (use for durable work/personal facts only, not persona by itself):\n${generatedText
      .trim()
      .slice(0, 900)}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  let rawJson = "";

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
        system: EXTRACTION_PROMPT,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });
    const data = (await res.json()) as any;
    rawJson = data.content?.[0]?.text ?? "";
  } else if (provider === "gemini") {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: `${EXTRACTION_PROMPT}\n\n${userPrompt}` }],
            },
          ],
          generationConfig: { maxOutputTokens: 1024, temperature: 0.2 },
        }),
      }
    );
    const data = (await res.json()) as any;
    rawJson = (data.candidates?.[0]?.content?.parts ?? [])
      .map((p: any) => p.text ?? "")
      .join("");
  } else {
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        instructions: EXTRACTION_PROMPT,
        input: userPrompt,
      }),
    });
    const data = (await res.json()) as any;
    if (typeof data?.output_text === "string" && data.output_text) {
      rawJson = data.output_text;
    } else {
      const parts: string[] = [];
      for (const item of data?.output ?? []) {
        if (item?.type === "message" && Array.isArray(item?.content)) {
          for (const c of item.content) {
            if (c?.type === "output_text" && typeof c?.text === "string") {
              parts.push(c.text);
            }
          }
        }
      }
      rawJson = parts.join("");
    }
  }

  const fenceMatch = rawJson.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = fenceMatch ? fenceMatch[1] : rawJson;

  const parsed = JSON.parse(jsonStr.trim()) as {
    memories: ExtractedMemory[];
  };

  const toSave = dedupeExtractedMemories(parsed.memories ?? []);
  const updates: MemoryUpdateSummary[] = [];

  for (const mem of toSave) {
    const result: { action: "created" | "reinforced" } = await ctx.runMutation(
      internal.memories.upsertExtracted,
      {
        userId,
        text: mem.content,
        tags: mem.tags,
        platform: mem.category,
        importance: mem.importance,
        confidence: mem.confidence,
      }
    );
    updates.push({
      category: mem.category,
      action: result.action,
      text: mem.content,
    });
  }

  return updates;
}

// ── Main extraction action ────────────────────────────────────────────────────

export const extractAndSave = internalAction({
  args: {
    userId: v.id("users"),
    generatedText: v.string(),
    instruction: v.string(),
    pageContext: v.optional(v.string()),
    existingText: v.optional(v.string()),
    platform: v.string(),
    provider: v.string(),
    apiKey: v.string(),
    model: v.string(),
    sessionId: v.optional(v.id("interactionSessions")),
  },
  handler: async (
    ctx,
    {
      userId,
      generatedText,
      instruction,
      pageContext,
      existingText,
      platform,
      provider,
      apiKey,
      model,
      sessionId,
    }
  ) => {
    try {
      await extractAndPersistMemories(ctx, {
        userId,
        generatedText,
        instruction,
        pageContext,
        existingText,
        platform,
        provider,
        apiKey,
        model,
        enforceCooldown: true,
      });
      await ctx.runMutation(internal.memories.repairExtractedForUser, {
        userId,
      });
    } catch {
      // Silently fail — memory extraction is non-critical background work
    }

    // Phase 4: Entity extraction — fire-and-forget, never blocks memory extraction
    // Only runs for platforms where user facts are likely (skip canvas/generic)
    if (platform !== "canvas" && generatedText.trim().length >= 60) {
      try {
        await ctx.scheduler.runAfter(0, internal.entities.extractEntities, {
          userId,
          generatedText,
          pageContext,
          platform,
          provider,
          apiKey,
          model,
          sessionId,
        });
      } catch {
        // Non-fatal
      }
    }
  },
});

export const extractAndSaveForCurrentUser = action({
  args: {
    generatedText: v.string(),
    instruction: v.optional(v.string()),
    pageContext: v.optional(v.string()),
    existingText: v.optional(v.string()),
    platform: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { generatedText, instruction, pageContext, existingText, platform }
  ): Promise<MemoryUpdateSummary[]> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const profile = await ctx.runQuery(internal.users._getProfileByUserId, {
      userId,
    });
    const { provider, apiKey, model } = resolveGenerationProvider(profile);
    if (!apiKey) return [];

    const updates = await extractAndPersistMemories(ctx, {
      userId,
      generatedText,
      instruction: instruction ?? "",
      pageContext,
      existingText,
      platform: platform ?? "general",
      provider,
      apiKey,
      model,
      enforceCooldown: true,
    });
    await ctx.runMutation(internal.memories.repairExtractedForUser, {
      userId,
    });
    return updates;
  },
});
