import { defineConfig } from "wxt";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  browser: "chrome",
  modules: ["@wxt-dev/module-react"],
  vite: () => ({
    plugins: [tailwindcss()],
  }),
  hooks: {
    "build:manifestGenerated"(_wxt, manifest) {
      // Force options page to open in a full tab, not embedded panel
      if (manifest.options_ui) {
        (manifest.options_ui as any).open_in_tab = true;
      }
    },
  },
  manifest: {
    name: "CheatResume - Text Fill",
    version: "2.0.0",
    description:
      "AI-powered writing assistant with persistent memory for emails, messages, forms, and job applications.",
    icons: {
      "16": "logo.png",
      "32": "logo.png",
      "48": "logo.png",
      "128": "logo.png",
    },
    action: {
      default_title: "CheatResume",
      default_icon: {
        "16": "logo.png",
        "32": "logo.png",
        "48": "logo.png",
      },
    },
    web_accessible_resources: [
      {
        resources: ["logo.png"],
        matches: ["<all_urls>"],
      },
    ],
    permissions: [
      "storage",
      "activeTab",
      "alarms",
      "identity",
      "cookies",
      "clipboardWrite",
      "scripting",
      "tabs",
      "webNavigation",
    ],
    host_permissions: [
      "https://*.convex.cloud/*",
      "https://*.convex.site/*",
      "https://api.openai.com/*",
      "https://api.anthropic.com/*",
      "https://generativelanguage.googleapis.com/*",
      "https://www.linkedin.com/*",
      "https://mail.google.com/*",
    ],
  },
});
