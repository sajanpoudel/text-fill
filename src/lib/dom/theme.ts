/**
 * Detects whether the host page is using a dark colour scheme.
 * Uses the body background luminance as the primary signal, falls back
 * to the OS-level prefers-color-scheme media query.
 */
export function isPageDark(): boolean {
  try {
    const bg = window.getComputedStyle(document.body).backgroundColor;
    const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return window.matchMedia("(prefers-color-scheme: dark)").matches;
    const luma = (0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3]) / 255;
    return luma < 0.5;
  } catch {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  }
}
