export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_idle",
  allFrames: true,
  matchAboutBlank: true,
  world: "MAIN",

  main() {
    const patchedWindow = window as Window & { __TF_XHR_PATCHED__?: boolean };
    if (patchedWindow.__TF_XHR_PATCHED__) return;
    patchedWindow.__TF_XHR_PATCHED__ = true;

    function isSendLike(method: string | null | undefined, url: string): boolean {
      const normalizedMethod = (method ?? "").toUpperCase();
      if (normalizedMethod !== "POST" && normalizedMethod !== "PUT") return false;

      try {
        const path = new URL(url, location.href).pathname.toLowerCase();
        return /send|message|reply|invite|connect|submit|compose/.test(path);
      } catch {
        return false;
      }
    }

    const originalFetch = window.fetch;
    window.fetch = async function (...args) {
      const [input, init] = args;
      const url =
        typeof input === "string"
          ? input
          : input instanceof Request
            ? input.url
            : String(input);
      const method =
        init?.method ?? (input instanceof Request ? input.method : "GET");

      const response = await originalFetch.apply(this, args);
      if (isSendLike(method, url) && response?.ok) {
        window.postMessage(
          { type: "__TF_SEND__", ts: Date.now(), status: response.status },
          "*",
        );
      }
      return response;
    };

    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (
      method: string,
      url: string | URL,
      async?: boolean,
      username?: string | null,
      password?: string | null,
    ) {
      const xhr = this as XMLHttpRequest & {
        __tfMethod?: string;
        __tfUrl?: string;
      };
      const urlStr = String(url);
      // Only track http/https URLs; skip chrome://, file://, etc. to avoid
      // false attribution when other extensions make non-web XHR requests.
      if (/^https?:\/\//i.test(urlStr)) {
        xhr.__tfMethod = method;
        xhr.__tfUrl = urlStr;
      }
      return originalOpen.call(this, method, url, async ?? true, username, password);
    };

    XMLHttpRequest.prototype.send = function (...args) {
      const xhr = this as XMLHttpRequest & {
        __tfMethod?: string;
        __tfUrl?: string;
      };

      if (isSendLike(xhr.__tfMethod, xhr.__tfUrl ?? "")) {
        this.addEventListener(
          "loadend",
          function () {
            if (this.status >= 200 && this.status < 400) {
              window.postMessage(
                { type: "__TF_SEND__", ts: Date.now(), status: this.status },
                "*",
              );
            }
          },
          { once: true },
        );
      }

      return originalSend.apply(this, args);
    };
  },
});
