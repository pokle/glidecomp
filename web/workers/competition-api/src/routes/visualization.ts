// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

import { Hono } from "hono";
import type { AuthedEnv, Env } from "../env";
import { sqidsMiddleware } from "../middleware/sqids";
import { optionalAuth } from "../middleware/auth";
import { isCompAdmin } from "../super-admin";
import { SAMPLE_COMP_NAME } from "../sample";
import { buildTask3dvisBundle, compute3dvisCacheKey } from "../visualization";

/**
 * These bundles are multi-megabyte (the bundled sample is ~3 MB), so the
 * expensive thing is re-sending one that hasn't changed.
 *
 * The URL is stable but the content is not — upload a track and the same URL
 * must answer differently — so a long max-age would serve a stale replay
 * through a live comp. The cache key already content-addresses the bundle, so
 * it makes a perfect ETag: a repeat view revalidates and gets a ~200-byte 304
 * instead of megabytes. That is the win; max-age stays short so freshness is
 * unchanged, and stale-while-revalidate keeps the revalidation off the
 * critical path.
 *
 * A signed-in viewer's bundle is `private`: the same URL answers differently
 * for an admin (a hidden `test` comp's bundle) than for everyone else (404),
 * so a shared cache holding the admin's copy would serve it to callers the
 * route itself would refuse — the same rule as the score route's
 * cacheControl(). `private` still lets the viewer's own browser cache and
 * revalidate, so the ETag saving is kept.
 */
export function bundleHeaders(cacheKey: string, signedIn: boolean) {
  return {
    "Content-Type": "application/octet-stream",
    "Cache-Control": `${signedIn ? "private" : "public"}, max-age=300, stale-while-revalidate=86400`,
    ETag: `"${cacheKey}"`,
  };
}

/**
 * Produce (or serve from KV) the 3D-replay bundle for a task. Shared by the
 * id-addressed and the sample routes.
 *
 * `body` is null when the caller's If-None-Match already matches: the bundle
 * is then never read out of KV at all, so a 304 costs one D1 key computation
 * rather than a multi-megabyte KV read.
 */
async function serve3dvis(
  env: Env,
  taskId: number,
  ifNoneMatch?: string | null
): Promise<{ body: ArrayBuffer | null; cache: "HIT" | "MISS" | "304"; cacheKey: string }> {
  const t0 = performance.now();
  const cacheKey = await compute3dvisCacheKey(taskId, env.DB);
  if (ifNoneMatch && etagMatches(ifNoneMatch, cacheKey)) {
    console.log(`[3dvis] task ${taskId}: not modified (${cacheKey})`);
    return { body: null, cache: "304", cacheKey };
  }
  const cached = await env.glidecomp_scores_cache.get(cacheKey, "arrayBuffer");
  if (cached) {
    console.log(
      `[3dvis] task ${taskId}: cache HIT (${cacheKey}, ${cached.byteLength}B) ` +
        `in ${(performance.now() - t0).toFixed(0)}ms`
    );
    return { body: cached, cache: "HIT", cacheKey };
  }
  console.log(`[3dvis] task ${taskId}: cache MISS (${cacheKey}) — building bundle`);

  const bundle = await buildTask3dvisBundle(taskId, env.DB, env.R2);
  const body = bundle.buffer.slice(
    bundle.byteOffset,
    bundle.byteOffset + bundle.byteLength
  ) as ArrayBuffer;
  const tPutStart = performance.now();
  await env.glidecomp_scores_cache.put(cacheKey, body, { expirationTtl: 604800 });
  console.log(
    `[3dvis] task ${taskId}: cached bundle (${(performance.now() - tPutStart).toFixed(0)}ms KV put) — ` +
      `total serve time ${(performance.now() - t0).toFixed(0)}ms`
  );
  return { body, cache: "MISS", cacheKey };
}

/**
 * Does an If-None-Match header cover this key? Handles the comma-separated
 * list, the `W/` weak prefix a proxy may add, and `*`.
 */
function etagMatches(ifNoneMatch: string, cacheKey: string): boolean {
  const mine = `"${cacheKey}"`;
  return ifNoneMatch
    .split(",")
    .map((t) => t.trim().replace(/^W\//, ""))
    .some((t) => t === mine || t === "*");
}

export const visualizationRoutes = new Hono<AuthedEnv>()

  // ── GET /api/comp/sample-3dvis ── the public sample, resolved by name so the
  // sample page needs no environment-specific ids. Registered before the param
  // route so "sample-3dvis" is never decoded as a comp id.
  .get("/api/comp/sample-3dvis", async (c) => {
    const comp = await c.env.DB.prepare(
      "SELECT comp_id FROM comp WHERE name = ? AND test = 0 ORDER BY comp_id LIMIT 1"
    )
      .bind(SAMPLE_COMP_NAME)
      .first<{ comp_id: number }>();
    if (!comp) return c.json({ error: "Sample competition not seeded" }, 404);

    const task = await c.env.DB.prepare(
      "SELECT task_id FROM task WHERE comp_id = ? AND xctsk IS NOT NULL ORDER BY task_date, task_id LIMIT 1"
    )
      .bind(comp.comp_id)
      .first<{ task_id: number }>();
    if (!task) return c.json({ error: "Sample competition has no task" }, 404);

    const { body, cache, cacheKey } = await serve3dvis(
      c.env,
      task.task_id,
      c.req.header("If-None-Match")
    );
    // No auth middleware on this route: the sample comp is public by
    // definition (test = 0 enforced in the lookup), so shared-cacheable.
    const headers = { ...bundleHeaders(cacheKey, false), "X-Cache": cache };
    if (!body) return c.body(null, 304, headers);
    return c.body(body, 200, headers);
  })

  // ── GET /api/comp/:comp_id/task/:task_id/3dvis ── packed replay bundle for a
  // task (public for non-test comps, like the score endpoint).
  .get(
    "/api/comp/:comp_id/task/:task_id/3dvis",
    optionalAuth,
    sqidsMiddleware,
    async (c) => {
      const compId = c.var.ids.comp_id!;
      const taskId = c.var.ids.task_id!;
      const user = c.var.user;

      const comp = await c.env.DB.prepare(
        "SELECT comp_id, test FROM comp WHERE comp_id = ?"
      )
        .bind(compId)
        .first<{ comp_id: number; test: number }>();
      if (!comp) return c.json({ error: "Not found" }, 404);

      if (comp.test) {
        if (!user) return c.json({ error: "Not found" }, 404);
        if (!(await isCompAdmin(c.env.DB, compId, user)))
          return c.json({ error: "Not found" }, 404);
      }

      const task = await c.env.DB.prepare(
        "SELECT task_id, xctsk FROM task WHERE task_id = ? AND comp_id = ?"
      )
        .bind(taskId, compId)
        .first<{ task_id: number; xctsk: string | null }>();
      if (!task) return c.json({ error: "Task not found" }, 404);
      if (!task.xctsk) return c.json({ error: "Task has no xctsk defined" }, 422);

      const { body, cache, cacheKey } = await serve3dvis(
        c.env,
        taskId,
        c.req.header("If-None-Match")
      );
      const headers = {
        ...bundleHeaders(cacheKey, user != null),
        "X-Cache": cache,
      };
      if (!body) return c.body(null, 304, headers);
      return c.body(body, 200, headers);
    }
  );
