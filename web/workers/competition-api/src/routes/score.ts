import { Hono } from "hono";
import type { Env, AuthUser } from "../env";
import { sqidsMiddleware } from "../middleware/sqids";
import { optionalAuth } from "../middleware/auth";
import { encodeId } from "../sqids";
import {
  computeScoreCacheKey,
  computeTaskScore,
  type TaskScoreResponse,
} from "../scoring";

type Variables = {
  user: AuthUser;
  ids: { comp_id?: number; task_id?: number; comp_pilot_id?: number };
};

type HonoEnv = { Bindings: Env; Variables: Variables };

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
        const isAdmin = await c.env.DB.prepare(
          "SELECT 1 FROM comp_admin WHERE comp_id = ? AND user_id = ?"
        )
          .bind(compId, user.id)
          .first();
        if (!isAdmin) return c.json({ error: "Not found" }, 404);
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
        alphabet
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
        const isAdmin = await c.env.DB.prepare(
          "SELECT 1 FROM comp_admin WHERE comp_id = ? AND user_id = ?"
        )
          .bind(compId, user.id)
          .first();
        if (!isAdmin) return c.json({ error: "Not found" }, 404);
      }

      // Load all tasks with xctsk for this comp
      const tasks = await c.env.DB.prepare(
        `SELECT task_id, name, task_date FROM task
         WHERE comp_id = ? AND xctsk IS NOT NULL
         ORDER BY task_date, task_id`
      )
        .bind(compId)
        .all<{ task_id: number; name: string; task_date: string }>();

      // Compute cache key for comp scores: hash of all task score cache keys
      const taskCacheKeys = await Promise.all(
        tasks.results.map((t) => computeScoreCacheKey(t.task_id, c.env.DB))
      );
      const compStateString = taskCacheKeys.join("|");
      const compHashBuffer = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(compStateString)
      );
      const compHex = Array.from(new Uint8Array(compHashBuffer))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
        .slice(0, 16);
      const compCacheKey = `compscore:${compId}:${compHex}`;

      const cachedComp = await c.env.glidecomp_scores_cache.get(compCacheKey, "json");
      if (cachedComp) {
        return c.json(cachedComp, 200, { "X-Cache": "HIT" });
      }

      // Load or compute each task's scores
      const taskScores: Array<{
        task_id: string;
        task_name: string;
        task_date: string;
        classes: TaskScoreResponse["classes"];
      }> = [];

      for (const task of tasks.results) {
        const cacheKey = taskCacheKeys[tasks.results.indexOf(task)];
        const cached = await c.env.glidecomp_scores_cache.get(cacheKey, "json") as TaskScoreResponse | null;

        let score: TaskScoreResponse;
        if (cached) {
          score = cached;
        } else {
          score = await computeTaskScore(task.task_id, c.env.DB, c.env.R2, alphabet);
          await c.env.glidecomp_scores_cache.put(cacheKey, JSON.stringify(score), {
            expirationTtl: 604800,
          });
        }

        taskScores.push({
          task_id: encodeId(alphabet, task.task_id),
          task_name: task.name,
          task_date: task.task_date,
          classes: score.classes,
        });
      }

      // Aggregate total points per pilot per class across all tasks
      type PilotTotals = {
        pilot_name: string;
        comp_pilot_id: string;
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
        })),
        standings,
      };

      await c.env.glidecomp_scores_cache.put(compCacheKey, JSON.stringify(result), {
        expirationTtl: 604800,
      });

      return c.json(result, 200, { "X-Cache": "MISS" });
    }
  );
