/**
 * Super-admin-only routes to inspect and clear the KV caches: the score
 * cache in this worker (`glidecomp_scores_cache` — score/compscore/od/pa/
 * 3dvis keys, see `computeScoreCacheKey()` in ../scoring.ts and
 * `compute3dvisCacheKey()` in ../visualization.ts) and the AirScore proxy
 * cache in the airscore-api worker, reached over the AIRSCORE_API service
 * binding. Gated by the same hardcoded allowlist as ../admin.ts.
 */
import { Hono } from "hono";
import type { Env, AuthUser } from "../env";
import { requireAuth } from "../middleware/auth";
import { isSuperAdmin } from "../super-admin";
import { mapWithConcurrency } from "../scoring";

type Variables = { user: AuthUser };
type HonoEnv = { Bindings: Env; Variables: Variables };

type CacheStats = { item_count: number; by_prefix: Record<string, number> };
type NamespaceStats = CacheStats & { name: string };

const SCORE_CACHE_PREFIXES: Array<[string, string]> = [
  ["score:", "Task scores"],
  ["compscore:", "Comp scores"],
  ["od:", "Open-distance analysis"],
  ["pa:", "Pilot analysis"],
  ["3dvis:", "3D replay bundles"],
];

function classifyScoreCacheKey(key: string): string {
  for (const [prefix, label] of SCORE_CACHE_PREFIXES) {
    if (key.startsWith(prefix)) return label;
  }
  return "Other";
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

async function getScoreCacheStats(kv: KVNamespace): Promise<CacheStats> {
  const keys = await listAllKeys(kv);
  const by_prefix: Record<string, number> = {};
  for (const key of keys) {
    const label = classifyScoreCacheKey(key);
    by_prefix[label] = (by_prefix[label] ?? 0) + 1;
  }
  return { item_count: keys.length, by_prefix };
}

async function clearScoreCache(kv: KVNamespace): Promise<number> {
  const keys = await listAllKeys(kv);
  await mapWithConcurrency(keys, 20, (key) => kv.delete(key));
  return keys.length;
}

async function getAirscoreCacheStats(airscoreApi: Fetcher): Promise<CacheStats | null> {
  try {
    const res = await airscoreApi.fetch("https://internal/internal/cache/stats");
    if (!res.ok) return null;
    return (await res.json()) as CacheStats;
  } catch (err) {
    console.error("[cache] failed to fetch airscore cache stats", err);
    return null;
  }
}

async function clearAirscoreCache(airscoreApi: Fetcher): Promise<number> {
  try {
    const res = await airscoreApi.fetch("https://internal/internal/cache/clear", {
      method: "POST",
    });
    if (!res.ok) return 0;
    const data = (await res.json()) as { cleared: number };
    return data.cleared;
  } catch (err) {
    console.error("[cache] failed to clear airscore cache", err);
    return 0;
  }
}

export const cacheRoutes = new Hono<HonoEnv>()
  // ── GET /api/admin/cache/stats ── Item counts across every KV cache,
  // broken down by key prefix within each namespace.
  .get("/api/admin/cache/stats", requireAuth, async (c) => {
    if (!isSuperAdmin(c.var.user)) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const scoreStats = await getScoreCacheStats(c.env.glidecomp_scores_cache);
    const airscoreStats = await getAirscoreCacheStats(c.env.AIRSCORE_API);

    const namespaces: NamespaceStats[] = [
      { name: "Score cache", ...scoreStats },
    ];
    if (airscoreStats) {
      namespaces.push({ name: "AirScore proxy cache", ...airscoreStats });
    }

    const total_items = namespaces.reduce((sum, ns) => sum + ns.item_count, 0);
    return c.json({ total_items, namespaces });
  })

  // ── DELETE /api/admin/cache ── Clear every KV cache entirely.
  .delete("/api/admin/cache", requireAuth, async (c) => {
    if (!isSuperAdmin(c.var.user)) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const scoreCleared = await clearScoreCache(c.env.glidecomp_scores_cache);
    const airscoreCleared = await clearAirscoreCache(c.env.AIRSCORE_API);
    const total = scoreCleared + airscoreCleared;

    // Global action, not tied to a comp — audit_log requires a comp_id (see
    // ../audit.ts), so this is a worker log line rather than a structured
    // audit entry.
    console.log(
      `[admin] ${c.var.user.email} cleared the KV cache: ` +
        `${scoreCleared} score-cache keys, ${airscoreCleared} airscore-cache keys`
    );

    return c.json({
      cleared: total,
      score_cache_cleared: scoreCleared,
      airscore_cache_cleared: airscoreCleared,
    });
  });
