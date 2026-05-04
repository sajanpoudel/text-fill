// Session observer — tracks what the user does before/after every AI generation.
// Emits a SessionPayload to the background service worker via chrome.runtime.sendMessage.
//
// Session lifecycle per field:
//   focusin         → onFieldFocus()         — opens session, attaches per-field listeners
//   generation call → onGenerationStart()    — snapshots pre-AI text + optional recipientName
//   post-insert     → onGenerationComplete() — records what actually landed in the editor
//   focusout        → onFieldBlur()          — computes diff, classifies outcome, emits
//
// Send confirmation uses 3 independent signals (any one is sufficient):
//   A) form `submit` event fires
//   B) Enter keydown (no Shift) on a single-line input, OR Ctrl/Cmd+Enter on contenteditable
//   C) mousedown on an ENABLED send-looking button, CONFIRMED by a `__TF_SEND__` XHR message
//      arriving from the MAIN-world interceptor within 3 seconds
// Signal C alone (mousedown without XHR confirmation) is not sufficient.

import { detectLinkedInFieldType } from "./platforms/linkedin.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

export type SessionOutcome =
  | "accepted"
  | "lightly_edited"
  | "heavily_edited"
  | "rewritten"
  | "abandoned"
  | "sent";

export interface SessionPayload {
  sessionId: string;
  platform: string;
  contextType: string | undefined;
  recipientName: string | undefined;
  traceId: string | undefined;
  openedAt: number;
  aiGeneratedAt: number | undefined;
  closedAt: number;
  outcome: SessionOutcome;
  charDelta: number | undefined;
  editFraction: number | undefined;
  aiPreText: string | undefined;
  aiGeneratedText: string | undefined;
  userFinalText: string | undefined;
}

// ── Text helpers ──────────────────────────────────────────────────────────────

export function getFieldText(field: Element): string {
  if (
    field instanceof HTMLInputElement ||
    field instanceof HTMLTextAreaElement
  ) {
    return field.value;
  }
  if ((field as HTMLElement).isContentEditable) {
    return (field as HTMLElement).innerText ?? field.textContent ?? "";
  }
  return field.textContent ?? "";
}

// Bounded Levenshtein — O(n) space, bails at maxDist to keep it fast for long texts
function levenshtein(a: string, b: string, maxDist = 5000): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let [s, t] = a.length <= b.length ? [a, b] : [b, a];
  if (t.length - s.length > maxDist) return maxDist + 1;

  const prev = Array.from({ length: s.length + 1 }, (_, i) => i);
  for (let i = 1; i <= t.length; i++) {
    let prevPrev = i - 1;
    prev[0] = i;
    let rowMin = i;
    for (let j = 1; j <= s.length; j++) {
      const tmp = prev[j];
      prev[j] =
        t[i - 1] === s[j - 1]
          ? prevPrev
          : 1 + Math.min(prev[j], prev[j - 1], prevPrev);
      prevPrev = tmp;
      if (prev[j] < rowMin) rowMin = prev[j];
    }
    if (rowMin > maxDist) return maxDist + 1;
  }
  return prev[s.length];
}

// Trigram similarity — fast approximation for texts > 1500 chars
function trigramSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 3 || b.length < 3) return 0;
  const ngrams = (s: string) => {
    const set = new Set<string>();
    for (let i = 0; i < s.length - 2; i++) set.add(s.slice(i, i + 3));
    return set;
  };
  const sa = ngrams(a);
  const sb = ngrams(b);
  let shared = 0;
  for (const g of sa) if (sb.has(g)) shared++;
  return (2 * shared) / (sa.size + sb.size);
}

export function editFraction(before: string, after: string): number {
  if (before === after) return 0;
  if (!before || !after) return 1;
  const maxLen = Math.max(before.length, after.length);
  if (maxLen > 1500) return 1 - trigramSimilarity(before, after);
  return levenshtein(before, after) / maxLen;
}

export function charDelta(before: string, after: string): number {
  return after.length - before.length;
}

export function classifyOutcome(
  aiText: string,
  finalText: string
): SessionOutcome {
  if (!finalText.trim()) return "abandoned";
  if (finalText.trim() === aiText.trim()) return "accepted";
  const frac = editFraction(aiText, finalText);
  if (frac < 0.15) return "lightly_edited";
  if (frac < 0.5) return "heavily_edited";
  return "rewritten";
}

export function chooseFinalText(
  aiText: string,
  liveText: string,
  settledText?: string
): string {
  if (settledText === undefined) return liveText;
  if (liveText !== aiText) return liveText;
  if (settledText !== liveText) return settledText;
  return liveText;
}

// ── Minimal debounce ──────────────────────────────────────────────────────────

function debounce<T extends (...args: unknown[]) => void>(
  fn: T,
  ms: number
): T & { cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const debounced = ((...args: Parameters<T>) => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  }) as T & { cancel(): void };
  debounced.cancel = () => {
    if (timer !== null) { clearTimeout(timer); timer = null; }
  };
  return debounced;
}

// ── Context type detection ────────────────────────────────────────────────────

function detectContextType(
  field: Element,
  platform: string
): string | undefined {
  if (platform === "linkedin") {
    const raw = detectLinkedInFieldType(field);
    if (!raw) return undefined;
    if (raw.includes("CONNECTION_NOTE")) return "connection_req";
    if (raw.includes("INMAIL")) return "inmail";
    if (raw.includes("DM_MESSAGE")) return "dm";
    if (raw.includes("COMMENT")) return "comment";
    if (raw.includes("POST_COMPOSE")) return "post";
    return undefined;
  }
  if (platform === "gmail" || platform === "outlook") return "email";
  if (
    platform === "messenger" ||
    platform === "discord" ||
    platform === "slack"
  ) return "dm";
  return undefined;
}

// ── Send button detection helpers ─────────────────────────────────────────────

const SEND_SELECTORS = [
  '[aria-label*="Send" i]',
  '[aria-label*="send invitation" i]',
  '[aria-label*="Submit" i]',
  '[data-testid*="send"]',
  '[data-control-name*="send"]',
  'button[type="submit"]',
];

function looksLikeSendButton(el: Element): boolean {
  for (const sel of SEND_SELECTORS) {
    try {
      if (el.matches(sel) || el.closest(sel)) return true;
    } catch { /* invalid selector — skip */ }
  }
  return false;
}

function isEnabled(el: Element): boolean {
  if ((el as HTMLButtonElement).disabled) return false;
  if (el.hasAttribute("disabled")) return false;
  if (el.getAttribute("aria-disabled") === "true") return false;
  // Walk up to find a disabled ancestor button
  let p: Element | null = el.parentElement;
  while (p) {
    if ((p as HTMLButtonElement).disabled || p.hasAttribute("disabled")) return false;
    p = p.parentElement;
  }
  return true;
}

// ── Session state ─────────────────────────────────────────────────────────────

interface SessionState {
  sessionId: string;
  platform: string;
  contextType: string | undefined;
  recipientName: string | undefined;
  traceId: string | undefined;
  openedAt: number;
  preText: string | undefined;
  aiGeneratedAt: number | undefined;
  aiGeneratedText: string | undefined;  // post-insert field text (what actually landed)
}

// ── SessionObserver ───────────────────────────────────────────────────────────

class SessionObserver {
  private sessions = new Map<Element, SessionState>();
  private activeField: Element | null = null;

  // Per-field composite snapshot state
  private _settledText = new Map<Element, string>();
  private _perFieldCleanup = new Map<Element, () => void>();

  // Send signal state
  private _mousedownPending: { field: Element; at: number } | null = null;
  private _xhrConfirmedAt = 0; // last XHR send signal timestamp
  private _formSubmitPending: { field: Element; at: number } | null = null;
  private _enterPending: { field: Element; at: number } | null = null;

  constructor() {
    // mousedown fires BEFORE blur — mark intent here
    document.addEventListener("mousedown", this._onMouseDown.bind(this), {
      capture: true,
      passive: true,
    });

    // form submit — strong send signal (fires before blur too)
    document.addEventListener("submit", this._onSubmit.bind(this), {
      capture: true,
      passive: true,
    });

    // Enter key — single-line inputs or Ctrl/Cmd+Enter on contenteditable
    document.addEventListener("keydown", this._onKeyDown.bind(this), {
      capture: true,
      passive: true,
    });

    // Receive XHR/fetch send confirmation from MAIN world interceptor
    window.addEventListener("message", this._onWindowMessage.bind(this));
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  onFieldFocus(field: Element, platform: string): void {
    this.activeField = field;
    if (this.sessions.has(field)) return; // re-focus on same session

    this.sessions.set(field, {
      sessionId: crypto.randomUUID(),
      platform,
      contextType: detectContextType(field, platform),
      recipientName: undefined,
      traceId: undefined,
      openedAt: Date.now(),
      preText: undefined,
      aiGeneratedAt: undefined,
      aiGeneratedText: undefined,
    });

    // Attach per-field listeners for accurate settled text
    this._attachFieldListeners(field);
  }

  onGenerationStart(field: Element, recipientName?: string): void {
    const state = this.sessions.get(field);
    if (!state) return;
    state.preText = getFieldText(field);
    if (recipientName) state.recipientName = recipientName;
  }

  // Takes the ACTUAL post-insert field text, not the raw API response string.
  // Callers must snapshot getFieldText(field) after insertText has settled (~200ms).
  onGenerationComplete(field: Element, postInsertFieldText: string, traceId?: string): void {
    const state = this.sessions.get(field);
    if (!state) return;
    state.aiGeneratedAt = Date.now();
    state.aiGeneratedText = postInsertFieldText;
    if (traceId) state.traceId = traceId;
    // Seed settled text so we have a baseline even if the user never touches the field
    this._settledText.set(field, postInsertFieldText);
  }

  onFieldBlur(field: Element): void {
    if (this.activeField === field) this.activeField = null;
    const state = this.sessions.get(field);
    if (!state) return;

    // Only record sessions where AI was used
    if (!state.aiGeneratedText) {
      this._cleanupField(field);
      return;
    }

    // Prefer settled text (from debounced input / compositionend),
    // fall back to synchronous blur-time snapshot
    const liveText = getFieldText(field);
    const finalText = chooseFinalText(
      state.aiGeneratedText,
      liveText,
      this._settledText.get(field)
    );

    const now = Date.now();
    const isSent = this._checkSentSignals(field, now);

    const outcome: SessionOutcome = isSent
      ? "sent"
      : classifyOutcome(state.aiGeneratedText, finalText);

    const fraction = isSent
      ? undefined
      : editFraction(state.aiGeneratedText, finalText);
    const delta = charDelta(state.aiGeneratedText, finalText);

    this._emit({
      sessionId: state.sessionId,
      platform: state.platform,
      contextType: state.contextType,
      recipientName: state.recipientName,
      traceId: state.traceId,
      openedAt: state.openedAt,
      aiGeneratedAt: state.aiGeneratedAt,
      closedAt: now,
      outcome,
      charDelta: delta,
      editFraction: fraction,
      aiPreText: state.preText,
      aiGeneratedText: state.aiGeneratedText,
      userFinalText: finalText,
    });

    this._cleanupField(field);
  }

  // ── Send confirmation logic ─────────────────────────────────────────────────

  private _checkSentSignals(field: Element, now: number): boolean {
    const WINDOW_MS = 2000; // all signals must arrive within 2s of each other

    // Signal A: form submit
    if (
      this._formSubmitPending?.field === field &&
      now - this._formSubmitPending.at < WINDOW_MS
    ) return true;

    // Signal B: Enter key
    if (
      this._enterPending?.field === field &&
      now - this._enterPending.at < WINDOW_MS
    ) return true;

    // Signal C: mousedown on enabled send button CONFIRMED by XHR signal
    if (
      this._mousedownPending?.field === field &&
      this._xhrConfirmedAt > this._mousedownPending.at &&
      this._xhrConfirmedAt - this._mousedownPending.at < 3000
    ) return true;

    return false;
  }

  // ── Event listeners ─────────────────────────────────────────────────────────

  private _onMouseDown(e: MouseEvent): void {
    if (!this.activeField) return;
    const target = e.target as Element | null;
    if (!target) return;
    if (!isEnabled(target)) return; // disabled buttons don't send
    if (looksLikeSendButton(target)) {
      this._mousedownPending = { field: this.activeField, at: Date.now() };
    }
  }

  private _onSubmit(e: Event): void {
    if (!this.activeField) return;
    const form = e.target as Element;
    const fieldForm = this.activeField.closest("form");
    if (fieldForm === form || form.contains(this.activeField)) {
      this._formSubmitPending = { field: this.activeField, at: Date.now() };
    }
  }

  private _onKeyDown(e: KeyboardEvent): void {
    if (e.key !== "Enter" || e.shiftKey || !this.activeField) return;
    const field = this.activeField;

    // Single-line inputs: plain Enter
    if (
      field instanceof HTMLInputElement &&
      field.type !== "textarea"
    ) {
      this._enterPending = { field, at: Date.now() };
      return;
    }

    // Contenteditable (LinkedIn, Gmail): Ctrl/Cmd+Enter is explicit send gesture
    if (
      (field as HTMLElement).isContentEditable &&
      (e.ctrlKey || e.metaKey)
    ) {
      this._enterPending = { field, at: Date.now() };
    }
  }

  private _onWindowMessage(e: MessageEvent): void {
    if (e.data?.type === "__TF_SEND__") {
      this._xhrConfirmedAt = (e.data.ts as number) ?? Date.now();
    }
  }

  // ── Per-field composite snapshot listeners ─────────────────────────────────

  private _attachFieldListeners(field: Element): void {
    if (this._perFieldCleanup.has(field)) return;

    const onBeforeInput = () => {
      if (this.sessions.get(field)?.aiGeneratedText !== undefined) {
        this._settledText.set(field, getFieldText(field));
      }
    };

    const onInput = debounce(() => {
      // Only update settled text after AI has generated — before that it's noise
      if (this.sessions.get(field)?.aiGeneratedText !== undefined) {
        this._settledText.set(field, getFieldText(field));
      }
    }, 300);

    const onCompositionStart = () => {
      if (this.sessions.get(field)?.aiGeneratedText !== undefined) {
        this._settledText.set(field, getFieldText(field));
      }
    };

    const onCompositionEnd = () => {
      // IME finalisation — update immediately without debounce
      if (this.sessions.get(field)?.aiGeneratedText !== undefined) {
        this._settledText.set(field, getFieldText(field));
      }
    };

    field.addEventListener("beforeinput", onBeforeInput, { passive: true });
    field.addEventListener("input", onInput, { passive: true });
    field.addEventListener("compositionstart", onCompositionStart, {
      passive: true,
    });
    field.addEventListener("compositionend", onCompositionEnd, { passive: true });

    this._perFieldCleanup.set(field, () => {
      field.removeEventListener("beforeinput", onBeforeInput);
      field.removeEventListener("input", onInput);
      field.removeEventListener("compositionstart", onCompositionStart);
      field.removeEventListener("compositionend", onCompositionEnd);
      onInput.cancel();
    });
  }

  private _cleanupField(field: Element): void {
    this._perFieldCleanup.get(field)?.();
    this._perFieldCleanup.delete(field);
    this._settledText.delete(field);
    this.sessions.delete(field);
    if (this._mousedownPending?.field === field) this._mousedownPending = null;
    if (this._formSubmitPending?.field === field) this._formSubmitPending = null;
    if (this._enterPending?.field === field) this._enterPending = null;
  }

  // ── Emit ─────────────────────────────────────────────────────────────────────

  private _emit(payload: SessionPayload): void {
    try {
      if (!chrome.runtime?.id) return;
      chrome.runtime
        .sendMessage({ type: "OBSERVE_SESSION", payload })
        .catch(() => {}); // non-fatal
    } catch {
      // Extension context invalidated — ignore
    }
  }
}

// ── Singleton export ──────────────────────────────────────────────────────────

export const sessionObserver = new SessionObserver();
