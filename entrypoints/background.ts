import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import type { SessionPayload } from "../src/lib/session-observer.ts";
import { ChromeBrowserExecutor } from "../src/lib/browser-executor.ts";
import {
  executeWaitForLinkedInPrimaryActionsInPage,
  executeLinkedInConnectWorkflowInPage,
} from "../src/lib/browser-control.ts";
import {
  normalizeAgentCommandError,
} from "../src/lib/agent-command-runtime.ts";
import {
  DEFAULT_TASK_QUEUE_SCOPE,
  LEGACY_TASK_QUEUE_KEY,
  TASK_QUEUE_ACTIVE_SCOPE_KEY,
  deriveTaskQueueScopeFromToken,
  getTaskProgressStorageKey,
  getTaskQueueStorageKey,
  normalizeStoredTaskQueue,
} from "../src/lib/task-queue-storage.ts";
import {
  syncQueuedTasksWithBatchDetails,
  type ExecutableTaskBatch,
  type TaskQueueTask,
} from "../src/lib/task-batch-handoff.ts";
import {
  buildLinkedInConnectPageContext,
  buildLinkedInCustomInviteUrl,
  coalesceLinkedInRecipientProfile,
  type LinkedInRecipientProfile,
} from "../src/lib/linkedin-recipient-profile.ts";
import {
  mergeCapturedGenerationContexts,
  normalizeCapturedGenerationContexts,
  type GenerationCapturedContext,
} from "../src/lib/captured-contexts.ts";
import {
  appendPlatformDomObservation,
  createEmptyPlatformDomLearningState,
  derivePlatformDomHints,
  normalizePlatformDomLabels,
  normalizePlatformDomLearningState,
  type PlatformDomHints,
} from "../src/lib/platform-dom-learning.ts";
import {
  normalizeVoiceRuntimeState,
  type VoiceRuntimeState,
} from "../src/lib/voice-runtime.ts";
import {
  DEFAULT_LOCAL_COMPANION_TIMEOUT_MS,
  DEFAULT_LOCAL_COMPANION_URL,
  requestLocalCompanion,
} from "../src/lib/local-agent-bridge.ts";
import {
  buildStoredConvexTokenUpdates,
  CONVEX_AUTH_JWT_STORAGE_KEY,
  CONVEX_AUTH_REFRESH_TOKEN_STORAGE_KEY,
  CONVEX_REFRESH_TOKEN_STORAGE_KEY,
  CONVEX_TOKEN_STORAGE_KEY,
  getStoredConvexAccessToken,
  getStoredConvexRefreshToken,
} from "../src/lib/convex-auth-storage.ts";
import {
  formatSavedSettingsContext,
  formatJobProfileContext,
  formatUserBasicIdentity,
  shouldIncludeJobApplicationArtifacts,
} from "../src/lib/agent-user-context.ts";
import type {
  LocalCompanionAction,
  LocalCompanionBrowserWorkItem,
  LocalCompanionCancelRunResult,
  LocalCompanionPanelState,
  LocalCompanionProviderConfig,
  LocalCompanionReportActionResult,
  LocalCompanionResumeRunResult,
  LocalCompanionResolveApprovalResult,
  LocalCompanionStartRunResult,
  LocalCompanionStructuredExtraction,
  ResumeFileData,
} from "../src/lib/local-agent-protocol.ts";
import { resolveApiKey } from "../convex/llmProvider.ts";

// ── Client singleton ──────────────────────────────────────────────────────
// ConvexHttpClient is stateless-friendly: safe to reuse across SW restarts.
const convex = new ConvexHttpClient(import.meta.env.VITE_CONVEX_URL as string);
const browserExecutor = new ChromeBrowserExecutor(chrome);
let currentTaskQueueScope = DEFAULT_TASK_QUEUE_SCOPE;
let voiceRuntimeState: VoiceRuntimeState = "idle";
const PLATFORM_DOM_LEARNING_KEY = "platformDomLearning";
const LOCAL_COMPANION_URL_KEY = "localCompanionUrl";
const LOCAL_COMPANION_TIMEOUT_MS_KEY = "localCompanionTimeoutMs";
const EXPIRE_CONTEXTS_ALARM_MINUTES = 30;

type BackgroundProfileSnapshot = {
  provider?: string;
  openaiKey?: string;
  anthropicKey?: string;
  geminiKey?: string;
  model?: string;
  memoryModel?: string;
  contextText?: string;
  jobProfile?: string;
  systemPrompt?: string;
} | null;

// ── Auth sync + silent refresh ────────────────────────────────────────────
// Auth state must survive popup/service-worker churn, so we persist both the
// Convex Auth provider keys (__convexAuth*) and the legacy generic mirror keys
// the background uses for fast access.

function parseJwtExpiry(token: string): number | null {
  try {
    // JWT payload is the second segment, base64url-encoded
    const b64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(b64));
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

async function refreshConvexToken(): Promise<boolean> {
  const stored = await chrome.storage.local.get([
    CONVEX_AUTH_REFRESH_TOKEN_STORAGE_KEY,
    CONVEX_REFRESH_TOKEN_STORAGE_KEY,
  ]);
  const refreshToken = getStoredConvexRefreshToken(stored);
  if (!refreshToken) return false;

  // Retry on transient failures (network errors, SW wake-up latency).
  // Service workers can be slow to establish connectivity on first wake.
  const RETRY_DELAYS = [0, 1_500, 4_000];
  for (const delay of RETRY_DELAYS) {
    if (delay > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
    try {
      convex.clearAuth();
      const result = await (convex as any).action(api.auth.signIn, { refreshToken });
      const tokens = result?.tokens as { token: string; refreshToken?: string } | null;
      if (!tokens?.token) return false;

      const updates = buildStoredConvexTokenUpdates(tokens);
      await chrome.storage.local.set(updates);
      await syncTaskQueueScope(tokens.token);
      convex.setAuth(tokens.token);
      return true;
    } catch {
      // swallow and retry
    }
  }
  return false;
}

async function syncTaskQueueScope(token: string | null): Promise<void> {
  const nextScope = deriveTaskQueueScopeFromToken(token);
  const scopedKey = getTaskQueueStorageKey(nextScope);
  const stored = await chrome.storage.local.get([
    LEGACY_TASK_QUEUE_KEY,
    TASK_QUEUE_ACTIVE_SCOPE_KEY,
    scopedKey,
  ]);
  const legacyQueue = normalizeStoredTaskQueue<unknown>(
    stored[LEGACY_TASK_QUEUE_KEY]
  );
  const scopedQueue = normalizeStoredTaskQueue<unknown>(stored[scopedKey]);
  const previousScope =
    typeof stored[TASK_QUEUE_ACTIVE_SCOPE_KEY] === "string"
      ? stored[TASK_QUEUE_ACTIVE_SCOPE_KEY]
      : null;

  const updates: Record<string, unknown> = {};
  if (
    legacyQueue.length > 0 &&
    !previousScope &&
    nextScope !== DEFAULT_TASK_QUEUE_SCOPE &&
    scopedQueue.length === 0
  ) {
    updates[scopedKey] = legacyQueue;
  }
  if (previousScope !== nextScope) {
    updates[TASK_QUEUE_ACTIVE_SCOPE_KEY] = nextScope;
  }
  if (Object.keys(updates).length > 0) {
    await chrome.storage.local.set(updates);
  }
  if (legacyQueue.length > 0) {
    await chrome.storage.local.remove(LEGACY_TASK_QUEUE_KEY);
  }
  currentTaskQueueScope = nextScope;
}

async function loadToken() {
  const stored = await chrome.storage.local.get([
    CONVEX_AUTH_JWT_STORAGE_KEY,
    CONVEX_TOKEN_STORAGE_KEY,
  ]);
  const convexToken = getStoredConvexAccessToken(stored);
  await syncTaskQueueScope(convexToken);

  if (!convexToken) {
    convex.clearAuth();
    return;
  }

  // Proactively refresh if the token is expired or expiring within the next 40 minutes.
  // The expireContexts alarm fires every 30 min, so a 40-min window guarantees the
  // alarm always catches the token while it still has time left — avoiding the window
  // where the background tries to refresh an already-expired token.
  const expiry = parseJwtExpiry(convexToken);
  if (expiry !== null && Date.now() >= expiry - 40 * 60 * 1000) {
    const refreshed = await refreshConvexToken();
    if (refreshed) return; // setAuth already called inside refreshConvexToken
  }

  convex.setAuth(convexToken);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeStructuredExtraction(
  value: unknown
): LocalCompanionStructuredExtraction | null {
  if (!isPlainObject(value)) return null;
  const data =
    isPlainObject(value.data) ? (value.data as Record<string, unknown>) : undefined;
  const matchedFields = Array.isArray(value.matchedFields)
    ? value.matchedFields.filter(
        (item): item is string => typeof item === "string" && item.trim().length > 0
      )
    : undefined;
  const unmatchedFields = Array.isArray(value.unmatchedFields)
    ? value.unmatchedFields.filter(
        (item): item is string => typeof item === "string" && item.trim().length > 0
      )
    : undefined;
  const headings = Array.isArray(value.headings)
    ? value.headings.filter(
        (item): item is string => typeof item === "string" && item.trim().length > 0
      )
    : undefined;
  const text =
    typeof value.text === "string" && value.text.trim()
      ? value.text.trim()
      : undefined;

  if (!data && !matchedFields && !unmatchedFields && !headings && !text) {
    return null;
  }

  return {
    ...(data ? { data } : {}),
    ...(matchedFields ? { matchedFields } : {}),
    ...(unmatchedFields ? { unmatchedFields } : {}),
    ...(headings ? { headings } : {}),
    ...(text ? { text } : {}),
  };
}

async function loadLocalCompanionConfig(): Promise<{
  url: string;
  timeoutMs: number;
}> {
  const stored = await chrome.storage.local.get([
    LOCAL_COMPANION_URL_KEY,
    LOCAL_COMPANION_TIMEOUT_MS_KEY,
  ]);
  const url =
    typeof stored[LOCAL_COMPANION_URL_KEY] === "string" &&
    stored[LOCAL_COMPANION_URL_KEY].trim()
      ? stored[LOCAL_COMPANION_URL_KEY].trim()
      : DEFAULT_LOCAL_COMPANION_URL;
  const timeoutMs =
    typeof stored[LOCAL_COMPANION_TIMEOUT_MS_KEY] === "number" &&
    Number.isFinite(stored[LOCAL_COMPANION_TIMEOUT_MS_KEY]) &&
    stored[LOCAL_COMPANION_TIMEOUT_MS_KEY] > 0
      ? Math.round(stored[LOCAL_COMPANION_TIMEOUT_MS_KEY])
      : DEFAULT_LOCAL_COMPANION_TIMEOUT_MS;
  return { url, timeoutMs };
}

async function callLocalCompanion<TResult>(
  method:
    | "get_panel_state"
    | "start_run"
    | "cancel_run"
    | "resume_run"
    | "resolve_approval"
    | "report_action_result",
  params: Record<string, unknown>,
  timeoutOverrideMs?: number
): Promise<TResult> {
  const config = await loadLocalCompanionConfig();
  return requestLocalCompanion<TResult>(method, params, {
    url: config.url,
    timeoutMs:
      typeof timeoutOverrideMs === "number" && timeoutOverrideMs > 0
        ? timeoutOverrideMs
        : config.timeoutMs,
  });
}

function buildLocalCompanionProviderConfig(
  profile: BackgroundProfileSnapshot
): LocalCompanionProviderConfig | null {
  if (!profile) return null;

  const { provider, apiKey } = resolveApiKey(profile);
  if (!apiKey) return null;

  return {
    provider,
    apiKey,
    model: profile.memoryModel ?? profile.model ?? "gpt-5-nano",
  };
}

async function buildCurrentAgentRuntimeInputs(options?: {
  includeJobProfile?: boolean;
  includeResumeFile?: boolean;
}): Promise<{
  providerConfig: LocalCompanionProviderConfig | null;
  userContext: string | null;
  systemPrompt: string | null;
  resumeFile: ResumeFileData | null;
}> {
  const profile = (await convex.query(
    api.users.getProfile,
    {}
  )) as BackgroundProfileSnapshot;
  const parts: string[] = [];

  // Always include basic identity (name, email, links) so the agent knows who it's
  // helping before doing anything — regardless of task type.
  const userIdentity = formatUserBasicIdentity((profile as any)?.jobProfile);
  if (userIdentity) {
    parts.push(userIdentity);
  }

  const formattedSettingsContext = formatSavedSettingsContext(profile?.contextText);
  if (formattedSettingsContext) {
    parts.push(formattedSettingsContext);
  }

  const formattedJobProfile =
    options?.includeJobProfile === false
      ? null
      : formatJobProfileContext((profile as any)?.jobProfile);
  if (formattedJobProfile) {
    parts.push(formattedJobProfile);
  }

  const capturedContexts = await loadCapturedContextsForGeneration();
  if (capturedContexts.length > 0) {
    const serialized = capturedContexts
      .slice(0, 6)
      .map((context, index) => {
        const title =
          typeof context.title === "string" && context.title.trim()
            ? context.title.trim()
            : `Captured context ${index + 1}`;
        const url =
          typeof context.url === "string" && context.url.trim()
            ? `URL: ${context.url.trim()}`
            : null;
        const text =
          typeof context.text === "string" && context.text.trim()
            ? context.text.trim().slice(0, 1200)
            : "";
        const pieces = [title, url, text].filter((value): value is string => Boolean(value));
        return pieces.join("\n");
      })
      .filter((value) => value.trim().length > 0);

    if (serialized.length > 0) {
      parts.push(`Captured user context:\n${serialized.join("\n\n---\n\n")}`);
    }
  }

  const combined = parts.join("\n\n");
  const systemPrompt =
    typeof profile?.systemPrompt === "string" ? profile.systemPrompt.trim() : "";

  return {
    providerConfig: buildLocalCompanionProviderConfig(profile),
    userContext: combined.trim() ? combined.trim() : null,
    systemPrompt: systemPrompt || null,
    resumeFile: options?.includeResumeFile ? await loadResumeFile() : null,
  };
}

async function loadResumeFile(): Promise<ResumeFileData | null> {
  try {
    const stored = await chrome.storage.local.get("resumeFile");
    const rf = isPlainObject(stored?.resumeFile)
      ? (stored.resumeFile as Record<string, unknown>)
      : null;
    if (
      rf &&
      typeof rf.name === "string" && rf.name &&
      typeof rf.base64 === "string" && rf.base64 &&
      typeof rf.mimeType === "string"
    ) {
      return { name: rf.name, mimeType: rf.mimeType, base64: rf.base64 };
    }
  } catch {
    // storage not available in this context
  }
  return null;
}

function resolveAgentRunPageUrl(
  sender: chrome.runtime.MessageSender,
  payloadPageUrl: unknown
): string | undefined {
  if (typeof sender.tab?.url === "string" && sender.tab.url.trim()) {
    return sender.tab.url;
  }
  if (typeof payloadPageUrl === "string" && payloadPageUrl.trim()) {
    return payloadPageUrl.trim();
  }
  return undefined;
}

function shouldAttachJobApplicationArtifacts(args: {
  goal?: string;
  platformHint?: string;
  pageUrl?: string;
  pageContext?: string;
  fieldTarget?: {
    selector?: string;
    platform?: string;
    fieldType?: string;
    charLimit?: number;
  };
  workItems?: LocalCompanionBrowserWorkItem[];
  structured?: LocalCompanionStructuredExtraction | null;
}): boolean {
  return shouldIncludeJobApplicationArtifacts({
    goal: args.goal,
    platformHint: args.platformHint,
    pageUrl: args.pageUrl,
    pageContext: args.pageContext,
    fieldTarget: args.fieldTarget
      ? {
          platform: args.fieldTarget.platform,
          fieldType: args.fieldTarget.fieldType,
        }
      : null,
    workItems: args.workItems,
    structured: args.structured
      ? {
          text: args.structured.text,
          headings: args.structured.headings,
          matchedFields: args.structured.matchedFields,
          unmatchedFields: args.structured.unmatchedFields,
        }
      : null,
  });
}

// ── Event listeners — MUST be synchronous top-level ──────────────────────

chrome.runtime.onMessage.addListener(
  (msg: { type: string; action?: string; payload?: any }, sender, sendResponse) => {
    handleMessage(msg, sender)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: String(err.message ?? err) }));
    return true; // keep channel open for async response
  }
);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "expireContexts") {
    void expireOldContexts();
  }
  if (alarm.name === "resumeTaskQueue") {
    void taskQueue.process();
  }
});

chrome.alarms.create("expireContexts", {
  periodInMinutes: EXPIRE_CONTEXTS_ALARM_MINUTES,
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (
    areaName !== "local" ||
    (!("convexToken" in changes) && !(CONVEX_AUTH_JWT_STORAGE_KEY in changes))
  ) {
    return;
  }
  void chrome.storage.local
    .get([CONVEX_AUTH_JWT_STORAGE_KEY, CONVEX_TOKEN_STORAGE_KEY])
    .then((stored) => syncTaskQueueScope(getStoredConvexAccessToken(stored)));
});

// ── SPA navigation detection ──────────────────────────────────────────────────
// Better than tabs.onUpdated for LinkedIn/Gmail which use history.pushState
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId !== 0) return;
  chrome.tabs
    .sendMessage(details.tabId, { type: "SPA_NAVIGATED", url: details.url })
    .catch(() => {}); // content script may not be ready yet
});

// ── Message handler ───────────────────────────────────────────────────────

async function handleMessage(
  msg: { type: string; action?: string; payload?: any },
  sender: chrome.runtime.MessageSender
) {
  await loadToken();

  switch (msg.type) {
    case "GENERATE":
      return handleGenerate(msg.action ?? "generate", msg.payload, sender);

    case "CAPTURE_CONTEXT":
      return handleCaptureContext(msg.payload);

    case "CLEAR_CONTEXT":
      return handleClearContext();

    case "OBSERVE_SESSION":
      return handleObserveSession(msg.payload as SessionPayload);

    case "SAVE_MEMORY":
      return convex.mutation(api.memories.save, msg.payload);

    case "GET_STATS":
      return convex.query(api.memories.getStats, {});

    case "OPEN_SETTINGS":
      chrome.runtime.openOptionsPage();
      return { ok: true };

    case "ENQUEUE_TASK":
      return handleEnqueueTasks(msg.payload);

    case "PROCESS_TASK_QUEUE":
      return handleProcessTaskQueue();

    case "GET_AGENT_PANEL_STATE":
      return handleGetAgentPanelState(msg.payload);

    case "START_AGENT_RUN":
      return handleStartAgentRun(msg.payload, sender);

    case "CANCEL_AGENT_RUN":
      return handleCancelAgentRun(msg.payload);

    case "RESUME_AGENT_RUN":
      return handleResumeAgentRun(msg.payload, sender);

    case "RESOLVE_AGENT_APPROVAL":
      return handleResolveAgentApproval(msg.payload, sender);

    case "START_VOICE":
      return startVoiceListening();

    case "STOP_VOICE":
      return stopVoiceListening();

    case "VOICE_COMMAND":
      return handleVoiceCommand(String((msg as any).text ?? msg.payload?.text ?? ""));

    case "VOICE_INTERIM":
      return { ok: true };

    case "VOICE_STATE":
      return handleVoiceRuntimeState(
        normalizeVoiceRuntimeState((msg as any).state ?? msg.payload?.state),
        typeof (msg as any).error === "string"
          ? (msg as any).error
          : typeof msg.payload?.error === "string"
            ? msg.payload.error
            : null
      );

    case "VOICE_ERROR":
      return handleVoiceError(
        String((msg as any).error ?? msg.payload?.error ?? "Voice error")
      );

    default:
      return { error: `Unknown message type: ${msg.type}` };
  }
}

// ── Observation ──────────────────────────────────────────────────────────────

async function handleObserveSession(payload: SessionPayload) {
  try {
    await convex.mutation(api.interactions.recordSession, {
      sessionId: payload.sessionId,
      platform: payload.platform,
      contextType: payload.contextType,
      recipientName: payload.recipientName,
      traceId: payload.traceId,
      openedAt: payload.openedAt,
      aiGeneratedAt: payload.aiGeneratedAt,
      closedAt: payload.closedAt,
      outcome: payload.outcome,
      charDelta: payload.charDelta,
      editFraction: payload.editFraction,
      aiPreText: payload.aiPreText,
      aiGeneratedText: payload.aiGeneratedText,
      userFinalText: payload.userFinalText,
    });
  } catch {
    // Non-fatal — observation is best-effort, never block the user
  }
  return { ok: true };
}

// ── Generate ──────────────────────────────────────────────────────────────

function buildMemoryToastMessage(
  updates: Array<{ category?: string; action: "created" | "reinforced" }>
): string | null {
  if (updates.length === 0) return null;

  const labels = {
    work: "Work",
    social: "Social",
    personal: "Personal",
    persona: "Persona",
  } as const;
  const categories = Array.from(
    new Set(
      updates
        .map((update) => (update.category ? labels[update.category as keyof typeof labels] ?? null : null))
        .filter(Boolean)
    )
  );
  const created = updates.filter((update) => update.action === "created").length;
  const reinforced = updates.length - created;

  if (updates.length === 1) {
    const category = categories[0] ?? "Memory";
    return `💡 ${category} memory ${created === 1 ? "saved" : "updated"}`;
  }

  const label =
    categories.length === 1 ? `${categories[0]} memories` : "memories";
  if (created > 0 && reinforced > 0) {
    return `💡 ${updates.length} ${label} updated`;
  }
  return `💡 ${updates.length} ${label} ${created > 0 ? "saved" : "updated"}`;
}

async function notifyMemoryUpdates(
  sender: chrome.runtime.MessageSender,
  payload: Record<string, unknown>,
  generatedText: string
) {
  const tabId = sender.tab?.id;
  if (tabId === undefined) return;

  try {
    const updates = await convex.action(
      api.memoryExtract.extractAndSaveForCurrentUser,
      {
        generatedText,
        instruction:
          typeof payload.instruction === "string" ? payload.instruction : "",
        pageContext:
          typeof payload.pageContext === "string" ? payload.pageContext : undefined,
        existingText:
          typeof payload.existingText === "string"
            ? payload.existingText
            : undefined,
        platform: typeof payload.platform === "string" ? payload.platform : "general",
      }
    );
    const message = buildMemoryToastMessage(updates ?? []);
    if (!message) return;
    await chrome.tabs.sendMessage(
      tabId,
      { type: "MEMORY_UPDATED", message },
      typeof sender.frameId === "number" ? { frameId: sender.frameId } : undefined
    );
  } catch {
    // Non-fatal — generation already succeeded.
  }
}

async function loadCapturedContextsForGeneration(): Promise<
  GenerationCapturedContext[]
> {
  let localContexts: GenerationCapturedContext[] = [];
  try {
    const { capturedContexts } = await chrome.storage.local.get("capturedContexts");
    localContexts = normalizeCapturedGenerationContexts(capturedContexts);
  } catch {
    // Non-fatal
  }

  if (localContexts.length > 0) {
    return localContexts;
  }

  let activeBackendContext: GenerationCapturedContext[] = [];
  try {
    const activeContext = await convex.query(api.context.getActive, {});
    activeBackendContext = normalizeCapturedGenerationContexts(
      activeContext
        ? [
            {
              id: String(activeContext._id),
              title: activeContext.title,
              url: activeContext.url,
              text: activeContext.text,
              capturedAt: activeContext.capturedAt,
              isActive: activeContext.isActive,
            },
          ]
        : []
    );
  } catch {
    // Non-fatal
  }

  return mergeCapturedGenerationContexts(localContexts, activeBackendContext);
}

async function loadPlatformDomHints(
  surface: "linkedin_profile_connect"
): Promise<PlatformDomHints> {
  try {
    const { [PLATFORM_DOM_LEARNING_KEY]: stored } = await chrome.storage.local.get(
      PLATFORM_DOM_LEARNING_KEY
    );
    const state = normalizePlatformDomLearningState(stored);
    return derivePlatformDomHints(state, surface);
  } catch {
    return derivePlatformDomHints(createEmptyPlatformDomLearningState(), surface);
  }
}

async function recordPlatformDomObservation(params: {
  surface: "linkedin_profile_connect";
  finalState: string;
  succeeded: boolean;
  labels: string[];
  pageUrl?: string;
  resolutionPath?: string[];
}) {
  try {
    const { [PLATFORM_DOM_LEARNING_KEY]: stored } = await chrome.storage.local.get(
      PLATFORM_DOM_LEARNING_KEY
    );
    const next = appendPlatformDomObservation(
      normalizePlatformDomLearningState(stored),
      {
        surface: params.surface,
        finalState: params.finalState,
        succeeded: params.succeeded,
        labels: normalizePlatformDomLabels(params.labels),
        pageUrl: params.pageUrl,
        resolutionPath: params.resolutionPath,
        observedAt: Date.now(),
      }
    );
    await chrome.storage.local.set({ [PLATFORM_DOM_LEARNING_KEY]: next });
  } catch {
    // Non-fatal
  }
}

async function handleGenerate(
  action: string,
  payload: Record<string, unknown>,
  sender: chrome.runtime.MessageSender
) {
  const { recipientProfileUrl, ...generationPayload } = payload;

  const capturedContexts = await loadCapturedContextsForGeneration();

  // Live recipient profile lookup (Layer 3) — only for LinkedIn, fire-and-forget on fail
  let recipientContext: string | undefined;
  const sanitizedRecipientProfileUrl =
    typeof recipientProfileUrl === "string" ? recipientProfileUrl : null;
  if (
    sanitizedRecipientProfileUrl &&
    typeof generationPayload.platform === "string" &&
    generationPayload.platform === "linkedin"
  ) {
    try {
      const profile = await fetchRecipientProfile(sanitizedRecipientProfileUrl);
      if (profile) recipientContext = formatRecipientProfile(profile);
    } catch { /* non-fatal — skip live context */ }
  }

  const args = {
    ...generationPayload,
    capturedContexts: capturedContexts.length > 0 ? capturedContexts : undefined,
    ...(recipientContext ? { recipientContext } : {}),
  };

  const callConvex = () =>
    action === "rewrite"
      ? convex.action(api.generate.rewrite, args as any)
      : action === "shorten"
        ? convex.action(api.generate.shorten, args as any)
        : action === "expand"
          ? convex.action(api.generate.expand, args as any)
          : convex.action(api.generate.generate, args as any);

  let response;
  try {
    response = await callConvex();
  } catch (err: any) {
    const isAuthError =
      err?.message?.includes("Unauthenticated") ||
      err?.message?.includes("OIDC token") ||
      err?.data?.code === "Unauthenticated";
    if (isAuthError) {
      const refreshed = await refreshConvexToken();
      if (refreshed) {
        response = await callConvex(); // retry once with fresh token
      } else {
        throw new Error("Session expired. Please open the extension popup to sign in again.");
      }
    } else {
      throw err;
    }
  }

  if (
    action === "generate" &&
    typeof response?.text === "string" &&
    response.text.trim().length >= 100
  ) {
    void notifyMemoryUpdates(sender, payload, response.text);
  }

  return response;
}

// ── Context capture ───────────────────────────────────────────────────────

async function handleCaptureContext(payload: {
  title: string;
  url: string;
  text: string;
}) {
  const id = await convex.mutation(api.context.capture, payload);
  // Also flag in local storage so content script can show the indicator instantly
  await chrome.storage.local.set({ capturedContextActive: true });
  return { id };
}

async function handleClearContext() {
  await convex.mutation(api.context.clear, {});
  await chrome.storage.local.remove("capturedContextActive");
  return { ok: true };
}

// ── Shared runtime helpers ───────────────────────────────────────────────────

async function getActiveTab(): Promise<chrome.tabs.Tab | null> {
  const [tab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  return tab ?? null;
}

async function relayStatusToActiveTab(message: string) {
  const tab = await getActiveTab();
  if (!tab?.id) return { ok: false };
  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: "MEMORY_UPDATED",
      message,
    });
  } catch {
    // Non-fatal
  }
  return { ok: true };
}

async function broadcastToAllTabs(message: Record<string, unknown>) {
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs
      .filter((tab) => typeof tab.id === "number")
      .map((tab) =>
        chrome.tabs.sendMessage(tab.id!, message).catch(() => {})
      )
  );
}

async function handleVoiceRuntimeState(
  state: VoiceRuntimeState,
  error: string | null = null
) {
  voiceRuntimeState = state;
  await broadcastToAllTabs({
    type: "VOICE_STATE",
    state,
    ...(error ? { error } : {}),
  });
  return { ok: true, state };
}

async function handleVoiceError(message: string) {
  await handleVoiceRuntimeState("error", message);
  await relayStatusToActiveTab(message);
  return { ok: true, state: voiceRuntimeState };
}

async function ensureOffscreenDocument(): Promise<void> {
  const url = chrome.runtime.getURL("offscreen.html");
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [url],
  });
  if (contexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Handle voice commands with SpeechRecognition in MV3.",
  });
}

async function startVoiceListening() {
  if (voiceRuntimeState === "listening" || voiceRuntimeState === "starting") {
    return { ok: true, state: voiceRuntimeState };
  }
  await handleVoiceRuntimeState("starting");
  try {
    await ensureOffscreenDocument();
    await chrome.runtime.sendMessage({ target: "offscreen", type: "START_VOICE" });
    return { ok: true, state: "starting" };
  } catch (error: any) {
    const message = String(error?.message ?? error ?? "Voice start failed");
    await handleVoiceError(message);
    return { ok: false, error: message };
  }
}

async function stopVoiceListening() {
  if (voiceRuntimeState === "idle" || voiceRuntimeState === "stopping") {
    return { ok: true, state: voiceRuntimeState };
  }
  await handleVoiceRuntimeState("stopping");
  try {
    await chrome.runtime.sendMessage({ target: "offscreen", type: "STOP_VOICE" });
    return { ok: true, state: "stopping" };
  } catch (error: any) {
    const message = String(error?.message ?? error ?? "Voice stop failed");
    await handleVoiceError(message);
    return { ok: false, error: message };
  }
}

async function handleVoiceCommand(text: string) {
  if (!text.trim()) return { ok: false };

  const intent = await convex.action(api.voice.parseIntent, { text });
  const activeTab = await getActiveTab();
  if (!activeTab?.id) return { ok: false };

  if (intent.action === "compose") {
    await chrome.tabs.sendMessage(activeTab.id, {
      type: "VOICE_COMPOSE",
      instruction: intent.params.instruction ?? text,
    });
    return { ok: true, intent };
  }

  if (intent.action === "search") {
    const query = intent.params.query ?? text;
    const targetUrl =
      activeTab.url?.includes("linkedin.com")
        ? `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(query)}`
        : `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    await chrome.tabs.update(activeTab.id, { url: targetUrl });
    return { ok: true, intent };
  }

  if (intent.action === "connect" && activeTab.url) {
    return handleEnqueueTasks({
      tasks: [
        {
          type: "linkedin_connect",
          targetUrl: activeTab.url,
        },
      ],
      dailyLimit: 1,
    });
  }

  await relayStatusToActiveTab(`Voice command not understood: ${text}`);
  return { ok: false, intent };
}

async function handleEnqueueTasks(payload: {
  tasks?: Array<{
    type: string;
    targetUrl: string;
    targetName?: string;
    generatedText?: string;
  }>;
  dailyLimit?: number;
}) {
  const tasks = Array.isArray(payload?.tasks) ? payload.tasks : [];
  const dailyLimit = Math.max(1, Math.min(100, Number(payload?.dailyLimit ?? 20)));
  if (tasks.length === 0) {
    return { error: "No tasks to enqueue" };
  }

  const batchType = tasks[0]?.type ?? "generic";
  const { batchId, itemIds } = await convex.mutation(api.tasks.createBatch, {
    batchType,
    dailyLimit,
    items: tasks.map((task) => ({
      targetUrl: task.targetUrl,
      targetName: task.targetName,
      generatedText: task.generatedText,
    })),
  });
  await convex.mutation(api.tasks.approveBatch, { batchId });

  const enrichedTasks = tasks.map((task, index) => ({
    ...task,
    batchId,
    itemId: itemIds[index],
    dailyLimit,
    generatedText: task.generatedText,
  }));

  const queued = await taskQueue.enqueue(enrichedTasks);
  return {
    ...queued,
    batchId,
    itemIds,
  };
}

async function handleGetAgentPanelState(payload: { limit?: number } | undefined) {
  const limit = Math.max(1, Math.min(10, Math.round(Number(payload?.limit ?? 5))));
  if (currentTaskQueueScope === DEFAULT_TASK_QUEUE_SCOPE) {
    return {
      authenticated: false,
      approvals: [],
      runs: [],
      runtime: "local_companion" as const,
      runtimeConnected: false,
    };
  }

  try {
    const state = await callLocalCompanion<LocalCompanionPanelState>(
      "get_panel_state",
      {
        userScope: currentTaskQueueScope,
        limit,
      },
      12_000
    );
    return {
      authenticated: true,
      approvals: Array.isArray(state.approvals) ? state.approvals : [],
      runs: Array.isArray(state.runs) ? state.runs : [],
      runtime: "local_companion" as const,
      runtimeConnected: state.runtimeConnected !== false,
      runtimeError:
        typeof state.runtimeError === "string" ? state.runtimeError : undefined,
    };
  } catch (error) {
    return {
      authenticated: true,
      approvals: [],
      runs: [],
      runtime: "local_companion" as const,
      runtimeConnected: false,
      runtimeError: normalizeAgentCommandError(error),
    };
  }
}

async function executeLocalCompanionAction(
  action: LocalCompanionAction,
  sender: chrome.runtime.MessageSender
): Promise<{
  summary: string;
  metadata?: Record<string, unknown>;
}> {
  switch (action.kind) {
    case "insert_draft": {
      const tabId = sender.tab?.id;
      if (typeof tabId !== "number") {
        throw new Error("Missing sender tab id for draft insertion");
      }

      const insertResult = await browserExecutor.execute({
        kind: "insert_text",
        tabId,
        selector: action.fieldTarget.selector,
        text: action.generatedText,
        platform: action.fieldTarget.platform,
        world: "ISOLATED",
      });
      if (!insertResult.inserted) {
        throw new Error("Failed to insert the approved draft into the active field");
      }

      const verifyResult = await browserExecutor.execute({
        kind: "verify_text",
        tabId,
        selector: action.fieldTarget.selector,
        expectedText: action.verifyText,
        world: "ISOLATED",
        maxLength: Math.max(200, action.verifyText.length + 50),
      });
      if (!verifyResult.matched) {
        throw new Error("Inserted draft could not be verified in the active field");
      }

      return {
        summary: action.targetName
          ? `Inserted the approved draft for ${action.targetName}.`
          : "Inserted the approved draft into the active field.",
        metadata: {
          kind: action.kind,
          selector: action.fieldTarget.selector,
        },
      };
    }

    case "enqueue_task_batch": {
      const result = await handleEnqueueTasks({
        dailyLimit: action.dailyLimit,
        tasks: action.items.map((item) => ({
          type: action.batchType,
          targetUrl: item.targetUrl,
          targetName: item.targetName,
          generatedText: item.generatedText,
        })),
      });
      if ("error" in result && typeof result.error === "string") {
        throw new Error(result.error);
      }

      return {
        summary:
          action.items.length === 1
            ? `Queued 1 approved ${action.batchType.replace(/_/g, " ")} task.`
            : `Queued ${action.items.length} approved ${action.batchType.replace(/_/g, " ")} tasks.`,
        metadata: {
          kind: action.kind,
          batchType: action.batchType,
          dailyLimit: action.dailyLimit,
          itemCount: action.items.length,
          ...("batchId" in result ? { batchId: result.batchId } : {}),
        },
      };
    }
  }
}

async function reportLocalCompanionActionResult(payload: {
  approvalId: string;
  succeeded: boolean;
  summary?: string;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
}): Promise<LocalCompanionReportActionResult | null> {
  if (currentTaskQueueScope === DEFAULT_TASK_QUEUE_SCOPE) {
    return null;
  }

  try {
    return await callLocalCompanion<LocalCompanionReportActionResult>(
      "report_action_result",
      {
        userScope: currentTaskQueueScope,
        approvalId: payload.approvalId,
        succeeded: payload.succeeded,
        summary: payload.summary,
        errorMessage: payload.errorMessage,
        metadata: payload.metadata,
      },
      10_000
    );
  } catch {
    return null;
  }
}

function normalizeAgentRunFieldTarget(
  fieldTarget:
    | {
        selector?: string;
        platform?: string;
        fieldType?: string;
        charLimit?: number;
      }
    | undefined
) {
  if (
    !fieldTarget ||
    typeof fieldTarget.selector !== "string" ||
    !fieldTarget.selector.trim()
  ) {
    return undefined;
  }
  return {
    selector: fieldTarget.selector.trim(),
    platform:
      typeof fieldTarget.platform === "string"
        ? fieldTarget.platform
        : undefined,
    fieldType:
      typeof fieldTarget.fieldType === "string"
        ? fieldTarget.fieldType
        : undefined,
    charLimit:
      typeof fieldTarget.charLimit === "number"
        ? fieldTarget.charLimit
        : undefined,
  };
}

function normalizeAgentRunCandidates(
  scannedCandidates:
    | Array<{
        targetName?: string;
        targetUrl?: string;
        headline?: string;
      }>
    | undefined
) {
  const normalized = Array.isArray(scannedCandidates)
    ? scannedCandidates
        .map((item) => ({
          targetName:
            typeof item?.targetName === "string" ? item.targetName.trim() : "",
          targetUrl:
            typeof item?.targetUrl === "string" ? item.targetUrl.trim() : "",
          headline:
            typeof item?.headline === "string" && item.headline.trim()
              ? item.headline.trim()
              : undefined,
        }))
        .filter((item) => item.targetName && item.targetUrl)
    : undefined;
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function normalizeAgentRunWorkItems(
  workItems:
    | Array<{
        title?: string;
        pageUrl?: string;
        targetUrl?: string;
        targetName?: string;
        itemGoal?: string;
        itemContext?: string;
        sourceType?: string;
      }>
    | undefined
): LocalCompanionBrowserWorkItem[] | undefined {
  const normalized = Array.isArray(workItems)
    ? workItems
        .map((item, index) => {
          const title =
            typeof item?.title === "string" ? item.title.trim() : "";
          const pageUrl =
            typeof item?.pageUrl === "string" && item.pageUrl.trim()
              ? item.pageUrl.trim()
              : typeof item?.targetUrl === "string" && item.targetUrl.trim()
                ? item.targetUrl.trim()
                : "";
          if (!title && !pageUrl) {
            return null;
          }
          return {
            title: title || `Handle item ${index + 1}`,
            ...(pageUrl ? { pageUrl, targetUrl: pageUrl } : {}),
            ...(typeof item?.targetName === "string" && item.targetName.trim()
              ? { targetName: item.targetName.trim() }
              : {}),
            ...(typeof item?.itemGoal === "string" && item.itemGoal.trim()
              ? { itemGoal: item.itemGoal.trim() }
              : {}),
            ...(typeof item?.itemContext === "string" && item.itemContext.trim()
              ? { itemContext: item.itemContext.trim() }
              : {}),
            ...(typeof item?.sourceType === "string" && item.sourceType.trim()
              ? { sourceType: item.sourceType.trim() }
              : {}),
          } satisfies LocalCompanionBrowserWorkItem;
        })
        .filter(
          (item): item is LocalCompanionBrowserWorkItem => item !== null
        )
    : undefined;
  return normalized && normalized.length > 0 ? normalized : undefined;
}

async function handleStartAgentRun(
  payload:
    | {
        goal?: string;
        platformHint?: string;
        pageUrl?: string;
        pageContext?: string;
        fieldTarget?: {
          selector?: string;
          platform?: string;
          fieldType?: string;
          charLimit?: number;
        };
        scannedCandidates?: Array<{
          targetName?: string;
          targetUrl?: string;
          headline?: string;
        }>;
        workItems?: Array<{
          title?: string;
          pageUrl?: string;
          targetUrl?: string;
          targetName?: string;
          itemGoal?: string;
          itemContext?: string;
          sourceType?: string;
        }>;
        nextPageUrl?: string | null;
        structured?: unknown;
      }
    | undefined,
  sender: chrome.runtime.MessageSender
) {
  if (currentTaskQueueScope === DEFAULT_TASK_QUEUE_SCOPE) {
    return { error: "Sign in through the extension popup before starting agent runs" };
  }

  const goal = typeof payload?.goal === "string" ? payload.goal.trim() : "";
  if (!goal) {
    return { error: "Goal is required" };
  }

  const pageUrl = resolveAgentRunPageUrl(sender, payload?.pageUrl);
  const fieldTarget = normalizeAgentRunFieldTarget(payload?.fieldTarget);
  const scannedCandidates = normalizeAgentRunCandidates(payload?.scannedCandidates);
  const workItems = normalizeAgentRunWorkItems(payload?.workItems);
  const structured = normalizeStructuredExtraction(payload?.structured);
  const includeJobApplicationArtifacts = shouldAttachJobApplicationArtifacts({
    goal,
    platformHint:
      typeof payload?.platformHint === "string" ? payload.platformHint : undefined,
    pageUrl,
    pageContext:
      typeof payload?.pageContext === "string" && payload.pageContext.trim()
        ? payload.pageContext.trim()
        : undefined,
    fieldTarget,
    workItems,
    structured,
  });
  const runtimeInputs = await buildCurrentAgentRuntimeInputs({
    includeJobProfile: includeJobApplicationArtifacts,
    includeResumeFile: includeJobApplicationArtifacts,
  });

  try {
    return await callLocalCompanion<LocalCompanionStartRunResult>(
      "start_run",
      {
        userScope: currentTaskQueueScope,
        goal,
        platformHint:
          typeof payload?.platformHint === "string"
            ? payload.platformHint
            : undefined,
        pageUrl,
        pageContext:
          typeof payload?.pageContext === "string" && payload.pageContext.trim()
            ? payload.pageContext.trim()
            : undefined,
        userContext: runtimeInputs.userContext ?? undefined,
        systemPrompt: runtimeInputs.systemPrompt ?? undefined,
        fieldTarget,
        scannedCandidates,
        workItems,
        nextPageUrl:
          typeof payload?.nextPageUrl === "string" || payload?.nextPageUrl === null
            ? payload.nextPageUrl
            : undefined,
        structured,
        providerConfig: runtimeInputs.providerConfig,
        resumeFile: runtimeInputs.resumeFile,
      },
      60_000
    );
  } catch (error) {
    return { error: normalizeAgentCommandError(error) };
  }
}

async function handleCancelAgentRun(
  payload:
    | {
        runId?: string;
      }
    | undefined
) {
  if (currentTaskQueueScope === DEFAULT_TASK_QUEUE_SCOPE) {
    return { error: "Sign in through the extension popup before cancelling runs" };
  }

  const runId = typeof payload?.runId === "string" ? payload.runId.trim() : "";
  if (!runId) {
    return { error: "Run id is required" };
  }

  try {
    return await callLocalCompanion<LocalCompanionCancelRunResult>(
      "cancel_run",
      {
        userScope: currentTaskQueueScope,
        runId,
      },
      20_000
    );
  } catch (error) {
    return { error: normalizeAgentCommandError(error) };
  }
}

async function handleResumeAgentRun(
  payload:
    | {
        runId?: string;
        goal?: string;
        platformHint?: string;
        pageUrl?: string;
        pageContext?: string;
        fieldTarget?: {
          selector?: string;
          platform?: string;
          fieldType?: string;
          charLimit?: number;
        };
        scannedCandidates?: Array<{
          targetName?: string;
          targetUrl?: string;
          headline?: string;
        }>;
        workItems?: Array<{
          title?: string;
          pageUrl?: string;
          targetUrl?: string;
          targetName?: string;
          itemGoal?: string;
          itemContext?: string;
          sourceType?: string;
        }>;
        nextPageUrl?: string | null;
        structured?: unknown;
      }
    | undefined,
  sender: chrome.runtime.MessageSender
) {
  if (currentTaskQueueScope === DEFAULT_TASK_QUEUE_SCOPE) {
    return { error: "Sign in through the extension popup before resuming runs" };
  }

  const runId = typeof payload?.runId === "string" ? payload.runId.trim() : "";
  if (!runId) {
    return { error: "Run id is required" };
  }

  const pageUrl = resolveAgentRunPageUrl(sender, payload?.pageUrl);
  const fieldTarget = normalizeAgentRunFieldTarget(payload?.fieldTarget);
  const scannedCandidates = normalizeAgentRunCandidates(payload?.scannedCandidates);
  const workItems = normalizeAgentRunWorkItems(payload?.workItems);
  const structured = normalizeStructuredExtraction(payload?.structured);
  const includeJobApplicationArtifacts = shouldAttachJobApplicationArtifacts({
    goal:
      typeof payload?.goal === "string" && payload.goal.trim()
        ? payload.goal.trim()
        : undefined,
    platformHint:
      typeof payload?.platformHint === "string" ? payload.platformHint : undefined,
    pageUrl,
    pageContext:
      typeof payload?.pageContext === "string" && payload.pageContext.trim()
        ? payload.pageContext.trim()
        : undefined,
    fieldTarget,
    workItems,
    structured,
  });
  const runtimeInputs = await buildCurrentAgentRuntimeInputs({
    includeJobProfile: includeJobApplicationArtifacts,
    includeResumeFile: includeJobApplicationArtifacts,
  });

  try {
    return await callLocalCompanion<LocalCompanionResumeRunResult>(
      "resume_run",
      {
        userScope: currentTaskQueueScope,
        runId,
        pageUrl,
        pageContext:
          typeof payload?.pageContext === "string" && payload.pageContext.trim()
            ? payload.pageContext.trim()
            : undefined,
        userContext: runtimeInputs.userContext ?? undefined,
        systemPrompt: runtimeInputs.systemPrompt ?? undefined,
        fieldTarget,
        scannedCandidates,
        workItems,
        nextPageUrl:
          typeof payload?.nextPageUrl === "string" || payload?.nextPageUrl === null
            ? payload.nextPageUrl
            : undefined,
        structured,
        providerConfig: runtimeInputs.providerConfig,
        resumeFile: runtimeInputs.resumeFile,
      },
      60_000
    );
  } catch (error) {
    return { error: normalizeAgentCommandError(error) };
  }
}

async function handleResolveAgentApproval(
  payload:
    | {
        approvalId?: string;
        decision?: "approved" | "rejected";
        decisionNote?: string;
      }
    | undefined,
  sender: chrome.runtime.MessageSender
) {
  if (currentTaskQueueScope === DEFAULT_TASK_QUEUE_SCOPE) {
    return { error: "Sign in through the extension popup before resolving approvals" };
  }

  const approvalId =
    typeof payload?.approvalId === "string" ? payload.approvalId : null;
  const decision = payload?.decision;
  if (!approvalId) {
    return { error: "Approval id is required" };
  }
  if (decision !== "approved" && decision !== "rejected") {
    return { error: "Approval decision must be approved or rejected" };
  }

  const runtimeInputs = await buildCurrentAgentRuntimeInputs();

  try {
    return await callLocalCompanion<LocalCompanionResolveApprovalResult>(
      "resolve_approval",
      {
        userScope: currentTaskQueueScope,
        approvalId,
        decision,
        decisionNote:
          typeof payload?.decisionNote === "string"
            ? payload.decisionNote
            : undefined,
        providerConfig: runtimeInputs.providerConfig,
      },
      20_000
    );
  } catch (error) {
    return { error: normalizeAgentCommandError(error) };
  }
}

async function handleProcessTaskQueue() {
  void taskQueue.process();
  return { ok: true };
}

// ── Live recipient profile retrieval (Layer 3) ───────────────────────────────

interface RecipientProfile {
  name: string;
  headline: string | null;
  url: string | null;
  recentPosts: string[];
}

/**
 * Self-contained JSON-LD extraction function injected into a background tab
 * via chrome.scripting.executeScript. Must not reference any outer-scope
 * variables — it is serialised and sent to the target tab.
 */
function extractLinkedInJsonLdForInjection(): RecipientProfile | null {
  for (const script of document.querySelectorAll<HTMLScriptElement>(
    'script[type="application/ld+json"]'
  )) {
    try {
      const data = JSON.parse(script.textContent ?? "");
      const graph: any[] = data["@graph"] ?? [data];
      const person = graph.find((n: any) => n["@type"] === "Person");
      if (!person) continue;
      return {
        name: (person.name as string) ?? "",
        headline:
          (person.description as string) ??
          (person.headline as string) ??
          null,
        url: (person.url as string) ?? null,
        recentPosts: graph
          .filter((n: any) => n["@type"] === "Article")
          .slice(0, 3)
          .map((a: any) => a.headline as string)
          .filter(Boolean),
      };
    } catch { /* malformed JSON-LD */ }
  }
  return null;
}

/**
 * Opens a background tab, waits for the page to fully load, runs an extraction
 * script, closes the tab, and returns the result. LinkedIn SPA hydration needs
 * ~800ms after the `complete` event before JSON-LD scripts are present.
 */
async function openExtractClose(url: string, extraWaitMs = 800): Promise<RecipientProfile | null> {
  let tabId: number | null = null;
  try {
    const opened = await browserExecutor.execute({
      kind: "open_tab",
      url,
      active: false,
    });
    tabId = opened.tabId;
    await browserExecutor.execute({
      kind: "wait_for_tab_complete",
      tabId,
      timeoutMs: 15_000,
    });

    // Extra wait for SPA hydration
    await browserExecutor.execute({
      kind: "wait",
      durationMs: extraWaitMs,
    });

    const result = await browserExecutor.execute({
      kind: "run_script",
      tabId,
      world: "ISOLATED",
      func: extractLinkedInJsonLdForInjection,
    });

    return result.result ?? null;
  } catch {
    return null;
  } finally {
    if (tabId !== null) {
      browserExecutor.execute({ kind: "close_tab", tabId }).catch(() => {});
    }
  }
}

/**
 * Returns a cached or freshly-fetched LinkedIn recipient profile for the given
 * profile URL. Uses chrome.storage.session for a 30-minute in-session cache.
 * Volatile data — never written to Convex or any persistent store.
 */
async function fetchRecipientProfile(profileUrl: string): Promise<RecipientProfile | null> {
  const cacheKey = `profile:${profileUrl}`;
  const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

  try {
    const cached = await chrome.storage.session.get(cacheKey);
    const entry = cached[cacheKey] as { data: RecipientProfile; fetchedAt: number } | undefined;
    if (entry && Date.now() - entry.fetchedAt < CACHE_TTL_MS) {
      return entry.data;
    }
  } catch { /* storage.session may be unavailable in some environments */ }

  const profile = await openExtractClose(profileUrl);
  if (!profile) return null;

  try {
    await chrome.storage.session.set({
      [cacheKey]: { data: profile, fetchedAt: Date.now() },
    });
  } catch { /* non-fatal — just don't cache */ }

  return profile;
}

/** Formats a RecipientProfile as a concise, prompt-ready string. */
function formatRecipientProfile(profile: RecipientProfile): string {
  const lines: string[] = [];
  if (profile.name) lines.push(`Name: ${profile.name}`);
  if (profile.headline) lines.push(`Headline: ${profile.headline}`);
  if (profile.recentPosts?.length) {
    lines.push(`Recent posts: ${profile.recentPosts.slice(0, 3).join(" | ")}`);
  }
  return lines.join("\n");
}

function summarizeLinkedInConnectDebug(result: {
  debug?: {
    primaryButtons?: string[];
    menuOptions?: string[];
    dialogButtons?: string[];
    resolutionPath?: string[];
  };
}): string {
  const parts: string[] = [];
  const primary = result.debug?.primaryButtons?.slice(0, 5).join(", ");
  const menu = result.debug?.menuOptions?.slice(0, 5).join(", ");
  const dialog = result.debug?.dialogButtons?.slice(0, 5).join(", ");
  const path = result.debug?.resolutionPath?.slice(0, 8).join(" -> ");
  if (primary) parts.push(`primary=${primary}`);
  if (menu) parts.push(`menu=${menu}`);
  if (dialog) parts.push(`dialog=${dialog}`);
  if (path) parts.push(`path=${path}`);
  return parts.join(" | ");
}

function isRetriableLinkedInConnectError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return (
    message.includes("Frame with ID 0 was removed") ||
    message.includes("No frame with id 0") ||
    message.includes("The frame was removed")
  );
}

function shouldRetryLinkedInConnectWithCustomInvite(finalState: string): boolean {
  return (
    finalState === "dialog_not_found" ||
    finalState === "no_connect_control" ||
    finalState === "menu_connect_not_found"
  );
}

// ── Persistent task queue (Tier 3 browser automation) ────────────────────────

type Task = TaskQueueTask;

/**
 * Box-Muller gaussian random delay — LinkedIn bot detection is sensitive to
 * uniform timing so we use a gaussian distribution around baseMs.
 */
function humanDelay(baseMs: number): number {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.max(1000, baseMs + z * baseMs * 0.3);
}

function getTaskProgressKey(task: Task, scope: string): string {
  return getTaskProgressStorageKey(scope, task);
}

async function getTaskProgress(task: Task, scope: string): Promise<number> {
  const key = getTaskProgressKey(task, scope);
  const stored = await chrome.storage.local.get(key);
  return Number(stored[key] ?? 0);
}

async function incrementTaskProgress(task: Task, scope: string): Promise<void> {
  const key = getTaskProgressKey(task, scope);
  const current = await getTaskProgress(task, scope);
  await chrome.storage.local.set({ [key]: current + 1 });
}

async function scheduleTaskQueueResume(): Promise<void> {
  const nextMidnight = new Date();
  nextMidnight.setHours(24, 0, 5, 0);
  await chrome.alarms.create("resumeTaskQueue", {
    when: nextMidnight.getTime(),
  });
}

/**
 * Task queue persisted in chrome.storage.local so it survives service worker
 * termination. Processes one task at a time with human-like delays between
 * each step. Keeps the SW alive via periodic storage reads during long batches.
 */
class PersistentTaskQueue {
  private running = false;

  private async readQueue(scope: string): Promise<Task[]> {
    const key = getTaskQueueStorageKey(scope);
    const stored = await chrome.storage.local.get(key);
    return normalizeStoredTaskQueue<Task>(stored[key]);
  }

  private async writeQueue(scope: string, queue: Task[]): Promise<void> {
    const key = getTaskQueueStorageKey(scope);
    await chrome.storage.local.set({ [key]: queue });
  }

  async enqueue(tasks: Task[]): Promise<{ queued: number }> {
    const scope = currentTaskQueueScope;
    if (scope === DEFAULT_TASK_QUEUE_SCOPE) {
      throw new Error("Cannot enqueue background tasks without an authenticated user");
    }
    const taskQueue = await this.readQueue(scope);
    await this.writeQueue(scope, [...taskQueue, ...tasks]);
    void this.process();
    return { queued: tasks.length };
  }

  private async loadSyncableBatchDetails(): Promise<ExecutableTaskBatch[]> {
    const batchDetails = await convex.query(api.tasks.getSyncableBatches, {
      limit: 40,
      perStatusLimit: 10,
    });
    return batchDetails.map((batchDetails) => ({
      batch: {
        _id: String(batchDetails.batch._id),
        batchType: batchDetails.batch.batchType,
        status: batchDetails.batch.status,
        dailyLimit: batchDetails.batch.dailyLimit,
      },
      items: batchDetails.items.map((item) => ({
          _id: String(item._id),
          targetUrl: item.targetUrl,
          targetName: item.targetName,
          status: item.status,
          generatedText: item.generatedText,
          userEditedText: item.userEditedText,
      })),
    }));
  }

  private async syncApprovedBatches(scope: string): Promise<number> {
    const existingQueue = await this.readQueue(scope);
    const nextQueue = syncQueuedTasksWithBatchDetails(
      existingQueue,
      await this.loadSyncableBatchDetails()
    );

    const queueDelta = nextQueue.length - existingQueue.length;
    if (queueDelta !== 0) {
      await this.writeQueue(scope, nextQueue);
    }
    return Math.max(0, queueDelta);
  }

  private async requeueFront(scope: string, task: Task): Promise<void> {
    const taskQueue = await this.readQueue(scope);
    await this.writeQueue(scope, [task, ...taskQueue]);
  }

  private async requeueBack(scope: string, task: Task): Promise<number> {
    const taskQueue = await this.readQueue(scope);
    const nextQueue = [...taskQueue, task];
    await this.writeQueue(scope, nextQueue);
    return nextQueue.length;
  }

  private async dequeue(scope: string): Promise<Task | null> {
    const taskQueue = await this.readQueue(scope);
    if (!taskQueue.length) return null;
    const [task, ...rest] = taskQueue;
    await this.writeQueue(scope, rest);
    return task as Task;
  }

  private async refreshExecutableTask(task: Task): Promise<Task | null> {
    if (!task.batchId || !task.itemId) {
      return task;
    }

    const batchDetails = await convex.query(api.tasks.getBatch, {
      batchId: task.batchId as any,
    });
    if (!batchDetails) {
      return null;
    }

    if (
      batchDetails.batch.status !== "approved" &&
      batchDetails.batch.status !== "running"
    ) {
      return null;
    }

    const item = batchDetails.items.find((candidate) => candidate._id === task.itemId);
    if (!item || item.status !== "approved") {
      return null;
    }

    return {
      ...task,
      targetUrl: item.targetUrl,
      targetName: item.targetName,
      dailyLimit: batchDetails.batch.dailyLimit,
      generatedText: item.generatedText,
      userEditedText: item.userEditedText,
    };
  }

  async process(): Promise<void> {
    if (this.running) return;
    await loadToken();
    const scope = currentTaskQueueScope;
    if (scope === DEFAULT_TASK_QUEUE_SCOPE) return;
    this.running = true;
    // Keep SW alive: storage access resets the 5-minute idle timer
    const keepAlive = setInterval(
      () => chrome.storage.local.get("_alive"),
      20_000
    );
    try {
      await this.syncApprovedBatches(scope);
      let consecutiveDeferred = 0;

      while (true) {
        let task = await this.dequeue(scope);
        if (!task) {
          const added = await this.syncApprovedBatches(scope);
          if (added === 0) {
            break;
          }
          task = await this.dequeue(scope);
          if (!task) {
            break;
          }
        }

        if (scope !== currentTaskQueueScope) {
          await this.requeueFront(scope, task);
          break;
        }

        const refreshedTask = await this.refreshExecutableTask(task);
        if (!refreshedTask) {
          consecutiveDeferred = 0;
          continue;
        }
        task = refreshedTask;

        if (
          task.dailyLimit &&
          (await getTaskProgress(task, scope)) >= task.dailyLimit
        ) {
          if (task.batchId) {
            await convex
              .mutation(api.tasks.pauseBatch, { batchId: task.batchId as any })
              .catch(() => {});
          }
          const queueLength = await this.requeueBack(scope, task);
          await scheduleTaskQueueResume();
          consecutiveDeferred += 1;
          if (consecutiveDeferred >= queueLength) {
            break;
          }
          continue;
        }
        consecutiveDeferred = 0;

        if (task.batchId) {
          await convex
            .mutation(api.tasks.markBatchRunning, {
              batchId: task.batchId as any,
            })
            .catch(() => {});
        }

        const result = await this.executeTask(task);
        if (result === "sent") {
          await incrementTaskProgress(task, scope);
        }
        await new Promise((r) => setTimeout(r, humanDelay(3000)));
      }
    } finally {
      clearInterval(keepAlive);
      this.running = false;
    }
  }

  private async executeTask(task: Task): Promise<"sent" | "failed" | "skipped"> {
    try {
      if (task.type === "linkedin_connect") {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            return await this.executeLinkedInConnect(task);
          } catch (error) {
            if (!isRetriableLinkedInConnectError(error) || attempt > 0) {
              throw error;
            }
            console.warn(
              "[TaskQueue] transient linkedin_connect retry",
              task.targetUrl,
              error instanceof Error ? error.message : error
            );
            await new Promise((resolve) =>
              setTimeout(resolve, humanDelay(1200 + attempt * 600))
            );
          }
        }
        return "failed";
      }
      if (task.itemId) {
        await convex.mutation(api.tasks.updateItemStatus, {
          itemId: task.itemId as any,
          status: "skipped",
          errorMessage: "Unsupported task type",
        });
      }
      return "skipped";
    } catch (err: any) {
      console.warn("[TaskQueue] task failed:", task.type, err?.message ?? err);
      if (task.itemId) {
        await convex.mutation(api.tasks.updateItemStatus, {
          itemId: task.itemId as any,
          status: "failed",
          errorMessage: String(err?.message ?? err).slice(0, 500),
        }).catch(() => {});
      }
      return "failed";
    }
  }

  private async executeLinkedInConnect(task: Task): Promise<"sent" | "failed" | "skipped"> {
    const previousActiveTab = await getActiveTab().catch(() => null);
    const domHints = await loadPlatformDomHints("linkedin_profile_connect");
    const opened = await browserExecutor.execute({
      kind: "open_tab",
      url: task.targetUrl,
      active: true,
    });
    const tabId = opened.tabId;
    let closeTabOnExit = true;

    try {
      await browserExecutor.execute({
        kind: "wait_for_tab_complete",
        tabId,
        timeoutMs: 15_000,
      });
      await browserExecutor.execute({
        kind: "wait",
        durationMs: humanDelay(1200),
      });

      const actionProbe = await browserExecutor.execute({
        kind: "run_script",
        tabId,
        world: "MAIN",
        func: executeWaitForLinkedInPrimaryActionsInPage,
        args: [9_000, domHints],
      });
      const actionProbeResult = actionProbe.result as unknown as Awaited<
        ReturnType<typeof executeWaitForLinkedInPrimaryActionsInPage>
      >;
      const preflightLabels = Array.isArray(actionProbeResult?.labels)
        ? actionProbeResult.labels
        : [];
      if (!actionProbeResult?.ready) {
        console.warn("[TaskQueue] linkedin_connect preflight", {
          targetUrl: task.targetUrl,
          targetName: task.targetName,
          labels: preflightLabels.join(", "),
        });
      }

      const currentTabProfile = await browserExecutor.execute({
        kind: "run_script",
        tabId,
        world: "ISOLATED",
        func: extractLinkedInJsonLdForInjection,
      });
      const recipientProfile = coalesceLinkedInRecipientProfile({
        observedProfile:
          (currentTabProfile.result as LinkedInRecipientProfile | null | undefined) ??
          null,
        fallbackTargetName: task.targetName,
      });
      const pageContext = buildLinkedInConnectPageContext({
        recipientProfile,
        fallbackTargetName: task.targetName,
      });

      let noteText = (task.userEditedText ?? task.generatedText ?? "").trim();
      if (!noteText) {
        try {
          const capturedContexts = await loadCapturedContextsForGeneration();
          const generated = await convex.action(api.generate.generate, {
            instruction:
              "Write a concise, natural LinkedIn connection note. Sound human, specific, and low-pressure.",
            pageContext,
            platform: "linkedin",
            fieldMaxLength: 300,
            ...(capturedContexts.length > 0
              ? { capturedContexts }
              : {}),
            ...(recipientProfile
              ? { recipientContext: formatRecipientProfile(recipientProfile) }
              : {}),
          });
          noteText = generated.text?.trim() ?? "";
        } catch {
          noteText = "";
        }
      }

      if (task.itemId && noteText && !task.userEditedText && !task.generatedText) {
        await convex.mutation(api.tasks.attachGeneratedText, {
          itemId: task.itemId as any,
          generatedText: noteText,
        }).catch(() => {});
      }

      const connectResult = await browserExecutor.execute({
        kind: "run_script",
        tabId,
        world: "MAIN",
        func: executeLinkedInConnectWorkflowInPage,
        args: [noteText, domHints],
      });
      let connectFlow = connectResult.result as unknown as Awaited<
        ReturnType<typeof executeLinkedInConnectWorkflowInPage>
      >;
      let finalState = String(connectFlow?.state ?? "dialog_not_found");
      if (shouldRetryLinkedInConnectWithCustomInvite(finalState)) {
        const customInviteUrl = buildLinkedInCustomInviteUrl(task.targetUrl);
        if (customInviteUrl) {
          console.warn("[TaskQueue] linkedin_connect custom_invite_retry", {
            targetUrl: task.targetUrl,
            targetName: task.targetName,
            initialState: finalState,
            customInviteUrl,
          });
          await browserExecutor.execute({
            kind: "navigate",
            tabId,
            url: customInviteUrl,
            waitForComplete: true,
            timeoutMs: 15_000,
          });
          await browserExecutor.execute({
            kind: "wait",
            durationMs: humanDelay(900),
          });
          const retryResult = await browserExecutor.execute({
            kind: "run_script",
            tabId,
            world: "MAIN",
            func: executeLinkedInConnectWorkflowInPage,
            args: [noteText, domHints],
          });
          connectFlow = retryResult.result as unknown as Awaited<
            ReturnType<typeof executeLinkedInConnectWorkflowInPage>
          >;
          finalState = String(connectFlow?.state ?? "dialog_not_found");
        }
      }
      const debugSummary =
        summarizeLinkedInConnectDebug(connectFlow ?? {}) ||
        (preflightLabels.length > 0
          ? `preflight=${preflightLabels.slice(0, 8).join(", ")}`
          : "");

      console.warn("[TaskQueue] linkedin_connect", {
        targetUrl: task.targetUrl,
        targetName: task.targetName,
        finalState,
        debugSummary,
      });

      const observedLabels = normalizePlatformDomLabels([
        ...preflightLabels,
        ...(connectFlow?.debug?.primaryButtons ?? []),
        ...(connectFlow?.debug?.menuOptions ?? []),
        ...(connectFlow?.debug?.dialogButtons ?? []),
      ]);
      await recordPlatformDomObservation({
        surface: "linkedin_profile_connect",
        finalState,
        succeeded: finalState === "sent",
        labels: observedLabels,
        pageUrl: task.targetUrl,
        resolutionPath: connectFlow?.debug?.resolutionPath,
      });

      if (finalState === "already_connected" || finalState === "already_pending") {
        if (task.itemId) {
          await convex.mutation(api.tasks.updateItemStatus, {
            itemId: task.itemId as any,
            status: "skipped",
            errorMessage: [
              finalState === "already_pending"
                ? "LinkedIn invitation already pending"
                : "LinkedIn profile already connected",
              debugSummary,
            ]
              .filter(Boolean)
              .join(" | ")
              .slice(0, 500),
          });
        }
        return "skipped";
      }

      if (finalState !== "sent") {
        if (
          finalState === "dialog_not_found" ||
          finalState === "note_editor_not_found" ||
          finalState === "send_not_found"
        ) {
          closeTabOnExit = false;
          console.warn("[TaskQueue] linkedin_connect preserved_tab", {
            targetUrl: task.targetUrl,
            targetName: task.targetName,
            finalState,
          });
        }
        if (task.itemId) {
          await convex.mutation(api.tasks.updateItemStatus, {
            itemId: task.itemId as any,
            status:
              finalState === "no_connect_control" ||
              finalState === "menu_connect_not_found"
                ? "skipped"
                : "failed",
            errorMessage: [
              `LinkedIn connect flow ended: ${finalState}`,
              debugSummary,
            ]
              .filter(Boolean)
              .join(" | ")
              .slice(0, 500),
          });
        }
        return finalState === "no_connect_control" ||
          finalState === "menu_connect_not_found"
          ? "skipped"
          : "failed";
      }

      if (task.itemId) {
        await convex.mutation(api.tasks.updateItemStatus, {
          itemId: task.itemId as any,
          status: "sent",
        });
      }
      return "sent";
    } finally {
      await browserExecutor.execute({
        kind: "wait",
        durationMs: 500,
      });
      if (closeTabOnExit) {
        browserExecutor.execute({ kind: "close_tab", tabId }).catch(() => {});
      }
      if (
        closeTabOnExit &&
        previousActiveTab?.id &&
        previousActiveTab.id !== tabId
      ) {
        chrome.tabs
          .update(previousActiveTab.id, { active: true })
          .catch(() => {});
      }
    }
  }
}

const taskQueue = new PersistentTaskQueue();

// ── TTL cleanup (runs on alarm) ───────────────────────────────────────────

async function expireOldContexts() {
  try {
    await loadToken();
    await convex.mutation(api.context.expireActive, {});
  } catch {
    // Ignore — user may not be signed in
  }
}

export default defineBackground({
  type: "module",
  main() {
    void taskQueue.process();
  },
});
