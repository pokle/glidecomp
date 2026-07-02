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

  // Store in cache - must await to ensure write completes before next read
  try {
    await kv.put(key, JSON.stringify(data), { expirationTtl: ttlSeconds });
  } catch (err) {
    console.error('Failed to cache data:', err);
  }

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

/** List every key in a KV namespace, paging through `list()` cursors. */
async function listAllKeys(kv: KVNamespace): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ cursor, limit: 1000 });
    keys.push(...page.keys.map((k) => k.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return keys;
}

export type CacheStats = { item_count: number; by_prefix: Record<string, number> };

/** Stats for the admin cache page — item counts, broken down by key prefix. */
export async function getCacheStats(kv: KVNamespace): Promise<CacheStats> {
  const keys = await listAllKeys(kv);
  const by_prefix: Record<string, number> = {};
  for (const key of keys) {
    const label = key.startsWith('airscore:task:')
      ? 'Task results'
      : key.startsWith('airscore:track:')
        ? 'Track files'
        : 'Other';
    by_prefix[label] = (by_prefix[label] ?? 0) + 1;
  }
  return { item_count: keys.length, by_prefix };
}

/** Delete every key in the namespace. Returns the number of keys cleared. */
export async function clearCache(kv: KVNamespace): Promise<number> {
  const keys = await listAllKeys(kv);
  const CONCURRENCY = 20;
  let next = 0;
  async function worker() {
    while (next < keys.length) {
      const key = keys[next++];
      await kv.delete(key);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, keys.length) }, worker)
  );
  return keys.length;
}

