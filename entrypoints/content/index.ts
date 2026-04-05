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

// ── MAIN-world XHR/fetch interceptor ─────────────────────────────────────────
// Injected as an inline <script> so it runs in the page's JS context (MAIN world)
// where chrome.* is unavailable. It posts a __TF_SEND__ window message back to
// the ISOLATED content script whenever a send-like network request fires.
// Signal C in session-observer.ts requires this confirmation before classifying
// a mousedown on a send button as an actual send event.
function injectSendInterceptor() {
  if ((window as any).__TF_XHR_PATCHED__) return;

  const script = document.createElement("script");
  script.textContent = `(function(){
    if(window.__TF_XHR_PATCHED__)return;
    window.__TF_XHR_PATCHED__=true;
    function isSendLike(method,url){
      var m=(method||'').toUpperCase();
      if(m!=='POST'&&m!=='PUT')return false;
      try{
        var path=new URL(url,location.href).pathname.toLowerCase();
        return /send|message|reply|invite|connect|submit|compose/.test(path);
      }catch(e){return false;}
    }
    var origFetch=window.fetch;
    window.fetch=function(input,init){
      var url=typeof input==='string'?input:(input instanceof Request?input.url:String(input));
      var method=(init&&init.method)||(input instanceof Request?input.method:'GET');
      if(isSendLike(method,url))window.postMessage({type:'__TF_SEND__',ts:Date.now()},'*');
      return origFetch.apply(this,arguments);
    };
    var origOpen=XMLHttpRequest.prototype.open;
    var origSend=XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open=function(method,url){
      this.__tfMethod=method;this.__tfUrl=url;
      return origOpen.apply(this,arguments);
    };
    XMLHttpRequest.prototype.send=function(){
      if(isSendLike(this.__tfMethod,this.__tfUrl))
        window.postMessage({type:'__TF_SEND__',ts:Date.now()},'*');
      return origSend.apply(this,arguments);
    };
  })();`;
  (document.head || document.documentElement).appendChild(script);
  script.remove();
}

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_idle",
  allFrames: true,
  matchAboutBlank: true,

  async main(ctx) {
    if (!globalThis.chrome?.runtime?.id) return;

    injectSendInterceptor();

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
