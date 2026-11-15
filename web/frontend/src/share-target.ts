/**
 * Files shared to the installed GlideComp app (the Web Share Target API,
 * Android only — iOS Safari cannot be a share target).
 *
 * The manifest (`public/manifest.webmanifest`) names `/share-target` as where
 * a share is POSTed. Nothing on the server answers that path: the service
 * worker (`public/sw.js`) catches the POST, stashes the files in the Cache
 * Storage bucket below and redirects to the page that wants them —
 *
 * - `/submit?shared=1` for ONE file that is not a task: the pilot who has
 *   just landed and shared their track from XCTrack or SeeYou (issue #800);
 * - `/analysis.html?shared=1` for a task (`.xctsk`) or several files.
 *
 * Both pages read the bucket through `readSharedFiles()`. The bucket outlives
 * the page that reads it, so a reload of `/submit?shared=1` finds the file
 * again; it is emptied once the track is submitted (`clearSharedFiles()`) and
 * by the service worker before every new share.
 *
 * Kept free of DOM and React so the vanilla analysis page and the SPA share
 * it, and so it is unit-testable against a fake CacheStorage.
 */

/** The Cache Storage bucket `public/sw.js` writes shared files into. */
export const SHARE_CACHE = "share-target-files";

/** The `?shared=1` marker the service worker's redirect carries. */
export const SHARED_PARAM = "shared";

/**
 * The files the last share stashed, in the order they were shared. Empty when
 * there are none, when Cache Storage is unavailable (a private window, an old
 * browser), or when reading fails: a missing share is never worth an error a
 * pilot has to dismiss before choosing their file by hand.
 */
export async function readSharedFiles(
  storage: CacheStorage | undefined = globalThis.caches
): Promise<File[]> {
  if (!storage) return [];
  try {
    if (!(await storage.has(SHARE_CACHE))) return [];
    const cache = await storage.open(SHARE_CACHE);
    const files: File[] = [];
    for (const request of await cache.keys()) {
      const response = await cache.match(request);
      if (!response) continue;
      const blob = await response.blob();
      files.push(
        new File([blob], sharedFileName(request.url, response.headers), { type: blob.type })
      );
    }
    return files;
  } catch {
    return [];
  }
}

/** Forget the last share, once what it carried has been dealt with. */
export async function clearSharedFiles(
  storage: CacheStorage | undefined = globalThis.caches
): Promise<void> {
  try {
    await storage?.delete(SHARE_CACHE);
  } catch {
    // Nothing to do: the service worker empties the bucket before every share.
  }
}

/**
 * The file's own name. `X-File-Name` (set by sw.js) is the primary source;
 * the cache key's last segment is the fallback, URL-decoded because the
 * service worker encodes it (SEC-13: the name comes from another app).
 */
export function sharedFileName(url: string, headers: Headers): string {
  const fromHeader = headers.get("X-File-Name");
  if (fromHeader) return fromHeader;
  const tail = new URL(url).pathname.split("/").pop() || "shared-file";
  try {
    return decodeURIComponent(tail);
  } catch {
    return tail;
  }
}
