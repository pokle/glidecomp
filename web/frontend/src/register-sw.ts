/**
 * Register `public/sw.js`, the service worker that receives files shared to
 * the installed app (see src/share-target.ts).
 *
 * Called from every page that links the manifest — the SPA
 * (src/react/entry-client.tsx) and the analysis page — because Android POSTs a
 * share to `/share-target` and only this worker answers that path. Until #800
 * only the analysis page registered it, so a pilot who installed GlideComp
 * from a comp page and shared a track before ever opening the app got Pages'
 * 405.
 *
 * Browser-only: call it from a client entry, never at module scope of
 * anything the SSR bundle imports.
 */
export function registerServiceWorker(): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  const register = () => {
    navigator.serviceWorker.register("/sw.js").catch((err: unknown) => {
      console.warn("Service worker registration failed:", err);
    });
  };
  // After load, so the worker's first fetch never competes with the page's.
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });
}
