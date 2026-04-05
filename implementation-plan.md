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
15. [Layer 8 — Agentic Task Orchestration](#15-layer-8--agentic-task-orchestration)

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

### Verified status snapshot (2026-04-05)

| Phase | Verified status | Notes |
|---|---|---|
| Phase 0 — Permissions | ✅ Complete | `scripting`, `tabs`, `webNavigation`, and `offscreen` are in [wxt.config.ts](wxt.config.ts) |
| Phase 1 — Session Observation | ✅ Implemented in code | Session capture, send heuristics, `recipientName`, `traceId`, and all action paths are wired |
| Phase 2 — Multi-Tier Retrieval | ✅ Implemented in code | Semantic + procedural + episodic retrieval is unified across `generate`, `rewrite`, `shorten`, and `expand` |
| Phase 3 — Procedural Pattern Promotion | ✅ Implemented in code | Pattern supports, promotion checks, and weekly decay cron exist |
| Phase 4 — Entity Graph | ✅ Implemented in code | Temporal entities/edges, lexical dedup, and embedding-backed fuzzy resolution are wired |
| Phase 5 — Browser Control | ⚠️ Core flow implemented | LinkedIn task queue, auth-scoped queue storage, and shared MAIN-world helpers exist; broader multi-platform automation is still pending |
| Phase 6 — Voice | ✅ Implemented in code | Offscreen recognition + intent parsing + explicit runtime state sync are wired end to end |
| Phase 7 — Proactive Scanning | ✅ Implemented in code | `ChangeThreshold`, LinkedIn scanning, suggestion chip, and queue preview are wired |
| Phase 8 — Evaluation & Tracing | ⚠️ Core tracing implemented | Trace tables, queries, and review UI exist; dev-only CDP/DevTools tooling is still not built |
| Phase 9 — Agentic Task Orchestration | ⚠️ Foundation in progress | Generic `BrowserExecutor` foundation exists, but durable run state, command bus, HITL resume flow, and multi-platform execution are still pending |

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

### What is now built (verified snapshot — 2026-04-05)

| Component | Location | Notes |
|---|---|---|
| `SessionObserver` class | [src/lib/session-observer.ts](src/lib/session-observer.ts) | Full session lifecycle, multi-signal send detection |
| Multi-signal send detection | [src/lib/session-observer.ts:345](src/lib/session-observer.ts#L345) | Signal A = form submit, B = Enter/Ctrl+Enter, C = mousedown + XHR confirm |
| Per-field composite snapshot | [src/lib/session-observer.ts:421](src/lib/session-observer.ts#L421) | Debounced `input` (300ms) + `compositionend` → `_settledText` map |
| MAIN-world XHR/fetch interceptor | [entrypoints/send-interceptor.content.ts](entrypoints/send-interceptor.content.ts) | Dedicated MAIN-world content script, posts `__TF_SEND__` on send-like POSTs |
| Bounded Levenshtein + trigram diff | [src/lib/session-observer.ts:61](src/lib/session-observer.ts#L61) | O(n) space, bails at 5000 ops; trigram fallback for texts > 1500 chars |
| `interactionSessions` + `sessionArtifacts` tables | [convex/schema.ts:68](convex/schema.ts#L68) | With `recipientName`, soft-deleted artifact, 3 indexes each |
| `recordSession` mutation | [convex/interactions.ts:7](convex/interactions.ts#L7) | Inserts session row + optional artifact in one transaction |
| `OBSERVE_SESSION` routing | [entrypoints/background.ts:103](entrypoints/background.ts#L103) | Fire-and-forget to Convex; never blocks generation |
| Generation hooks — all paths | [entrypoints/content/FieldButton.tsx:173](entrypoints/content/FieldButton.tsx#L173), [GenerateModal.tsx:289](entrypoints/content/GenerateModal.tsx#L289) | `onGenerationStart` + `onGenerationComplete(getFieldText(field))` after 80+120ms |
| `scripting`, `tabs`, `webNavigation` permissions | [wxt.config.ts](wxt.config.ts) | Added for Layer 1; `offscreen` deferred to Layer 5 (voice) |

### What is still missing

| Gap | Impact |
|---|---|
| Browser automation is implemented mainly for the LinkedIn connect flow | Other controlled actions still need shared helpers and live-site validation |
| Dev-only tracing extras (`chrome.debugger`, DevTools panel, network replay tooling) are still absent | Deep local debugging remains limited to current trace tables and manual DevTools use |
| No generic agent runtime exists yet | The extension can queue known tasks, but it cannot yet plan, pause, resume, and complete arbitrary long-running browser jobs across platforms |

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

### Planned extension for long-running agentic tasks

The current architecture is enough for deterministic queued actions, but not for open-ended agentic jobs like:

- "Find 20 recruiters in software engineering in Cincinnati and draft connection requests"
- "Go through these job applications, answer the short-answer questions, and stop for approval before submit"
- "Review this Gmail thread, summarize the asks, draft replies, and queue follow-ups"

To support those safely, the system needs one additional layer:

```
┌─────────────────────────────────────────────────────────────────┐
│  NODE PLANNER RUNTIME (new)                                    │
│  • OpenAI Agents SDK JS                                        │
│  • Tool calling / handoffs / approvals                         │
│  • Serialised run state for pause/resume                       │
│  • Emits browser commands, consumes browser observations       │
└────────────────────────────┬────────────────────────────────────┘
                             │ Convex + HTTPS
┌────────────────────────────▼────────────────────────────────────┐
│  CONVEX DURABLE STATE (expanded)                               │
│  • agentRuns / agentSteps / agentApprovals / browserCommands   │
│  • existing traces / tasks / memories reused, not replaced     │
│  • event bridge between planner runtime and extension executor │
└────────────────────────────┬────────────────────────────────────┘
                             │ chrome.runtime + storage + tabs
┌────────────────────────────▼────────────────────────────────────┐
│  EXTENSION EXECUTOR (existing, expanded)                       │
│  • service worker schedules commands                           │
│  • content scripts inspect DOM and execute actions             │
│  • MAIN-world helpers for framework-sensitive interactions     │
└─────────────────────────────────────────────────────────────────┘
```

This preserves the core production constraint: browser execution still happens inside the user's real Chrome session. The planner becomes a separate layer that decides *what* to do next; the extension remains the layer that actually clicks, types, navigates, waits, and reads.

---

## 4. Layer 1 — Observation

> **Status: IMPLEMENTED IN CODE** (verified 2026-04-05). The capture path is wired end to end. Remaining risk is real-site validation on CSP-heavy pages and send-button DOM variants.

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
| [entrypoints/send-interceptor.content.ts](entrypoints/send-interceptor.content.ts) | MAIN-world send interceptor runs as a dedicated content script in the MAIN world |

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
- The MAIN-world interceptor now lives in [entrypoints/send-interceptor.content.ts](entrypoints/send-interceptor.content.ts) as a dedicated MAIN-world content script, which avoids CSP issues from inline injection

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
    const queueKey = getTaskQueueStorageKey(currentUserScope);
    const { [queueKey]: queue = [] } = await chrome.storage.local.get(queueKey);
    await chrome.storage.local.set({ [queueKey]: [...queue, ...tasks] });
    void this.process();
  }

  private async dequeue(): Promise<Task | null> {
    const queueKey = getTaskQueueStorageKey(currentUserScope);
    const { [queueKey]: queue = [] } = await chrome.storage.local.get(queueKey);
    if (!queue.length) return null;
    const [task, ...rest] = queue;
    await chrome.storage.local.set({ [queueKey]: rest });
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

`entrypoints/offscreen.html` + `entrypoints/offscreen/main.ts`:

```typescript
// entrypoints/offscreen/main.ts
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
// offscreen/main.ts
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
// offscreen/main.ts — OpenAI Realtime API option
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
// offscreen/main.ts
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
entrypoints/offscreen/main.ts — SpeechRecognition, MediaRecorder, Porcupine
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

### Phase 0 — Permissions ✅ VERIFIED COMPLETE
**Files**: [wxt.config.ts](wxt.config.ts)

- ✅ Added `scripting`, `tabs`, `webNavigation` to production permissions
- ✅ Added `https://www.linkedin.com/*` and `https://mail.google.com/*` to `host_permissions`
- `offscreen` deferred to Phase 6 (voice). `debugger`/`nativeMessaging` deferred to Phase 8 (eval).

---

### Phase 1 — Session Observation ✅ IMPLEMENTED (verified 2026-04-05)
**Files**: [entrypoints/content/App.tsx](entrypoints/content/App.tsx), [entrypoints/content/FieldButton.tsx](entrypoints/content/FieldButton.tsx), [entrypoints/content/GenerateModal.tsx](entrypoints/content/GenerateModal.tsx), [entrypoints/content/index.ts](entrypoints/content/index.ts), [entrypoints/background.ts](entrypoints/background.ts), [convex/schema.ts](convex/schema.ts), [convex/interactions.ts](convex/interactions.ts), [src/lib/session-observer.ts](src/lib/session-observer.ts)

- ✅ `interactionSessions` + `sessionArtifacts` tables in schema (with `recipientName`, 3 indexes each)
- ✅ Inline bounded Levenshtein + trigram diff in `session-observer.ts` (no external dep)
- ✅ `onFieldFocus` / `onFieldBlur` hooks in App.tsx `focusin`/`focusout` handlers
- ✅ Per-field composite snapshot: debounced `input` (300ms) + immediate `compositionend` → `_settledText`
- ✅ `onGenerationStart` + `onGenerationComplete(getFieldText(field))` in FieldButton + GenerateModal (all action paths: generate, rewrite, shorten, expand)
- ✅ Post-insert text contract: callers snapshot field text at 80ms+120ms after `insertText` (not raw API response)
- ✅ Three-signal send detection: Signal A (form submit), Signal B (Enter/Ctrl+Enter), Signal C (mousedown+XHR confirm)
- ✅ MAIN-world XHR/fetch interceptor runs as a dedicated MAIN-world content script
- ✅ `OBSERVE_SESSION` routing in service worker → Convex `recordSession` mutation
- ✅ Build: zero errors, zero warnings (`npx wxt build` clean)

**Outcome**: Raw behavioral data accumulates on every AI-assisted compose session across all action types.
**Remaining risk**: live validation is still needed on unusual send-button DOM variants, but the CSP-specific inline-script risk is removed.

---

### Phase 2 — Multi-Tier Retrieval in generate.ts ✅ IMPLEMENTED
**Files**: [convex/generate.ts](convex/generate.ts), new `convex/retrieval.ts`

1. Add `proceduralPatterns` table (empty to start)
2. In `generate.ts`, replace single `memoryContext` block with 3 labeled sections:
   - `ABOUT YOU`: existing semantic memory (unchanged)
   - `YOUR STYLE RULES`: query `proceduralPatterns` by `userId + platform + contextType`
   - `RECENT EXAMPLES`: query last 3 sessions with same `platform + contextType` where `outcome != 'abandoned'`, inject as anonymized edit summaries (not raw messages)
3. Pass `recipientContext` as a new parameter — injected as `RECIPIENT CONTEXT` block, never stored

**Outcome**: Generation now uses semantic memory, procedural rules, episodic summaries, and transient recipient context across all text actions.
**Remaining work**: prompt-quality tuning and live-provider evaluation, not missing wiring.

---

### Phase 3 — Procedural Pattern Promotion ✅ IMPLEMENTED
**Files**: new `convex/patterns.ts`, [convex/crons.ts](convex/crons.ts), [convex/schema.ts](convex/schema.ts)

1. Add `patternSupports` junction table
2. After recording each session, run `patterns.checkPromotion` mutation:
   - Increment `pendingCount` on matching `platform + contextType` pattern candidate
   - When `pendingCount >= 3` AND sessions span 2+ distinct days → schedule `patterns.promoteAsync` action
3. `promoteAsync` action: batch the supporting sessions, call LLM (1 call, `metaprompt` style) to draft rule text → write to `proceduralPatterns`
4. Weekly cron: `confidence *= 0.9` for patterns not triggered in 7 days; soft-delete at `confidence < 0.1`

**Outcome**: The system learns behavioral rules automatically from observed edit patterns.
**Remaining work**: tune promotion thresholds/confidence decay from real user data.

---

### Phase 4 — Entity Graph ✅ IMPLEMENTED IN CODE
**Files**: [convex/schema.ts](convex/schema.ts), new `convex/entities.ts`, [convex/memoryExtract.ts](convex/memoryExtract.ts)

1. Add `entities`, `entityEmbeddings`, `entityEdges`, `edgeSupports` tables
2. In `memoryExtract.ts`, extract entity mentions alongside fact extraction
3. Entity resolution: canonical-name dedup first, then embedding-backed fuzzy matching with conservative ambiguity handling
4. Contradiction handling: when new `works_at` edge conflicts with existing, set `invalidAt = now` on old edge, insert new edge
5. Upgrade `memories` table: add `validAt`, `invalidAt` fields, update soft-delete index

**Outcome**: Temporal entity relationships are now extracted and tracked, including contradiction invalidation for exclusive relations like `works_at`.
**Remaining work**: richer human-review / LLM-confirmation workflows for ambiguous entity merges are optional future work, but the core fuzzy-resolution path is now wired.

---

### Phase 5 — Browser Control + Batch Operations ⚠️ CORE FLOW IMPLEMENTED
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

**Outcome**: Extension can scan LinkedIn search results, queue connection tasks, generate notes, and execute a controlled LinkedIn connect flow.
**Remaining work**: expand the shared browser-control layer to more platforms and finish broader live-site E2E validation.

---

### Phase 6 — Voice ✅ IMPLEMENTED IN CODE
**Files**: new `entrypoints/offscreen.html`, [entrypoints/offscreen/main.ts](entrypoints/offscreen/main.ts), [entrypoints/background.ts](entrypoints/background.ts), new `convex/voice.ts`

1. Create offscreen document entrypoint
2. Add `ensureOffscreen()` to service worker startup
3. Implement `SpeechRecognition` in offscreen with auto-restart
4. Add `VOICE_COMMAND` routing in service worker → Convex `voice.parseIntent` action
5. Wire result back to content script to fill active field or show suggestion
6. Add voice activation button to FAB UI
7. Optional: add Porcupine wake word detection (behind feature flag, adds ~1MB WASM bundle)
8. Optional: upgrade to OpenAI Realtime API for lower latency (behind user-selectable setting)

**Outcome**: User can trigger offscreen speech recognition, parse intent, and route compose/search/connect actions back into the extension with explicit runtime-state acknowledgements reflected in the FAB.
**Remaining work**: wake word support and optional Realtime/Porcupine upgrades remain future work.

---

### Phase 7 — Proactive AI-First Scanning ✅ IMPLEMENTED
**Files**: [entrypoints/content/App.tsx](entrypoints/content/App.tsx), [src/lib/platforms/linkedin.ts](src/lib/platforms/linkedin.ts), new `src/lib/scanner.ts`

1. Add `ChangeThreshold` scanner class alongside existing `MutationObserver`
2. Add `scanForOpportunities(platform)` that dispatches to platform-specific scanners
3. Add `scanLinkedInSearchResults()` extractor
4. Build suggestion chip React component (dismissable, non-blocking)
5. Build queue preview panel with per-item edit capability
6. Connect to batch execution in Phase 5

**Outcome**: Extension proactively surfaces LinkedIn batch opportunities without the user having to ask.
**Remaining work**: expand the dispatcher beyond LinkedIn and tune thresholds from live usage.

---

### Phase 8 — Evaluation & Tracing ⚠️ CORE TRACING IMPLEMENTED
**Files**: new `convex/traces.ts`, [convex/schema.ts](convex/schema.ts), [entrypoints/background.ts](entrypoints/background.ts)

1. Add `traces` + `traceArtifacts` tables
2. Write trace after every generation (fire-and-forget from service worker)
3. Update trace on session close with `userAction` + `editDistance`
4. Build simple query page in options app: "show last 50 rejected/heavily-edited generations"
5. Local debug mode (dev build only): attach `chrome.debugger` + CDP Network, add DevTools panel

**Outcome**: Every generation can be traced, linked back to observed user outcomes, and reviewed from the memory app.
**Remaining work**: the dev-only `chrome.debugger` / DevTools-panel tooling is still not implemented.

---

### Phase 9 — Agentic Task Orchestration ⚠️ FOUNDATION IN PROGRESS
**Files**: new planner runtime package, expanded [entrypoints/background.ts](entrypoints/background.ts), new [src/lib/browser-executor.ts](src/lib/browser-executor.ts), expanded [src/lib/browser-control.ts](src/lib/browser-control.ts), new Convex run/command tables, existing platform adapters in [src/lib/platforms](src/lib/platforms)

1. Add a generic browser command bus:
   - `navigate`, `wait_for_url`, `wait_for_element`, `click`, `type`, `press_key`, `scroll`, `extract_text`, `extract_structured`, `snapshot_interactives`, `open_tab`, `close_tab`
2. Move browser execution behind a versioned `BrowserExecutor` interface so agent tools reuse the same low-level actions as batch automation
3. Add planner/runtime state:
   - `agentRuns`, `agentRunSteps`, `browserCommands`, `browserCommandResults`, `agentApprovals`
4. Run OpenAI Agents SDK JS in a Node planner runtime, not in the MV3 service worker
5. Persist serialized agent state plus approval interruptions so runs can pause/resume across long jobs
6. Keep human-in-the-loop gates before irreversible actions (`send`, `submit`, `connect`, `apply`, `delete`)
7. Reuse existing `taskBatches` / `taskItems` for deterministic send queues generated by the planner
8. Expand platform adapters so agent runs can act generically on any site, then add higher-confidence platform-specific skills on top
9. Keep `chrome.debugger` / Playwright / Stagehand out of the production core path; use them only for dev tooling, CI, or optional power mode

**Outcome target**: The extension can plan, inspect, and execute long-running multi-step browser tasks across platforms while keeping final execution inside the user's real Chrome session.
**Important constraint**: this phase should absorb the remaining Phase 5 work instead of duplicating it. The browser-control generalization becomes part of the agentic executor.
**Current progress**: the reusable executor foundation now exists in [src/lib/browser-executor.ts](src/lib/browser-executor.ts), and the current LinkedIn batch flow already routes through it from [entrypoints/background.ts](entrypoints/background.ts). Remaining work is durable agent run state, planner runtime, approval storage, and broader multi-platform adapters.

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

## 15. Layer 8 — Agentic Task Orchestration

> **Goal**: Add a true planner/runtime layer that can execute long-running browser jobs across platforms without replacing the extension-native executor that already works inside the user's real Chrome session.

### Current completion gate

The current implementation plan is **not** 100% done yet. Two existing items remain real:

1. **Phase 5 shared browser control** still needs to expand beyond the current LinkedIn-heavy batch flow.
2. **Phase 8 dev-only debugger tooling** is still absent.

This does **not** mean Phase 9 must wait. It means Phase 9 should:

- absorb the remaining shared browser-control generalization work instead of creating a second executor, and
- leave the dev-only `chrome.debugger` / DevTools work as a parallel debugging track, not a blocker for production agentic features.

### External ecosystem review (official-source based)

| Option | What it gives | Fit for this repo | Decision |
|---|---|---|---|
| [OpenAI Agents SDK JS](https://openai.github.io/openai-agents-js/) | Agent loop, tools, handoffs, guardrails, HITL, tracing, state resume | Strong fit for planner/runtime layer, but **not** for in-extension browser execution | **Use** for planner/runtime |
| [OpenAI function tools + HITL](https://openai.github.io/openai-agents-js/guides/tools/) / [HITL guide](https://openai.github.io/openai-agents-js/guides/human-in-the-loop/) | Function tools, `needsApproval`, paused runs, `RunState` serialization | Ideal for approval-gated browser actions like send/connect/submit | **Use** |
| [Convex Durable Workflows](https://github.com/get-convex/workflow) | Durable orchestration, `awaitEvent`, `sleep`, retry, restart, exactly-once completion | Strong fit for long-lived jobs, pause/resume, approval waits, service-worker restarts | **Use alongside** the planner |
| Existing `@convex-dev/agent` in [convex/agent.ts](convex/agent.ts) | Convex-native agent wrapper | Already present but dormant; introducing it as a second live agent loop would duplicate orchestration | **Do not expand for new work** |
| [LangGraph.js](https://langchain-ai.github.io/langgraphjs/) | Durable graph workflows, interrupts, explicit state graphs | Good alternative, but adds a second orchestration model on top of Convex + OpenAI Agents | **Not primary** |
| [Mastra](https://mastra.ai/reference/agents/agent) | Agents, workflows, evals, memory, infra layer | Strong framework, but overlaps too much with Convex + existing extension architecture | **Not primary** |
| [Playwright](https://playwright.dev/docs/library) / [Puppeteer](https://pptr.dev/) | Full browser automation in Node | Excellent for CI, local replay, and power-mode sidecars; wrong core path for real-user Chrome-session execution | **Dev / optional power mode only** |
| [Stagehand](https://docs.stagehand.dev/v3/configuration/browser) | LLM-friendly browser layer with local/cloud environments | Useful for experiments and hostile-site fallback, but it launches/owns its own browser environment | **Research fallback, not core** |
| [Browser Use](https://docs.browser-use.com/cloud/browser/playwright-puppeteer-selenium) | Managed stealth browser infra via CDP, TS SDK, long sessions | Useful if we ever need cloud-run browsing, but not aligned with "act in the user's real browser" | **Optional future mode, not core** |

### Why this path wins for this codebase

The repo already has the hard part that external browser-agent frameworks usually need to recreate:

- live field and session observation
- platform detection and compose-boundary extraction
- DOM semantic walking
- extension-native tab control and MAIN-world DOM execution
- durable user memory, traces, tasks, and approvals on Convex

So the correct design is:

- **do not** replace the extension executor with Playwright/Stagehand/browser-use
- **do not** create a second browser-control stack in Node
- **do** add a planner/runtime that emits commands to the browser executor already in this repo

### Architecture decision

#### Planner/runtime placement

Do **not** put the planner loop in the MV3 extension. The extension service worker should remain a deterministic executor plus UI bridge.

There are two viable planner placements:

1. **Hosted Node planner using OpenAI Agents SDK JS**
2. **Convex-native planner steps inside actions/workflows using direct model calls**
3. **Local companion planner on the user's device** using a native app or localhost bridge

Use the first option when we want the full Agents SDK feature set: built-in tool semantics, handoffs, guardrails, session handling, and tracing. Use the second when minimizing deployment complexity matters more than SDK-native orchestration features.

For this repo, the durable source of truth should be **Convex workflows either way**. The main decision is whether each planning step is executed by:

- a hosted Node planner using Agents SDK, or
- a Convex action using direct model calls and repo-owned orchestration logic.

Current preference:

- **near-term durable implementation**: Convex Durable Workflows as the outer orchestrator, with planner steps allowed to start in Convex actions if we want the lowest-ops rollout
- **Phase 9 implementation default**: Convex-first orchestration and planning
- **full featured hosted mode**: Node planner with OpenAI Agents SDK JS once we are ready to operate that runtime
- **future local mode**: optional companion planner on the user's device if we want local-only orchestration outside MV3

Why this nuance matters:

- official OpenAI Agents SDK JS support is strongest on server runtimes such as **Node.js 22+, Deno, and Bun**
- Convex Durable Workflows already solve sleep, event waiting, retries, cancellation, and long-lived state
- requiring a separate self-hosted Node service too early adds avoidable deployment friction
- a local companion planner is viable, but it adds install/update/startup complexity and should be treated as a future mode, not the first release path

So the architecture should be **workflow-first, planner-runtime-pluggable**, not "self-hosted Node planner required on day one".

Use **OpenAI Agents SDK JS** in a **Node runtime** when we explicitly choose the hosted planner path:

- official OpenAI Agents SDK JS currently supports **Node.js 22+, Deno, and Bun**, with experimental Cloudflare Workers support
- the browser extension service worker should stay thin and deterministic
- the planner should own agent loop state, handoffs, approvals, and resumability

Practical placement options:

1. **Preferred release path**: planner steps executed from Convex actions under a Convex workflow
2. **Preferred hosted mode**: a small dedicated Node planner service in this repo
3. **Optional future local mode**: a companion process on the user's device using native messaging or localhost bridge
4. **Optional later**: a dedicated Node-side Convex-adjacent service if we want private networking and separate scaling
5. **Not recommended**: trying to force the planner into MV3 service worker code

#### Durable orchestration placement

Use **Convex Durable Workflows** for wall-clock durability:

- sleeping between steps
- waiting for browser command results
- waiting for user approvals
- cancel/restart/retry behavior
- observable live status in the extension UI

The split of responsibility should be:

- **Planner step** = agent reasoning, tool selection, and replanning
- **Convex workflows** = durable outer job orchestration, event waiting, retries, cancellation, state checkpoints, and status streaming
- **extension** = actual browser control and DOM observation

This avoids duplicating agent and workflow concerns in one layer and keeps the workflow state durable even if the planner implementation changes later.

### Cross-review improvements to incorporate

The external research review surfaced several changes that should be treated as required for long-range tasks rather than optional nice-to-haves:

1. **Rolling context compression**
   - After every N tactical steps, summarize completed work into a compact run summary and trim raw observation history from the live planner context.
   - Keep raw logs in `agentRunSteps` / `browserCommandResults`, but only feed summaries plus the active sub-task back into the planner.
   - Concrete first implementation:
     - add `summaryAfterStep?: string` to `agentRunSteps`
     - after every 5 tactical steps, call a `summarize_progress` action
     - each next planning step loads:
       - original goal
       - latest strategic plan / sub-task
       - latest `summaryAfterStep`
       - only the last 5 raw tool/result pairs

2. **Hierarchical planning**
   - Split planning into:
     - a **strategic planner** that produces sub-tasks such as `scan_candidates`, `extract_profiles`, `generate_messages`, `await_approval`, `execute_batch`
     - a **tactical executor** that turns one sub-task into browser commands
   - The strategic planner should never need the full DOM transcript for the whole run.

3. **Verification after irreversible actions**
   - A successful `click` means only that the event sequence fired.
   - For `send`, `submit`, `connect`, and `apply`, the executor must verify the expected post-condition before the workflow proceeds.
   - Verification can use DOM-state checks first and screenshot/vision fallback second.

4. **Explicit run-owned tab registry**
   - Persist `runId -> [tabId]` ownership so service-worker restarts can recover or clean up open tabs.
   - Deterministic cleanup should happen on cancel, fail, and complete states.

5. **Approval expiry semantics**
   - `agentApprovals` should include `expiresAt` and an expiry action such as `pause_run` or `reject`.
   - Approval waits should be modeled as workflow events with explicit timeout behavior, not indefinite hanging UI state.

6. **Retry and compensation**
   - Browser-command execution needs transient retry rules with bounded backoff.
   - Long-running runs need compensation/cleanup rules such as closing run-owned tabs or marking partially-completed work safely.

7. **Keep local queue narrow**
   - `chrome.storage.local` queue state should remain for the deterministic final send queue and rate limits.
   - The full agent run state should live in Convex, not in the extension.

### Can Convex workflows handle the targeted agentic tasks?

Yes, for the tasks this repo is actually targeting:

- recruiter / people search and review
- profile / listing extraction
- draft generation
- approval-gated outreach
- bounded multi-step browser tasks that may span minutes or hours

The execution model is:

1. workflow loads durable run state
2. one planning action decides the next tactical step
3. workflow issues one or more browser commands
4. extension executes them and writes normalized results
5. workflow resumes, updates state, and either:
   - continues
   - waits for approval
   - pauses
   - completes

This is sufficient for bounded, step-sequential agentic work.

What it is **not** trying to optimize for yet:

- highly interactive real-time conversational agents
- many tool calls inside a single sub-second reasoning turn
- browser progress while Chrome is closed

Those are valid future reasons to add a hosted planner or local companion runtime, but they are not blockers for the current product scope.

### Tooling model: function tools first, computer-use fallback second

The first production version should **not** start with screenshot-only "computer use" behavior.

Use **function tools** backed by structured browser commands first:

- `get_active_tab_context`
- `snapshot_interactive_elements`
- `navigate`
- `open_tab`
- `close_tab`
- `wait_for_url`
- `wait_for_element`
- `take_screenshot`
- `get_accessibility_tree`
- `set_field_value`
- `click_element`
- `type_into_field`
- `press_key`
- `scroll_region`
- `extract_structured_data`
- `scan_candidates`
- `enqueue_reviewable_batch`
- `request_user_approval`

Why:

- the extension already has semantic DOM access that is more reliable than screenshot-only planning
- approvals map cleanly to `needsApproval`
- platform adapters can add site-specific confidence without changing the planner contract

Only after that should we add an optional **computer-use fallback** for hostile pages:

- canvas-heavy apps
- unusual nested iframes
- pages where semantic extraction fails

That fallback can still use OpenAI Agents SDK JS, but it should be a secondary tool path, not the core execution mode.

### Reuse plan: what stays and what changes

#### Reuse directly

- [entrypoints/background.ts](entrypoints/background.ts): tab lifecycle, alarms, auth sync, queue processing
- [src/lib/browser-control.ts](src/lib/browser-control.ts): low-level click/type primitives and MAIN-world helpers
- [src/lib/platform.ts](src/lib/platform.ts) + [src/lib/platforms](src/lib/platforms): field detection, compose boundaries, platform-specific extraction
- [src/lib/context.ts](src/lib/context.ts): prompt-ready foreground/thread/background context
- [src/lib/session-observer.ts](src/lib/session-observer.ts): behavioral feedback and outcome classification
- [convex/tasks.ts](convex/tasks.ts): deterministic batch item state
- [convex/traces.ts](convex/traces.ts): trace storage and review UI
- [convex/entities.ts](convex/entities.ts), [convex/memories.ts](convex/memories.ts), [convex/generate.ts](convex/generate.ts): long-term memory and writing context

#### Generalize, do not duplicate

- Keep extending the now-generic `BrowserExecutor` instead of reintroducing platform-specific background execution paths
- Keep platform-specific logic in adapters, not in the planner prompt
- Keep generated copy in current generation/retrieval flows unless the task explicitly needs agent planning

#### Avoid for core production path

- external owned-browser execution for normal user flows
- a second live agent loop built on `@convex-dev/agent`
- direct planner-to-DOM logic that bypasses the extension executor

### Proposed runtime contracts

#### New generic browser command interface

```typescript
type BrowserCommand =
  | { kind: "open_tab"; url: string; active?: boolean }
  | { kind: "close_tab"; tabId: number }
  | { kind: "navigate"; tabId: number; url: string }
  | { kind: "wait_for_url"; tabId: number; urlIncludes: string; timeoutMs?: number }
  | { kind: "wait_for_element"; tabId: number; selector?: string; semanticLabel?: string; timeoutMs?: number }
  | { kind: "take_screenshot"; tabId: number; fullPage?: boolean }
  | { kind: "get_accessibility_tree"; tabId: number; scope?: "viewport" | "main" | "dialog" }
  | { kind: "snapshot_interactives"; tabId: number; scope?: "viewport" | "main" | "dialog" }
  | { kind: "click"; tabId: number; targetId?: string; selector?: string; semanticLabel?: string; approvalRequired?: boolean }
  | { kind: "type"; tabId: number; targetId?: string; selector?: string; text: string; approvalRequired?: boolean }
  | { kind: "set_field_value"; tabId: number; targetId?: string; selector?: string; value: string | boolean | string[] }
  | { kind: "press_key"; tabId: number; key: string; modifiers?: string[] }
  | { kind: "scroll"; tabId: number; direction: "up" | "down"; amount?: number }
  | { kind: "extract_structured"; tabId: number; schema: string; promptHint?: string }
  | { kind: "scan_candidates"; tabId: number; strategy: string };
```

**Important clarification**: this `BrowserCommand` type is the **executor-local payload** used by [src/lib/browser-executor.ts](src/lib/browser-executor.ts). It should stay focused on browser behavior and should **not** be overloaded with Convex workflow metadata.

For agent runs, the Convex command bus should wrap it in a separate envelope:

```typescript
type BrowserCommandEnvelope =
  | {
      runId: Id<"agentRuns">;
      stepId: Id<"agentRunSteps">;
      commandId: Id<"browserCommands">;
      deliveryScope: "specific_tab";
      targetTabId: number;
      completionEventId: string;
      command: BrowserCommand;
    }
  | {
      runId: Id<"agentRuns">;
      stepId: Id<"agentRunSteps">;
      commandId: Id<"browserCommands">;
      deliveryScope: "any_attached_tab";
      targetUrl?: string;
      completionEventId: string;
      command: BrowserCommand;
    };
```

This separation resolves the 9A/9B dependency issue:

- **Phase 9A** extends the executor-local `BrowserCommand`
- **Phase 9B** introduces the Convex envelope and bus tables

So the phases can stay conceptually separate, even if they are implemented in the same milestone.

#### New run-state tables

Add minimal new tables instead of reinventing everything:

- `agentRuns`: one row per long-running agent task
- `agentRunSteps`: planner/tool/approval events, summaries, and command/approval links
- `browserCommands`: commands awaiting extension execution
- `browserCommandResults`: normalized outputs, errors, screenshots, or structured extracts
- `agentApprovals`: approval items and decisions for irreversible actions
- `agentRunTabs`: run-owned tab registry and recovery metadata

Reuse existing tables where they already fit:

- `taskBatches` / `taskItems` for reviewable outbound queues
- `traces` / `traceArtifacts` for prompt/debug review

#### Concrete Phase 9B schemas

The first Convex-first implementation should use concrete fields, not placeholders:

```typescript
agentRuns: {
  userId: string;
  goal: string;
  platformHint?: string;
  status: "created" | "planning" | "executing" | "awaiting_approval" | "paused" | "completed" | "failed" | "cancelled";
  currentStepIndex: number;
  latestSummary?: string;
  lastSummarizedAtStep: number;
  activeWorkflowId: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  lastError?: string;
}

agentRunSteps: {
  runId: Id<"agentRuns">;
  stepIndex: number;
  phase: "strategic_plan" | "tactical_plan" | "browser_command" | "browser_result" | "summary" | "approval";
  content?: string;
  commandId?: Id<"browserCommands">;
  approvalId?: Id<"agentApprovals">;
  summaryAfterStep?: string;
  createdAt: number;
}

browserCommands: {
  runId: Id<"agentRuns">;
  stepId: Id<"agentRunSteps">;
  targetTabId?: number;
  targetUrl?: string;
  deliveryScope: "specific_tab" | "any_attached_tab";
  completionEventId: string;
  status: "pending" | "claimed" | "executing" | "completed" | "failed" | "cancelled";
  attemptCount: number;
  command: BrowserCommand;
  createdAt: number;
  claimedAt?: number;
  completedAt?: number;
  lastError?: string;
}

browserCommandResults: {
  runId: Id<"agentRuns">;
  commandId: Id<"browserCommands">;
  ok: boolean;
  resultJson?: string;
  error?: string;
  createdAt: number;
}

agentApprovals: {
  runId: Id<"agentRuns">;
  stepId: Id<"agentRunSteps">;
  kind: "send" | "submit" | "connect" | "apply" | "delete" | "navigation";
  title: string;
  payloadJson: string;
  status: "pending" | "approved" | "rejected" | "expired";
  expiresAt: number;
  completionEventId: string;
  createdAt: number;
  resolvedAt?: number;
}

agentRunTabs: {
  runId: Id<"agentRuns">;
  tabId: number;
  url: string;
  status: "open" | "closed" | "orphaned";
  openedAt: number;
  closedAt?: number;
}
```

Notes:

- `agentRunSteps` should **not** talk about a "serialized planner state pointer" in the Convex-first implementation. The durable state lives in the workflow plus persisted summaries and step records.
- If a hosted Node planner mode is added later, it may add an optional planner-session key, but that is not required for the Convex-first rollout.
- In the actual Convex schema, `browserCommands.command` should be stored as a serializable Convex value such as `v.any()` or a normalized JSON-safe object shape. The TypeScript `BrowserCommand` union is the application-level type contract, not a literal Convex validator.

#### Command delivery protocol

The extension-side delivery path must be explicit before implementation:

1. Every tab with the content app registers a lightweight **command relay**.
2. The relay knows its live Chrome tab id and page URL.
3. The relay subscribes to pending `browserCommands` for:
   - its exact `targetTabId`, or
   - `deliveryScope === "any_attached_tab"` when appropriate.
4. When a matching command appears, the relay sends `EXECUTE_BROWSER_COMMAND` to the service worker via `chrome.runtime.sendMessage`.
5. The service worker claims the command via a Convex mutation before executing it.
6. The service worker executes the command through `BrowserExecutor`.
7. The service worker writes the result through a Convex mutation.

This repo should use the **content-script relay** approach rather than service-worker polling because:

- MV3 service workers do not have a durable real-time subscription model
- the content script already has a live React tree and an always-on page context
- relay messages wake the service worker only when needed

If no relay is currently attached for a command's target tab, the run remains pending until the tab loads or Chrome is reopened. That is acceptable for the bounded local-session tasks this project targets.

#### Workflow resume protocol

The workflow resume path must also be explicit:

1. When the workflow creates a `browserCommands` row, it also generates a `completionEventId`.
2. The workflow waits on that command's completion event.
3. The mutation that writes `browserCommandResults` must, in the same logical path, also signal the matching workflow event using `completionEventId`.
4. The workflow wakes, reads the normalized result, updates `agentRunSteps` / summaries, and decides the next action.

The same pattern applies to approvals:

- `agentApprovals` rows carry a `completionEventId`
- the approval-decision mutation updates the row and signals the workflow event
- expired approvals resolve through a scheduled expiry mutation that also signals the workflow

#### Phase 9B prerequisite

Before implementing the Convex workflow layer:

1. install `@convex-dev/workflow`
2. register the workflow component in the Convex app config
3. verify the repo can build and deploy with workflow support enabled

Phase 9B should not start until that prerequisite is complete.

### Capability ladder for "any platform"

We should not promise the same confidence level on every site on day one. The execution model should explicitly support four levels:

| Level | Description | Examples |
|---|---|---|
| L1 | Generic DOM executor | click/type/navigate/extract on ordinary forms and threads |
| L2 | Generic semantic adapter | main region, dialogs, visible fields, candidate interactive elements |
| L3 | Platform adapter | LinkedIn, Gmail, job boards, Slack-style threads, etc. |
| L4 | Fallback computer-use mode | screenshot-guided execution when DOM semantics are insufficient |

This is how we support "any platform" without pretending every site is equally solved.

### Example run: "find 20 recruiters and send connection requests"

1. User starts an agentic task from popup, command box, or voice.
2. Service worker captures active tab, current page context, and browser session metadata.
3. Convex creates `agentRun`.
4. Convex workflow starts the first planner step with tools for:
   - reading the current page
   - scanning candidates
   - opening profiles
   - extracting profile context
   - generating connection notes
   - asking for approval
   - enqueueing sendable tasks
5. Planner step issues browser commands through Convex.
6. Extension executes them in the user's Chrome session and writes back results.
7. Workflow resumes, updates summaries and run state, and either continues or waits.
8. User approves the queue or individual sends.
9. Deterministic executor path reuses `taskBatches` / `taskItems` and daily-rate limits to actually send.

The planner decides *what should happen*. The extension still decides *how to click/type safely on the real page*.

### Approval policy

Every irreversible action must require explicit approval:

- `send`
- `submit`
- `connect`
- `apply`
- `delete`
- any tool that leaves the current site or opens many tabs

For the Convex-first planner path, enforce these through `agentApprovals` rows plus workflow wait/resume events. If a hosted OpenAI Agents SDK mode is added later, map the same policy to SDK `needsApproval` rules in that mode.

The planner can auto-approve only:

- observation
- scanning
- non-destructive extraction
- navigation within the same run
- draft generation

### Recommended phased rollout inside Phase 9

#### Phase 9A — Generic executor foundation

- Create `BrowserExecutor` interface
- Convert current LinkedIn MAIN-world helpers into generic command implementations
- Add `snapshot_interactive_elements`, `extract_structured`, and `get_accessibility_tree` commands

**Status**: partially complete. `BrowserExecutor` and normalized command routing exist, plus generic `open_tab`, `close_tab`, `navigate`, `wait_for_url`, `wait_for_element`, `click`, `type`, and `run_script` execution. `snapshot_interactive_elements`, `extract_structured`, and `get_accessibility_tree` are the remaining Phase 9A prerequisites before any real planner rollout. `take_screenshot` and `set_field_value` should land in the same window if low effort, but they are secondary to semantic observation.

#### Phase 9B — Durable run state

Prerequisite:
- add `@convex-dev/workflow` and wire the workflow component into the Convex app config before building the new run-state tables

- Add `agentRuns`, `agentRunSteps`, `browserCommands`, `browserCommandResults`, `agentApprovals`
- Add `agentRunTabs` for tab recovery and cleanup
- Add Convex workflow wrapper for long-running browser jobs
- Persist planner run state, approval state, and rolling run summaries
- Implement approval expiry and workflow event resume semantics
- Add bounded retry / compensation policies per browser step
- Add `summaryAfterStep` compression checkpoints and "load last 5 raw steps + latest summary" planner context rules

#### Phase 9C — Convex-first planner runtime

- Add strategic planner / tactical executor split
- Implement planner steps as Convex actions under the durable workflow
- Implement function tools that translate into browser commands
- Add rolling context compression and first HITL resume loop
- Verify irreversible actions before the workflow advances

#### Phase 9D — Multi-platform adapter expansion

- Lift reusable semantics from [src/lib/platforms/linkedin.ts](src/lib/platforms/linkedin.ts), [src/lib/platforms/jobboard.ts](src/lib/platforms/jobboard.ts), and [src/lib/platforms/conversation.ts](src/lib/platforms/conversation.ts)
- Add generic form/thread/page adapters
- Add first non-LinkedIn agentic flows:
  - Gmail/Outlook thread drafting
  - generic application form answering
  - recruiter / people search review queues

#### Phase 9E — Hosted / local planner future modes

- Add hosted Node planner mode using OpenAI Agents SDK JS when we want SDK-native sessions, guardrails, or handoffs
- Add optional local companion planner mode for on-device orchestration outside MV3
- Keep both modes behind the same Convex workflow / browser-command contracts

#### Phase 9F — Optional fallback and dev tooling

- Add screenshot-guided fallback tool path
- Keep Playwright / Puppeteer / Stagehand / Browser Use limited to:
  - local replay
  - CI
  - optional power mode
- Keep `chrome.debugger` confined to dev tooling

### Implementation rules for this phase

1. Do not move core browser execution out of the extension.
2. Do not replace existing deterministic queue execution for sends.
3. Do not introduce more than one active production agent loop at a time. Start with the Convex-first planner; add a hosted Node planner only as a pluggable upgrade path in Phase 9E.
4. Do not rebuild memory/retrieval logic in the planner; call existing Convex capabilities where possible.
5. Do not let platform-specific prompt text substitute for real executor capabilities.

### Success criteria

Phase 9 is successful when all of the following are true:

- a long-running run survives service-worker restarts
- the planner can pause for approval and resume later
- the same planner can operate on more than one platform
- browser execution still happens in the user's real Chrome session
- current retrieval, memory, tracing, and task queues are reused rather than duplicated

---

*Last updated: 2026-04-05. Research basis: multiple passes covering Chrome MV3 APIs, OpenAI Agents SDK JS, Convex Durable Workflows, LangGraph.js, Mastra, browser-use, Stagehand, Playwright/Puppeteer, Web Speech API in MV3, LinkedIn automation safety, and ActivityWatch heartbeat architecture. This document now reflects code that was verified against the current repository, plus a new Phase 9 architecture recommendation grounded in current official docs and the existing codebase.*
