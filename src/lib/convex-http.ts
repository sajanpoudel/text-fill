// ConvexHttpClient instance for the background service worker.
// The reactive ConvexReactClient is only used in popup/options/memory pages.
import { ConvexHttpClient } from "convex/browser";
import {
  CONVEX_AUTH_JWT_STORAGE_KEY,
  CONVEX_TOKEN_STORAGE_KEY,
  getStoredConvexAccessToken,
} from "./convex-auth-storage.ts";

let _client: ConvexHttpClient | null = null;

export function getConvexClient(): ConvexHttpClient {
  if (!_client) {
    const url = import.meta.env.VITE_CONVEX_URL as string;
    if (!url) throw new Error("VITE_CONVEX_URL is not set");
    _client = new ConvexHttpClient(url);
  }
  return _client;
}

export function setConvexAuth(token: string): void {
  getConvexClient().setAuth(token);
}

export function clearConvexAuth(): void {
  getConvexClient().clearAuth();
}

export async function syncConvexAuthFromStorage(): Promise<string | null> {
  const stored = await chrome.storage.local.get([
    CONVEX_AUTH_JWT_STORAGE_KEY,
    CONVEX_TOKEN_STORAGE_KEY,
  ]);
  const token = getStoredConvexAccessToken(stored);
  if (token) {
    setConvexAuth(token);
  } else {
    clearConvexAuth();
  }
  return token;
}
