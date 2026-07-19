/**
 * Stale-first score storage — the D1 `task_scores` table.
 * See docs/score-caching-stale-first-plan.md.
 *
 * Principle: reads never compute; writes do. Each task's scores are
 * materialized as one row holding the exact response the endpoint serves.
 * Score-affecting mutations bump `inputs_rev` (marking the row stale for
 * every reader, transactionally) and schedule a background revalidation;
 * revalidation takes a lease lock so N concurrent triggers run exactly one
 * compute, and its guarded write can never record a result computed from
 * superseded inputs as fresh.
 *
 * Freshness is derived, not stored: a row is fresh iff
 * `computed_rev = inputs_rev` AND the blob was computed by the running
 * scoring-engine version. The engine check makes deploys that change scoring
 * behaviour roll every row to stale with no migration step — recomputes then
 * spread over organic traffic instead of stampeding.
 *
 * Like audit(): calling bumpScoreInputs()/scheduleTaskRevalidation() beside
 * every score-affecting mutation is part of that handler being "done".
 */

import { SCORING_ENGINE_VERSION } from "@glidecomp/engine";
import type { Env } from "./env";
import { fieldAnalysisBumpStatement } from "./field-analysis-store";
import {
  computeScoreStateKey,
  computeTaskScore,
  type TaskScoreResponse,
} from "./scoring";

/** One materialized row of the task_scores table. */
export interface TaskScoreRow {
  task_id: number;
  response_json: string;
  state_key: string;
  computed_at: string;
  engine_version: number;
  inputs_rev: number;
  computed_rev: number;
  revalidating_until: string;
}

/** The stored response blob: the pure scoring result plus its compute
 * timestamp. The read-time `stale` flag is added by the endpoint. */
export type StoredTaskScore = TaskScoreResponse & { computed_at: string };

/** How long one revalidation may hold the lock before another may steal it.
 * Generous versus a worst-case cold compute so double-computes only happen
 * when a worker actually died mid-compute. */
export const REVALIDATION_LEASE_MS = 120_000;

/** True when the row's blob was computed from superseded inputs (or by a
 * different engine version) and a re-score is pending or in flight. */
export function isRowStale(row: TaskScoreRow): boolean {
  return (
    row.computed_rev < row.inputs_rev ||
    row.engine_version !== SCORING_ENGINE_VERSION
  );
}

/** True when the row carries a servable blob (false for placeholder rows
 * created by an inputs bump that landed before the first compute). */
export function rowHasResult(row: TaskScoreRow): boolean {
  return row.computed_rev >= 0 && row.response_json !== "";
}

export async function readTaskScoreRow(
  db: D1Database,
  taskId: number
): Promise<TaskScoreRow | null> {
  return db
    .prepare(`SELECT * FROM task_scores WHERE task_id = ?`)
    .bind(taskId)
    .first<TaskScoreRow>();
}

/** All rows for a comp's scoreable (route-bearing) tasks, keyed by task_id. */
export async function readTaskScoreRowsForComp(
  db: D1Database,
  compId: number
): Promise<Map<number, TaskScoreRow>> {
  const rows = await db
    .prepare(
      `SELECT ts.* FROM task_scores ts
       JOIN task t ON t.task_id = ts.task_id
       WHERE t.comp_id = ? AND t.xctsk IS NOT NULL`
    )
    .bind(compId)
    .all<TaskScoreRow>();
  return new Map(rows.results.map((r) => [r.task_id, r]));
}

// ---------------------------------------------------------------------------
// Mutation side: bump inputs_rev
// ---------------------------------------------------------------------------

/**
 * Mark tasks' DERIVED ANALYSES stale because a scoring input changed. Call
 * this right AFTER the mutation's DB write commits (never before — a bump
 * that precedes the write would let a concurrent revalidation record the
 * pre-mutation state as fresh), then scheduleTaskRevalidation() so fresh
 * scores follow within seconds. Upserts a placeholder row for tasks never
 * scored, so the very first mutation already gives readers a transactional
 * staleness signal.
 *
 * The batch bumps BOTH derived tables — `task_scores` and
 * `task_field_analysis` (migration 0019). Field analysis is a function of
 * exactly the same inputs as scores, so one bump covers both and the 28
 * mutation call sites never learn the second table exists. Anything added
 * later that derives from scoring inputs belongs in this batch too.
 *
 * (The two then revalidate differently: scores eagerly, via
 * scheduleTaskRevalidation below; field analysis lazily, on read — it is far
 * more expensive and read by far fewer people. See field-analysis-store.ts.)
 *
 * Best-effort like audit(): a failure must never fail the mutation itself.
 */
export async function bumpScoreInputs(
  db: D1Database,
  taskIds: number[]
): Promise<void> {
  if (taskIds.length === 0) return;
  try {
    await db.batch(
      taskIds.flatMap((id) => [
        db
          .prepare(
            `INSERT INTO task_scores (
               task_id, response_json, state_key, computed_at,
               engine_version, inputs_rev, computed_rev, revalidating_until
             ) VALUES (?, '', '', '', 0, 1, -1, '')
             ON CONFLICT(task_id) DO UPDATE SET
               inputs_rev = task_scores.inputs_rev + 1`
          )
          .bind(id),
        fieldAnalysisBumpStatement(db, id),
      ])
    );
  } catch (err) {
    console.error("bumpScoreInputs failed", err, { taskIds });
  }
}

/** Task IDs whose scores a change to these pilots can affect: the tasks
 * where they have a track OR a manual flight (issue #306). Query BEFORE
 * deleting pilots — the cascade removes the very rows this looks at. */
export async function taskIdsForPilots(
  db: D1Database,
  compPilotIds: number[]
): Promise<number[]> {
  if (compPilotIds.length === 0) return [];
  const placeholders = compPilotIds.map(() => "?").join(", ");
  const rows = await db
    .prepare(
      `SELECT task_id FROM task_track WHERE comp_pilot_id IN (${placeholders})
       UNION
       SELECT task_id FROM task_manual_flight WHERE comp_pilot_id IN (${placeholders})`
    )
    .bind(...compPilotIds, ...compPilotIds)
    .all<{ task_id: number }>();
  return rows.results.map((r) => r.task_id);
}

/** All scoreable task IDs of a comp — for comp-wide scoring-input changes
 * (scoring_format, gap_params). */
export async function taskIdsForComp(
  db: D1Database,
  compId: number
): Promise<number[]> {
  const rows = await db
    .prepare(
      `SELECT task_id FROM task WHERE comp_id = ? AND xctsk IS NOT NULL`
    )
    .bind(compId)
    .all<{ task_id: number }>();
  return rows.results.map((r) => r.task_id);
}

// ---------------------------------------------------------------------------
// Revalidation: the only writer of response_json
// ---------------------------------------------------------------------------

/** The subset of Env revalidation needs — accepting it (rather than a Hono
 * context) keeps the store callable from tests and non-request code. */
export type ScoreStoreEnv = Pick<Env, "DB" | "R2" | "SQIDS_ALPHABET">;

/** Structural view of a Hono context: just the bindings and the (possibly
 * absent — the getter throws outside a Worker request) execution context. */
export interface ScoreStoreContext {
  env: Env;
  executionCtx: { waitUntil(promise: Promise<unknown>): void };
}

/**
 * Schedule background revalidation of the given tasks. Uses the request's
 * waitUntil so the caller's response is never blocked; outside a Worker
 * request context (no ExecutionContext) it runs fire-and-forget.
 */
export function scheduleTaskRevalidation(
  c: ScoreStoreContext,
  taskIds: number[]
): void {
  if (taskIds.length === 0) return;
  const run = () =>
    Promise.allSettled(taskIds.map((id) => revalidateTaskScores(c.env, id)));
  try {
    c.executionCtx.waitUntil(run());
  } catch {
    // Hono throws when there is no ExecutionContext (e.g. tests invoking the
    // app directly). Revalidation is best-effort; run it unanchored.
    void run().catch(() => {});
  }
}

/** bumpScoreInputs + scheduleTaskRevalidation — the pairing every
 * score-affecting route handler calls right after its write, beside audit(). */
export async function bumpAndRevalidateScores(
  c: ScoreStoreContext,
  taskIds: number[]
): Promise<void> {
  await bumpScoreInputs(c.env.DB, taskIds);
  scheduleTaskRevalidation(c, taskIds);
}

/**
 * Recompute one task's scores if its inputs demand it — the background half
 * of stale-first. Exactly-once under concurrency:
 *
 * 1. Take the lock: a conditional UPDATE on revalidating_until. Zero rows
 *    changed means another revalidation holds a live lease (or the task has
 *    no row) — stop.
 * 2. Capture rev = inputs_rev, then compute from current inputs.
 * 3. Guarded write (see storeComputedTaskScore): fresh iff inputs_rev is
 *    still rev; otherwise the blob still lands but the row stays stale and
 *    the next trigger converges it.
 */
export async function revalidateTaskScores(
  env: ScoreStoreEnv,
  taskId: number
): Promise<void> {
  const now = Date.now();
  const lease = new Date(now + REVALIDATION_LEASE_MS).toISOString();
  const lock = await env.DB.prepare(
    `UPDATE task_scores SET revalidating_until = ?
     WHERE task_id = ? AND revalidating_until < ?`
  )
    .bind(lease, taskId, new Date(now).toISOString())
    .run();
  if (lock.meta.changes === 0) return;

  const releaseLock = async () => {
    try {
      await env.DB.prepare(
        `UPDATE task_scores SET revalidating_until = ''
         WHERE task_id = ? AND revalidating_until = ?`
      )
        .bind(taskId, lease)
        .run();
    } catch (err) {
      console.error("revalidation lock release failed", err, { taskId });
    }
  };

  try {
    const row = await env.DB.prepare(
      `SELECT inputs_rev, computed_rev, engine_version FROM task_scores
       WHERE task_id = ?`
    )
      .bind(taskId)
      .first<Pick<TaskScoreRow, "inputs_rev" | "computed_rev" | "engine_version">>();
    const task = await env.DB.prepare(
      `SELECT xctsk FROM task WHERE task_id = ?`
    )
      .bind(taskId)
      .first<{ xctsk: string | null }>();
    if (!row || !task) return; // task deleted under us — cascade cleans up
    if (
      row.computed_rev >= 0 &&
      row.computed_rev === row.inputs_rev &&
      row.engine_version === SCORING_ENGINE_VERSION
    ) {
      // Already fresh — an earlier trigger finished between our caller
      // observing staleness and us taking the lock. Don't recompute, and
      // don't sit on the lease.
      await releaseLock();
      return;
    }
    if (!task.xctsk) {
      // Not scoreable (route cleared / never set). Leave the placeholder —
      // the endpoint 422s before ever reading it.
      await releaseLock();
      return;
    }
    await computeAndStoreTaskScore(env, taskId, row.inputs_rev);
    // The store write clears the lock when it lands; when its freshness
    // guard filtered the write (a newer result is already in place), release
    // explicitly so the lease doesn't outlive the work.
    await releaseLock();
  } catch (err) {
    console.error("score revalidation failed", err, { taskId });
    // Release so the next stale read can retry immediately instead of
    // waiting out the lease.
    await releaseLock();
  }
}

/**
 * Compute a task's scores from its current inputs and store them, tagged as
 * computed from revision `rev` (the inputs_rev captured BEFORE reading any
 * scoring input — pass 0 when the task has no row yet). Also the synchronous
 * cold path for rowless tasks.
 *
 * The write is a guarded upsert rather than a blind one:
 * - `computed_rev` is set to `rev`; whether the row then reads as fresh is
 *   simply whether inputs_rev still equals rev — a result computed from
 *   superseded inputs stays stale by construction, no flag to get wrong.
 * - The guard only lets a write through when it is newer than what the row
 *   holds (higher computed_rev, or a changed engine version), so a slow
 *   writer that lost a lock-lease race cannot regress a newer result.
 * - `inputs_rev` is never touched on conflict — mutations own it.
 *
 * Returns the stored blob (+ its state key) so the cold read path can serve
 * exactly what it stored. Storage failures are logged, not thrown — serving
 * the freshly computed result still beats a 500.
 */
export async function computeAndStoreTaskScore(
  env: ScoreStoreEnv,
  taskId: number,
  rev: number
): Promise<{ response: StoredTaskScore; stateKey: string }> {
  const result = await computeTaskScore(
    taskId,
    env.DB,
    env.R2,
    env.SQIDS_ALPHABET
  );
  const stateKey = await computeScoreStateKey(taskId, env.DB);
  const response: StoredTaskScore = {
    ...result,
    computed_at: new Date().toISOString(),
  };
  try {
    await env.DB.prepare(
      `INSERT INTO task_scores (
         task_id, response_json, state_key, computed_at,
         engine_version, inputs_rev, computed_rev, revalidating_until
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, '')
       ON CONFLICT(task_id) DO UPDATE SET
         response_json = excluded.response_json,
         state_key = excluded.state_key,
         computed_at = excluded.computed_at,
         engine_version = excluded.engine_version,
         computed_rev = ?6,
         revalidating_until = ''
       WHERE task_scores.computed_rev < ?6
          OR task_scores.engine_version != ?5`
    )
      .bind(
        taskId,
        JSON.stringify(response),
        stateKey,
        response.computed_at,
        SCORING_ENGINE_VERSION,
        rev
      )
      .run();
  } catch (err) {
    // E.g. the task was deleted mid-compute (FK) — nothing to store.
    console.error("task_scores store write failed", err, { taskId, rev });
  }
  return { response, stateKey };
}

// ---------------------------------------------------------------------------
// ETag helpers
// ---------------------------------------------------------------------------

/** Wrap a state key as a quoted HTTP ETag value. */
export function toEtag(stateKey: string): string {
  return `"${stateKey}"`;
}

/** Does an If-None-Match header match this state key? Handles `*`, comma
 * lists, weak validators, and quoting — browsers echo the ETag back
 * verbatim, but intermediaries may weaken it. */
export function ifNoneMatchMatches(
  header: string | undefined,
  stateKey: string
): boolean {
  if (!header) return false;
  if (header.trim() === "*") return true;
  return header
    .split(",")
    .map((t) => t.trim().replace(/^W\//i, "").replace(/^"|"$/g, ""))
    .includes(stateKey);
}
