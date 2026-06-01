/**
 * GlideComp Service Worker
 *
 * Handles the Web Share Target API so that IGC / XCTSK files shared from other
 * apps on mobile (Android) are received, cached, and then picked up by the
 * analysis page.
 *
 * Flow:
 *  1. Mobile OS POSTs shared files to /share-target (as configured in the manifest).
 *  2. This service worker intercepts the request, stashes the files in a
 *     dedicated Cache Storage bucket, and redirects to /analysis.html?shared=1.
 *  3. The analysis page detects the query parameter, reads the files from the
 *     cache, processes them, then deletes the cache entries.
 */

const SHARE_CACHE = 'share-target-files';

self.addEventListener('install', () => {
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
 * and redirect to the analysis page.
 */
async function handleShareTarget(request) {
  const formData = await request.formData();
  const files = formData.getAll('files');

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
  for (const file of files) {
    const rawName = typeof file.name === 'string' ? file.name : 'shared-file';
    const safeName = rawName.replace(/[\x00-\x1f\x7f]/g, '') || 'shared-file';
    const response = new Response(file, {
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
        'X-File-Name': safeName,
      },
    });
    await cache.put(`/shared-file/${encodeURIComponent(safeName)}`, response);
  }

  return Response.redirect('/analysis.html?shared=1', 303);
}
