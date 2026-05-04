export type ProviderProfile = {
  provider?: string;
  openaiKey?: string;
  anthropicKey?: string;
  geminiKey?: string;
  model?: string;
  memoryModel?: string;
} | null;

export function resolveApiKey(profile: ProviderProfile): {
  provider: string;
  apiKey: string | null;
} {
  const provider = profile?.provider ?? "openai";
  const apiKey =
    provider === "anthropic"
      ? (profile?.anthropicKey ?? null)
      : provider === "gemini"
        ? (profile?.geminiKey ?? null)
        : (profile?.openaiKey ?? null);
  return { provider, apiKey };
}

export async function callProvider(opts: {
  provider: string;
  model: string;
  apiKey: string;
  system: string;
  user: string;
  maxOutputTokens?: number;
  temperature?: number;
}): Promise<string> {
  const {
    provider,
    model,
    apiKey,
    system,
    user,
    maxOutputTokens = 1024,
    temperature = 0.7,
  } = opts;

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
        max_tokens: maxOutputTokens,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
    const data = (await res.json()) as any;
    if (!res.ok) {
      throw new Error(
        `Anthropic error: ${data?.error?.message ?? JSON.stringify(data)}`
      );
    }
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
            maxOutputTokens,
            temperature,
          },
        }),
      }
    );
    const data = (await res.json()) as any;
    if (!res.ok) {
      throw new Error(
        `Gemini error: ${data?.error?.message ?? JSON.stringify(data)}`
      );
    }
    return (data.candidates?.[0]?.content?.parts ?? [])
      .map((part: any) => part.text ?? "")
      .join("")
      .trim();
  }

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, instructions: system, input: user }),
  });
  const data = (await res.json()) as any;
  if (!res.ok) {
    throw new Error(
      `OpenAI error: ${data?.error?.message ?? JSON.stringify(data)}`
    );
  }

  if (typeof data?.output_text === "string" && data.output_text) {
    return data.output_text.trim();
  }

  const parts: string[] = [];
  for (const item of data?.output ?? []) {
    if (item?.type === "message" && Array.isArray(item?.content)) {
      for (const contentPart of item.content) {
        if (
          contentPart?.type === "output_text" &&
          typeof contentPart?.text === "string"
        ) {
          parts.push(contentPart.text);
        }
      }
    }
  }

  if (parts.length > 0) {
    return parts.join("\n").trim();
  }
  throw new Error("Could not parse OpenAI response");
}
