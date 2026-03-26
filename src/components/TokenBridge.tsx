// Syncs the Convex JWT to chrome.storage.local so the background SW can use it.
import { useEffect } from "react";
import { useAuthToken } from "@convex-dev/auth/react";

export function TokenBridge() {
  const token = useAuthToken();

  useEffect(() => {
    if (!token) {
      chrome.storage.local.remove("convexToken");
      return;
    }
    chrome.storage.local.set({ convexToken: token });
  }, [token]);

  return null;
}
