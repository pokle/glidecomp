/**
 * TaskScore Service Worker
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
  for (const file of files) {
    const response = new Response(file, {
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
        'X-File-Name': file.name,
      },
    });
    await cache.put(`/shared-file/${file.name}`, response);
  }

  return Response.redirect('/analysis.html?shared=1', 303);
}
