import { createRoot } from "react-dom/client";
import { createElement, Component, type ReactNode } from "react";
import { ContentApp, markContextInvalidated } from "./App.tsx";

function isInvalidatedError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return msg.includes("Extension context invalidated");
}

class RootBoundary extends Component<{ children: ReactNode }, { dead: boolean }> {
  state = { dead: false };
  static getDerivedStateFromError(): { dead: boolean } { return { dead: true }; }
  componentDidCatch(error: unknown) {
    if (!isInvalidatedError(error)) console.error("[TextFill] root crashed, unmounting UI", error);
  }
  render(): ReactNode { return this.state.dead ? null : this.props.children; }
}

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_idle",
  allFrames: true,
  matchAboutBlank: true,

  async main(ctx) {
    if (!globalThis.chrome?.runtime?.id) return;

    const ensureBody = async () => {
      if (document.body) return document.body;
      await new Promise<void>((resolve) => {
        if (document.readyState === "loading") {
          document.addEventListener("DOMContentLoaded", () => resolve(), {
            once: true,
          });
        } else {
          requestAnimationFrame(() => resolve());
        }
      });
      return document.body ?? document.documentElement;
    };

    const parent = await ensureBody();
    if (!parent) return;

    const host = document.createElement("div");
    host.id = "text-fill-root";
    host.setAttribute("data-tfa-ui", "root");
    host.style.position = "fixed";
    host.style.top = "0";
    host.style.left = "0";
    host.style.width = "0";
    host.style.height = "0";
    host.style.overflow = "visible";
    host.style.zIndex = "2147483646";
    host.style.pointerEvents = "auto";
    host.style.background = "transparent";

    parent.appendChild(host);

    // Keep our root as the last child of body so it always paints above
    // site-injected modals/dialogs (e.g. LinkedIn connect/InMail overlays)
    // that get appended to document.body after us.
    const topObserver = new MutationObserver(() => {
      if (host.isConnected && parent.lastChild !== host) {
        parent.appendChild(host);
      }
    });
    topObserver.observe(parent, { childList: true });

    const root = createRoot(host);
    root.render(createElement(RootBoundary, null, createElement(ContentApp)));

    ctx.onInvalidated(() => {
      topObserver.disconnect();
      markContextInvalidated();   // stop all renders immediately
      try { root.unmount(); } catch { /* already unmounted */ }
      host.remove();
    });
  },
});
