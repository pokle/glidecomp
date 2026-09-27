/**
 * Recovering a tab that outlived a deploy.
 *
 * Every build names its code-split chunks by content hash
 * (`Dashboard-a1b2c3.js`), and a Cloudflare Pages deploy replaces the previous
 * one outright. A tab opened before a deploy is still running the old app, and
 * the first time it asks for a page it has not loaded yet — any `lazy()` route
 * in routes.tsx — it asks for a file that no longer exists. The import
 * rejects, and before AppErrorBoundary that left a blank page until the reader
 * thought to reload.
 *
 * A reload is the whole fix: it fetches the new app, whose chunk names match
 * the deployment. So it is done for the reader, once. A timestamp in
 * sessionStorage stops a loop — if the chunk is still missing straight after
 * a reload, reloading again will not help, and the error screen is shown
 * instead.
 *
 * No `window` at module scope: routes.tsx imports the error boundary, which
 * imports this, and routes.tsx runs server-side for the SSR comp pages.
 */

const RELOADED_AT_KEY = "glidecomp:stale-deploy-reload";

/** A second failure within this long of the last reload is not a stale tab. */
const RELOAD_GUARD_MS = 30_000;

/**
 * The browsers' own words for a dynamic import or CSS preload that failed.
 * Chrome: "Failed to fetch dynamically imported module: …". Firefox: "error
 * loading dynamically imported module: …". Safari: "Importing a module script
 * failed." Vite's CSS preload: "Unable to preload CSS for …".
 */
const CHUNK_ERROR =
  /dynamically imported module|Importing a module script failed|Unable to preload CSS/i;

export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return CHUNK_ERROR.test(message);
}

/**
 * Reload the page to pick up the new deploy, unless that was already tried in
 * the last RELOAD_GUARD_MS. Returns whether it reloaded. Without
 * sessionStorage (blocked, private mode) there is no loop guard, so it does
 * not reload, and the caller shows the error screen instead.
 */
export function reloadForNewDeploy(
  reload: () => void = () => window.location.reload()
): boolean {
  if (typeof window === "undefined") return false;
  try {
    const last = Number(window.sessionStorage.getItem(RELOADED_AT_KEY));
    if (Number.isFinite(last) && Date.now() - last < RELOAD_GUARD_MS) return false;
    window.sessionStorage.setItem(RELOADED_AT_KEY, String(Date.now()));
  } catch {
    return false;
  }
  reload();
  return true;
}

/**
 * Catch a failed chunk load at its source. Vite dispatches `vite:preloadError`
 * on window when a dynamic import or its CSS fails, and cancelling the event
 * stops it throwing. When the reload is not attempted, the event is left alone
 * and the error reaches AppErrorBoundary. Call once, from a client entry.
 */
export function installStaleDeployReload(): void {
  window.addEventListener("vite:preloadError", (event) => {
    if (reloadForNewDeploy()) event.preventDefault();
  });
}
