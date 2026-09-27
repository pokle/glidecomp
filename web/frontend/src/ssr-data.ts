/**
 * The SSR Function (functions/comp/[[path]].ts) embeds its loader result as
 * `<script type="application/json" id="__SSR_DATA__">`. A JSON data block is
 * never executed, so the Content-Security-Policy's `script-src 'self'`
 * (public/_headers) has nothing to refuse — an executable
 * `<script>window.__SSR_DATA__=…</script>` would need a per-request nonce.
 *
 * Parsed once and cached; `undefined` when the page was not server-rendered
 * (a classic SPA boot) or outside a browser.
 */
export const SSR_DATA_ID = "__SSR_DATA__";

let cached: { value: unknown } | null = null;

export function readSsrData<T>(): T | undefined {
  if (typeof document === "undefined") return undefined;
  if (!cached) {
    const text = document.getElementById(SSR_DATA_ID)?.textContent;
    let value: unknown = undefined;
    if (text) {
      try {
        value = JSON.parse(text);
      } catch {
        // A malformed block is treated as no block: the client renders fresh.
      }
    }
    cached = { value };
  }
  return cached.value as T | undefined;
}
