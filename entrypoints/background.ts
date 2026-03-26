import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";

// ── Client singleton ──────────────────────────────────────────────────────
// ConvexHttpClient is stateless-friendly: safe to reuse across SW restarts.
const convex = new ConvexHttpClient(import.meta.env.VITE_CONVEX_URL as string);

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
    convex.setAuth(tokens.token);
    return true;
  } catch {
    return false;
  }
}

async function loadToken() {
  const stored = await chrome.storage.local.get("convexToken");
  const convexToken = typeof stored.convexToken === "string" ? stored.convexToken : null;

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
  if (alarm.name === "expireContexts") expireOldContexts();
});

// Set up recurring alarm for TTL cleanup (runs every 5 minutes)
chrome.alarms.create("expireContexts", { periodInMinutes: 5 });

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

    case "SAVE_MEMORY":
      return convex.mutation(api.memories.save, msg.payload);

    case "GET_STATS":
      return convex.query(api.memories.getStats, {});

    case "OPEN_SETTINGS":
      chrome.runtime.openOptionsPage();
      return { ok: true };

    default:
      return { error: `Unknown message type: ${msg.type}` };
  }
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

  const args = { ...payload, capturedContexts: capturedContexts.length > 0 ? capturedContexts : undefined };

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
