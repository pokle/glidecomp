/**
 * GlideComp Service Worker
 *
 * Handles the Web Share Target API so that IGC / XCTSK files shared from other
 * apps on Android (XCTrack, SeeYou Navigator, the Files app) reach the page
 * that wants them. iOS Safari cannot be a share target.
 *
 * Flow:
 *  1. Android POSTs the shared files to /share-target (manifest.webmanifest).
 *     Nothing on the server answers that path — Pages says 405 — so this
 *     worker must be registered before the first share. Both the SPA
 *     (src/react/entry-client.tsx) and the analysis page register it, so it
 *     is in place on whichever page GlideComp was installed from.
 *  2. This worker stashes the files in a dedicated Cache Storage bucket and
 *     redirects:
 *       - ONE file that is not a task -> /submit?shared=1, where the Submit
 *         track form opens with that file already chosen (issue #800). This
 *         is the pilot who has just landed, and /submit works signed out.
 *       - a task (.xctsk) or several files -> /analysis.html?shared=1.
 *  3. The page reads the files from the cache (src/share-target.ts). /submit
 *     empties the bucket once the track is submitted; the next share empties
 *     it too.
 */

const SHARE_CACHE = 'share-target-files';

self.addEventListener('install', (event) => {
  // Every request except the share itself goes straight to the network
  // without waking this worker (the Service Worker static routing API,
  // Chrome 123+). Without it every page load in every tab would start the
  // worker only for it to do nothing. Where the API is missing or refuses a
  // rule, the fetch handler below still lets everything else through.
  try {
    if (event.addRoutes) {
      event.waitUntil(
        event
          .addRoutes([
            { condition: { requestMethod: 'GET' }, source: 'network' },
            { condition: { urlPattern: '/api/*' }, source: 'network' },
          ])
          .catch(() => {})
      );
    }
  } catch {
    // An unsupported condition throws synchronously in some versions.
  }
  // Activate immediately – no assets to pre-cache.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (url.pathname === '/share-target' && event.request.method === 'POST') {
    event.respondWith(handleShareTarget(event.request));
  }

  // All other requests fall through to the network (no offline caching).
});

/**
 * Extract shared files from the POST body, stash them in Cache Storage,
 * and redirect to the page that takes them.
 */
async function handleShareTarget(request) {
  let files = [];
  try {
    const formData = await request.formData();
    files = formData.getAll('files').filter((f) => typeof f === 'object');
  } catch {
    // An unreadable share still opens the submit form, where the pilot can
    // choose the file by hand.
    return Response.redirect('/submit', 303);
  }

  const cache = await caches.open(SHARE_CACHE);

  // Clear any leftover shared files from a previous share.
  const existingKeys = await cache.keys();
  for (const key of existingKeys) {
    await cache.delete(key);
  }

  // Store each shared file as a cached response keyed by filename.
  // SEC-13: file.name comes from another app on the device via the Web Share
  // Target API. Strip CR/LF and other control chars before putting it in a
  // response header (would otherwise break header parsing), and URL-encode
  // the cache key so names with `?`, `#`, `..`, etc. round-trip safely.
  const names = [];
  for (const file of files) {
    const rawName = typeof file.name === 'string' ? file.name : 'shared-file';
    const safeName = rawName.replace(/[\x00-\x1f\x7f]/g, '') || 'shared-file';
    names.push(safeName);
    const response = new Response(file, {
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
        'X-File-Name': safeName,
      },
    });
    await cache.put(`/shared-file/${encodeURIComponent(safeName)}`, response);
  }

  return Response.redirect(shareDestination(names), 303);
}

/**
 * Where a share goes, by what it carries. One track is a submission; a task
 * or a handful of tracks is something to look at. A single file with some
 * other name still goes to /submit: the form says plainly when a file is not
 * an IGC, and the pilot can choose another there.
 */
function shareDestination(names) {
  if (names.length === 0) return '/submit';
  if (names.length === 1 && !names[0].toLowerCase().endsWith('.xctsk')) {
    return '/submit?shared=1';
  }
  return '/analysis.html?shared=1';
}
