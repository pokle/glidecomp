import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { clearCompData, createComp, createTask, request } from "./helpers";
import { decodeId } from "../src/sqids";

interface CacheStatsResponse {
  total_items: number;
  namespaces: Array<{
    name: string;
    item_count: number;
    by_prefix: Record<string, number>;
  }>;
}

async function clearKv(): Promise<void> {
  const { keys } = await env.glidecomp_scores_cache.list();
  await Promise.all(keys.map((k) => env.glidecomp_scores_cache.delete(k.name)));
}

beforeEach(async () => {
  await clearKv();
  await clearCompData();
});

/** Create a comp + task and seed its task_scores row directly. */
async function seedScoreRow(overrides: {
  inputs_rev?: number;
  computed_rev?: number;
  engine_version?: number;
} = {}): Promise<number> {
  const compId = await createComp();
  const taskId = decodeId(
    env.SQIDS_ALPHABET,
    await createTask(compId, { xctsk: JSON.parse(env.SAMPLE_TASK_XCTSK) })
  )!;
  await env.DB.prepare(
    `INSERT INTO task_scores (task_id, response_json, state_key, computed_at,
       engine_version, inputs_rev, computed_rev, revalidating_until)
     VALUES (?, '{}', 'key', '2026-01-01T00:00:00Z', ?, ?, ?, '')
     ON CONFLICT(task_id) DO UPDATE SET
       engine_version = excluded.engine_version,
       inputs_rev = excluded.inputs_rev,
       computed_rev = excluded.computed_rev`
  )
    .bind(
      taskId,
      overrides.engine_version ?? 2,
      overrides.inputs_rev ?? 0,
      overrides.computed_rev ?? 0
    )
    .run();
  return taskId;
}

describe("GET /api/admin/cache/stats", () => {
  test("requires authentication", async () => {
    const res = await request("GET", "/api/admin/cache/stats");
    expect(res.status).toBe(401);
  });

  test("is forbidden for a plain authenticated user", async () => {
    const res = await request("GET", "/api/admin/cache/stats", { user: "user-1" });
    expect(res.status).toBe(403);
  });

  test("reports D1 score-store counts, KV keys, and the airscore cache", async () => {
    // A stale row (creating a task with a route also materializes a row in
    // the background, so score-store counts are asserted as lower bounds).
    const staleTaskId = await seedScoreRow({ inputs_rev: 3, computed_rev: 2 });
    await env.glidecomp_scores_cache.put("3dvis:v1:t1:jkl", "abc");
    await env.glidecomp_scores_cache.put("score:v5:t1:abc", "{}");

    const res = await request("GET", "/api/admin/cache/stats", { user: "user-super" });
    expect(res.status).toBe(200);
    const data = (await res.json()) as CacheStatsResponse;

    const scoreStore = data.namespaces.find(
      (ns) => ns.name === "Materialized scores (D1)"
    )!;
    expect(scoreStore.by_prefix["Task scores (stale)"]).toBeGreaterThanOrEqual(1);
    expect(scoreStore.item_count).toBeGreaterThanOrEqual(1);

    const kvNs = data.namespaces.find((ns) => ns.name === "Score cache (KV)")!;
    expect(kvNs.item_count).toBe(2);
    expect(kvNs.by_prefix).toEqual({
      "3D replay bundles": 1,
      "Task scores (legacy)": 1,
    });

    const airscoreNs = data.namespaces.find(
      (ns) => ns.name === "AirScore proxy cache"
    )!;
    expect(airscoreNs.item_count).toBe(3);

    expect(data.total_items).toBe(
      scoreStore.item_count + kvNs.item_count + airscoreNs.item_count
    );
    // Sanity: the stale row we seeded is the one counted.
    const row = await env.DB.prepare(
      "SELECT inputs_rev, computed_rev FROM task_scores WHERE task_id = ?"
    )
      .bind(staleTaskId)
      .first<{ inputs_rev: number; computed_rev: number }>();
    expect(row!.computed_rev).toBeLessThan(row!.inputs_rev);
  });
});

describe("DELETE /api/admin/cache", () => {
  test("requires authentication", async () => {
    const res = await request("DELETE", "/api/admin/cache");
    expect(res.status).toBe(401);
  });

  test("is forbidden for a plain authenticated user", async () => {
    const res = await request("DELETE", "/api/admin/cache", { user: "user-1" });
    expect(res.status).toBe(403);
  });

  test("marks every stored score stale and clears the KV cache", async () => {
    const taskId = await seedScoreRow({ inputs_rev: 5, computed_rev: 5 });
    await env.glidecomp_scores_cache.put("3dvis:v1:t1:abc", "x");
    await env.glidecomp_scores_cache.put("pa:v1:hash:tt1:2026", "{}");

    const res = await request("DELETE", "/api/admin/cache", { user: "user-super" });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      cleared: number;
      scores_marked_stale: number;
      scores_deleted: number;
      score_cache_cleared: number;
      airscore_cache_cleared: number;
    };

    expect(data.scores_marked_stale).toBeGreaterThanOrEqual(1);
    expect(data.scores_deleted).toBe(0);
    expect(data.score_cache_cleared).toBe(2);
    expect(data.airscore_cache_cleared).toBe(3);
    expect(data.cleared).toBeGreaterThanOrEqual(6);

    // The row survives, marked stale — the blob keeps serving instantly
    // while background revalidation recomputes it.
    const row = await env.DB.prepare(
      "SELECT inputs_rev, computed_rev FROM task_scores WHERE task_id = ?"
    )
      .bind(taskId)
      .first<{ inputs_rev: number; computed_rev: number }>();
    expect(row).not.toBeNull();
    expect(row!.inputs_rev).toBe(6);
    expect(row!.computed_rev).toBe(5);

    const remaining = await env.glidecomp_scores_cache.list();
    expect(remaining.keys).toHaveLength(0);
  });

  test("?hard=true drops the materialized rows entirely", async () => {
    const taskId = await seedScoreRow();

    const res = await request("DELETE", "/api/admin/cache?hard=true", {
      user: "user-super",
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      scores_deleted: number;
      scores_marked_stale: number;
    };
    expect(data.scores_deleted).toBeGreaterThanOrEqual(1);
    expect(data.scores_marked_stale).toBe(0);

    const row = await env.DB.prepare(
      "SELECT task_id FROM task_scores WHERE task_id = ?"
    )
      .bind(taskId)
      .first();
    expect(row).toBeNull();
  });
});
