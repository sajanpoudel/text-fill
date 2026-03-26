import { Agent } from "@convex-dev/agent";
import { components } from "./_generated/api";
import { openai } from "@ai-sdk/openai";

// This static agent wrapper is not the live memory retrieval path.
// Per-user OpenAI/Gemini embeddings now resolve dynamically in convex/embeddings.ts.
export const textFillAgent = new Agent(components.agent, {
  name: "TextFill Assistant",
  chat: openai.chat("gpt-4o"),
  textEmbedding: openai.embedding("text-embedding-3-small"),
  instructions: `You are a concise writing assistant embedded in a browser extension.
Generate clear, contextually appropriate text based on the user's instruction, their background, and the current page.
Match tone to the platform: professional on LinkedIn/job boards, warm on Gmail, casual on social media.
Do not include explanatory preamble — return only the text that should be inserted into the field.`,
  maxSteps: 3,
});
