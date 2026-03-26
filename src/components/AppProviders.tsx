import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ConvexReactClient } from "convex/react";
import type { ReactNode } from "react";

// Singleton — one client per page context (popup, options, memory viewer)
const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL as string);

// Custom storage that wraps localStorage and mirrors the refresh token to
// chrome.storage.local so the background service worker can use it for
// silent token refresh when the popup is closed.
function makeExtensionStorage(): Storage {
  const ls = window.localStorage;
  return {
    get length() { return ls.length; },
    clear() { ls.clear(); },
    getItem: (key) => ls.getItem(key),
    key: (index) => ls.key(index),
    removeItem(key) {
      ls.removeItem(key);
      if (key.includes("RefreshToken")) {
        chrome.storage.local.remove("convexRefreshToken").catch(() => {});
      }
    },
    setItem(key, value) {
      ls.setItem(key, value);
      // @convex-dev/auth stores the refresh token under __convexAuthRefreshToken_<namespace>
      // Mirror it to chrome.storage.local so the background SW can refresh silently
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
