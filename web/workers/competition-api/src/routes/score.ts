import { Hono } from "hono";
import type { Context } from "hono";
import type { Env, AuthUser } from "../env";
import { sqidsMiddleware } from "../middleware/sqids";
import { optionalAuth, requireAuth, requireCompAdmin } from "../middleware/auth";
import { isCompAdmin } from "../super-admin";
import { audit } from "../audit";
import { encodeId } from "../sqids";
import {
  computePilotAnalysis,
  mapWithConcurrency,
  rankByTotalScore,
  shortHash,
  type TaskScoreResponse,
} from "../scoring";
import {
  bumpAndRevalidateScores,
  computeAndStoreTaskScore,
  ifNoneMatchMatches,
  isRowStale,
  readTaskScoreRow,
  readTaskScoreRowsForComp,
  rowHasResult,
  scheduleTaskRevalidation,
  taskIdsForComp,
  toEtag,
  type StoredTaskScore,
} from "../score-store";

/** How many rowless (cold) tasks to score in parallel for the comp-level
 * endpoint. Each task itself fans out over its tracks, so this stays small
 * to bound total R2 concurrency. Normal tasks are materialized rows and
 * never hit this path. */
const COMP_TASK_CONCURRENCY = 3;

type Variables = {
  user: AuthUser;
  ids: { comp_id?: number; task_id?: number; comp_pilot_id?: number };
};

type HonoEnv = { Bindings: Env; Variables: Variables };

/**
 * Cache-Control for score responses (matches the SSR plan): signed-in
 * viewers must never see another session's cached body; anonymous readers
 * and crawlers may cache but must revalidate — the ETag makes that a
 * one-row 304.
 */
function cacheControl(c: Context<HonoEnv>): string {
  return c.var.user
    ? "private, no-store"
    : "public, max-age=0, must-revalidate";
}

export const scoreRoutes = new Hono<HonoEnv>()

  // ── GET /api/comp/:comp_id/task/:task_id/score ── Task scores (public for non-test)
  //
  // Stale-first: served from the task's materialized task_scores row in a
  // single D1 read. A stale row is served immediately (labelled stale) while
  // revalidation runs in the background; only a task with no usable row —
  // one predating this feature or that slipped past the mutation hooks —
  // computes synchronously.
  .get(
    "/api/comp/:comp_id/task/:task_id/score",
    optionalAuth,
    sqidsMiddleware,
    async (c) => {
      const compId = c.var.ids.comp_id!;
      const taskId = c.var.ids.task_id!;
      const user = c.var.user;

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

      const row = await readTaskScoreRow(c.env.DB, taskId);

      if (row && rowHasResult(row)) {
        const stale = isRowStale(row);
        if (stale) scheduleTaskRevalidation(c, [taskId]);
        // The ETag is the identity of the served body: the stored state_key
        // plus the staleness label riding on it — a stale-labelled body must
        // never revalidate a fresh one (or a browser would re-serve the
        // banner after the re-score concluded). Re-score polls carry the
        // stale ETag: 304 while the row is unchanged (one D1 read, no body),
        // 200 the moment the re-score lands — even a no-op re-score whose
        // recomputed state_key is identical.
        const etagKey = stale ? `${row.state_key}:stale` : row.state_key;
        const headers = {
          ETag: toEtag(etagKey),
          "X-Cache": stale ? "HIT-STALE" : "HIT",
          "Cache-Control": cacheControl(c),
        };
        if (ifNoneMatchMatches(c.req.header("If-None-Match"), etagKey)) {
          return c.body(null, 304, headers);
        }
        const body = JSON.parse(row.response_json) as StoredTaskScore;
        return c.json({ ...body, stale }, 200, headers);
      }

      // Cold — no servable blob. Compute synchronously, store, serve.
      const { response, stateKey } = await computeAndStoreTaskScore(
        c.env,
        taskId,
        row?.inputs_rev ?? 0
      );
      return c.json({ ...response, stale: false }, 200, {
        ETag: toEtag(stateKey),
        "X-Cache": "MISS",
        "Cache-Control": cacheControl(c),
      });
    }
  )

  // ── GET /api/comp/:comp_id/scores ── Competition-level scores (public for non-test)
  //
  // Pure aggregation over the per-task task_scores rows plus live team
  // assignments — no comp-level materialization to keep consistent. Reports
  // computed_at = the oldest constituent task's, stale = any task stale.
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

      // Team assignments are embedded in the response (for the Teams view).
      // Read fresh every time and folded into the comp ETag — a team edit
      // needs no cache handling at all.
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

      // One query for every task's materialized scores. Stale rows are
      // served as-is (revalidation is scheduled below); only rowless tasks
      // compute synchronously.
      const scoreRows = await readTaskScoreRowsForComp(c.env.DB, compId);

      const staleTaskIds: number[] = [];
      let anyCold = false;

      const taskScores = await mapWithConcurrency(
        tasks.results,
        COMP_TASK_CONCURRENCY,
        async (task) => {
          const row = scoreRows.get(task.task_id);
          let score: StoredTaskScore;
          let stateKey: string;
          let stale = false;
          if (row && rowHasResult(row)) {
            score = JSON.parse(row.response_json) as StoredTaskScore;
            stateKey = row.state_key;
            stale = isRowStale(row);
            if (stale) staleTaskIds.push(task.task_id);
          } else {
            anyCold = true;
            const computed = await computeAndStoreTaskScore(
              c.env,
              task.task_id,
              row?.inputs_rev ?? 0
            );
            score = computed.response;
            stateKey = computed.stateKey;
          }

          return {
            task_id: encodeId(alphabet, task.task_id),
            task_name: task.name,
            task_date: task.task_date,
            classes: score.classes,
            computed_at: score.computed_at,
            state_key: stateKey,
            stale,
          };
        }
      );

      if (staleTaskIds.length > 0) scheduleTaskRevalidation(c, staleTaskIds);

      const anyStale = taskScores.some((t) => t.stale);
      // Oldest constituent compute: the honest "as of" for aggregated
      // standings. Null for a comp with no scoreable tasks.
      const computedAt = taskScores.reduce<string | null>(
        (oldest, t) =>
          oldest === null || t.computed_at < oldest ? t.computed_at : oldest,
        null
      );

      // Comp-level ETag: the identity of everything the response is built
      // from — each task's stored state_key plus the team assignments, with
      // the staleness label folded in (as on the task endpoint) so a
      // stale-labelled body never revalidates a fresh one.
      const compStateString = [
        ...taskScores.map((t) => t.state_key),
        ...teamRows.results.map((r) => `${r.comp_pilot_id}=${r.team_name ?? ""}`),
      ].join("|");
      const compEtagKey =
        `compscores:${compId}:${await shortHash(compStateString)}` +
        (anyStale ? ":stale" : "");
      const headers = {
        ETag: toEtag(compEtagKey),
        "X-Cache": anyCold ? "MISS" : anyStale ? "HIT-STALE" : "HIT",
        "Cache-Control": cacheControl(c),
      };
      if (ifNoneMatchMatches(c.req.header("If-None-Match"), compEtagKey)) {
        return c.body(null, 304, headers);
      }

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

      // Build ranked standings per class. rankByTotalScore applies S7A
      // §5.2.5.4 ties (equal published totals share a rank; no tie-break).
      const standings = Object.entries(classStandings).map(
        ([pilotClass, pilots]) => ({
          pilot_class: pilotClass,
          pilots: rankByTotalScore(Object.values(pilots)),
        })
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
        computed_at: computedAt,
        stale: anyStale,
      };

      return c.json(result, 200, headers);
    }
  )

  // ── GET /api/comp/:comp_id/task/:task_id/pilot/:comp_pilot_id/analysis ──
  // Per-pilot scoring transparency: the turnpoint-sequence result (GAP) or
  // the scored open-distance line, for the score-details explanation. Same
  // engine + inputs as the scorer; public for non-test comps like the scores.
  .get(
    "/api/comp/:comp_id/task/:task_id/pilot/:comp_pilot_id/analysis",
    optionalAuth,
    sqidsMiddleware,
    async (c) => {
      const compId = c.var.ids.comp_id!;
      const taskId = c.var.ids.task_id!;
      const compPilotId = c.var.ids.comp_pilot_id!;
      const user = c.var.user;

      // Check comp exists and handle test visibility
      const comp = await c.env.DB.prepare(
        "SELECT comp_id, test FROM comp WHERE comp_id = ?"
      )
        .bind(compId)
        .first<{ comp_id: number; test: number }>();

      if (!comp) {
        return c.json({ error: "Not found" }, 404);
      }

      if (comp.test) {
        if (!user) {
          return c.json({ error: "Not found" }, 404);
        }
        if (!(await isCompAdmin(c.env.DB, compId, user))) {
          return c.json({ error: "Not found" }, 404);
        }
      }

      // Verify task belongs to comp
      const task = await c.env.DB.prepare(
        "SELECT task_id FROM task WHERE task_id = ? AND comp_id = ?"
      )
        .bind(taskId, compId)
        .first();

      if (!task) {
        return c.json({ error: "Task not found" }, 404);
      }

      try {
        const result = await computePilotAnalysis(
          taskId,
          compPilotId,
          c.env.DB,
          c.env.R2,
          c.env.SQIDS_ALPHABET
        );
        if (!result) {
          return c.json({ error: "Track not found" }, 404);
        }
        return c.json(result);
      } catch (err) {
        console.error("Pilot analysis failed:", err);
        return c.json({ error: "Failed to analyze track" }, 500);
      }
    }
  )

  // ── POST /api/comp/:comp_id/rescore ── Force a full re-score (admin only)
  //
  // The stale-first store already recomputes automatically after any
  // scoring-input change, so this is rarely needed — but it gives admins an
  // explicit "recompute now" affordance (issue #343): reassurance that scores
  // are current, or a way to recover a task whose background revalidation got
  // wedged. It bumps every scoreable task's inputs_rev (marking them stale)
  // and schedules revalidation, exactly as a real input change would. Scoring
  // is deterministic, so a task whose inputs are unchanged simply recomputes
  // to the same result — and the ScoreFreshness poll still detects the landing
  // (the ETag folds the staleness label in), so the UI can confirm it ran.
  .post(
    "/api/comp/:comp_id/rescore",
    requireAuth,
    sqidsMiddleware,
    requireCompAdmin,
    async (c) => {
      const compId = c.var.ids.comp_id!;

      const comp = await c.env.DB.prepare(
        "SELECT name FROM comp WHERE comp_id = ?"
      )
        .bind(compId)
        .first<{ name: string }>();
      if (!comp) return c.json({ error: "Not found" }, 404);

      const taskIds = await taskIdsForComp(c.env.DB, compId);
      await bumpAndRevalidateScores(c, taskIds);

      await audit(c.env.DB, c.var.user, compId, {
        subject_type: "comp",
        subject_id: compId,
        subject_name: comp.name,
        description: `Triggered a manual re-score of ${taskIds.length} task${taskIds.length === 1 ? "" : "s"}`,
      });

      return c.json({ ok: true, task_count: taskIds.length });
    }
  );

/** Response type of the task score endpoint (materialized blob + read-time
 * staleness), re-exported for tests and typed clients. */
export type ServedTaskScore = TaskScoreResponse & {
  computed_at: string;
  stale: boolean;
};
