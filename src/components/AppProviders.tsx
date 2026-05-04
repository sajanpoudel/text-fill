import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ConvexReactClient } from "convex/react";
import type { ReactNode } from "react";
import {
  CONVEX_AUTH_JWT_STORAGE_KEY,
  CONVEX_AUTH_REFRESH_TOKEN_STORAGE_KEY,
  CONVEX_REFRESH_TOKEN_STORAGE_KEY,
  CONVEX_TOKEN_STORAGE_KEY,
  isConvexAuthStorageKey,
} from "../lib/convex-auth-storage.ts";

// Singleton — one client per page context (popup, options, memory viewer)
const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL as string);

// Sync in-memory cache for auth tokens, pre-populated from chrome.storage.local.
// This makes the storage resilient to localStorage being cleared (which happens
// when users clear browser cookies/site data — chrome.storage.local is unaffected).
const storageCache = new Map<string, string>();
let isStorageCacheSubscribed = false;

function subscribeStorageCache(): void {
  if (isStorageCacheSubscribed || typeof chrome === "undefined") return;
  isStorageCacheSubscribed = true;
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    for (const [key, change] of Object.entries(changes)) {
      if (!isConvexAuthStorageKey(key)) continue;
      if (typeof change.newValue === "string") {
        storageCache.set(key, change.newValue);
      } else {
        storageCache.delete(key);
      }
    }
  });
}

// Call this once before mounting React to seed the cache from chrome.storage.local.
export async function initExtensionStorage(): Promise<void> {
  const all = await chrome.storage.local.get(null);
  for (const [k, v] of Object.entries(all)) {
    if (typeof v === "string" && isConvexAuthStorageKey(k)) {
      storageCache.set(k, v);
    }
  }
  subscribeStorageCache();
}

// Custom storage backed by chrome.storage.local (via sync cache).
// chrome.storage.local is not cleared by browser "Clear browsing data",
// making sessions survive browser restarts and data clears.
function makeExtensionStorage(): Storage {
  return {
    get length() { return storageCache.size; },
    clear() {
      const keys = [
        ...storageCache.keys(),
        CONVEX_TOKEN_STORAGE_KEY,
        CONVEX_REFRESH_TOKEN_STORAGE_KEY,
      ];
      storageCache.clear();
      chrome.storage.local.remove(keys).catch(() => {});
    },
    getItem: (key) => storageCache.get(key) ?? null,
    key: (index) => [...storageCache.keys()][index] ?? null,
    removeItem(key) {
      storageCache.delete(key);
      const keys = [key];
      if (key === CONVEX_AUTH_JWT_STORAGE_KEY) {
        keys.push(CONVEX_TOKEN_STORAGE_KEY);
      }
      if (key === CONVEX_AUTH_REFRESH_TOKEN_STORAGE_KEY) {
        keys.push(CONVEX_REFRESH_TOKEN_STORAGE_KEY);
      }
      chrome.storage.local.remove(keys).catch(() => {});
    },
    setItem(key, value) {
      storageCache.set(key, value);
      const updates: Record<string, string> = { [key]: value };
      if (key === CONVEX_AUTH_JWT_STORAGE_KEY) {
        updates[CONVEX_TOKEN_STORAGE_KEY] = value;
      }
      if (key === CONVEX_AUTH_REFRESH_TOKEN_STORAGE_KEY) {
        updates[CONVEX_REFRESH_TOKEN_STORAGE_KEY] = value;
      }
      chrome.storage.local.set(updates).catch(() => {});
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
