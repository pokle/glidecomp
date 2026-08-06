/**
 * Bounded-concurrency helpers shared across the worker.
 *
 * Lives here rather than in the scorer because it is a general utility: the
 * scoring path, the 3D pack and the cache-warming route all need the same
 * "overlap the R2 latency, but don't hold N decompressed tracklogs at once"
 * behaviour.
 */

/** Map over items with bounded concurrency, preserving input order. Keeps peak
 * memory (decompressed tracklogs) and outbound concurrency in check on a
 * Worker while still overlapping R2 latency across many tracks. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

/** How many tracks to fetch/parse from R2 at once on a cache miss. */
export const TRACK_FETCH_CONCURRENCY = 10;
