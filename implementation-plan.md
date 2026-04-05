# CheatResume — Browser Intelligence System: Implementation Plan

> **Goal**: Transform a text generator with flat memory into a proactive, AI-first browser intelligence layer that controls the browser, understands user behavior, speaks, and acts on the user's behalf before they even ask.

---

## Table of Contents

1. [Vision](#1-vision)
2. [Current State Audit](#2-current-state-audit)
3. [Architecture Overview](#3-architecture-overview)
4. [Layer 1 — Observation](#4-layer-1--observation)
5. [Layer 2 — Memory System](#5-layer-2--memory-system)
6. [Layer 3 — Live Retrieval](#6-layer-3--live-retrieval)
7. [Layer 4 — Browser Control](#7-layer-4--browser-control)
8. [Layer 5 — Voice](#8-layer-5--voice)
9. [Layer 6 — Proactive AI-First Behavior](#9-layer-6--proactive-ai-first-behavior)
10. [Layer 7 — Evaluation & Tracing](#10-layer-7--evaluation--tracing)
11. [Manifest & Permission Changes](#11-manifest--permission-changes)
12. [Convex Schema — Full Addition](#12-convex-schema--full-addition)
13. [Phased Implementation Order](#13-phased-implementation-order)
14. [Key Constraints & Guardrails](#14-key-constraints--guardrails)

---

## 1. Vision

The end state is not a text box helper. It is a **personal browser-layer AI** that:

- **Watches** what the user does before and after every AI generation — what they edited, what they sent, what they abandoned — and learns from it.
- **Understands** the user's behavioral patterns per platform and context type ("for LinkedIn recruiter DMs, user always shortens output and removes proof points").
- **Acts proactively**: scans pages for opportunities, finds 50 recruiter profiles on a search result, generates personalized messages for all of them, shows a preview queue, and sends them with human-in-the-loop approval.
- **Controls the browser** end-to-end: navigates tabs, clicks buttons, fills fields, reads pages, extracts data — all within the user's real Chrome session with no external tooling needed for core features.
- **Listens**: responds to voice commands ("write an email to this person, look at the attached context"), dictates text, and optionally wakes on a trigger phrase.
- **Learns over time**: every session is an episode. Episodes feed into procedural rules. Rules improve future generation prompts automatically.

The core constraint: the extension must be **production-safe** — no `chrome.debugger` warning bar, no native messaging install friction for core features. All core functionality uses `chrome.scripting`, `chrome.tabs`, `chrome.webNavigation`, and an offscreen document for audio/voice.

---

## 2. Current State Audit

### What already exists and is good

| Component | Location | Quality |
|---|---|---|
| MutationObserver + SPA detection | [entrypoints/content/App.tsx:661](entrypoints/content/App.tsx#L661) | Production-quality. Handles `pushState`, `replaceState`, delayed re-scans |
| `focusin`/`focusout` active field tracking | [entrypoints/content/App.tsx:763](entrypoints/content/App.tsx#L763) | Good. Natural session start/end hook |
| Platform-specific field selectors | [src/lib/platform.ts:108](src/lib/platform.ts#L108) | Comprehensive across 15+ platforms |
| Shadow DOM deep query | [src/lib/platform.ts:240](src/lib/platform.ts#L240) | `querySelectorAllDeep` handles Shadow DOM |
| LinkedIn context extractor | [src/lib/platforms/linkedin.ts](src/lib/platforms/linkedin.ts) | Platform-specific boundary + field type detection |
| DOM semantic walker | [src/lib/dom/walker.ts](src/lib/dom/walker.ts) | ARIA-based, class-name-free — stable |
| Page context orchestrator | [src/lib/context.ts:57](src/lib/context.ts#L57) | Clean 3-tier: platform extractor → DOM walk → recipient fallback |
| Vector search memory retrieval | [convex/generate.ts:414](convex/generate.ts#L414) | Works but flat — single `memoryContext` block |
| Memory extraction post-generation | [convex/memoryExtract.ts:194](convex/memoryExtract.ts#L194) | Semantic facts only, no episodic or procedural |
| Background service worker | [entrypoints/background.ts](entrypoints/background.ts) | Handles GENERATE, CAPTURE_CONTEXT, auth refresh |

### What is now built (Layer 1 complete — 2026-04-04)

| Component | Location | Notes |
|---|---|---|
| `SessionObserver` class | [src/lib/session-observer.ts](src/lib/session-observer.ts) | Full session lifecycle, multi-signal send detection |
| Multi-signal send detection | [src/lib/session-observer.ts:345](src/lib/session-observer.ts#L345) | Signal A = form submit, B = Enter/Ctrl+Enter, C = mousedown + XHR confirm |
| Per-field composite snapshot | [src/lib/session-observer.ts:421](src/lib/session-observer.ts#L421) | Debounced `input` (300ms) + `compositionend` → `_settledText` map |
| MAIN-world XHR/fetch interceptor | [entrypoints/content/index.ts:20](entrypoints/content/index.ts#L20) | Injected as inline `<script>` element, posts `__TF_SEND__` on send-like POSTs |
| Bounded Levenshtein + trigram diff | [src/lib/session-observer.ts:61](src/lib/session-observer.ts#L61) | O(n) space, bails at 5000 ops; trigram fallback for texts > 1500 chars |
| `interactionSessions` + `sessionArtifacts` tables | [convex/schema.ts:68](convex/schema.ts#L68) | With `recipientName`, soft-deleted artifact, 3 indexes each |
| `recordSession` mutation | [convex/interactions.ts:7](convex/interactions.ts#L7) | Inserts session row + optional artifact in one transaction |
| `OBSERVE_SESSION` routing | [entrypoints/background.ts:103](entrypoints/background.ts#L103) | Fire-and-forget to Convex; never blocks generation |
| Generation hooks — all paths | [entrypoints/content/FieldButton.tsx:173](entrypoints/content/FieldButton.tsx#L173), [GenerateModal.tsx:289](entrypoints/content/GenerateModal.tsx#L289) | `onGenerationStart` + `onGenerationComplete(getFieldText(field))` after 80+120ms |
| `scripting`, `tabs`, `webNavigation` permissions | [wxt.config.ts](wxt.config.ts) | Added for Layer 1; `offscreen` deferred to Layer 5 (voice) |

### What is still missing

| Gap | Impact |
|---|---|
| No episodic memory retrieval in generation | Sessions accumulate but don't feed back into prompts yet |
| No procedural memory (what rules does user follow) | Cannot adapt generation prompts to user style |
| No entity graph (people, companies, relations) | Cannot track "user works at X" with temporal validity |
| No live retrieval (recipient profile at generation time) | Volatile data leaks into long-term memory |
| No browser control (click, navigate, fill fields) | Cannot act on user's behalf |
| No proactive scanning (find opportunities, suggest) | Always reactive — waits for user to ask |
| No voice input | Cannot listen to commands |
| No offscreen document | No long-running audio or persistent JS |

---

## 3. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  BROWSER (User's Chrome)                                        │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  CONTENT SCRIPT (injected into every tab)                │  │
│  │  • Field observer (MutationObserver + focus/blur)        │  │
│  │  • Session lifecycle (open → AI gen → edit → send)       │  │
│  │  • Proactive page scanner (LinkedIn search results, etc) │  │
│  │  • UI layer (FAB, modal, suggestion chips, queue view)   │  │
│  │  • Worker: receives CLICK, TYPE, EXTRACT commands from SW│  │
│  └────────────────┬─────────────────────────────────────────┘  │
│                   │ chrome.runtime.sendMessage                  │
│  ┌────────────────▼─────────────────────────────────────────┐  │
│  │  SERVICE WORKER (orchestrator, always-on relay)          │  │
│  │  • Task queue (persisted in chrome.storage.local)        │  │
│  │  • Tab lifecycle manager (create/wait/inject/close)      │  │
│  │  • Auth token management + Convex HTTP client            │  │
│  │  • Routes: GENERATE, OBSERVE_SESSION, ENQUEUE_TASK,      │  │
│  │             VOICE_COMMAND, SCAN_PAGE, BATCH_EXECUTE      │  │
│  └────────────────┬─────────────────────────────────────────┘  │
│                   │                                             │
│  ┌────────────────▼─────────────────────────────────────────┐  │
│  │  OFFSCREEN DOCUMENT (persistent, DOM-capable)            │  │
│  │  • Web Speech API (continuous SpeechRecognition)         │  │
│  │  • MediaRecorder (audio chunks for Whisper/Realtime)     │  │
│  │  • Wake word detection (Porcupine WASM)                  │  │
│  │  • Long-running JS without SW termination risk           │  │
│  └──────────────────────────────────────────────────────────┘  │
└────────────────────────────┬────────────────────────────────────┘
                             │ HTTPS (Convex HTTP client)
┌────────────────────────────▼────────────────────────────────────┐
│  CONVEX BACKEND                                                 │
│  • memories: semantic facts (existing, upgraded)                │
│  • interactionSessions + sessionArtifacts: episodic records     │
│  • entities + entityEdges + edgeSupports: temporal entity graph │
│  • proceduralPatterns + patternSupports: behavioral rules       │
│  • traces + traceArtifacts: eval/debug records                  │
│  • generate.ts: upgraded 3-tier retrieval (semantic + procedural│
│    + episodic examples)                                         │
│  • Scheduled actions: pattern consolidation, confidence decay   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 4. Layer 1 — Observation

> **Status: COMPLETE** (2026-04-04). All code is live and building clean.

### What was built

| File | Role |
|---|---|
| [src/lib/session-observer.ts](src/lib/session-observer.ts) | `SessionObserver` singleton — full session lifecycle |
| [convex/interactions.ts](convex/interactions.ts) | `recordSession` mutation — one transaction for session + artifact |
| [convex/schema.ts:68](convex/schema.ts#L68) | `interactionSessions` + `sessionArtifacts` tables |
| [entrypoints/content/App.tsx:770](entrypoints/content/App.tsx#L770) | `onFieldFocus` / `onFieldBlur` hooks into existing focusin/focusout handlers |
| [entrypoints/content/FieldButton.tsx:173](entrypoints/content/FieldButton.tsx#L173) | `onGenerationStart` + `onGenerationComplete` for generate path |
| [entrypoints/content/GenerateModal.tsx:289](entrypoints/content/GenerateModal.tsx#L289) | `onGenerationStart` + `onGenerationComplete` for rewrite/shorten/expand paths |
| [entrypoints/background.ts:103](entrypoints/background.ts#L103) | `OBSERVE_SESSION` case → `handleObserveSession` → Convex mutation |
| [entrypoints/content/index.ts:20](entrypoints/content/index.ts#L20) | MAIN-world XHR/fetch interceptor injected as inline `<script>` element |

### Session lifecycle (as implemented)

```
focusin        → onFieldFocus(field, platform)   — opens session, attaches per-field listeners
generation call → onGenerationStart(field)        — snapshots preText
post-insert    → onGenerationComplete(field, getFieldText(field))  — 80ms + 120ms after insert
input/IME      → debounced 300ms / compositionend — updates _settledText map
focusout       → onFieldBlur(field)              — computes diff, classifies, emits to SW
```

### Composite text snapshot model (as implemented)

1. `onGenerationStart(field)` — captures `getFieldText(field)` as `preText` baseline
2. Per-field `input` listener, debounced 300ms — updates `_settledText` after framework normalization
3. Per-field `compositionend` listener — immediate update for IME input completion
4. `onGenerationComplete(field, getFieldText(field))` — called 200ms after `insertText`, captures what actually landed in the editor (not the raw API response — `insertText` may truncate/normalize)
5. `onFieldBlur` — uses `_settledText` preferentially over sync snapshot

### Diff computation (as implemented)

No external dependency. Inline in `session-observer.ts`:

- **Bounded Levenshtein** — O(n) space, bails out at `maxDist=5000` for speed. Sufficient for texts up to ~1500 chars.
- **Trigram similarity fallback** — for texts > 1500 chars. Returns `1 - similarity` as edit fraction.

```typescript
export function classifyOutcome(aiText: string, finalText: string): SessionOutcome {
  if (!finalText.trim()) return 'abandoned';
  if (finalText.trim() === aiText.trim()) return 'accepted';
  const frac = editFraction(aiText, finalText);
  if (frac < 0.15) return 'lightly_edited';
  if (frac < 0.5) return 'heavily_edited';
  return 'rewritten';
}
```

### Send detection — three independent signals (as implemented)

Signal C alone (mousedown without XHR confirmation) is **not sufficient**. All three are independent:

**Signal A — form `submit` event** (self-confirming):
```typescript
document.addEventListener('submit', (e) => {
  if (form.contains(activeField)) _formSubmitPending = { field, at: Date.now() };
}, { capture: true, passive: true });
```

**Signal B — keyboard Enter** (self-confirming):
- Single-line `<input>`: plain Enter
- `contenteditable` (LinkedIn, Gmail): Ctrl/Cmd+Enter only

**Signal C — mousedown on enabled send button, confirmed by XHR** (requires both):
- `mousedown` on element matching `[aria-label*="Send"]`, `[data-testid*="send"]`, etc., AND `disabled` check on element + ancestors
- XHR/fetch POST to send-like URL must arrive within 3 seconds via `window.postMessage`
- The MAIN-world interceptor is injected at content script init in [entrypoints/content/index.ts:20](entrypoints/content/index.ts#L20) as an inline `<script>` element (not via `chrome.scripting.executeScript` — that would require a tab ID; the inline approach works directly from the ISOLATED world)

```typescript
private _checkSentSignals(field: Element, now: number): boolean {
  const WINDOW_MS = 2000;
  // Signal A
  if (this._formSubmitPending?.field === field && now - this._formSubmitPending.at < WINDOW_MS) return true;
  // Signal B
  if (this._enterPending?.field === field && now - this._enterPending.at < WINDOW_MS) return true;
  // Signal C
  if (this._mousedownPending?.field === field &&
      this._xhrConfirmedAt > this._mousedownPending.at &&
      this._xhrConfirmedAt - this._mousedownPending.at < 3000) return true;
  return false;
}
```

### Session event emission (as implemented)

On field blur, `SessionObserver` calls `chrome.runtime.sendMessage` with:

```typescript
{
  type: 'OBSERVE_SESSION',
  payload: {
    sessionId,      // crypto.randomUUID()
    platform,       // "linkedin" | "gmail" | etc.
    contextType,    // "connection_req" | "dm" | "inmail" | "email" | "post" | undefined
    recipientName,  // from onGenerationStart optional param
    openedAt, aiGeneratedAt, closedAt,
    outcome,        // "accepted" | "lightly_edited" | "heavily_edited" | "rewritten" | "abandoned" | "sent"
    charDelta, editFraction,
    aiPreText, aiGeneratedText, userFinalText,  // capped at 4000 chars each in Convex
  }
}
```

Service worker routes to `handleObserveSession` → `convex.mutation(api.interactions.recordSession, ...)`. Fire-and-forget — never blocks generation.

---

## 5. Layer 2 — Memory System

### Three tiers

| Tier | What it stores | Updated when | Used for |
|---|---|---|---|
| **Semantic** (existing `memories` table, upgraded) | Durable facts: current job, education, stable skills | Post-generation extraction (existing) | Ground truth about user |
| **Episodic** (`interactionSessions` + `sessionArtifacts`) | What happened in each session | Every session close | Few-shot examples in generation |
| **Procedural** (`proceduralPatterns` + `patternSupports`) | Behavioral rules per platform/context | Counter-triggered LLM consolidation | Adapting generation prompts |

### Semantic memory upgrade: bi-temporal validity

Add `validAt` and `invalidAt` to the existing `memories` table. When a new fact contradicts an old one (e.g., user changes job), **soft-invalidate** — never delete:

```typescript
// On contradiction: set invalidAt on old record, insert new record
await ctx.db.patch(oldMemoryId, { invalidAt: Date.now() });
await ctx.db.insert('memories', { ...newFact, validAt: Date.now(), invalidAt: null });
```

Query only active facts: `withIndex("by_user_active", q => q.eq("userId", userId).eq("invalidAt", undefined))`

> **Critical Convex index rule**: `invalidAt` must be the **first non-userId field** in the index for the `.eq("invalidAt", undefined)` filter to be efficient. A `.filter()` instead of `.withIndex()` causes a full-table scan.

### Entity graph

Track entities (people, companies) and their temporal relationships:

- `entities`: each named entity the user interacts with
- `entityEdges`: relationships with `validAt`/`invalidAt` bi-temporal fields
- `edgeSupports`: junction table (edge ↔ session) — no unbounded arrays

**Entity resolution** (matching "Google DeepMind" to "DeepMind"):
1. Exact normalized string match (free)
2. Embedding cosine similarity ≥ 0.85 (cheap)
3. Async LLM call for 0.75–0.85 range (expensive, run via scheduled Convex action)

### Procedural pattern promotion

**Counter-triggered, not weekly batch:**

1. On every session close, increment a counter in `proceduralPatterns` for matching `platform + contextType`
2. When counter reaches **3**, schedule an async LLM call to draft a rule text from the supporting sessions
3. Weekly scheduled action handles **confidence decay** only (`confidence *= 0.9` per week with no trigger)
4. At `confidence < 0.1`, soft-delete the pattern

**Evidence threshold before promotion**: 3+ occurrences across 2+ distinct calendar days. A single power-user session with 3 identical sends should not immediately create a rule.

### Junction tables (Convex-safe many-to-many)

Never use unbounded arrays. Use explicit join tables:

```
edgeSupports(edgeId, sessionId) — which sessions support which entity edges
patternSupports(patternId, sessionId) — which sessions support which procedural rules
```

Install `convex-helpers` and use `getManyVia` for relationship lookups:
```typescript
import { getManyVia } from "convex-helpers/server/relationships";
const sessions = await getManyVia(ctx.db, "patternSupports", "sessionId", "by_pattern", patternId);
```

---

## 6. Layer 3 — Live Retrieval

### The core rule
**Volatile recipient data is NEVER stored in long-term memory.** It is fetched at generation time, injected into the prompt as context, and discarded. It does not belong in `memories`, `entities`, or any Convex table unless the user explicitly confirms "remember this person."

### Retrieval policy (in order)

```
1. Load foreground page context (existing extractPageContext())
2. Retrieve semantic facts about the user (memories WHERE status='active' AND invalidAt IS NULL)
3. Retrieve procedural rules for this platform + contextType (proceduralPatterns)
4. Retrieve 2-3 recent similar episodes (interactionSessions WHERE platform=X AND outcome != 'abandoned')
5. If recipient profile missing or stale: do live lookup (navigate → extract → return)
6. Only now: call generate.ts with all context assembled
```

### Multi-tier prompt injection

Replace the single `memoryContext` block in [generate.ts:462](convex/generate.ts#L462) with three labeled sections:

```
=== ABOUT YOU ===
[semantic facts — durable, user-specific]

=== YOUR STYLE RULES ===
[procedural patterns for this platform/context — e.g., "For LinkedIn recruiter DMs: keep under 3 sentences, skip social proof, end with direct CTA"]

=== RECENT CONTEXT ===
[2-3 anonymized edit summaries from similar past sessions — NOT full prior messages]

=== RECIPIENT CONTEXT (transient) ===
[live-fetched profile data — present ONLY for this generation, never persisted]
```

> **Important**: inject anonymized edit summaries (e.g., "User shortened by 45%, removed the proof-point sentence") as few-shot examples — NOT the full past outbound message verbatim. Raw prior messages leak stale recipient-specific details into new threads.

### LinkedIn JSON-LD extraction (stable method)

LinkedIn publishes JSON-LD on profile pages for SEO. This is more stable than CSS class selectors (which change quarterly):

```typescript
// src/lib/platforms/linkedin.ts — add to existing file
export function extractLinkedInJsonLd(): RecipientProfile | null {
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(script.textContent!);
      const graph: any[] = data['@graph'] ?? [data];
      const person = graph.find(n => n['@type'] === 'Person');
      if (!person) continue;
      return {
        name: person.name as string,
        headline: (person.description ?? person.headline ?? null) as string | null,
        url: person.url as string ?? null,
        recentPosts: graph
          .filter(n => n['@type'] === 'Article')
          .slice(0, 3)
          .map((a: any) => a.headline as string),
      };
    } catch {}
  }
  return null;
}
```

### Transient caching

Use `chrome.storage.session` (10 MB, expires on browser restart) to cache profile data within a browser session:

```typescript
// Cache lookup before live fetch
const cacheKey = `profile:${profileUrl}`;
const cached = await chrome.storage.session.get(cacheKey);
if (cached[cacheKey] && Date.now() - cached[cacheKey].fetchedAt < 30 * 60 * 1000) {
  return cached[cacheKey].data; // 30-minute in-session cache
}
// ... fetch, then:
await chrome.storage.session.set({ [cacheKey]: { data: profile, fetchedAt: Date.now() } });
```

---

## 7. Layer 4 — Browser Control

### Control tiers (from safe to invasive)

#### Tier 1 — Content script injection (production-safe, no warning)

**The primary tier for all user-facing automation.** Uses `chrome.scripting.executeScript` with `world: "MAIN"` for reliable interaction with React/Vue apps.

**Reliable synthetic click for React apps:**
```typescript
// MAIN world — full pointer + mouse event sequence
function syntheticClick(el: Element) {
  el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
  el.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  (el as HTMLElement).click(); // belt-and-suspenders
}
```

**Reliable text injection into contenteditable (React/Quill/Lexical/ProseMirror):**

Your existing `insert-text.ts` already has the correct pattern. Key mechanism: `document.execCommand('insertText', false, text)` goes through the browser's editing pipeline, fires `beforeinput` which frameworks intercept. For `<textarea>` and `<input>`, use the native property setter:

```typescript
const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  ?? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
setter?.call(el, text);
el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
el.dispatchEvent(new Event('change', { bubbles: true }));
```

> **MAIN world critical limitation**: `chrome.*` APIs are `undefined` in MAIN world. Communication back to your content script must go through `window.postMessage`. Your ISOLATED-world content script listener receives it via `window.addEventListener('message', ...)`.

#### Tier 2 — Tab orchestration (production-safe)

Open background tab → wait for load → inject → extract → close:

```typescript
// entrypoints/background.ts — add to service worker
async function openExtractClose<T>(
  url: string,
  extractFn: () => T,
  extraWaitMs = 800
): Promise<T> {
  const tab = await chrome.tabs.create({ url, active: false });
  
  await new Promise<void>(resolve => {
    const listener = (tabId: number, info: chrome.tabs.TabChangeInfo) => {
      if (tabId === tab.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
  
  // Extra wait for SPA hydration (LinkedIn needs ~800ms after 'complete')
  await new Promise(r => setTimeout(r, extraWaitMs));
  
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: extractFn,
  });
  
  await chrome.tabs.remove(tab.id);
  return result.result as T;
}
```

**SPA navigation detection** — use `webNavigation.onHistoryStateUpdated` (better than `tabs.onUpdated` for LinkedIn/Gmail which use `history.pushState`):

```typescript
// background.ts — better than polling or MutationObserver for SW-level detection
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId !== 0) return;
  chrome.tabs.sendMessage(details.tabId, { type: 'SPA_NAVIGATED', url: details.url })
    .catch(() => {}); // content script may not be ready yet
});
```

#### Tier 3 — Persistent task queue (for batch operations)

Persisted in `chrome.storage.local` so it survives service worker termination:

```typescript
// entrypoints/background.ts
class PersistentTaskQueue {
  private running = false;

  async enqueue(tasks: Task[]) {
    const { queue = [] } = await chrome.storage.local.get('taskQueue');
    await chrome.storage.local.set({ taskQueue: [...queue, ...tasks] });
    void this.process();
  }

  private async dequeue(): Promise<Task | null> {
    const { queue = [] } = await chrome.storage.local.get('taskQueue');
    if (!queue.length) return null;
    const [task, ...rest] = queue;
    await chrome.storage.local.set({ taskQueue: rest });
    return task;
  }

  async process() {
    if (this.running) return;
    this.running = true;
    // Keep SW alive: storage access resets the 5-minute idle timer
    const keepAlive = setInterval(() => chrome.storage.local.get('_alive'), 20_000);
    try {
      let task: Task | null;
      while ((task = await this.dequeue())) {
        await this.executeTask(task);
        // Human-like random delay between tasks
        await new Promise(r => setTimeout(r, humanDelay(3000)));
      }
    } finally {
      clearInterval(keepAlive);
      this.running = false;
    }
  }
}

// Gaussian random delay (not uniform) — LinkedIn bot detection is sensitive to uniform timing
function humanDelay(baseMs: number): number {
  const u1 = Math.random(), u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.max(1000, baseMs + z * baseMs * 0.3);
}
```

#### Tier 4 — Local power mode: chrome.debugger (dev builds only)

`chrome.debugger` attaches CDP to a tab and gives you:
- `Network.requestWillBeSent` + `Network.getResponseBody` — full request/response bodies
- `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` — precise mouse/keyboard input
- `Page.navigate` — programmatic navigation

**Critical production constraint**: Chrome shows a hardcoded infobar: *"[Extension] started debugging this browser."* This cannot be suppressed. Use `chrome.debugger` **only** in local/dev builds, never in the production Chrome Web Store build.

Gating pattern in `wxt.config.ts`:
```typescript
// Only include debugger in dev builds
...(process.env.NODE_ENV === 'development' ? ['debugger', 'nativeMessaging'] : [])
```

#### Tier 5 — Native messaging sidecar (Playwright/Puppeteer, local power users)

For full agent-level browser control beyond what `chrome.scripting` can do:
- Playwright (`chromium.connectOverCDP('http://localhost:9222')`) can connect to Chrome launched with `--remote-debugging-port`
- `chrome.runtime.connectNative('com.yourapp.sidecar')` opens a persistent pipe to a local Node/Python process

**Requires OS-level install** (manifest JSON file placement in OS-specific location). This is appropriate for a "power mode" offered to developers and advanced users, not general distribution.

Native host manifest (`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.yourapp.sidecar.json`):
```json
{
  "name": "com.yourapp.sidecar",
  "description": "CheatResume browser automation sidecar",
  "path": "/usr/local/bin/cheatresume-sidecar",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://YOUR_EXTENSION_ID/"]
}
```

---

## 8. Layer 5 — Voice

### Architecture: offscreen document as voice runtime

The MV3 service worker cannot use `SpeechRecognition` (no `window` object) and gets terminated after 5 minutes of inactivity. The offscreen document solves both problems: it has a full DOM, runs indefinitely, and has access to `getUserMedia`.

```
User speaks
  → Offscreen document (SpeechRecognition / MediaRecorder)
  → chrome.runtime.sendMessage to service worker
  → Service worker routes: VOICE_COMMAND → generate | TRANSCRIPTION → fill field
  → Content script receives result, fills field or shows suggestion
```

### Setup

`entrypoints/offscreen.html` + `entrypoints/offscreen.ts` (new files):

```typescript
// entrypoints/offscreen.ts
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== 'offscreen') return;
  if (msg.type === 'START_VOICE') startRecognition();
  if (msg.type === 'STOP_VOICE') stopRecognition();
});
```

Service worker creates offscreen document on demand:
```typescript
// background.ts
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: chrome.runtime.getURL('offscreen.html'),
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: 'Continuous speech recognition for voice commands',
  });
}
```

### Web Speech API (continuous recognition)

```typescript
// offscreen.ts
const SR = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
const recognition = new SR() as SpeechRecognition;
recognition.continuous = true;
recognition.interimResults = true;
recognition.lang = 'en-US';

recognition.onresult = (e: SpeechRecognitionEvent) => {
  const isFinal = e.results[e.results.length - 1].isFinal;
  const transcript = Array.from(e.results).map(r => r[0].transcript).join('');
  chrome.runtime.sendMessage({
    target: 'background',
    type: isFinal ? 'VOICE_COMMAND' : 'VOICE_INTERIM',
    text: transcript,
  });
};

// Auto-restart on end (Chrome stops after silence or ~5 minutes)
recognition.onend = () => {
  if (isListening) recognition.start();
};
```

**Microphone permission**: No manifest key pre-grants mic access. The first `getUserMedia` call triggers a one-time OS permission prompt for the extension origin (`chrome-extension://...`). Subsequent calls use the stored grant. Trigger this from the extension popup for the smoothest UX.

### Cloud STT via OpenAI (higher accuracy, language-agnostic)

For commands needing higher accuracy or non-English support, stream audio to OpenAI's Realtime API or Whisper:

```typescript
// offscreen.ts — OpenAI Realtime API option
const ws = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview', [
  'realtime',
  `openai-insecure-api-key.${OPENAI_KEY}`, // use session token in production
  'openai-beta.realtime-v1',
]);
// Stream PCM16 audio chunks; receive JSON transcript events
// Latency: ~300-600ms — faster than chunked Whisper
```

For chunked Whisper (simpler, higher latency): capture 3-second `MediaRecorder` chunks, send as `Uint8Array` to service worker, forward to Convex action that calls OpenAI Whisper API.

### Voice command parsing

Commands from the offscreen document arrive at the service worker as raw transcript text. Route to Convex for intent parsing:

```typescript
// Service worker
case 'VOICE_COMMAND': {
  const intent = await convex.action(api.voice.parseIntent, { text: msg.text });
  // intent: { action: 'compose' | 'search' | 'send' | 'connect', params: {...} }
  if (intent.action === 'compose') {
    await handleGenerate('generate', intent.params, sender);
  }
  break;
}
```

### Wake word detection (optional, privacy-preserving)

Porcupine Web SDK (`@picovoice/porcupine-web`) runs WASM in the offscreen document. No audio leaves the device until wake word is detected. Built-in keywords available (e.g., "Jarvis", "Hey Siri"-style); custom keywords require Picovoice account.

```typescript
// offscreen.ts
import { Porcupine, BuiltInKeyword } from '@picovoice/porcupine-web';
const porcupine = await Porcupine.create(PICOVOICE_KEY, [BuiltInKeyword.Jarvis], () => {
  chrome.runtime.sendMessage({ target: 'background', type: 'WAKE_WORD' });
  startFullRecognition(); // activate full speech pipeline on wake
});
```

Bundle size: ~300KB–2MB for WASM model. Load lazily only when wake word feature is enabled in settings.

---

## 9. Layer 6 — Proactive AI-First Behavior

### Philosophy

The extension should behave like a smart colleague who notices things and offers to help — not a modal that interrupts every page load. Key UX rules:
- **Never interrupt mid-compose.** Only surface suggestions when the user is NOT actively typing.
- **Threshold-gate suggestions.** Don't suggest for 1-2 items. Minimum meaningful threshold (e.g., 5+ people on a LinkedIn search).
- **Respect dismissals.** Store dismissal per URL pattern; don't resurface on the same page.
- **Show, don't act.** Show a preview queue and require explicit approval before any autonomous action.

### Page scanning trigger

Extend the existing `MutationObserver` in [App.tsx:661](entrypoints/content/App.tsx#L661) with a debounced change-threshold layer:

```typescript
// Add to App.tsx alongside existing MutationObserver
const opportunityScanner = {
  changeCount: 0,
  lastScan: 0,
  timer: null as ReturnType<typeof setTimeout> | null,

  record(addedNodeCount: number) {
    this.changeCount += addedNodeCount;
    clearTimeout(this.timer!);
    this.timer = setTimeout(() => this.evaluate(), 2000); // 2s debounce
  },

  evaluate() {
    const now = Date.now();
    const COOLDOWN = 30_000; // 30s between scans
    if (this.changeCount >= 5 && now - this.lastScan > COOLDOWN) {
      this.lastScan = now;
      this.changeCount = 0;
      scanForOpportunities(platform);
    }
    this.changeCount = 0;
  }
};
```

### LinkedIn search result scanner

```typescript
// src/lib/platforms/linkedin.ts — add scanner
export function scanLinkedInSearchResults(): SearchResult[] {
  const results = document.querySelectorAll('.entity-result__item');
  return Array.from(results).map(el => ({
    name: el.querySelector('.entity-result__title-text a span[aria-hidden="true"]')
           ?.textContent?.trim() ?? null,
    title: el.querySelector('.entity-result__primary-subtitle')?.textContent?.trim() ?? null,
    company: el.querySelector('.entity-result__secondary-subtitle')?.textContent?.trim() ?? null,
    profileUrl: (el.querySelector('a.app-aware-link[href*="/in/"]') as HTMLAnchorElement)
                 ?.href?.split('?')[0] ?? null,
    isAlreadyConnected: !!el.querySelector('[aria-label*="Message"]'), // 1st degree = Message
  })).filter(r => r.name && r.profileUrl && !r.isAlreadyConnected);
}
```

### Suggestion chip UX

When `results.length >= 5` and user has scrolled past first result (intent signal):

1. Show a small, dismissable suggestion chip at the bottom-right (not a modal)
2. Chip: "Found 23 recruiters — send personalized connection requests?"
3. Click → expands to full queue preview panel

### Batch execution flow (LinkedIn connection requests example)

```
Content script scans page
  → Finds 23 unconnected recruiters
  → Shows suggestion chip

User clicks chip
  → Service worker: PLAN_BATCH_TASK
  → Opens background tabs one at a time (NOT parallel — max 1-2 at once)
  → For each: extracts profile (JSON-LD) → closes tab
  → Runs Convex generate.ts for each (personalized 300-char note)
  → Returns full queue to content script

Content script shows queue preview panel
  → User reviews/edits each message
  → Sets limit: "Send 5 today" (enforced by SW)
  → Clicks confirm

Service worker executes with rate limiting
  → Opens profile tab
  → Clicks Connect button via executeScript MAIN world
  → Clicks "Add a note"
  → Fills note via native property setter + InputEvent
  → Clicks "Send invitation"
  → Closes tab
  → Waits human-like delay (3-8s, Gaussian distribution)
  → Reports progress to content script
  → Stops after daily limit reached
```

### LinkedIn automation safety limits

| Limit | Value | Enforcement |
|---|---|---|
| Requests per day | 20 max | Counter in `chrome.storage.local`, reset at midnight |
| Requests per session | 5 max (per "Send N today" selection) | Checked before each iteration |
| Delay between actions | 3–8s Gaussian random | `humanDelay(5000)` |
| Profile view time before connect | 2–5s | `setTimeout` before clicking Connect |
| Daily profile visits | 100 max | Counter in storage |

Your extension runs in the user's **real Chrome session** with their real cookies and residential IP. This is inherently less detectable than Puppeteer/Playwright (which uses a separate browser with detectable fingerprint). Still: respect LinkedIn's Terms of Service and communicate limits clearly to users.

---

## 10. Layer 7 — Evaluation & Tracing

### Trace record structure

Every generation records a trace (write to IndexedDB immediately, sync to Convex async):

```typescript
interface GenerationTrace {
  traceId: string;
  sessionId: string;
  platform: string;
  modelId: string;
  promptHash: string;           // SHA-256 of full prompt
  // Retrieval inputs (what informed the prompt)
  retrievedMemoryIds: string[];
  retrievedPatternIds: string[];
  episodeExampleCount: number;
  hadLiveContext: boolean;
  // Output
  presentedOutput: string;      // cap at 2000 chars
  // User behavior (filled in on session close)
  userAction?: 'accepted' | 'edited' | 'rejected' | 'abandoned';
  editDistance?: number;
  // Timing
  latencyMs: number;
  tokenPrompt: number;
  tokenCompletion: number;
  createdAt: number;
}
```

**Full prompt text** lives in `traceArtifacts` (separate table) — not in every `traces` row. This keeps the trace table cheap to query.

### Replay for debugging

Store `promptHash` now, add a `traceArtifacts` table when you need it. To replay an exact trace:
```typescript
const trace = await convex.query(api.traces.get, { traceId });
const artifact = await convex.query(api.traceArtifacts.getByTrace, { traceId });
const replayedOutput = await callLLM({ model: trace.modelId, prompt: artifact.fullPrompt });
```

### Regression testing

Build a "bad cases" dataset from traces where `userAction === 'rejected'` or `editDistance > 20`. When changing a prompt, run the new prompt against the last 50 bad cases and compare mean edit distance.

### Local debug mode (dev builds only)

When `chrome.debugger` is available (dev build), attach to the active tab and enable `Network` domain to capture full request/response bodies. Inject a DevTools-style trace viewer panel accessible from the extension popup.

---

## 11. Manifest & Permission Changes

File: [wxt.config.ts](wxt.config.ts)

### Production build additions

```typescript
permissions: [
  "storage",
  "activeTab",
  "alarms",
  "identity",
  "cookies",
  "clipboardWrite",
  // NEW:
  "scripting",       // chrome.scripting.executeScript (MAIN world injection)
  "tabs",            // chrome.tabs.create/remove/sendMessage for background tab automation
  "webNavigation",   // onHistoryStateUpdated for reliable SPA navigation detection
  "offscreen",       // offscreen document for voice/audio
],
host_permissions: [
  // existing:
  "https://*.convex.cloud/*",
  "https://*.convex.site/*",
  "https://api.openai.com/*",
  "https://api.anthropic.com/*",
  "https://generativelanguage.googleapis.com/*",
  // NEW: needed for executeScript + tabs API to work on user sites:
  "https://www.linkedin.com/*",
  "https://mail.google.com/*",
  // For broader use (may require justification in Chrome Web Store review):
  "<all_urls>",
],
```

### Dev build additions (gated behind `process.env.NODE_ENV === 'development'`)

```typescript
permissions: [
  ...productionPermissions,
  "debugger",         // CDP access — shows warning bar, dev only
  "nativeMessaging",  // Playwright/Puppeteer sidecar — dev only
],
```

### New entrypoints to add

```
entrypoints/offscreen.html   — voice runtime
entrypoints/offscreen.ts     — SpeechRecognition, MediaRecorder, Porcupine
entrypoints/devtools.html    — DevTools panel (dev builds only)
entrypoints/devtools.ts      — chrome.devtools.network + trace viewer
```

---

## 12. Convex Schema — Full Addition

File: [convex/schema.ts](convex/schema.ts)

Add these tables alongside the existing `memories`, `memoryEmbeddings`, `userProfiles`, `capturedContexts`:

```typescript
// ── Interaction observation ────────────────────────────────────────────────────

// One row per compose session (focusin → session close)
interactionSessions: defineTable({
  userId: v.id("users"),
  sessionId: v.string(),                    // client-generated UUID
  platform: v.string(),                     // "linkedin" | "gmail" | "general" | etc.
  contextType: v.optional(v.string()),      // "recruiter_dm" | "connection_req" | "cold_email"
  recipientEntityId: v.optional(v.id("entities")),
  openedAt: v.number(),
  aiGeneratedAt: v.optional(v.number()),
  closedAt: v.optional(v.number()),
  outcome: v.optional(v.string()),          // "accepted" | "lightly_edited" | "heavily_edited" | "rewritten" | "abandoned" | "sent"
  charDelta: v.optional(v.number()),        // negative = shortened
  editFraction: v.optional(v.number()),     // 0-1, fraction of AI text that changed
  artifactId: v.optional(v.id("sessionArtifacts")),
})
  .index("by_user_opened", ["userId", "openedAt"])
  .index("by_user_platform", ["userId", "platform", "openedAt"])
  .index("by_user_outcome", ["userId", "outcome", "openedAt"]),

// Text blobs — separate table so session status updates don't rewrite large strings
sessionArtifacts: defineTable({
  sessionId: v.id("interactionSessions"),
  aiPreText: v.optional(v.string()),
  aiGeneratedText: v.optional(v.string()),
  userFinalText: v.optional(v.string()),
  diffSummary: v.optional(v.string()),      // compact representation of what user changed
})
  .index("by_session", ["sessionId"]),

// ── Entity graph ──────────────────────────────────────────────────────────────

// Named entities: people, companies, platforms
entities: defineTable({
  userId: v.id("users"),
  name: v.string(),
  type: v.string(),                         // "person" | "company" | "platform"
  normalizedName: v.string(),               // lowercased, trimmed — for matching
  createdAt: v.number(),
  deletedAt: v.optional(v.number()),        // MUST be first in soft-delete index
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
  relation: v.string(),                     // "works_at" | "knows" | "reports_to"
  validAt: v.number(),                      // when true in reality
  invalidAt: v.optional(v.number()),        // when stopped being true (null = still valid)
  createdAt: v.number(),                    // when system learned it
  expiredAt: v.optional(v.number()),        // when system recorded the change
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
  .index("by_session", ["sessionId"]),

// ── Procedural patterns ───────────────────────────────────────────────────────

// Behavioral rules derived from repeated edit patterns
proceduralPatterns: defineTable({
  userId: v.id("users"),
  platform: v.string(),
  contextType: v.optional(v.string()),
  ruleText: v.string(),                     // "For LinkedIn recruiter DMs: keep under 3 sentences"
  confidence: v.number(),                   // 0-1, decays weekly
  triggerCount: v.number(),                 // total times observed
  pendingCount: v.number(),                 // sessions since last promotion (for threshold)
  promotedAt: v.number(),
  lastTriggeredAt: v.optional(v.number()),
  deletedAt: v.optional(v.number()),        // MUST be first in soft-delete index
})
  // deletedAt FIRST for efficient active query
  .index("by_user_active", ["userId", "deletedAt", "platform"])
  .index("by_user_platform", ["userId", "platform", "confidence"]),

// Junction: which sessions support which patterns
patternSupports: defineTable({
  patternId: v.id("proceduralPatterns"),
  sessionId: v.id("interactionSessions"),
  createdAt: v.number(),
})
  .index("by_pattern", ["patternId"])
  .index("by_session", ["sessionId"]),

// ── Evaluation & tracing ─────────────────────────────────────────────────────

traces: defineTable({
  userId: v.id("users"),
  sessionId: v.optional(v.id("interactionSessions")),
  platform: v.string(),
  modelId: v.string(),
  promptHash: v.string(),                   // SHA-256, used for dedup + regression testing
  presentedOutput: v.string(),              // cap at 2000 chars
  hadLiveContext: v.boolean(),
  retrievedPatternCount: v.number(),
  episodeExampleCount: v.number(),
  userAction: v.optional(v.string()),       // filled in on session close
  editDistance: v.optional(v.number()),
  latencyMs: v.number(),
  tokenPrompt: v.number(),
  tokenCompletion: v.number(),
  createdAt: v.number(),
})
  .index("by_user_created", ["userId", "createdAt"])
  .index("by_user_action", ["userId", "userAction", "createdAt"]),

// Full prompt text — separate table, only write when debugging/eval needed
traceArtifacts: defineTable({
  traceId: v.id("traces"),
  fullPrompt: v.string(),
  rawLlmOutput: v.string(),
})
  .index("by_trace", ["traceId"]),

// ── Batch task queue ─────────────────────────────────────────────────────────

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
})
  .index("by_user_status", ["userId", "status", "createdAt"]),

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
```

### Convex schema safety rules (enforced by this schema)

- ✅ No unbounded arrays on documents — all one-to-many use separate tables with foreign keys
- ✅ Soft-delete fields (`deletedAt`) are always **first** in their index after `userId` — enables efficient `.eq("deletedAt", undefined)` filter
- ✅ Large text blobs in separate tables (`sessionArtifacts`, `traceArtifacts`) — keeps frequently-updated parent documents small
- ✅ Embeddings in separate tables (`entityEmbeddings`) — mirrors existing `memoryEmbeddings` pattern
- ✅ Junction tables for many-to-many (`edgeSupports`, `patternSupports`) — no arrays

---

## 13. Phased Implementation Order

### Phase 0 — Permissions ✅ DONE
**Files**: [wxt.config.ts](wxt.config.ts)

- ✅ Added `scripting`, `tabs`, `webNavigation` to production permissions
- ✅ Added `https://www.linkedin.com/*` and `https://mail.google.com/*` to `host_permissions`
- `offscreen` deferred to Phase 6 (voice). `debugger`/`nativeMessaging` deferred to Phase 8 (eval).

---

### Phase 1 — Session Observation ✅ DONE (2026-04-04)
**Files**: [entrypoints/content/App.tsx](entrypoints/content/App.tsx), [entrypoints/content/FieldButton.tsx](entrypoints/content/FieldButton.tsx), [entrypoints/content/GenerateModal.tsx](entrypoints/content/GenerateModal.tsx), [entrypoints/content/index.ts](entrypoints/content/index.ts), [entrypoints/background.ts](entrypoints/background.ts), [convex/schema.ts](convex/schema.ts), [convex/interactions.ts](convex/interactions.ts), [src/lib/session-observer.ts](src/lib/session-observer.ts)

- ✅ `interactionSessions` + `sessionArtifacts` tables in schema (with `recipientName`, 3 indexes each)
- ✅ Inline bounded Levenshtein + trigram diff in `session-observer.ts` (no external dep)
- ✅ `onFieldFocus` / `onFieldBlur` hooks in App.tsx `focusin`/`focusout` handlers
- ✅ Per-field composite snapshot: debounced `input` (300ms) + immediate `compositionend` → `_settledText`
- ✅ `onGenerationStart` + `onGenerationComplete(getFieldText(field))` in FieldButton + GenerateModal (all action paths: generate, rewrite, shorten, expand)
- ✅ Post-insert text contract: callers snapshot field text at 80ms+120ms after `insertText` (not raw API response)
- ✅ Three-signal send detection: Signal A (form submit), Signal B (Enter/Ctrl+Enter), Signal C (mousedown+XHR confirm)
- ✅ MAIN-world XHR/fetch interceptor injected as inline `<script>` from content script init
- ✅ `OBSERVE_SESSION` routing in service worker → Convex `recordSession` mutation
- ✅ Build: zero errors, zero warnings (`npx wxt build` clean)

**Outcome**: Raw behavioral data accumulates on every AI-assisted compose session across all action types.

---

### Phase 2 — Multi-Tier Retrieval in generate.ts (zero extra LLM calls)
**Files**: [convex/generate.ts](convex/generate.ts), new `convex/retrieval.ts`

1. Add `proceduralPatterns` table (empty to start)
2. In `generate.ts`, replace single `memoryContext` block with 3 labeled sections:
   - `ABOUT YOU`: existing semantic memory (unchanged)
   - `YOUR STYLE RULES`: query `proceduralPatterns` by `userId + platform + contextType`
   - `RECENT EXAMPLES`: query last 3 sessions with same `platform + contextType` where `outcome != 'abandoned'`, inject as anonymized edit summaries (not raw messages)
3. Pass `recipientContext` as a new parameter — injected as `RECIPIENT CONTEXT` block, never stored

**Outcome**: Generation now uses all three memory tiers, even though procedural patterns are empty at first.

---

### Phase 3 — Procedural Pattern Promotion
**Files**: new `convex/patterns.ts`, [convex/crons.ts](convex/crons.ts), [convex/schema.ts](convex/schema.ts)

1. Add `patternSupports` junction table
2. After recording each session, run `patterns.checkPromotion` mutation:
   - Increment `pendingCount` on matching `platform + contextType` pattern candidate
   - When `pendingCount >= 3` AND sessions span 2+ distinct days → schedule `patterns.promoteAsync` action
3. `promoteAsync` action: batch the supporting sessions, call LLM (1 call, `metaprompt` style) to draft rule text → write to `proceduralPatterns`
4. Weekly cron: `confidence *= 0.9` for patterns not triggered in 7 days; soft-delete at `confidence < 0.1`

**Outcome**: The system learns behavioral rules automatically from observed edit patterns.

---

### Phase 4 — Entity Graph
**Files**: [convex/schema.ts](convex/schema.ts), new `convex/entities.ts`, [convex/memoryExtract.ts](convex/memoryExtract.ts)

1. Add `entities`, `entityEmbeddings`, `entityEdges`, `edgeSupports` tables
2. In `memoryExtract.ts`, extract entity mentions alongside fact extraction
3. Entity resolution: embedding cosine similarity ≥ 0.85 for dedup; async LLM confirmation for 0.75–0.85 range
4. Contradiction handling: when new `works_at` edge conflicts with existing, set `invalidAt = now` on old edge, insert new edge
5. Upgrade `memories` table: add `validAt`, `invalidAt` fields, update soft-delete index

**Outcome**: Temporal entity relationships tracked. "User currently works at X" never gets confused with "User previously worked at Y."

---

### Phase 5 — Browser Control + Batch Operations
**Files**: [entrypoints/background.ts](entrypoints/background.ts), [entrypoints/content/App.tsx](entrypoints/content/App.tsx), new `src/lib/browser-control.ts`, new `convex/tasks.ts`

1. Add `taskBatches` + `taskItems` tables
2. Add `PersistentTaskQueue` class to service worker
3. Add `webNavigation.onHistoryStateUpdated` listener to service worker (better SPA detection)
4. Add `openExtractClose` helper for background tab extraction
5. Build LinkedIn batch connection flow:
   - `scanLinkedInSearchResults()` in content script
   - Suggestion chip UI (new React component)
   - Queue preview panel (new React component)
   - Service worker batch executor with `humanDelay`
   - Daily limit enforcement (`chrome.storage.local`)

**Outcome**: Extension can find and message 20+ recruiters with one user click.

---

### Phase 6 — Voice
**Files**: new `entrypoints/offscreen.html`, new `entrypoints/offscreen.ts`, [entrypoints/background.ts](entrypoints/background.ts), new `convex/voice.ts`

1. Create offscreen document entrypoint
2. Add `ensureOffscreen()` to service worker startup
3. Implement `SpeechRecognition` in offscreen with auto-restart
4. Add `VOICE_COMMAND` routing in service worker → Convex `voice.parseIntent` action
5. Wire result back to content script to fill active field or show suggestion
6. Add voice activation button to FAB UI
7. Optional: add Porcupine wake word detection (behind feature flag, adds ~1MB WASM bundle)
8. Optional: upgrade to OpenAI Realtime API for lower latency (behind user-selectable setting)

**Outcome**: User can say "write a connection note to this recruiter" and the extension generates and fills it.

---

### Phase 7 — Proactive AI-First Scanning
**Files**: [entrypoints/content/App.tsx](entrypoints/content/App.tsx), [src/lib/platforms/linkedin.ts](src/lib/platforms/linkedin.ts), new `src/lib/scanner.ts`

1. Add `ChangeThreshold` scanner class alongside existing `MutationObserver`
2. Add `scanForOpportunities(platform)` that dispatches to platform-specific scanners
3. Add `scanLinkedInSearchResults()` extractor
4. Build suggestion chip React component (dismissable, non-blocking)
5. Build queue preview panel with per-item edit capability
6. Connect to batch execution in Phase 5

**Outcome**: Extension proactively surfaces batch action opportunities without user having to ask.

---

### Phase 8 — Evaluation & Tracing
**Files**: new `convex/traces.ts`, [convex/schema.ts](convex/schema.ts), [entrypoints/background.ts](entrypoints/background.ts)

1. Add `traces` + `traceArtifacts` tables
2. Write trace after every generation (fire-and-forget from service worker)
3. Update trace on session close with `userAction` + `editDistance`
4. Build simple query page in options app: "show last 50 rejected/heavily-edited generations"
5. Local debug mode (dev build only): attach `chrome.debugger` + CDP Network, add DevTools panel

---

## 14. Key Constraints & Guardrails

### chrome.debugger is development-only
The hardcoded Chrome infobar ("X started debugging this browser") cannot be suppressed. Any feature that relies on `chrome.debugger` must be gated behind `NODE_ENV === 'development'` and excluded from the Chrome Web Store build.

### MAIN world scripts cannot use chrome.* APIs
`chrome.scripting.executeScript({ world: "MAIN" })` gives you access to the page's JS heap but strips all `chrome.*` APIs. Communication back to your content script must go through `window.postMessage`. Your ISOLATED-world content script receives it via `window.addEventListener('message', ...)`.

### Convex index design is irreversible
Once data is in production, changing an index requires a migration. Get soft-delete index ordering right at schema creation time: `deletedAt` (or `invalidAt`) must be the **first** non-userId field in the index for `withIndex(..., q => q.eq("deletedAt", undefined))` to be efficient. Never rely on `.filter()` for this — it full-table-scans past Convex's 32,000-document query limit.

### No unbounded arrays in Convex documents
Arrays can have at most 8,192 elements. Document size limit is 1MB. All one-to-many relationships must use separate tables with foreign keys, not embedded arrays. The `edgeSupports` and `patternSupports` junction tables enforce this for the patterns and entities layers.

### Separate large text blobs from frequently-updated status fields
`sessionArtifacts` and `traceArtifacts` exist specifically so that updating `session.outcome` does not force a re-write of 4–10KB of text content. This keeps mutations cheap and avoids hitting Convex's 16MB write limit on high-volume sessions.

### LinkedIn daily limits are non-negotiable
Exceeding LinkedIn's connection request limits results in account restrictions. Hard limits: 20 connections/day, 5/session, human-like timing (Gaussian delays, not uniform), view profile for 2–5s before connecting. Store limits in `chrome.storage.local` with daily reset at midnight local time.

### Memory ≠ context. Volatile data is never stored.
Live-fetched recipient profiles, job listing text, company page text, and current thread context are **transient task context**. They are passed as parameters to Convex actions, injected into prompts, and discarded. They are never written to `memories`, `entities`, or any other durable table. Only data that is durably true about the user and their relationships belongs in long-term storage.

### Pattern promotion requires 3 occurrences across 2+ days
A single power-user session with many identical sends must not immediately create a procedural rule. Check that supporting sessions span at least 2 distinct calendar days before calling the LLM to draft a rule. This prevents noise from outlier sessions.

---

*Last updated: 2026-04-04. Research basis: three passes covering Chrome MV3 APIs, LangMem/Mem0/Graphiti memory systems, OCEL process mining, rrweb vs hand-rolled observation, Convex schema design, browser-use/Playwright/Puppeteer, Web Speech API in MV3, Porcupine WASM wake detection, LinkedIn automation safety, and ActivityWatch heartbeat architecture. Phase 0 + Phase 1 implemented and verified.*
