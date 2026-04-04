import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ConvexReactClient } from "convex/react";
import type { ReactNode } from "react";

// Singleton — one client per page context (popup, options, memory viewer)
const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL as string);

// Sync in-memory cache for auth tokens, pre-populated from chrome.storage.local.
// This makes the storage resilient to localStorage being cleared (which happens
// when users clear browser cookies/site data — chrome.storage.local is unaffected).
const storageCache = new Map<string, string>();

// Call this once before mounting React to seed the cache from chrome.storage.local.
export async function initExtensionStorage(): Promise<void> {
  const all = await chrome.storage.local.get(null);
  for (const [k, v] of Object.entries(all)) {
    if (typeof v === "string" && k.startsWith("__convexAuth")) {
      storageCache.set(k, v);
    }
  }
}

// Custom storage backed by chrome.storage.local (via sync cache).
// chrome.storage.local is not cleared by browser "Clear browsing data",
// making sessions survive browser restarts and data clears.
function makeExtensionStorage(): Storage {
  return {
    get length() { return storageCache.size; },
    clear() {
      const keys = [...storageCache.keys()];
      storageCache.clear();
      chrome.storage.local.remove(keys).catch(() => {});
    },
    getItem: (key) => storageCache.get(key) ?? null,
    key: (index) => [...storageCache.keys()][index] ?? null,
    removeItem(key) {
      storageCache.delete(key);
      chrome.storage.local.remove(key).catch(() => {});
      // Backward compat: also remove generic refresh token key used by the background SW
      if (key.includes("RefreshToken")) {
        chrome.storage.local.remove("convexRefreshToken").catch(() => {});
      }
    },
    setItem(key, value) {
      storageCache.set(key, value);
      // Persist to chrome.storage.local with the actual key so initExtensionStorage
      // can restore it on next popup open even if the in-memory cache is gone.
      chrome.storage.local.set({ [key]: value }).catch(() => {});
      // Also save under the generic key the background SW reads for silent refresh.
      if (key.includes("RefreshToken")) {
        chrome.storage.local.set({ convexRefreshToken: value }).catch(() => {});
      }
    },
  };
}

const extensionStorage = makeExtensionStorage();

interface Props {
  children: ReactNode;
}

export function AppProviders({ children }: Props) {
  return (
    <ConvexAuthProvider client={convex} storage={extensionStorage}>
      {children}
    </ConvexAuthProvider>
  );
}
