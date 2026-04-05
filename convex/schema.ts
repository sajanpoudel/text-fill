import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";

export default defineSchema({
  // Convex Auth manages users / sessions / accounts tables automatically
  ...authTables,

  // Extended user profile — one-to-one with authTables.users
  userProfiles: defineTable({
    userId: v.id("users"),
    contextText: v.optional(v.string()),     // Resume / bio text
    contextFileName: v.optional(v.string()),
    systemPrompt: v.optional(v.string()),
    provider: v.optional(v.string()),        // "openai" | "anthropic" | "gemini"
    model: v.optional(v.string()),
    embeddingProvider: v.optional(v.string()),
    embeddingModel: v.optional(v.string()),
    // API keys stored server-side (never in chrome.storage)
    openaiKey: v.optional(v.string()),
    anthropicKey: v.optional(v.string()),
    geminiKey: v.optional(v.string()),
    memoryModel: v.optional(v.string()),   // lighter model for background extraction
  }).index("by_user", ["userId"]),

  // Memory metadata (no embedding here — split table for performance)
  memories: defineTable({
    userId: v.id("users"),
    text: v.string(),
    status: v.string(),                      // "active" | "archived" | "deleted"
    tags: v.array(v.string()),
    platform: v.optional(v.string()),
    sourceUrl: v.optional(v.string()),
    importance: v.optional(v.number()),      // 0.0-1.0
    confidence: v.optional(v.number()),      // 0.0-1.0
    mentions: v.optional(v.number()),
    accessCount: v.number(),
    lastAccessedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.optional(v.number()),
    sessionsSinceAccess: v.optional(v.number()),
    forgetScore: v.optional(v.number()),
    schemaVersion: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_user_status", ["userId", "status"])
    .index("by_user_created", ["userId", "createdAt"]),

  // Embeddings in a separate table — avoids loading large float arrays on every read
  memoryEmbeddings: defineTable({
    memoryId: v.id("memories"),
    userId: v.id("users"),                   // Duplicated for vector filter efficiency
    scopeKey: v.optional(v.string()),
    provider: v.optional(v.string()),
    model: v.optional(v.string()),
    embedding: v.array(v.float64()),
  })
    .index("by_memory", ["memoryId"])
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 1536,                      // text-embedding-3-small output size
      filterFields: ["scopeKey"],
    }),

  // ── Interaction observation ─────────────────────────────────────────────────

  // One row per compose session (focusin → blur / send)
  interactionSessions: defineTable({
    userId: v.id("users"),
    sessionId: v.string(),                   // client-generated UUID
    platform: v.string(),
    contextType: v.optional(v.string()),     // "connection_req" | "dm" | "inmail" | "email" | etc.
    recipientName: v.optional(v.string()),
    openedAt: v.number(),
    aiGeneratedAt: v.optional(v.number()),
    closedAt: v.number(),
    outcome: v.string(),                     // "accepted" | "lightly_edited" | "heavily_edited" | "rewritten" | "abandoned" | "sent"
    charDelta: v.optional(v.number()),       // negative = shortened
    editFraction: v.optional(v.number()),    // 0-1, fraction of AI text changed
    artifactId: v.optional(v.id("sessionArtifacts")),
  })
    .index("by_user_opened", ["userId", "openedAt"])
    .index("by_user_platform", ["userId", "platform", "openedAt"])
    .index("by_user_outcome", ["userId", "outcome", "openedAt"]),

  // Text blobs — separate so session status updates don't rewrite large strings
  sessionArtifacts: defineTable({
    sessionId: v.id("interactionSessions"),
    aiPreText: v.optional(v.string()),
    aiGeneratedText: v.optional(v.string()),
    userFinalText: v.optional(v.string()),
  })
    .index("by_session", ["sessionId"]),

  // Cross-tab captured page context (30-min TTL, cleaned up by scheduled job)
  capturedContexts: defineTable({
    userId: v.id("users"),
    title: v.string(),
    url: v.string(),
    text: v.string(),
    capturedAt: v.number(),
    expiresAt: v.number(),
    isActive: v.boolean(),
  }).index("by_user_active", ["userId", "isActive"]),
});
