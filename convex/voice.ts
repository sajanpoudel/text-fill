import { action } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internal } from "./_generated/api";

// ── Voice intent types ────────────────────────────────────────────────────────

export type VoiceAction =
  | "compose"  // compose / write something in the active field
  | "search"   // navigate to a search result
  | "connect"  // send a connection request
  | "unknown"; // could not parse intent

export interface VoiceIntent {
  action: VoiceAction;
  params: {
    instruction?: string;   // for compose: the writing instruction
    query?: string;         // for search: search query
    platform?: string;      // inferred platform if detectable
  };
  confidence: number;       // 0–1
}

// ── System prompt ─────────────────────────────────────────────────────────────

const INTENT_SYSTEM = `You are a voice command parser for a writing assistant browser extension.
Parse the user's spoken command into a structured intent JSON object.

Valid actions:
- "compose": user wants to write/generate text in the active field
  Examples: "write a connection note", "draft a message to this recruiter", "fill this form"
- "search": user wants to search for something
  Examples: "find senior engineers in Seattle", "search for product managers at Google"
- "connect": user wants to send a connection request to the current profile
  Examples: "connect with this person", "send a connection request"
- "unknown": cannot determine intent

Respond ONLY with a valid JSON object in this exact format:
{
  "action": "compose" | "search" | "connect" | "unknown",
  "params": {
    "instruction": "<writing instruction if compose>",
    "query": "<search query if search>",
    "platform": "<platform name if detectable, else omit>"
  },
  "confidence": <0.0 to 1.0>
}

No markdown, no explanation — only the JSON object.`;

// ── Parse intent action ───────────────────────────────────────────────────────

export const parseIntent = action({
  args: {
    text: v.string(),
  },
  handler: async (ctx, args): Promise<VoiceIntent> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const profile = await ctx.runQuery(internal.users._getProfileByUserId, {
      userId,
    });

    const provider = profile?.provider ?? "openai";
    const apiKey =
      provider === "anthropic"
        ? (profile?.anthropicKey ?? null)
        : provider === "gemini"
          ? (profile?.geminiKey ?? null)
          : (profile?.openaiKey ?? null);

    if (!apiKey) {
      // Fall back to heuristic parsing when no API key is configured
      return heuristicParse(args.text);
    }

    const model =
      profile?.model ??
      (provider === "anthropic"
        ? "claude-haiku-4-5-20251001"
        : provider === "gemini"
          ? "gemini-2.0-flash"
          : "gpt-4o-mini");

    try {
      const raw = await callProvider({
        provider,
        model,
        apiKey,
        system: INTENT_SYSTEM,
        user: `Command: "${args.text}"`,
      });
      const parsed = JSON.parse(raw) as VoiceIntent;
      // Validate shape
      if (
        typeof parsed.action !== "string" ||
        typeof parsed.confidence !== "number"
      ) {
        return heuristicParse(args.text);
      }
      return parsed;
    } catch {
      return heuristicParse(args.text);
    }
  },
});

// ── Heuristic fallback (no LLM call) ─────────────────────────────────────────

function heuristicParse(text: string): VoiceIntent {
  const lower = text.toLowerCase().trim();

  if (
    /\b(write|draft|compose|fill|generate|type|create)\b/.test(lower) ||
    /\b(message|note|email|reply|post|comment)\b/.test(lower)
  ) {
    return {
      action: "compose",
      params: { instruction: text },
      confidence: 0.7,
    };
  }

  if (/\b(connect|connection request|invite)\b/.test(lower)) {
    return { action: "connect", params: {}, confidence: 0.8 };
  }

  if (/\b(search|find|look for|show me)\b/.test(lower)) {
    return {
      action: "search",
      params: { query: text },
      confidence: 0.7,
    };
  }

  return { action: "unknown", params: {}, confidence: 0.3 };
}

// ── Provider call (shared with generate.ts pattern) ───────────────────────────

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
        max_tokens: 256,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
    const data = (await res.json()) as any;
    if (!res.ok)
      throw new Error(
        `Anthropic error: ${data?.error?.message ?? JSON.stringify(data)}`
      );
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
          generationConfig: { maxOutputTokens: 256, temperature: 0.2 },
        }),
      }
    );
    const data = (await res.json()) as any;
    if (!res.ok)
      throw new Error(
        `Gemini error: ${data?.error?.message ?? JSON.stringify(data)}`
      );
    return (data.candidates?.[0]?.content?.parts ?? [])
      .map((p: any) => p.text ?? "")
      .join("")
      .trim();
  }

  // OpenAI Responses API
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, instructions: system, input: user }),
  });
  const data = (await res.json()) as any;
  if (!res.ok)
    throw new Error(
      `OpenAI error: ${data?.error?.message ?? JSON.stringify(data)}`
    );
  const parts: string[] = [];
  for (const item of data.output ?? []) {
    for (const c of item.content ?? []) {
      if (c?.type === "output_text" && typeof c?.text === "string")
        parts.push(c.text);
    }
  }
  if (parts.length > 0) return parts.join("\n").trim();
  throw new Error("Could not parse OpenAI response");
}
