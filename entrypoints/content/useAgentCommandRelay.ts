import { useEffect } from "react";
import { api } from "../../convex/_generated/api";
import {
  getAgentCommandRelayPollMs,
  shouldRunAgentCommandRelay,
} from "../../src/lib/agent-command-runtime.ts";
import {
  getConvexClient,
  syncConvexAuthFromStorage,
} from "../../src/lib/convex-http.ts";

type RelayContextResponse = {
  tabId: number | null;
  url: string | null;
};

export function useAgentCommandRelay() {
  useEffect(() => {
    if (!shouldRunAgentCommandRelay(window)) {
      return;
    }

    let cancelled = false;
    let pollTimer: number | null = null;
    let pollInFlight = false;
    let relayTabId: number | null = null;
    const inFlightCommandIds = new Set<string>();
    const client = getConvexClient();

    const schedulePoll = () => {
      if (cancelled) return;
      const delayMs = getAgentCommandRelayPollMs(document.hidden);
      pollTimer = window.setTimeout(() => {
        pollTimer = null;
        void poll();
      }, delayMs);
    };

    const ensureRelayContext = async (): Promise<number | null> => {
      if (typeof relayTabId === "number") return relayTabId;
      const response = (await chrome.runtime.sendMessage({
        type: "GET_COMMAND_RELAY_CONTEXT",
      })) as RelayContextResponse | undefined;
      relayTabId = typeof response?.tabId === "number" ? response.tabId : null;
      return relayTabId;
    };

    const poll = async () => {
      if (cancelled || pollInFlight) return;
      pollInFlight = true;
      try {
        const tabId = await ensureRelayContext();
        if (typeof tabId !== "number") return;

        const pendingCommands = await client.query(
          api.agentRuns.listPendingCommandsForTab,
          {
            tabId,
            pageUrl: location.href,
            limit: 10,
          }
        );

        for (const command of pendingCommands) {
          if (cancelled) break;
          const commandId = String(command._id);
          if (inFlightCommandIds.has(commandId)) continue;
          inFlightCommandIds.add(commandId);
          void chrome.runtime
            .sendMessage({
              type: "EXECUTE_BROWSER_COMMAND",
              payload: { commandId },
            })
            .catch(() => {})
            .finally(() => {
              inFlightCommandIds.delete(commandId);
            });
        }
      } catch {
        // Best-effort relay; transient auth or network issues should not affect the page UI.
      } finally {
        pollInFlight = false;
        schedulePoll();
      }
    };

    void syncConvexAuthFromStorage();
    void poll();

    const onVisibilityChange = () => {
      if (pollTimer !== null) {
        window.clearTimeout(pollTimer);
        pollTimer = null;
      }
      void poll();
    };

    const onStorageChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string
    ) => {
      if (areaName !== "local" || !("convexToken" in changes)) return;
      void syncConvexAuthFromStorage();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    chrome.storage.onChanged.addListener(onStorageChanged);

    return () => {
      cancelled = true;
      if (pollTimer !== null) {
        window.clearTimeout(pollTimer);
      }
      document.removeEventListener("visibilitychange", onVisibilityChange);
      try {
        chrome.storage.onChanged.removeListener(onStorageChanged);
      } catch {
        // ignore invalidated context during teardown
      }
    };
  }, []);
}
