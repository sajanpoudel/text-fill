// ConvexHttpClient instance for the background service worker.
// The reactive ConvexReactClient is only used in popup/options/memory pages.
import { ConvexHttpClient } from "convex/browser";

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
