/**
 * Caching utilities for AirScore API responses
 */

/**
 * Get cached data or fetch fresh data from the provided fetcher function.
 * Results are stored in KV with the specified TTL.
 */
export async function getCachedOrFetch<T>(
  kv: KVNamespace,
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<T>
): Promise<{ data: T; cached: boolean }> {
  // Try cache first
  const cached = await kv.get(key, 'json');
  if (cached !== null) {
    return { data: cached as T, cached: true };
  }

  // Fetch fresh data
  const data = await fetcher();

  // Store in cache (fire and forget - don't block on this)
  // Using waitUntil would be better but we don't have ctx here
  kv.put(key, JSON.stringify(data), { expirationTtl: ttlSeconds }).catch((err) => {
    console.error('Failed to cache data:', err);
  });

  return { data, cached: false };
}

/**
 * Generate cache key for task results
 */
export function taskCacheKey(comPk: number, tasPk: number): string {
  return `airscore:task:${comPk}:${tasPk}`;
}

/**
 * Generate cache key for track files
 */
export function trackCacheKey(trackId: string): string {
  return `airscore:track:${trackId}`;
}

/**
 * Invalidate cached data for a specific key
 */
export async function invalidateCache(kv: KVNamespace, key: string): Promise<void> {
  await kv.delete(key);
}
