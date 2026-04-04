// Syncs the Convex JWT to chrome.storage.local so the background SW can use it.
import { useEffect } from "react";
import { useAuthToken } from "@convex-dev/auth/react";
import { useConvexAuth } from "convex/react";

export function TokenBridge() {
  const token = useAuthToken();
  const { isLoading } = useConvexAuth();

  useEffect(() => {
    // Don't touch chrome.storage.local while auth is still initializing —
    // useAuthToken() returns null during loading, which would incorrectly
    // remove the token the background SW needs for in-flight requests.
    if (isLoading) return;
    if (!token) {
      chrome.storage.local.remove("convexToken");
      return;
    }
    chrome.storage.local.set({ convexToken: token });
  }, [token, isLoading]);

  return null;
}
