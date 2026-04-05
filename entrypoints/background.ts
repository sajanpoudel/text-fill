import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import type { SessionPayload } from "../src/lib/session-observer.ts";
import { ChromeBrowserExecutor } from "../src/lib/browser-executor.ts";
import {
  executeLinkedInConnectFromMoreMenuInPage,
  executeLinkedInConnectPrimaryActionInPage,
  executeLinkedInFillAndSendConnectDialogInPage,
} from "../src/lib/browser-control.ts";
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
  normalizeVoiceRuntimeState,
  type VoiceRuntimeState,
} from "../src/lib/voice-runtime.ts";

// ── Client singleton ──────────────────────────────────────────────────────
// ConvexHttpClient is stateless-friendly: safe to reuse across SW restarts.
const convex = new ConvexHttpClient(import.meta.env.VITE_CONVEX_URL as string);
const browserExecutor = new ChromeBrowserExecutor(chrome);
let currentTaskQueueScope = DEFAULT_TASK_QUEUE_SCOPE;
let voiceRuntimeState: VoiceRuntimeState = "idle";

// ── Auth sync + silent refresh ────────────────────────────────────────────
// The popup stores the JWT (convexToken) and refresh token (convexRefreshToken)
// in chrome.storage.local. We load the JWT here every time the SW wakes up
// and proactively refresh it when it's close to expiry.

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
  const stored = await chrome.storage.local.get("convexRefreshToken");
  const refreshToken = typeof stored.convexRefreshToken === "string" ? stored.convexRefreshToken : null;
  if (!refreshToken) return false;

  try {
    // Clear stale auth before calling the auth endpoint
    convex.clearAuth();
    // api.auth.signIn with just a refreshToken performs a silent token refresh
    const result = await (convex as any).action(api.auth.signIn, { refreshToken });
    const tokens = result?.tokens as { token: string; refreshToken?: string } | null;
    if (!tokens?.token) return false;

    const updates: Record<string, string> = { convexToken: tokens.token };
    if (tokens.refreshToken) updates.convexRefreshToken = tokens.refreshToken;
    await chrome.storage.local.set(updates);
    await syncTaskQueueScope(tokens.token);
    convex.setAuth(tokens.token);
    return true;
  } catch {
    return false;
  }
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
  const stored = await chrome.storage.local.get("convexToken");
  const convexToken = typeof stored.convexToken === "string" ? stored.convexToken : null;
  await syncTaskQueueScope(convexToken);

  if (!convexToken) {
    convex.clearAuth();
    return;
  }

  // Proactively refresh if token is expired or expiring within the next 2 minutes
  const expiry = parseJwtExpiry(convexToken);
  if (expiry !== null && Date.now() >= expiry - 2 * 60 * 1000) {
    const refreshed = await refreshConvexToken();
    if (refreshed) return; // setAuth already called inside refreshConvexToken
  }

  convex.setAuth(convexToken);
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

// Set up recurring alarm for TTL cleanup (runs every 5 minutes)
chrome.alarms.create("expireContexts", { periodInMinutes: 5 });

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !("convexToken" in changes)) return;
  const nextToken =
    typeof changes.convexToken?.newValue === "string"
      ? changes.convexToken.newValue
      : null;
  void syncTaskQueueScope(nextToken);
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

async function handleGenerate(
  action: string,
  payload: Record<string, unknown>,
  sender: chrome.runtime.MessageSender
) {
  const { recipientProfileUrl, ...generationPayload } = payload;

  // Read active contexts from local storage (multi-context library)
  let capturedContexts: Array<{ id: string; title: string; url: string; hostname: string; text: string; time: number; active: boolean }> = [];
  try {
    const { capturedContexts: stored } = await chrome.storage.local.get("capturedContexts");
    if (Array.isArray(stored)) {
      capturedContexts = stored.filter((c: any) => c && c.active !== false && typeof c.text === "string" && c.text.trim());
    }
  } catch {
    // Non-fatal
  }

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
  tasks?: Array<{ type: string; targetUrl: string; targetName?: string }>;
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
    })),
  });
  await convex.mutation(api.tasks.approveBatch, { batchId });

  const enrichedTasks = tasks.map((task, index) => ({
    ...task,
    batchId,
    itemId: itemIds[index],
    dailyLimit,
  }));

  return taskQueue.enqueue(enrichedTasks);
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

// ── Persistent task queue (Tier 3 browser automation) ────────────────────────

interface Task {
  type: string;
  targetUrl: string;
  targetName?: string;
  batchId?: string;
  itemId?: string;
  dailyLimit?: number;
  payload?: Record<string, unknown>;
}

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

  private async requeueFront(scope: string, task: Task): Promise<void> {
    const taskQueue = await this.readQueue(scope);
    await this.writeQueue(scope, [task, ...taskQueue]);
  }

  private async dequeue(scope: string): Promise<Task | null> {
    const taskQueue = await this.readQueue(scope);
    if (!taskQueue.length) return null;
    const [task, ...rest] = taskQueue;
    await this.writeQueue(scope, rest);
    return task as Task;
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
      let task: Task | null;
      while ((task = await this.dequeue(scope))) {
        if (scope !== currentTaskQueueScope) {
          await this.requeueFront(scope, task);
          break;
        }
        if (
          task.dailyLimit &&
          (await getTaskProgress(task, scope)) >= task.dailyLimit
        ) {
          if (task.batchId) {
            await convex
              .mutation(api.tasks.pauseBatch, { batchId: task.batchId as any })
              .catch(() => {});
          }
          await this.requeueFront(scope, task);
          await scheduleTaskQueueResume();
          break;
        }

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
        return await this.executeLinkedInConnect(task);
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
    const opened = await browserExecutor.execute({
      kind: "open_tab",
      url: task.targetUrl,
      active: false,
    });
    const tabId = opened.tabId;

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

      const recipientProfile = await fetchRecipientProfile(task.targetUrl);
      const recipientName =
        recipientProfile?.name || task.targetName || "this person";
      const recipientHeadline = recipientProfile?.headline ?? "";
      const pageContext = [
        "[CONNECT_NOTE_300]",
        recipientName
          ? `Audience: ${recipientName}${recipientHeadline ? ` — ${recipientHeadline}` : ""}`
          : "",
      ]
        .filter(Boolean)
        .join("\n");

      let noteText = "";
      try {
        const generated = await convex.action(api.generate.generate, {
          instruction:
            "Write a concise, natural LinkedIn connection note. Sound human, specific, and low-pressure.",
          pageContext,
          platform: "linkedin",
          fieldMaxLength: 300,
          ...(recipientProfile
            ? { recipientContext: formatRecipientProfile(recipientProfile) }
            : {}),
        });
        noteText = generated.text?.trim() ?? "";
      } catch {
        noteText = "";
      }

      if (task.itemId && noteText) {
        await convex.mutation(api.tasks.attachGeneratedText, {
          itemId: task.itemId as any,
          generatedText: noteText,
        }).catch(() => {});
      }

      const connectResult = await browserExecutor.execute({
        kind: "run_script",
        tabId,
        world: "MAIN",
        func: executeLinkedInConnectPrimaryActionInPage,
      });

      if (connectResult.result === "opened_more") {
        await browserExecutor.execute({
          kind: "wait",
          durationMs: humanDelay(700),
        });
        await browserExecutor.execute({
          kind: "run_script",
          tabId,
          world: "MAIN",
          func: executeLinkedInConnectFromMoreMenuInPage,
        });
      }

      await browserExecutor.execute({
        kind: "wait",
        durationMs: humanDelay(900),
      });

      const fillAndSend = async () =>
        browserExecutor.execute({
          kind: "run_script",
          tabId,
          world: "MAIN",
          func: executeLinkedInFillAndSendConnectDialogInPage,
          args: [noteText],
        });

      let finalState = "no_dialog";
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const state = await fillAndSend();
        finalState = String(state.result ?? "");
        if (finalState === "note_opened") {
          await browserExecutor.execute({
            kind: "wait",
            durationMs: humanDelay(700),
          });
          continue;
        }
        break;
      }

      if (
        connectResult.result === "not_found" ||
        finalState === "send_not_found" ||
        finalState === "no_dialog"
      ) {
        if (task.itemId) {
          await convex.mutation(api.tasks.updateItemStatus, {
            itemId: task.itemId as any,
            status: "skipped",
            errorMessage: "LinkedIn connect controls not found",
          });
        }
        return "skipped";
      }

      if (finalState !== "sent") {
        if (task.itemId) {
          await convex.mutation(api.tasks.updateItemStatus, {
            itemId: task.itemId as any,
            status: "failed",
            errorMessage: `Unexpected LinkedIn dialog state: ${finalState}`,
          });
        }
        return "failed";
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
      browserExecutor.execute({ kind: "close_tab", tabId }).catch(() => {});
    }
  }
}

const taskQueue = new PersistentTaskQueue();

// ── TTL cleanup (runs on alarm) ───────────────────────────────────────────

async function expireOldContexts() {
  try {
    await loadToken();
    // The getActive query auto-expires; just calling it is enough
    await convex.query(api.context.getActive, {});
  } catch {
    // Ignore — user may not be signed in
  }
}

export default defineBackground({
  type: "module",
  main() {
    // All registration happens at module top-level above.
    // This function is called by WXT to activate the service worker.
  },
});
