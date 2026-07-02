import { Hono } from "hono";
import type { Context } from "hono";
import type { Env, AuthUser } from "../env";
import { sqidsMiddleware } from "../middleware/sqids";
import { optionalAuth } from "../middleware/auth";
import { isCompAdmin } from "../super-admin";
import { encodeId } from "../sqids";
import {
  computeScoreCacheKey,
  computeTaskScore,
  mapWithConcurrency,
  type TaskScoreResponse,
} from "../scoring";

/** How many cold tasks to score in parallel for the comp-level endpoint. Each
 * task itself fans out over its tracks, so this stays small to bound total R2
 * concurrency. */
const COMP_TASK_CONCURRENCY = 3;

type Variables = {
  user: AuthUser;
  ids: { comp_id?: number; task_id?: number; comp_pilot_id?: number };
};

type HonoEnv = { Bindings: Env; Variables: Variables };

/**
 * Cloudflare's waitUntil, if this invocation has an ExecutionContext — lets us
 * persist per-track analysis cache writes without blocking the response.
 * Returns undefined outside a Worker request (the caller then awaits instead).
 */
function getWaitUntil(
  c: Context<HonoEnv>
): ((promise: Promise<unknown>) => void) | undefined {
  try {
    const ctx = c.executionCtx;
    return ctx.waitUntil.bind(ctx);
  } catch {
    return undefined;
  }
}

export const scoreRoutes = new Hono<HonoEnv>()

  // ── GET /api/comp/:comp_id/task/:task_id/score ── Task scores (public for non-test)
  .get(
    "/api/comp/:comp_id/task/:task_id/score",
    optionalAuth,
    sqidsMiddleware,
    async (c) => {
      const compId = c.var.ids.comp_id!;
      const taskId = c.var.ids.task_id!;
      const user = c.var.user;
      const alphabet = c.env.SQIDS_ALPHABET;

      // Check comp exists and handle test visibility
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

      // Verify task exists, belongs to comp, and has an xctsk
      const task = await c.env.DB.prepare(
        "SELECT task_id, xctsk FROM task WHERE task_id = ? AND comp_id = ?"
      )
        .bind(taskId, compId)
        .first<{ task_id: number; xctsk: string | null }>();

      if (!task) return c.json({ error: "Task not found" }, 404);

      if (!task.xctsk) {
        return c.json(
          { error: "Task has no xctsk defined — cannot score without a task definition" },
          422
        );
      }

      // Check KV cache
      const cacheKey = await computeScoreCacheKey(taskId, c.env.DB);
      const cached = await c.env.glidecomp_scores_cache.get(cacheKey, "json") as TaskScoreResponse | null;

      if (cached) {
        return c.json(cached, 200, { "X-Cache": "HIT" });
      }

      // Cache miss — compute scores
      const result = await computeTaskScore(
        taskId,
        c.env.DB,
        c.env.R2,
        alphabet,
        c.env.glidecomp_scores_cache,
        getWaitUntil(c)
      );

      // Store in KV with 7-day TTL
      await c.env.glidecomp_scores_cache.put(cacheKey, JSON.stringify(result), {
        expirationTtl: 604800,
      });

      return c.json(result, 200, { "X-Cache": "MISS" });
    }
  )

  // ── GET /api/comp/:comp_id/scores ── Competition-level scores (public for non-test)
  .get(
    "/api/comp/:comp_id/scores",
    optionalAuth,
    sqidsMiddleware,
    async (c) => {
      const compId = c.var.ids.comp_id!;
      const user = c.var.user;
      const alphabet = c.env.SQIDS_ALPHABET;

      // Check comp exists and handle test visibility
      const comp = await c.env.DB.prepare(
        "SELECT comp_id, test, pilot_classes FROM comp WHERE comp_id = ?"
      )
        .bind(compId)
        .first<{ comp_id: number; test: number; pilot_classes: string }>();

      if (!comp) return c.json({ error: "Not found" }, 404);

      if (comp.test) {
        if (!user) return c.json({ error: "Not found" }, 404);
        if (!(await isCompAdmin(c.env.DB, compId, user)))
          return c.json({ error: "Not found" }, 404);
      }

      // Load all tasks with xctsk for this comp
      const tasks = await c.env.DB.prepare(
        `SELECT task_id, name, task_date FROM task
         WHERE comp_id = ? AND xctsk IS NOT NULL
         ORDER BY task_date, task_id`
      )
        .bind(compId)
        .all<{ task_id: number; name: string; task_date: string }>();

      // Team assignments are embedded in the response (for the Teams view), so
      // they must also be part of the hashed cache state — a team change
      // doesn't touch any task score cache key.
      const teamRows = await c.env.DB.prepare(
        `SELECT comp_pilot_id, team_name FROM comp_pilot
         WHERE comp_id = ? ORDER BY comp_pilot_id`
      )
        .bind(compId)
        .all<{ comp_pilot_id: number; team_name: string | null }>();
      const teamByPilot = new Map(
        teamRows.results.map((r) => [
          encodeId(alphabet, r.comp_pilot_id),
          r.team_name,
        ])
      );

      // Compute cache key for comp scores: hash of all task score cache keys
      // plus the team assignments
      const taskCacheKeys = await Promise.all(
        tasks.results.map((t) => computeScoreCacheKey(t.task_id, c.env.DB))
      );
      const compStateString = [
        ...taskCacheKeys,
        ...teamRows.results.map((r) => `${r.comp_pilot_id}=${r.team_name ?? ""}`),
      ].join("|");
      const compHashBuffer = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(compStateString)
      );
      const compHex = Array.from(new Uint8Array(compHashBuffer))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
        .slice(0, 16);
      // v3: added team_name per pilot (and team assignments to the hash).
      const compCacheKey = `compscore:v3:${compId}:${compHex}`;

      const cachedComp = await c.env.glidecomp_scores_cache.get(compCacheKey, "json");
      if (cachedComp) {
        return c.json(cachedComp, 200, { "X-Cache": "HIT" });
      }

      // Load or compute each task's scores. Tasks are independent, so cold ones
      // are scored with bounded concurrency; each reuses its own per-task cache
      // and (on a miss) the per-track analysis cache.
      const waitUntil = getWaitUntil(c);
      const taskScores = await mapWithConcurrency(
        tasks.results,
        COMP_TASK_CONCURRENCY,
        async (task, index) => {
          const cacheKey = taskCacheKeys[index];
          const cached = await c.env.glidecomp_scores_cache.get(cacheKey, "json") as TaskScoreResponse | null;

          let score: TaskScoreResponse;
          if (cached) {
            score = cached;
          } else {
            score = await computeTaskScore(
              task.task_id,
              c.env.DB,
              c.env.R2,
              alphabet,
              c.env.glidecomp_scores_cache,
              waitUntil
            );
            const put = c.env.glidecomp_scores_cache.put(cacheKey, JSON.stringify(score), {
              expirationTtl: 604800,
            });
            if (waitUntil) waitUntil(put);
            else await put;
          }

          return {
            task_id: encodeId(alphabet, task.task_id),
            task_name: task.name,
            task_date: task.task_date,
            classes: score.classes,
          };
        }
      );

      // Aggregate total points per pilot per class across all tasks
      type PilotTotals = {
        pilot_name: string;
        comp_pilot_id: string;
        team_name: string | null;
        total_score: number;
        tasks: Array<{ task_id: string; task_date: string; score: number; rank: number }>;
      };

      const classStandings: Record<string, Record<string, PilotTotals>> = {};

      for (const task of taskScores) {
        for (const cls of task.classes) {
          if (!classStandings[cls.pilot_class]) {
            classStandings[cls.pilot_class] = {};
          }
          for (const pilot of cls.pilots) {
            if (!classStandings[cls.pilot_class][pilot.comp_pilot_id]) {
              classStandings[cls.pilot_class][pilot.comp_pilot_id] = {
                pilot_name: pilot.pilot_name,
                comp_pilot_id: pilot.comp_pilot_id,
                team_name: teamByPilot.get(pilot.comp_pilot_id) ?? null,
                total_score: 0,
                tasks: [],
              };
            }
            const entry = classStandings[cls.pilot_class][pilot.comp_pilot_id];
            entry.total_score += pilot.total_score;
            entry.tasks.push({
              task_id: task.task_id,
              task_date: task.task_date,
              score: pilot.total_score,
              rank: pilot.rank,
            });
          }
        }
      }

      // Build ranked standings per class
      const standings = Object.entries(classStandings).map(
        ([pilotClass, pilots]) => {
          const ranked = Object.values(pilots)
            .sort((a, b) => b.total_score - a.total_score)
            .map((p, i) => ({ ...p, rank: i + 1 }));
          return { pilot_class: pilotClass, pilots: ranked };
        }
      );

      const result = {
        comp_id: encodeId(alphabet, compId),
        tasks: taskScores.map((t) => ({
          task_id: t.task_id,
          task_name: t.task_name,
          task_date: t.task_date,
          classes: t.classes.map((cls) => cls.pilot_class),
        })),
        standings,
      };

      await c.env.glidecomp_scores_cache.put(compCacheKey, JSON.stringify(result), {
        expirationTtl: 604800,
      });

      return c.json(result, 200, { "X-Cache": "MISS" });
    }
  );
