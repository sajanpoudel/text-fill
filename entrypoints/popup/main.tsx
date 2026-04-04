import { createRoot } from "react-dom/client";
import "../../src/styles/globals.css";
import { App } from "./App";
import { initExtensionStorage } from "../../src/components/AppProviders";

// Pre-seed the auth storage cache from chrome.storage.local before mounting.
// This restores the session even if localStorage was cleared (e.g. browser data wipe).
initExtensionStorage().then(() => {
  createRoot(document.getElementById("root")!).render(<App />);
});
