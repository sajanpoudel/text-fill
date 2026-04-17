import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";
import {
  agentRunStatusValidator,
  agentRunStepRoleValidator,
  agentFieldTargetValidator,
  approvalStatusValidator,
  browserCommandDeliveryScopeValidator,
  browserCommandStatusValidator,
  browserCommandTerminalStatusValidator,
  completionEventIdValidator,
  runTabStatusValidator,
  workflowIdValidator,
} from "./agentRunValidators";

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
    jobProfile: v.optional(v.string()),    // JSON: structured job application profile
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
    // Bi-temporal validity — null invalidAt means currently valid
    validAt: v.optional(v.number()),
    invalidAt: v.optional(v.number()),
  })
    .index("by_user", ["userId"])
    .index("by_user_status", ["userId", "status"])
    .index("by_user_created", ["userId", "createdAt"])
    // invalidAt FIRST (after userId) for efficient active-only queries
    .index("by_user_active", ["userId", "invalidAt"]),

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

  // ── Procedural patterns ───────────────────────────────────────────────────────

  // Behavioral rules derived from repeated edit patterns
  proceduralPatterns: defineTable({
    userId: v.id("users"),
    platform: v.string(),
    contextType: v.optional(v.string()),
    ruleText: v.string(),                    // "For LinkedIn recruiter DMs: keep under 3 sentences"
    confidence: v.number(),                  // 0-1, decays weekly
    triggerCount: v.number(),                // total times observed
    pendingCount: v.number(),                // sessions since last promotion
    promotedAt: v.number(),
    lastTriggeredAt: v.optional(v.number()),
    deletedAt: v.optional(v.number()),       // MUST be first non-userId field in soft-delete index
  })
    // deletedAt FIRST for efficient active query
    .index("by_user_active", ["userId", "deletedAt", "platform"])
    .index("by_user_platform", ["userId", "platform", "confidence"]),

  // Junction: which sessions support which patterns (no unbounded arrays)
  patternSupports: defineTable({
    patternId: v.id("proceduralPatterns"),
    sessionId: v.id("interactionSessions"),
    createdAt: v.number(),
  })
    .index("by_pattern", ["patternId"])
    .index("by_session", ["sessionId"])
    .index("by_pattern_and_session", ["patternId", "sessionId"]),

  // ── Entity graph ──────────────────────────────────────────────────────────────

  // Named entities: people, companies, platforms
  entities: defineTable({
    userId: v.id("users"),
    name: v.string(),
    type: v.string(),                        // "person" | "company" | "platform"
    normalizedName: v.string(),              // lowercased, trimmed — for matching
    createdAt: v.number(),
    deletedAt: v.optional(v.number()),       // MUST be first in soft-delete index
  })
    // deletedAt FIRST — critical for efficient .eq("deletedAt", undefined) filter
    .index("by_user_active", ["userId", "deletedAt", "createdAt"])
    .index("by_user_name", ["userId", "normalizedName"]),

  // Entity embeddings — separate table (mirrors memoryEmbeddings pattern)
  entityEmbeddings: defineTable({
    entityId: v.id("entities"),
    userId: v.id("users"),
    embedding: v.array(v.float64()),
  })
    .index("by_entity", ["entityId"])
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 1536,
      filterFields: ["userId"],
    }),

  // Temporal relationships between entities
  entityEdges: defineTable({
    userId: v.id("users"),
    fromEntityId: v.id("entities"),
    toEntityId: v.id("entities"),
    relation: v.string(),                    // "works_at" | "knows" | "reports_to"
    validAt: v.number(),                     // when true in reality
    invalidAt: v.optional(v.number()),       // when stopped being true (null = still valid)
    createdAt: v.number(),                   // when system learned it
    expiredAt: v.optional(v.number()),       // when system recorded the change
  })
    .index("by_from_active", ["fromEntityId", "invalidAt"])
    .index("by_user_active", ["userId", "invalidAt", "validAt"]),

  // Junction: which sessions support which edges (no unbounded arrays)
  edgeSupports: defineTable({
    edgeId: v.id("entityEdges"),
    sessionId: v.id("interactionSessions"),
    createdAt: v.number(),
  })
    .index("by_edge", ["edgeId"])
    .index("by_session", ["sessionId"])
    .index("by_edge_and_session", ["edgeId", "sessionId"]),

  // ── Evaluation & tracing ─────────────────────────────────────────────────────

  // One trace per AI generation — written fire-and-forget from generate.ts.
  // userAction and editDistance are filled in later when the session closes.
  traces: defineTable({
    userId: v.id("users"),
    sessionId: v.optional(v.id("interactionSessions")), // linked on session close
    platform: v.string(),
    modelId: v.string(),
    promptFingerprint: v.string(),          // first 64 chars of system prompt (for dedup/compare)
    presentedOutput: v.string(),            // capped at 2000 chars
    hadLiveContext: v.boolean(),            // true if recipientContext was present
    retrievedPatternCount: v.number(),      // # procedural rules injected
    episodeExampleCount: v.number(),        // # episodic examples injected
    latencyMs: v.number(),
    userAction: v.optional(v.string()),     // "accepted" | "lightly_edited" | "heavily_edited" | "rewritten" | "abandoned" | "sent"
    editFraction: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_user_created", ["userId", "createdAt"])
    .index("by_user_action", ["userId", "userAction", "createdAt"]),

  // Full prompt text in separate table — only written when debugging/eval needed.
  // Not written by default to keep traces table cheap. Opt-in via TRACE_FULL_PROMPT flag.
  traceArtifacts: defineTable({
    traceId: v.id("traces"),
    systemPrompt: v.string(),
    userPrompt: v.string(),
    rawLlmOutput: v.string(),
  })
    .index("by_trace", ["traceId"]),

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

  // ── Batch task queue ──────────────────────────────────────────────────────────

  // Persisted task queue for multi-step browser operations
  taskBatches: defineTable({
    userId: v.id("users"),
    batchType: v.string(),                    // "linkedin_connect" | "profile_extract" | etc.
    status: v.string(),                       // "pending" | "approved" | "running" | "done" | "paused"
    totalTasks: v.number(),
    completedTasks: v.number(),
    dailyLimit: v.number(),
    createdAt: v.number(),
    approvedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
  }).index("by_user_status", ["userId", "status", "createdAt"]),

  taskItems: defineTable({
    batchId: v.id("taskBatches"),
    userId: v.id("users"),
    targetUrl: v.string(),
    targetName: v.optional(v.string()),
    generatedText: v.optional(v.string()),    // pre-generated message for approval
    status: v.string(),                       // "pending" | "approved" | "sent" | "failed" | "skipped"
    userEditedText: v.optional(v.string()),   // if user edited the generated message
    executedAt: v.optional(v.number()),
    errorMessage: v.optional(v.string()),
    sortOrder: v.number(),
  })
    .index("by_batch", ["batchId", "sortOrder"])
    .index("by_batch_status", ["batchId", "status"]),

  // ── Agentic task orchestration ─────────────────────────────────────────────

  agentRuns: defineTable({
    userId: v.id("users"),
    goal: v.string(),
    platformHint: v.optional(v.string()),
    pageUrl: v.optional(v.string()),
    initialPageContext: v.optional(v.string()),
    fieldTarget: v.optional(agentFieldTargetValidator),
    status: agentRunStatusValidator,
    currentStepIndex: v.number(),
    latestSummary: v.optional(v.string()),
    lastSummarizedAtStep: v.number(),
    activeWorkflowId: workflowIdValidator,
    createdAt: v.number(),
    updatedAt: v.number(),
    completedAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
  })
    .index("by_user_and_status_and_created_at", ["userId", "status", "createdAt"])
    .index("by_user_and_updated_at", ["userId", "updatedAt"])
    .index("by_active_workflow_id", ["activeWorkflowId"]),

  agentRunSteps: defineTable({
    runId: v.id("agentRuns"),
    stepIndex: v.number(),
    role: agentRunStepRoleValidator,
    content: v.string(),
    toolCall: v.optional(v.any()),
    commandId: v.optional(v.id("browserCommands")),
    approvalId: v.optional(v.id("agentApprovals")),
    summaryAfterStep: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_run_and_step_index", ["runId", "stepIndex"])
    .index("by_run_and_created_at", ["runId", "createdAt"]),

  browserCommands: defineTable({
    userId: v.id("users"),
    runId: v.id("agentRuns"),
    stepId: v.id("agentRunSteps"),
    status: browserCommandStatusValidator,
    deliveryScope: browserCommandDeliveryScopeValidator,
    targetTabId: v.optional(v.number()),
    targetUrl: v.optional(v.string()),
    command: v.any(),
    completionEventId: completionEventIdValidator,
    claimedBy: v.optional(v.string()),
    claimedAt: v.optional(v.number()),
    createdAt: v.number(),
    completedAt: v.optional(v.number()),
    attemptCount: v.number(),
    lastError: v.optional(v.string()),
  })
    .index("by_run_and_created_at", ["runId", "createdAt"])
    .index("by_user_and_status_and_target_tab_id", ["userId", "status", "targetTabId"])
    .index("by_user_and_status_and_delivery_scope", ["userId", "status", "deliveryScope"])
    .index("by_completion_event_id", ["completionEventId"]),

  browserCommandResults: defineTable({
    userId: v.id("users"),
    runId: v.id("agentRuns"),
    commandId: v.id("browserCommands"),
    status: browserCommandTerminalStatusValidator,
    result: v.optional(v.any()),
    errorMessage: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_command", ["commandId"])
    .index("by_run_and_created_at", ["runId", "createdAt"])
    .index("by_user_and_created_at", ["userId", "createdAt"]),

  agentApprovals: defineTable({
    userId: v.id("users"),
    runId: v.id("agentRuns"),
    stepId: v.id("agentRunSteps"),
    approvalKind: v.string(),
    title: v.string(),
    reason: v.optional(v.string()),
    payload: v.optional(v.any()),
    status: approvalStatusValidator,
    completionEventId: completionEventIdValidator,
    expiresAt: v.optional(v.number()),
    decidedAt: v.optional(v.number()),
    decisionNote: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_run_and_created_at", ["runId", "createdAt"])
    .index("by_user_and_status_and_created_at", ["userId", "status", "createdAt"])
    .index("by_user_and_status_and_expires_at", ["userId", "status", "expiresAt"])
    .index("by_completion_event_id", ["completionEventId"]),

  agentRunTabs: defineTable({
    userId: v.id("users"),
    runId: v.id("agentRuns"),
    tabId: v.number(),
    url: v.string(),
    status: runTabStatusValidator,
    openedAt: v.number(),
    updatedAt: v.number(),
    closedAt: v.optional(v.number()),
  })
    .index("by_run_and_status_and_opened_at", ["runId", "status", "openedAt"])
    .index("by_run_and_tab_id", ["runId", "tabId"])
    .index("by_user_and_status_and_opened_at", ["userId", "status", "openedAt"])
    .index("by_tab_id", ["tabId"]),
});
