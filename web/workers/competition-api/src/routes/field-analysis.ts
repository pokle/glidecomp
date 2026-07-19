/**
 * Field analysis endpoints — the behavioural metrics (climbing, gliding,
 * decision-making, gaggle, race craft, day profile) and the Spearman ranking
 * of which of them actually separate the leaderboard.
 *
 * ADMIN-ONLY FOR NOW. The metrics are exploratory and easy to misread, so the
 * rollout starts with competition admins and super-admins. See
 * canViewFieldAnalysis() below — going public is deliberately a one-function
 * change (plus the notes in "WHEN WE GO PUBLIC" there).
 *
 * Stale-first like scores (see field-analysis-store.ts), with one deliberate
 * departure: the cold path NEVER computes synchronously. A cold analysis
 * parses every pilot's tracklog; blocking a request on that is the wrong
 * trade, so a task with no stored report returns `pending: true`, schedules
 * the work, and the UI polls.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { aggregateComp, type CompTaskResult } from "@glidecomp/engine";
import type { Env, AuthUser } from "../env";
import { sqidsMiddleware } from "../middleware/sqids";
import { optionalAuth, requireAuth, requireCompAdmin } from "../middleware/auth";
import { isCompAdmin } from "../super-admin";
import { audit } from "../audit";
import { encodeId } from "../sqids";
import { shortHash } from "../scoring";
import { ifNoneMatchMatches, toEtag } from "../score-store";
import {
  bumpFieldAnalysisInputs,
  decodeFieldAnalysisRow,
  fieldRowHasResult,
  isFieldRowStale,
  readFieldAnalysisRow,
  readFieldAnalysisRowsForComp,
  scheduleFieldAnalysisRevalidation,
  type StoredFieldAnalysis,
} from "../field-analysis-store";

type Variables = {
  user: AuthUser;
  ids: { comp_id?: number; task_id?: number; comp_pilot_id?: number };
};

type HonoEnv = { Bindings: Env; Variables: Variables };

/**
 * Who may read field analysis: competition admins and super-admins
 * (isCompAdmin grants both).
 *
 * The GET routes use `optionalAuth` (not `requireAuth`) so an anonymous
 * request 404s here rather than 401ing in middleware — the endpoint's
 * existence shouldn't be a signal, and it means going public needs no
 * middleware change at all.
 *
 * WHEN WE GO PUBLIC: replace this body with the score route's visibility
 * check — public unless `comp.test`, in which case admin-only. Three further
 * things change at that point, none of them here: the Cache-Control becomes
 * the score route's `cacheControl(c)` (public + must-revalidate); the cold
 * "pending" state needs to be pleasant for anonymous first visitors rather
 * than merely honest; and the pages want SSR + a ROUTES entry in
 * functions/comp/[[path]].ts.
 */
async function canViewFieldAnalysis(
  c: Context<HonoEnv>,
  compId: number
): Promise<boolean> {
  const user = c.var.user;
  if (!user) return false;
  return isCompAdmin(c.env.DB, compId, user);
}

/** Short per-task label used as a column header in the comp aggregate —
 * "Task 1 (2026-01-05)" reads as "T1" in a matrix of them. */
function taskLabel(name: string, index: number): string {
  const short = name.match(/task\s*(\d+)/i);
  return short ? `T${short[1]}` : `T${index + 1}`;
}

export const fieldAnalysisRoutes = new Hono<HonoEnv>()

  // ── GET /api/comp/:comp_id/task/:task_id/field-analysis ── (admin only)
  .get(
    "/api/comp/:comp_id/task/:task_id/field-analysis",
    optionalAuth,
    sqidsMiddleware,
    async (c) => {
      const compId = c.var.ids.comp_id!;
      const taskId = c.var.ids.task_id!;

      const comp = await c.env.DB.prepare(
        "SELECT comp_id FROM comp WHERE comp_id = ?"
      )
        .bind(compId)
        .first<{ comp_id: number }>();
      if (!comp) return c.json({ error: "Not found" }, 404);

      // 404 rather than 403 for a non-admin — the same way hidden `test`
      // comps are concealed, so the endpoint's existence isn't a signal.
      if (!(await canViewFieldAnalysis(c, compId)))
        return c.json({ error: "Not found" }, 404);

      const task = await c.env.DB.prepare(
        "SELECT task_id, xctsk FROM task WHERE task_id = ? AND comp_id = ?"
      )
        .bind(taskId, compId)
        .first<{ task_id: number; xctsk: string | null }>();
      if (!task) return c.json({ error: "Task not found" }, 404);
      if (!task.xctsk) {
        return c.json(
          { error: "Task has no route defined — nothing to analyse" },
          422
        );
      }

      const row = await readFieldAnalysisRow(c.env.DB, taskId);
      const stale = row ? isFieldRowStale(row) : true;

      if (row && fieldRowHasResult(row)) {
        if (stale) scheduleFieldAnalysisRevalidation(c, [taskId]);
        // `fa:` prefix because scores and field analysis share the same
        // state_key (identical inputs) — without it a browser could match a
        // score ETag against this body. The staleness label rides on the
        // ETag so a stale body can never revalidate a fresh one.
        const etagKey = `fa:${row.state_key}${stale ? ":stale" : ""}`;
        const headers = {
          ETag: toEtag(etagKey),
          "X-Cache": stale ? "HIT-STALE" : "HIT",
          // Always private: admin-only, and it names every pilot.
          "Cache-Control": "private, no-store",
        };
        if (ifNoneMatchMatches(c.req.header("If-None-Match"), etagKey)) {
          return c.body(null, 304, headers);
        }
        const body = await decodeFieldAnalysisRow(row);
        if (body) {
          return c.json(
            { ...body, stale, pending: false, error: null },
            200,
            headers
          );
        }
      }

      // A row that computed successfully but produced nothing analysable
      // (open distance, no tracks, too many tracks) carries the reason. It is
      // not pending — recomputing would reach the same refusal.
      if (row && row.error && !stale) {
        return c.json(
          {
            task_id: encodeId(c.env.SQIDS_ALPHABET, taskId),
            comp_id: encodeId(c.env.SQIDS_ALPHABET, compId),
            classes: [],
            computed_at: row.computed_at,
            stale: false,
            pending: false,
            error: row.error,
          },
          200,
          { "Cache-Control": "private, no-store" }
        );
      }

      // Cold. Unlike scores, do NOT compute on the request path — schedule it
      // and let the client poll.
      scheduleFieldAnalysisRevalidation(c, [taskId]);
      return c.json(
        {
          task_id: encodeId(c.env.SQIDS_ALPHABET, taskId),
          comp_id: encodeId(c.env.SQIDS_ALPHABET, compId),
          classes: [],
          computed_at: null,
          stale: true,
          pending: true,
          error: null,
        },
        200,
        { "X-Cache": "MISS", "Cache-Control": "private, no-store" }
      );
    }
  )

  // ── GET /api/comp/:comp_id/field-analysis ── Comp aggregate (admin only)
  //
  // Pure aggregation over the per-task rows — aggregateComp is arithmetic
  // over already-stored reports, so there is nothing comp-level to
  // materialize or keep consistent. Tasks with no stored report yet are
  // scheduled and reported as pending rather than computed inline.
  .get(
    "/api/comp/:comp_id/field-analysis",
    optionalAuth,
    sqidsMiddleware,
    async (c) => {
      const compId = c.var.ids.comp_id!;
      const alphabet = c.env.SQIDS_ALPHABET;

      const comp = await c.env.DB.prepare(
        "SELECT comp_id, name FROM comp WHERE comp_id = ?"
      )
        .bind(compId)
        .first<{ comp_id: number; name: string }>();
      if (!comp) return c.json({ error: "Not found" }, 404);
      if (!(await canViewFieldAnalysis(c, compId)))
        return c.json({ error: "Not found" }, 404);

      const tasks = await c.env.DB.prepare(
        `SELECT task_id, name, task_date FROM task
         WHERE comp_id = ? AND xctsk IS NOT NULL
         ORDER BY task_date, task_id`
      )
        .bind(compId)
        .all<{ task_id: number; name: string; task_date: string }>();

      const rows = await readFieldAnalysisRowsForComp(c.env.DB, compId);

      // Per class: the ordered list of task reports aggregateComp needs.
      // Classes are never mixed (engine aggregate.ts), so a comp with an
      // open and a floater class produces one aggregate each.
      const byClass = new Map<string, CompTaskResult[]>();
      const taskLabels: string[] = [];
      const includedTasks: {
        task_id: string;
        task_name: string;
        task_date: string;
        label: string;
      }[] = [];
      const coldTaskIds: number[] = [];
      const stateKeys: string[] = [];
      let anyStale = false;
      let oldestComputedAt: string | null = null;

      for (const [i, task] of tasks.results.entries()) {
        const row = rows.get(task.task_id);
        if (!row || !fieldRowHasResult(row)) {
          // Cold or errored — schedule it (a refusal row won't recompute
          // needlessly: revalidateFieldAnalysis bails when it's already
          // fresh) and leave it out of the aggregate.
          if (!row || !row.error) coldTaskIds.push(task.task_id);
          continue;
        }
        const report: StoredFieldAnalysis | null = await decodeFieldAnalysisRow(row);
        if (!report) continue;

        if (isFieldRowStale(row)) {
          anyStale = true;
          coldTaskIds.push(task.task_id);
        }
        stateKeys.push(row.state_key);
        if (!oldestComputedAt || row.computed_at < oldestComputedAt) {
          oldestComputedAt = row.computed_at;
        }

        const label = taskLabel(task.name, i);
        taskLabels.push(label);
        includedTasks.push({
          task_id: encodeId(alphabet, task.task_id),
          task_name: task.name,
          task_date: task.task_date,
          label,
        });

        for (const cls of report.classes) {
          const list = byClass.get(cls.pilot_class) ?? [];
          list.push({
            label,
            report: cls.report,
            pilotKeyByTrackFile: cls.pilot_key_by_track_file,
            totals: cls.totals,
          });
          byClass.set(cls.pilot_class, list);
        }
      }

      if (coldTaskIds.length > 0) {
        scheduleFieldAnalysisRevalidation(c, coldTaskIds);
      }

      const classes = [...byClass.entries()].map(([pilotClass, taskResults]) => ({
        pilot_class: pilotClass,
        aggregate: aggregateComp(taskResults),
      }));

      const etagKey = `compfa:${compId}:${await shortHash(
        stateKeys.join("|")
      )}${anyStale ? ":stale" : ""}`;
      const headers = {
        ETag: toEtag(etagKey),
        "Cache-Control": "private, no-store",
      };
      if (ifNoneMatchMatches(c.req.header("If-None-Match"), etagKey)) {
        return c.body(null, 304, headers);
      }

      return c.json(
        {
          comp_id: encodeId(alphabet, compId),
          comp_name: comp.name,
          tasks: includedTasks,
          task_labels: taskLabels,
          classes,
          computed_at: oldestComputedAt,
          stale: anyStale,
          pending_task_count: coldTaskIds.length,
          total_task_count: tasks.results.length,
        },
        200,
        headers
      );
    }
  )

  // ── POST /api/comp/:comp_id/task/:task_id/field-analysis/refresh ──
  //
  // Explicit "recompute now". The store already recomputes after any
  // scoring-input change, so this is for recovering a task whose background
  // revalidation got wedged or whose compute errored. Bumps ONLY the
  // analysis row — re-scoring is a separate, heavier action (POST /rescore).
  .post(
    "/api/comp/:comp_id/task/:task_id/field-analysis/refresh",
    requireAuth,
    sqidsMiddleware,
    requireCompAdmin,
    async (c) => {
      const compId = c.var.ids.comp_id!;
      const taskId = c.var.ids.task_id!;

      const task = await c.env.DB.prepare(
        "SELECT task_id, name FROM task WHERE task_id = ? AND comp_id = ?"
      )
        .bind(taskId, compId)
        .first<{ task_id: number; name: string }>();
      if (!task) return c.json({ error: "Task not found" }, 404);

      await bumpFieldAnalysisInputs(c.env.DB, [taskId]);
      scheduleFieldAnalysisRevalidation(c, [taskId]);

      await audit(c.env.DB, c.var.user, compId, {
        subject_type: "task",
        subject_id: taskId,
        subject_name: task.name,
        description: `Triggered a manual field-analysis recompute for task "${task.name}"`,
      });

      return c.json({ ok: true });
    }
  );
