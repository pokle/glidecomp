import { Hono } from "hono";
import type { Context } from "hono";
import {
  ftvDiscardFactor,
  calculatedFtv,
  computeFtvForPilot,
  type FtvTaskStatus,
} from "@glidecomp/engine";
import type { AuthedEnv } from "../env";
import { sqidsMiddleware } from "../middleware/sqids";
import { optionalAuth, requireAuth, requireCompAdmin } from "../middleware/auth";
import { isCompAdmin } from "../super-admin";
import { audit } from "../audit";
import { encodeId } from "../sqids";
import { mapWithConcurrency } from "../lib/concurrency";
import { computePilotAnalysis } from "../pilot-analysis";
import {
  rankByTotalScore,
  shortHash,
  type OfficialResultsWire,
  type StoredOfficialResults,
  type TaskScoreResponse,
} from "../scoring";
import {
  bumpAndRevalidateScores,
  computeAndStoreTaskScore,
  ifNoneMatchMatches,
  isRowStale,
  publicMaxAgeSeconds,
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

/**
 * Storage shape → wire shape for a task score.
 *
 * The wire calls the per-class array `class_scores`, matching the comp-level
 * endpoint so a consumer can read both with one code path. The STORED blob
 * (`task_scores.response_json`) still calls it `classes`, and deliberately
 * keeps doing so:
 *
 *  - the store is stale-first, so a row written before this change is still
 *    SERVED while its revalidation runs. Renaming the stored key would mean
 *    every such row arrives at a client reading `class_scores` as undefined —
 *    a task page showing no scores at all until that row happened to be
 *    recomputed;
 *  - `routes/pilot-profile.ts` reads the blob with raw SQL
 *    (`json_each(ts.response_json, '$.classes')`) to get per-task ranks for a
 *    pilot's profile. A migration that blanked or reshaped the cache would
 *    empty that column for every task not yet re-read.
 *
 * So the rename lives here, at the boundary, and the cache format is left
 * alone. It is an internal derived cache, not a contract with anyone.
 */
function toTaskScoreWire(
  body: StoredTaskScore | TaskScoreResponse,
  stale: boolean,
  official?: OfficialResultsWire | null
): Record<string, unknown> {
  const { classes, ...rest } = body;
  return {
    ...rest,
    class_scores: classes,
    stale,
    ...(official ? { official_results: official } : {}),
  };
}

/**
 * The task's officially published results (migration 0031, issue #603) in
 * wire shape: stored comp_pilot ids become the same sqids the score entries
 * carry, keyed for per-row lookup. Read live from the task row — NOT from
 * the cached score blob, because official results are display-only and must
 * never invalidate or ride inside a scoring artefact. Returns null for the
 * common case (no official record) and for an unreadable column, which is
 * an annotation not worth failing a scores page over.
 */
/**
 * Only ever hand an `http(s):` URL to the client — `task.official_results`
 * is populated by an offline importer, not a live route, but the wire
 * response is rendered straight into an anchor's `href` on public score
 * pages, so a `javascript:`-scheme (or any other non-web-scheme) value must
 * never reach it.
 */
function safeExternalUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function officialResultsWire(
  raw: string | null,
  alphabet: string
): OfficialResultsWire | null {
  if (!raw) return null;
  try {
    const stored = JSON.parse(raw) as StoredOfficialResults;
    if (!Array.isArray(stored.results) || stored.results.length === 0) return null;
    const ranks: OfficialResultsWire["ranks"] = {};
    for (const r of stored.results) {
      ranks[encodeId(alphabet, r.comp_pilot_id)] = { rank: r.rank, total: r.total };
    }
    return {
      source: stored.source ?? "AirScore",
      comp_url: safeExternalUrl(stored.comp_url),
      task_url: safeExternalUrl(stored.task_url),
      ranks,
    };
  } catch (err) {
    console.error("unreadable task.official_results", err);
    return null;
  }
}

/**
 * Cache-Control for score responses (matches the SSR plan): signed-in
 * viewers must never see another session's cached body; anonymous readers
 * and crawlers may cache but must revalidate — the ETag makes that a
 * one-row 304. The max-age grows with how long the scores have already been
 * stable (publicMaxAgeSeconds), so a finished comp stops being re-fetched
 * while a live one stays near-realtime; a stale row always gets 0.
 */
function cacheControl(
  c: Context<AuthedEnv>,
  computedAt: string | null,
  stale: boolean
): string {
  if (c.var.user) return "private, no-store";
  const maxAge = publicMaxAgeSeconds(computedAt, stale, Date.now());
  return `public, max-age=${maxAge}, must-revalidate`;
}

export const scoreRoutes = new Hono<AuthedEnv>()

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
        "SELECT task_id, xctsk, official_results FROM task WHERE task_id = ? AND comp_id = ?"
      )
        .bind(taskId, compId)
        .first<{
          task_id: number;
          xctsk: string | null;
          official_results: string | null;
        }>();

      if (!task) return c.json({ error: "Task not found" }, 404);

      if (!task.xctsk) {
        return c.json(
          { error: "Task has no xctsk defined — cannot score without a task definition" },
          422
        );
      }

      // The official annotation rides OUTSIDE the cached score blob (it is
      // not a scoring input), so it joins the response — and the ETag, which
      // is the identity of the served body — at read time.
      const official = officialResultsWire(
        task.official_results,
        c.env.SQIDS_ALPHABET
      );
      const officialTag = task.official_results
        ? `:official:${await shortHash(task.official_results)}`
        : "";

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
        const etagKey =
          (stale ? `${row.state_key}:stale` : row.state_key) + officialTag;
        const headers = {
          ETag: toEtag(etagKey),
          "X-Cache": stale ? "HIT-STALE" : "HIT",
          "Cache-Control": cacheControl(c, row.computed_at, stale),
        };
        if (ifNoneMatchMatches(c.req.header("If-None-Match"), etagKey)) {
          return c.body(null, 304, headers);
        }
        const body = JSON.parse(row.response_json) as StoredTaskScore;
        return c.json(toTaskScoreWire(body, stale, official), 200, headers);
      }

      // Cold — no servable blob. Compute synchronously, store, serve.
      const { response, stateKey } = await computeAndStoreTaskScore(
        c.env,
        taskId,
        row?.inputs_rev ?? 0
      );
      return c.json(toTaskScoreWire(response, false, official), 200, {
        ETag: toEtag(stateKey + officialTag),
        "X-Cache": "MISS",
        "Cache-Control": cacheControl(c, response.computed_at, false),
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
        "SELECT comp_id, test, pilot_classes, scoring_format, series_scoring, ftv_factor, category FROM comp WHERE comp_id = ?"
      )
        .bind(compId)
        .first<{
          comp_id: number;
          test: number;
          pilot_classes: string;
          scoring_format: string;
          series_scoring: string;
          ftv_factor: number | null;
          category: string | null;
        }>();

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
      // scores. Null for a comp with no scoreable tasks.
      const computedAt = taskScores.reduce<string | null>(
        (oldest, t) =>
          oldest === null || t.computed_at < oldest ? t.computed_at : oldest,
        null
      );

      // Comp-level ETag: the identity of everything the response is built
      // from — each task's stored state_key plus the team assignments, with
      // the staleness label folded in (as on the task endpoint) so a
      // stale-labelled body never revalidates a fresh one.
      // The series-scoring settings change the scores (FTV vs sum, and the
      // discard factor) without touching any per-task state_key, so they must
      // be folded in here or a toggle would serve a stale cached body.
      const compStateString = [
        ...taskScores.map((t) => t.state_key),
        ...teamRows.results.map((r) => `${r.comp_pilot_id}=${r.team_name ?? ""}`),
        `series=${comp.series_scoring}`,
        `ftvf=${comp.ftv_factor ?? "auto"}`,
      ].join("|");
      const compEtagKey =
        `compscores:${compId}:${await shortHash(compStateString)}` +
        (anyStale ? ":stale" : "");
      const headers = {
        ETag: toEtag(compEtagKey),
        "X-Cache": anyCold ? "MISS" : anyStale ? "HIT-STALE" : "HIT",
        "Cache-Control": cacheControl(c, computedAt, anyStale),
      };
      if (ifNoneMatchMatches(c.req.header("If-None-Match"), compEtagKey)) {
        return c.body(null, 304, headers);
      }

      // Aggregate per pilot per class across all tasks. `winner_score` is the
      // class day-winner's score on that task, kept for FTV (validity units).
      type TaskEntry = {
        task_id: string;
        task_date: string;
        score: number;
        rank: number;
        winner_score: number;
        ftv_status?: FtvTaskStatus;
        ftv_counted_score?: number;
        validity?: number;
      };
      type PilotTotals = {
        pilot_name: string;
        comp_pilot_id: string;
        team_name: string | null;
        total_score: number;
        tasks: TaskEntry[];
        calculated_ftv?: number;
      };

      const classTotals: Record<string, Record<string, PilotTotals>> = {};
      // Per class, per task: the day-winner's score (max in the class).
      const classTaskWinner: Record<string, Record<string, number>> = {};

      for (const task of taskScores) {
        for (const cls of task.classes) {
          // S7F 2026 §16 (PG only): a stopped task with a task validity
          // under 0.05 (the winner has fewer than 50 points) is excluded
          // from the competition ranking. It stays on the task's own scores
          // page — only the comp aggregation skips it.
          if (
            comp.category === "pg" &&
            comp.scoring_format === "gap" &&
            cls.stopped &&
            cls.task_validity.task < 0.05
          ) {
            continue;
          }
          classTotals[cls.pilot_class] ??= {};
          classTaskWinner[cls.pilot_class] ??= {};
          const winnerScore = cls.pilots.reduce(
            (max, p) => Math.max(max, p.total_score),
            0
          );
          classTaskWinner[cls.pilot_class][task.task_id] = winnerScore;
          for (const pilot of cls.pilots) {
            if (!classTotals[cls.pilot_class][pilot.comp_pilot_id]) {
              classTotals[cls.pilot_class][pilot.comp_pilot_id] = {
                pilot_name: pilot.pilot_name,
                comp_pilot_id: pilot.comp_pilot_id,
                team_name: teamByPilot.get(pilot.comp_pilot_id) ?? null,
                total_score: 0,
                tasks: [],
              };
            }
            const entry = classTotals[cls.pilot_class][pilot.comp_pilot_id];
            // Default (sum-of-tasks) total; overwritten below under FTV.
            entry.total_score += pilot.total_score;
            entry.tasks.push({
              task_id: task.task_id,
              task_date: task.task_date,
              score: pilot.total_score,
              rank: pilot.rank,
              winner_score: winnerScore,
            });
          }
        }
      }

      // FTV (S7F §16): applies to GAP comps set to FTV with more than one task
      // (a single task can't discard anything). Pure re-aggregation over the
      // per-task scores already loaded above — no task is re-scored.
      const ftvActive =
        comp.series_scoring === "ftv" &&
        comp.scoring_format === "gap" &&
        taskScores.length > 1;
      const ftvFactor = ftvActive
        ? comp.ftv_factor ?? ftvDiscardFactor(taskScores.length)
        : null;

      if (ftvActive && ftvFactor !== null) {
        for (const [clsKey, pilots] of Object.entries(classTotals)) {
          const target = calculatedFtv(
            Object.values(classTaskWinner[clsKey] ?? {}),
            ftvFactor
          );
          for (const entry of Object.values(pilots)) {
            const res = computeFtvForPilot(
              entry.tasks.map((t) => ({
                taskId: t.task_id,
                score: t.score,
                winnerScore: t.winner_score,
              })),
              target
            );
            entry.total_score = res.total;
            entry.calculated_ftv = target;
            const byId = new Map(res.tasks.map((t) => [t.taskId, t]));
            for (const t of entry.tasks) {
              const b = byId.get(t.task_id);
              if (!b) continue;
              t.ftv_status = b.status;
              t.ftv_counted_score = b.countedScore;
              t.validity = b.validity;
            }
          }
        }
      }

      // Build the ranked scores per class. rankByTotalScore applies S7A
      // §5.2.5.4 ties (equal published totals share a rank; no tie-break) to
      // whatever total_score holds — the sum, or the FTV total set above.
      const classScores = Object.entries(classTotals).map(
        ([pilotClass, pilots]) => ({
          pilot_class: pilotClass,
          pilots: rankByTotalScore(Object.values(pilots)).map((p) => ({
            pilot_name: p.pilot_name,
            comp_pilot_id: p.comp_pilot_id,
            team_name: p.team_name,
            rank: p.rank,
            total_score: p.total_score,
            ...(p.calculated_ftv !== undefined
              ? { calculated_ftv: p.calculated_ftv }
              : {}),
            // Drop the internal winner_score; surface FTV fields when present.
            tasks: p.tasks.map((t) => ({
              task_id: t.task_id,
              task_date: t.task_date,
              score: t.score,
              rank: t.rank,
              ...(t.ftv_status !== undefined
                ? {
                    ftv_status: t.ftv_status,
                    ftv_counted_score: t.ftv_counted_score,
                    validity: t.validity,
                  }
                : {}),
            })),
          })),
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
        class_scores: classScores,
        computed_at: computedAt,
        stale: anyStale,
        series_scoring: ftvActive ? "ftv" : "total",
        ...(ftvFactor !== null ? { ftv_factor: ftvFactor } : {}),
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
  /** The officially published record beside the rescored one (issue #603) —
   * read live from the task row, absent when no official result is known. */
  official_results?: OfficialResultsWire;
};
