/**
 * offscreen/main.ts — Voice recognition runtime for the MV3 offscreen document.
 *
 * The service worker cannot use SpeechRecognition (no window object) and is
 * terminated after 5 minutes of inactivity. The offscreen document solves both:
 * it has a full DOM, runs indefinitely, and has access to getUserMedia.
 *
 * Flow:
 *   Service worker sends START_VOICE / STOP_VOICE → this document
 *   This document sends VOICE_INTERIM / VOICE_COMMAND → service worker
 */

import { type VoiceRuntimeState } from "../../src/lib/voice-runtime.ts";

const SR: SpeechRecognitionConstructor | undefined =
  window.SpeechRecognition ?? window.webkitSpeechRecognition;

let recognition: SpeechRecognition | null = null;
let isListening = false;

function postVoiceState(state: VoiceRuntimeState, error?: string): void {
  chrome.runtime.sendMessage({
    target: "background",
    type: "VOICE_STATE",
    state,
    ...(error ? { error } : {}),
  });
}

function startRecognition(): void {
  if (isListening) {
    postVoiceState("listening");
    return;
  }
  if (!SR) {
    postVoiceState(
      "error",
      "Background voice recognition is unavailable here. Use the inline mic."
    );
    chrome.runtime.sendMessage({
      target: "background",
      type: "VOICE_ERROR",
      error: "Background voice recognition is unavailable here. Use the inline mic.",
    });
    return;
  }

  recognition = new SR() as SpeechRecognition;
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = "en-US";
  recognition.onstart = () => {
    isListening = true;
    postVoiceState("listening");
  };

  recognition.onresult = (e: SpeechRecognitionEvent) => {
    const isFinal = e.results[e.results.length - 1].isFinal;
    const parts: string[] = [];
    for (let i = 0; i < e.results.length; i += 1) {
      parts.push(e.results[i][0].transcript);
    }
    const transcript = parts.join("");

    chrome.runtime.sendMessage({
      target: "background",
      type: isFinal ? "VOICE_COMMAND" : "VOICE_INTERIM",
      text: transcript,
    });
  };

  recognition.onerror = (e: SpeechRecognitionErrorEvent) => {
    // non-fatal — restart on recoverable errors
    if (e.error === "no-speech" || e.error === "audio-capture") return;
    if (e.error === "not-allowed") {
      // Mic permission denied — stop and notify
      isListening = false;
      postVoiceState("error", "Microphone permission denied");
      chrome.runtime.sendMessage({
        target: "background",
        type: "VOICE_ERROR",
        error: "Microphone permission denied",
      });
      return;
    }
    postVoiceState("error", `Voice error: ${e.error}`);
  };

  // Auto-restart on end (Chrome stops after silence or ~5 minutes)
  recognition.onend = () => {
    if (isListening) {
      try {
        recognition?.start();
      } catch {
        // May throw if already started; ignore
        isListening = false;
        recognition = null;
        postVoiceState("idle");
      }
    } else {
      recognition = null;
      postVoiceState("idle");
    }
  };

  postVoiceState("starting");
  try {
    recognition.start();
  } catch (error: any) {
    isListening = false;
    recognition = null;
    const message = String(error?.message ?? error ?? "Voice start failed");
    postVoiceState("error", message);
    chrome.runtime.sendMessage({
      target: "background",
      type: "VOICE_ERROR",
      error: message,
    });
  }
}

function stopRecognition(): void {
  if (!recognition && !isListening) {
    postVoiceState("idle");
    return;
  }
  isListening = false;
  postVoiceState("stopping");
  try {
    recognition?.stop();
  } catch {
    // ignore
    postVoiceState("idle");
  }
}

// Listen for control messages from the service worker
chrome.runtime.onMessage.addListener(
  (msg: { target?: string; type: string }) => {
    if (msg.target !== "offscreen") return;
    if (msg.type === "START_VOICE") startRecognition();
    if (msg.type === "STOP_VOICE") stopRecognition();
  }
);
