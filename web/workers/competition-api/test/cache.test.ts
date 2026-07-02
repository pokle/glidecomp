import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { request } from "./helpers";

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

beforeEach(clearKv);

describe("GET /api/admin/cache/stats", () => {
  test("requires authentication", async () => {
    const res = await request("GET", "/api/admin/cache/stats");
    expect(res.status).toBe(401);
  });

  test("is forbidden for a plain authenticated user", async () => {
    const res = await request("GET", "/api/admin/cache/stats", { user: "user-1" });
    expect(res.status).toBe(403);
  });

  test("reports item counts by prefix, merged with the airscore cache", async () => {
    await env.glidecomp_scores_cache.put("score:v5:t1:abc", "{}");
    await env.glidecomp_scores_cache.put("score:v5:t2:def", "{}");
    await env.glidecomp_scores_cache.put("compscore:v2:c1:ghi", "{}");
    await env.glidecomp_scores_cache.put("od:v1:hash:tt1:2026", "{}");
    await env.glidecomp_scores_cache.put("3dvis:v1:t1:jkl", "abc");

    const res = await request("GET", "/api/admin/cache/stats", { user: "user-super" });
    expect(res.status).toBe(200);
    const data = (await res.json()) as CacheStatsResponse;

    const scoreNs = data.namespaces.find((ns) => ns.name === "Score cache")!;
    expect(scoreNs.item_count).toBe(5);
    expect(scoreNs.by_prefix).toEqual({
      "Task scores": 2,
      "Comp scores": 1,
      "Open-distance analysis": 1,
      "3D replay bundles": 1,
    });

    const airscoreNs = data.namespaces.find((ns) => ns.name === "AirScore proxy cache")!;
    expect(airscoreNs.item_count).toBe(3);

    expect(data.total_items).toBe(scoreNs.item_count + airscoreNs.item_count);
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

  test("deletes every key in the score cache and reports counts", async () => {
    await env.glidecomp_scores_cache.put("score:v5:t1:abc", "{}");
    await env.glidecomp_scores_cache.put("pa:v1:hash:tt1:2026", "{}");

    const res = await request("DELETE", "/api/admin/cache", { user: "user-super" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      cleared: 5,
      score_cache_cleared: 2,
      airscore_cache_cleared: 3,
    });

    const remaining = await env.glidecomp_scores_cache.list();
    expect(remaining.keys).toHaveLength(0);
  });
});
