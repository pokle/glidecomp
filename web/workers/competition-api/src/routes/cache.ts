/**
 * Super-admin-only routes to inspect and reset the derived stores: the
 * materialized scores in D1 (`task_scores` + `track_analysis`, see
 * ../score-store.ts), the search index (`search_doc`, see ../search-index.ts),
 * the KV namespace (`glidecomp_scores_cache` — now only 3dvis replay bundles
 * plus any legacy score keys from the pre-D1 design), and the AirScore proxy
 * cache in the airscore-api worker, reached over the AIRSCORE_API service
 * binding. Gated by the same hardcoded allowlist as ../admin.ts.
 *
 * "Clear" marks every task_scores row stale (inputs_rev + 1) so organic
 * traffic recomputes in the background — nothing goes slow. Pass ?hard=true
 * to also drop the materialized rows and per-track analyses entirely,
 * forcing full recomputes from R2 (the recovery lever for a suspected bad
 * blob or analysis).
 */
import { Hono } from "hono";
import { SCORING_ENGINE_VERSION } from "@glidecomp/engine";
import type { Env, AuthUser } from "../env";
import { requireAuth } from "../middleware/auth";
import { isSuperAdmin } from "../super-admin";
import { mapWithConcurrency } from "../scoring";
import {
  drainSearchIndex,
  reindexAllSearchDocs,
  searchIndexStats,
} from "../search-index";

type Variables = { user: AuthUser };
type HonoEnv = { Bindings: Env; Variables: Variables };

type CacheStats = { item_count: number; by_prefix: Record<string, number> };
type NamespaceStats = CacheStats & { name: string };

/** Reindex passes one admin request will wait for (40 documents each). A pass
 *  is five small queries — 1000 documents measured at well under a second
 *  against the seeded archive — so this is generous while staying far inside
 *  the Worker's CPU ceiling. The rest is left queued. */
const REINDEX_PASSES_PER_REQUEST = 100;

const SCORE_CACHE_PREFIXES: Array<[string, string]> = [
  ["3dvis:", "3D replay bundles"],
  ["score:", "Task scores (legacy)"],
  ["compscore:", "Comp scores (legacy)"],
  ["od:", "Open-distance analysis (legacy)"],
  ["pa:", "Pilot analysis (legacy)"],
  ["pd:", "Pilot detail (legacy)"],
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

async function getKvCacheStats(kv: KVNamespace): Promise<CacheStats> {
  const keys = await listAllKeys(kv);
  const by_prefix: Record<string, number> = {};
  for (const key of keys) {
    const label = classifyScoreCacheKey(key);
    by_prefix[label] = (by_prefix[label] ?? 0) + 1;
  }
  return { item_count: keys.length, by_prefix };
}

async function clearKvCache(kv: KVNamespace): Promise<number> {
  const keys = await listAllKeys(kv);
  await mapWithConcurrency(keys, 20, (key) => kv.delete(key));
  return keys.length;
}

/** Materialized-score row counts, split by freshness. Stale means newer
 * inputs (or a newer scoring engine) exist and a recompute is pending. */
async function getScoreStoreStats(db: D1Database): Promise<CacheStats> {
  const counts = await db
    .prepare(
      `SELECT
         SUM(CASE WHEN computed_rev >= 0 AND computed_rev = inputs_rev
                   AND engine_version = ?1 THEN 1 ELSE 0 END) AS fresh,
         SUM(CASE WHEN computed_rev >= 0 AND (computed_rev < inputs_rev
                   OR engine_version != ?1) THEN 1 ELSE 0 END) AS stale,
         SUM(CASE WHEN computed_rev < 0 THEN 1 ELSE 0 END) AS pending
       FROM task_scores`
    )
    .bind(SCORING_ENGINE_VERSION)
    .first<{ fresh: number | null; stale: number | null; pending: number | null }>();

  const analyses = await db
    .prepare(
      `SELECT variant, COUNT(*) AS cnt FROM track_analysis GROUP BY variant`
    )
    .all<{ variant: string; cnt: number }>();

  const by_prefix: Record<string, number> = {};
  if (counts?.fresh) by_prefix["Task scores (fresh)"] = counts.fresh;
  if (counts?.stale) by_prefix["Task scores (stale)"] = counts.stale;
  if (counts?.pending) by_prefix["Task scores (awaiting first compute)"] = counts.pending;
  const variantLabels: Record<string, string> = {
    gap: "Track analyses (GAP)",
    od: "Track analyses (open distance)",
    "pilot-detail": "Track analyses (pilot detail)",
    quality: "Track analyses (data quality)",
  };
  for (const row of analyses.results) {
    by_prefix[variantLabels[row.variant] ?? `Track analyses (${row.variant})`] =
      row.cnt;
  }
  const item_count = Object.values(by_prefix).reduce((sum, n) => sum + n, 0);
  return { item_count, by_prefix };
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
  // ── GET /api/admin/cache/stats ── Row/item counts across the score stores,
  // broken down within each store.
  .get("/api/admin/cache/stats", requireAuth, async (c) => {
    if (!isSuperAdmin(c.var.user)) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const scoreStoreStats = await getScoreStoreStats(c.env.DB);
    const searchStats = await searchIndexStats(c.env.DB);
    const kvStats = await getKvCacheStats(c.env.glidecomp_scores_cache);
    const airscoreStats = await getAirscoreCacheStats(c.env.AIRSCORE_API);

    const namespaces: NamespaceStats[] = [
      { name: "Materialized scores (D1)", ...scoreStoreStats },
      { name: "Search index (D1)", ...searchStats },
      { name: "Score cache (KV)", ...kvStats },
    ];
    if (airscoreStats) {
      namespaces.push({ name: "AirScore proxy cache", ...airscoreStats });
    }

    const total_items = namespaces.reduce((sum, ns) => sum + ns.item_count, 0);
    return c.json({ total_items, namespaces });
  })

  // ── DELETE /api/admin/cache ── Re-score everything / reset the caches.
  // Default: mark every materialized score stale (recomputes happen in the
  // background off organic traffic) and clear the KV + AirScore caches.
  // ?hard=true additionally deletes the task_scores rows and every stored
  // per-track analysis, so the next visit recomputes from R2 from scratch.
  .delete("/api/admin/cache", requireAuth, async (c) => {
    if (!isSuperAdmin(c.var.user)) {
      return c.json({ error: "Forbidden" }, 403);
    }
    const hard = c.req.query("hard") === "true";

    let scoresMarkedStale = 0;
    let scoresDeleted = 0;
    let analysesDeleted = 0;
    if (hard) {
      const [scores, analyses] = await c.env.DB.batch([
        c.env.DB.prepare("DELETE FROM task_scores"),
        c.env.DB.prepare("DELETE FROM track_analysis"),
      ]);
      scoresDeleted = scores.meta.changes ?? 0;
      analysesDeleted = analyses.meta.changes ?? 0;
    } else {
      const res = await c.env.DB.prepare(
        "UPDATE task_scores SET inputs_rev = inputs_rev + 1"
      ).run();
      scoresMarkedStale = res.meta.changes ?? 0;
    }

    const kvCleared = await clearKvCache(c.env.glidecomp_scores_cache);
    const airscoreCleared = await clearAirscoreCache(c.env.AIRSCORE_API);
    const total =
      scoresMarkedStale + scoresDeleted + analysesDeleted + kvCleared + airscoreCleared;

    // Global action, not tied to a comp — audit_log requires a comp_id (see
    // ../audit.ts), so this is a worker log line rather than a structured
    // audit entry.
    console.log(
      `[admin] ${c.var.user.email} reset the score caches (${hard ? "hard" : "mark-stale"}): ` +
        `${scoresMarkedStale} scores marked stale, ${scoresDeleted} score rows deleted, ` +
        `${analysesDeleted} track analyses deleted, ${kvCleared} KV keys, ` +
        `${airscoreCleared} airscore-cache keys`
    );

    return c.json({
      cleared: total,
      scores_marked_stale: scoresMarkedStale,
      scores_deleted: scoresDeleted,
      track_analyses_deleted: analysesDeleted,
      score_cache_cleared: kvCleared,
      airscore_cache_cleared: airscoreCleared,
    });
  })

  // ── POST /api/admin/search/reindex ── Rebuild every search document.
  //
  // The lever for "search is wrong and I don't know why". The nightly sweep
  // only reindexes documents that LOOK out of date (missing, or behind the
  // document-builder revision); this asks no questions.
  //
  // A database with more documents than one request should rebuild does not
  // finish in one call, so the caller repeats with `?resume=true` — which
  // drains what is already queued WITHOUT queueing everything again. Without
  // that distinction a repeat call re-queues the whole database each time and
  // `remaining` never reaches zero: it re-adds more than the call can drain.
  // (Whatever is still queued when the admin stops asking is picked up by the
  // hourly cron regardless.)
  .post("/api/admin/search/reindex", requireAuth, async (c) => {
    if (!isSuperAdmin(c.var.user)) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const resume = c.req.query("resume") === "true";
    const queued = resume ? 0 : await reindexAllSearchDocs(c.env.DB);
    const rebuilt = await drainSearchIndex(c.env.DB, REINDEX_PASSES_PER_REQUEST);
    const left = await c.env.DB.prepare(
      "SELECT COUNT(*) AS cnt FROM search_dirty"
    ).first<{ cnt: number }>();
    const remaining = left?.cnt ?? 0;

    console.log(
      `[admin] ${c.var.user.email} rebuilt the search index` +
        `${resume ? " (resumed)" : ""}: ${queued} documents queued, ` +
        `${rebuilt} rebuilt, ${remaining} left for the cron`
    );

    return c.json({ queued, rebuilt, remaining });
  });
