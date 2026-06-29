// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

import { Hono } from "hono";
import type { Env, AuthUser } from "../env";
import { sqidsMiddleware } from "../middleware/sqids";
import { optionalAuth } from "../middleware/auth";
import { SAMPLE_COMP_NAME } from "../sample";
import { buildTask3dvisBundle, compute3dvisCacheKey } from "../visualization";

type Variables = {
  user: AuthUser;
  ids: { comp_id?: number; task_id?: number; comp_pilot_id?: number };
};

type HonoEnv = { Bindings: Env; Variables: Variables };

const BUNDLE_HEADERS = {
  "Content-Type": "application/octet-stream",
  // The bundle is content-addressed by the cache key; safe to cache a while.
  "Cache-Control": "public, max-age=300",
} as const;

/**
 * Produce (or serve from KV) the 3D-replay bundle for a task. Shared by the
 * id-addressed and the sample routes.
 */
async function serve3dvis(
  env: Env,
  taskId: number
): Promise<{ body: ArrayBuffer; cache: "HIT" | "MISS" }> {
  const cacheKey = await compute3dvisCacheKey(taskId, env.DB);
  const cached = await env.glidecomp_scores_cache.get(cacheKey, "arrayBuffer");
  if (cached) return { body: cached, cache: "HIT" };

  const bundle = await buildTask3dvisBundle(taskId, env.DB, env.R2);
  const body = bundle.buffer.slice(
    bundle.byteOffset,
    bundle.byteOffset + bundle.byteLength
  ) as ArrayBuffer;
  await env.glidecomp_scores_cache.put(cacheKey, body, { expirationTtl: 604800 });
  return { body, cache: "MISS" };
}

export const visualizationRoutes = new Hono<HonoEnv>()

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

    const { body, cache } = await serve3dvis(c.env, task.task_id);
    return c.body(body, 200, { ...BUNDLE_HEADERS, "X-Cache": cache });
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
        const isAdmin = await c.env.DB.prepare(
          "SELECT 1 FROM comp_admin WHERE comp_id = ? AND user_id = ?"
        )
          .bind(compId, user.id)
          .first();
        if (!isAdmin) return c.json({ error: "Not found" }, 404);
      }

      const task = await c.env.DB.prepare(
        "SELECT task_id, xctsk FROM task WHERE task_id = ? AND comp_id = ?"
      )
        .bind(taskId, compId)
        .first<{ task_id: number; xctsk: string | null }>();
      if (!task) return c.json({ error: "Task not found" }, 404);
      if (!task.xctsk) return c.json({ error: "Task has no xctsk defined" }, 422);

      const { body, cache } = await serve3dvis(c.env, taskId);
      return c.body(body, 200, { ...BUNDLE_HEADERS, "X-Cache": cache });
    }
  );
