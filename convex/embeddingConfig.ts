export const OPENAI_EMBEDDING_MODELS = [
  "text-embedding-3-small",
  "text-embedding-3-large",
] as const;

export const GEMINI_EMBEDDING_MODELS = [
  "gemini-embedding-001",
] as const;

export const DEFAULT_OPENAI_EMBEDDING_MODEL = OPENAI_EMBEDDING_MODELS[0];
export const DEFAULT_GEMINI_EMBEDDING_MODEL = GEMINI_EMBEDDING_MODELS[0];
export const EMBEDDING_DIMENSIONS = 1536;

export type EmbeddingProvider = "openai" | "gemini";

type EmbeddingProfileLike = {
  provider?: string | null;
  embeddingProvider?: string | null;
  embeddingModel?: string | null;
  openaiKey?: string | null;
  geminiKey?: string | null;
};

type ResolvedEmbeddingConfig =
  | {
      ok: true;
      provider: EmbeddingProvider;
      model: string;
      apiKey: string;
    }
  | {
      ok: false;
      provider: EmbeddingProvider | null;
      model: string | null;
      apiKey: null;
      error: string;
    };

export function isEmbeddingProvider(
  value: string | null | undefined
): value is EmbeddingProvider {
  return value === "openai" || value === "gemini";
}

export function defaultEmbeddingProvider(
  profile: EmbeddingProfileLike | null | undefined
): EmbeddingProvider {
  if (isEmbeddingProvider(profile?.embeddingProvider)) {
    return profile.embeddingProvider;
  }
  if (profile?.provider === "gemini") return "gemini";
  if (profile?.provider === "openai") return "openai";
  if (profile?.openaiKey) return "openai";
  if (profile?.geminiKey) return "gemini";
  return "openai";
}

export function defaultEmbeddingModel(provider: EmbeddingProvider): string {
  return provider === "gemini"
    ? DEFAULT_GEMINI_EMBEDDING_MODEL
    : DEFAULT_OPENAI_EMBEDDING_MODEL;
}

function resolveModel(
  provider: EmbeddingProvider,
  requestedModel: string | null | undefined
): string {
  const fallback = defaultEmbeddingModel(provider);
  if (!requestedModel) return fallback;
  if (
    provider === "openai" &&
    OPENAI_EMBEDDING_MODELS.includes(
      requestedModel as (typeof OPENAI_EMBEDDING_MODELS)[number]
    )
  ) {
    return requestedModel;
  }
  if (
    provider === "gemini" &&
    GEMINI_EMBEDDING_MODELS.includes(
      requestedModel as (typeof GEMINI_EMBEDDING_MODELS)[number]
    )
  ) {
    return requestedModel;
  }
  return fallback;
}

export function resolveEmbeddingConfig(
  profile: EmbeddingProfileLike | null | undefined
): ResolvedEmbeddingConfig {
  const provider = defaultEmbeddingProvider(profile);
  const model = resolveModel(provider, profile?.embeddingModel);
  const apiKey =
    provider === "gemini"
      ? profile?.geminiKey?.trim() || null
      : profile?.openaiKey?.trim() || null;

  if (!apiKey) {
    return {
      ok: false,
      provider,
      model,
      apiKey: null,
      error:
        provider === "gemini"
          ? "Missing Gemini API key for embeddings."
          : "Missing OpenAI API key for embeddings.",
    };
  }

  return {
    ok: true,
    provider,
    model,
    apiKey,
  };
}
