/**
 * Stale-first task-analysis storage — the D1 `task_analysis` table.
 * See docs/2026-07-18-field-analysis-plan.md and migration 0019.
 *
 * A deliberate SIBLING of score-store.ts rather than a shared abstraction:
 * the two follow the same stale-first contract (reads never compute; a lease
 * lock makes revalidation exactly-once; a guarded CAS write can never record
 * a result computed from superseded inputs as fresh), but they differ in
 * enough places — two version stamps, a gzipped blob, an error column, no
 * synchronous cold path — that one generalised store would be harder to read
 * than two clear ones. Keep them in sync by hand; the shapes are small.
 *
 * Two deliberate differences from scores, both because this compute is
 * expensive (every pilot's full tracklog in memory at once) and read by a
 * handful of admins rather than everyone:
 *
 *   * Revalidation is LAZY — triggered by a read of a stale row, not by the
 *     mutation. Recomputing on every one of the 28 score-affecting mutations
 *     (every IGC upload!) would multiply CPU and R2 traffic for a report
 *     nobody asked for.
 *   * The cold path never computes synchronously. A rowless task returns a
 *     "pending" response and schedules the work; the UI polls.
 *
 * Invalidation is shared: bumpScoreInputs() in score-store.ts bumps BOTH
 * tables in one batch, because task analysis is a function of exactly the
 * same inputs as scores. There is no separate bump at the mutation sites.
 */

import { SCORING_ENGINE_VERSION, TASK_ANALYSIS_VERSION } from "@glidecomp/engine";
import type { Env } from "./env";
import { computeScoreStateKey } from "./scoring";
import {
  computeTaskAnalysis,
  TaskAnalysisUnsupported,
  type TaskAnalysisResponse,
} from "./task-analysis";

/**
 * A BLOB as D1 hands it back. D1 accepts an ArrayBuffer on the way in but
 * returns a plain byte ARRAY on the way out — not an ArrayBuffer, and not a
 * Uint8Array. Reading `.byteLength` on it is silently `undefined`, so every
 * read goes through blobBytes() below.
 */
type D1Blob = number[] | ArrayBuffer | Uint8Array;

/**
 * Normalize D1's BLOB representation to a standalone ArrayBuffer.
 *
 * Returns a buffer rather than a view because this feeds `new Response(...)`,
 * and the frontend typecheck (which compiles the worker's types through the
 * DOM lib) rejects a Uint8Array as BodyInit.
 */
function blobBytes(blob: D1Blob): ArrayBuffer {
  if (blob instanceof ArrayBuffer) return blob;
  const view = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  const out = new ArrayBuffer(view.byteLength);
  new Uint8Array(out).set(view);
  return out;
}

/** One materialized row of the task_analysis table. */
export interface TaskAnalysisRow {
  task_id: number;
  report_gz: D1Blob;
  state_key: string;
  computed_at: string;
  engine_version: number;
  analysis_version: number;
  inputs_rev: number;
  computed_rev: number;
  revalidating_until: string;
  compute_ms: number;
  error: string;
}

/** The stored blob: the report plus its compute timestamp. The read-time
 * `stale`/`pending` flags are added by the endpoint. */
export type StoredTaskAnalysis = TaskAnalysisResponse & {
  computed_at: string;
};

/** Longer than the score lease: a cold task analysis parses the whole
 * field's tracklogs, so a legitimate compute can run for many seconds. */
export const FIELD_REVALIDATION_LEASE_MS = 300_000;

/**
 * True when the row's report was computed from superseded inputs, by a
 * different scoring engine (which moves the ranks every correlation is
 * measured against), or by different metric code (which moves the values).
 */
export function isFieldRowStale(row: TaskAnalysisRow): boolean {
  return (
    row.computed_rev < row.inputs_rev ||
    row.engine_version !== SCORING_ENGINE_VERSION ||
    row.analysis_version !== TASK_ANALYSIS_VERSION
  );
}

/** True when the row carries a servable report (false for placeholder rows
 * created by an inputs bump that landed before the first compute, and for
 * rows whose last compute failed). */
export function fieldRowHasResult(row: TaskAnalysisRow): boolean {
  // NOT row.report_gz.byteLength — D1 hands BLOBs back as a plain byte array,
  // where that property is silently undefined and every row would read cold.
  return row.computed_rev >= 0 && blobLength(row.report_gz) > 0;
}

/** Byte length of a D1 BLOB in any of the shapes it can arrive in. */
function blobLength(blob: D1Blob): number {
  if (Array.isArray(blob)) return blob.length;
  return blob.byteLength;
}

export async function readTaskAnalysisRow(
  db: D1Database,
  taskId: number
): Promise<TaskAnalysisRow | null> {
  return db
    .prepare(`SELECT * FROM task_analysis WHERE task_id = ?`)
    .bind(taskId)
    .first<TaskAnalysisRow>();
}

/** All rows for a comp's scoreable (route-bearing) tasks, keyed by task_id. */
export async function readTaskAnalysisRowsForComp(
  db: D1Database,
  compId: number
): Promise<Map<number, TaskAnalysisRow>> {
  const rows = await db
    .prepare(
      `SELECT fa.* FROM task_analysis fa
       JOIN task t ON t.task_id = fa.task_id
       WHERE t.comp_id = ? AND t.xctsk IS NOT NULL`
    )
    .bind(compId)
    .all<TaskAnalysisRow>();
  return new Map(rows.results.map((r) => [r.task_id, r]));
}

// ---------------------------------------------------------------------------
// Gzip helpers — the blob is per-pilot × per-metric and compresses ~10x
// ---------------------------------------------------------------------------

async function gzipJson(value: unknown): Promise<ArrayBuffer> {
  const stream = new Response(
    new TextEncoder().encode(JSON.stringify(value))
  ).body!.pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

async function gunzipJson<T>(blob: D1Blob): Promise<T> {
  const stream = new Response(blobBytes(blob)).body!.pipeThrough(
    new DecompressionStream("gzip")
  );
  return JSON.parse(await new Response(stream).text()) as T;
}

/** Decode a stored row's report (null when the row carries no result). */
export async function decodeTaskAnalysisRow(
  row: TaskAnalysisRow
): Promise<StoredTaskAnalysis | null> {
  if (!fieldRowHasResult(row)) return null;
  try {
    return await gunzipJson<StoredTaskAnalysis>(row.report_gz);
  } catch (err) {
    console.error("task analysis blob decode failed", err, {
      taskId: row.task_id,
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Mutation side
// ---------------------------------------------------------------------------

/**
 * Mark ONLY the task analysis of these tasks stale, without touching the
 * scores. For the explicit "recompute the analysis" admin action and for
 * recovering a row whose last compute errored — the routine path is
 * bumpScoreInputs(), which bumps both tables together.
 *
 * Best-effort like audit(): a failure must never fail the request.
 */
export async function bumpTaskAnalysisInputs(
  db: D1Database,
  taskIds: number[]
): Promise<void> {
  if (taskIds.length === 0) return;
  try {
    await db.batch(taskIds.map((id) => taskAnalysisBumpStatement(db, id)));
  } catch (err) {
    console.error("bumpTaskAnalysisInputs failed", err, { taskIds });
  }
}

/**
 * Create a task's placeholder row if it has none, without disturbing an
 * existing one. Distinct from a bump: this claims no pending revision, it
 * just gives the lease lock something to grab.
 */
export async function ensureTaskAnalysisRow(
  db: D1Database,
  taskId: number
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO task_analysis (
           task_id, report_gz, state_key, computed_at, engine_version,
           analysis_version, inputs_rev, computed_rev, revalidating_until,
           compute_ms, error
         ) VALUES (?, x'', '', '', 0, 0, 0, -1, '', 0, '')
         ON CONFLICT(task_id) DO NOTHING`
      )
      .bind(taskId)
      .run();
  } catch (err) {
    console.error("ensureTaskAnalysisRow failed", err, { taskId });
  }
}

/**
 * The upsert that marks one task's analysis stale. Exported as a
 * statement (not a query) so bumpScoreInputs() can run it in its own batch
 * right after the score bump — which is what keeps the 28 mutation call
 * sites from ever learning this table exists.
 */
export function taskAnalysisBumpStatement(
  db: D1Database,
  taskId: number
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO task_analysis (
         task_id, report_gz, state_key, computed_at, engine_version,
         analysis_version, inputs_rev, computed_rev, revalidating_until,
         compute_ms, error
       ) VALUES (?, x'', '', '', 0, 0, 1, -1, '', 0, '')
       ON CONFLICT(task_id) DO UPDATE SET
         inputs_rev = task_analysis.inputs_rev + 1`
    )
    .bind(taskId);
}

// ---------------------------------------------------------------------------
// Revalidation: the only writer of report_gz
// ---------------------------------------------------------------------------

export type TaskAnalysisStoreEnv = Pick<Env, "DB" | "R2" | "SQIDS_ALPHABET">;

/** Structural view of a Hono context — see ScoreStoreContext. */
export interface TaskAnalysisStoreContext {
  env: Env;
  executionCtx: { waitUntil(promise: Promise<unknown>): void };
}

/**
 * All scheduled compute work in this isolate forms ONE serial queue — at most
 * one whole-field compute runs at a time, no matter how many requests
 * schedule work. Never rejects: every link swallows its own failure.
 *
 * Why a module-level queue and not just a serial loop per call: the pending
 * UI (and the e2e helper) POLLS this endpoint every couple of seconds, and
 * every poll schedules the still-cold tasks again. A per-call loop starts a
 * new chain per poll; the per-task lease makes the duplicate work a no-op
 * but each new chain skips the leased task and starts computing the NEXT
 * cold one — so polling quietly rebuilt the very concurrency the loop was
 * meant to remove, one compute per poll. Chaining every batch onto one
 * isolate-wide promise is what actually bounds it.
 */
let revalidationQueue: Promise<void> = Promise.resolve();

/**
 * Schedule background recomputation of these tasks' field analyses. Called
 * from the READ path when it serves a stale or pending row (and from the
 * explicit refresh action) — never from a mutation.
 *
 * ONE task at a time, deliberately (via revalidationQueue above). A
 * whole-field compute is the heaviest thing this worker does (every pilot's
 * raw fixes in memory at once — see MAX_TASK_ANALYSIS_TRACKS), and
 * everything here shares the isolate and budget of the requests that
 * schedule it: waitUntil extends the invocation, it doesn't move the work.
 * Serial bounds the peak at one field's worth however hard the endpoint is
 * polled.
 *
 * Under `wrangler dev`, know that even ONE such compute can kill the
 * session on a CPU-starved machine: multi-second CPU-pegged stretches in
 * workerd starve wrangler's internal loopback until a connection drops, and
 * wrangler treats that as fatal (issue #477's crash — reproduced in a
 * CPU-constrained container, where the same polling under the same load
 * WITHOUT the compute never died, PR #609). The supervisor restarts it, but
 * that is why seeding warms these rows (seed-sample-comp.ts) instead of
 * leaving the first reader to trigger the compute inside workerd, and why
 * the e2e poll helper tolerates a mid-poll restart. The caller already
 * answered `pending`/stale before this runs, so serial costs nothing a
 * reader can see; each task's row still lands as it finishes.
 */
export function scheduleTaskAnalysisRevalidation(
  c: TaskAnalysisStoreContext,
  taskIds: number[]
): void {
  if (taskIds.length === 0) return;
  const chained = (revalidationQueue = revalidationQueue.then(async () => {
    for (const id of taskIds) {
      // One failed task must not cost the rest their recompute.
      await revalidateTaskAnalysis(c.env, id).catch(() => {});
    }
  }));
  try {
    // The queue may be carrying earlier batches; waiting on `chained` keeps
    // this invocation alive through those too. That is the point — the work
    // must outlive whichever request happens to be at the head of the queue.
    c.executionCtx.waitUntil(chained);
  } catch {
    // No ExecutionContext (e.g. tests invoking the app directly).
    void chained.catch(() => {});
  }
}

/**
 * Recompute one task's analysis if its inputs demand it. Exactly-once
 * under concurrency, by the same three steps as revalidateTaskScores:
 * take a lease lock, capture inputs_rev, then write under a freshness guard.
 */
export async function revalidateTaskAnalysis(
  env: TaskAnalysisStoreEnv,
  taskId: number
): Promise<void> {
  // The lock below is an UPDATE, which changes nothing when the task has no
  // row — and unlike scores, NOTHING else creates one: task analysis never
  // computes on the request path, so a task that has never been mutated
  // since this feature shipped would stay coldForever. Seed a placeholder
  // first (inputs_rev 0, computed_rev -1 = "cold, nothing pending"), leaving
  // an existing row untouched so this can't clobber a live revision.
  await ensureTaskAnalysisRow(env.DB, taskId);

  const now = Date.now();
  const lease = new Date(now + FIELD_REVALIDATION_LEASE_MS).toISOString();
  const lock = await env.DB.prepare(
    `UPDATE task_analysis SET revalidating_until = ?
     WHERE task_id = ? AND revalidating_until < ?`
  )
    .bind(lease, taskId, new Date(now).toISOString())
    .run();
  if (lock.meta.changes === 0) return;

  const releaseLock = async () => {
    try {
      await env.DB.prepare(
        `UPDATE task_analysis SET revalidating_until = ''
         WHERE task_id = ? AND revalidating_until = ?`
      )
        .bind(taskId, lease)
        .run();
    } catch (err) {
      console.error("task analysis lock release failed", err, { taskId });
    }
  };

  try {
    const row = await env.DB.prepare(
      `SELECT inputs_rev, computed_rev, engine_version, analysis_version
       FROM task_analysis WHERE task_id = ?`
    )
      .bind(taskId)
      .first<
        Pick<
          TaskAnalysisRow,
          "inputs_rev" | "computed_rev" | "engine_version" | "analysis_version"
        >
      >();
    const task = await env.DB.prepare(`SELECT xctsk FROM task WHERE task_id = ?`)
      .bind(taskId)
      .first<{ xctsk: string | null }>();
    if (!row || !task) return; // task deleted under us — cascade cleans up
    if (
      row.computed_rev >= 0 &&
      row.computed_rev === row.inputs_rev &&
      row.engine_version === SCORING_ENGINE_VERSION &&
      row.analysis_version === TASK_ANALYSIS_VERSION
    ) {
      // Already fresh — an earlier trigger finished between our caller
      // observing staleness and us taking the lock.
      await releaseLock();
      return;
    }
    if (!task.xctsk) {
      await releaseLock();
      return;
    }
    await computeAndStoreTaskAnalysis(env, taskId, row.inputs_rev);
    await releaseLock();
  } catch (err) {
    console.error("task analysis revalidation failed", err, { taskId });
    await releaseLock();
  }
}

/**
 * Compute a task's analysis from its current inputs and store it,
 * tagged as computed from revision `rev`. The write is the same guarded
 * upsert as scores: `computed_rev` is set to `rev`, so whether the row reads
 * fresh is simply whether inputs_rev still equals rev, and the guard stops a
 * slow writer from regressing a newer result.
 *
 * A TaskAnalysisUnsupported task (open distance, no tracks, too many tracks)
 * is not an error to retry: it stores an EMPTY row carrying the explanation,
 * marked computed at this revision, so the endpoint can say why instead of
 * recomputing the same refusal on every read.
 */
export async function computeAndStoreTaskAnalysis(
  env: TaskAnalysisStoreEnv,
  taskId: number,
  rev: number
): Promise<{ report: StoredTaskAnalysis | null; error: string }> {
  const startedAt = Date.now();
  let report: StoredTaskAnalysis | null = null;
  let error = "";
  try {
    const result = await computeTaskAnalysis(
      taskId,
      env.DB,
      env.R2,
      env.SQIDS_ALPHABET
    );
    report = { ...result, computed_at: new Date().toISOString() };
  } catch (err) {
    if (err instanceof TaskAnalysisUnsupported) {
      error = err.message;
    } else {
      // A real failure (R2 outage, engine bug on one malformed track). It
      // MUST land in the error column — rethrowing here would leave the row
      // at computed_rev = -1, indistinguishable from cold, so the UI would
      // show "being computed" forever while every page view re-triggered the
      // whole-field compute: an invisible retry loop with no backoff. Stored
      // as computed-at-this-rev instead, the row serves the error and stops
      // retrying; the next input change or an explicit refresh recomputes.
      console.error("task analysis compute failed", err, { taskId });
      error = `Analysis failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  const stateKey = await computeScoreStateKey(taskId, env.DB);
  const computedAt = report?.computed_at ?? new Date().toISOString();
  const computeMs = Date.now() - startedAt;
  const blob = report ? await gzipJson(report) : new ArrayBuffer(0);

  try {
    await env.DB.prepare(
      `INSERT INTO task_analysis (
         task_id, report_gz, state_key, computed_at, engine_version,
         analysis_version, inputs_rev, computed_rev, revalidating_until,
         compute_ms, error
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, '', ?8, ?9)
       ON CONFLICT(task_id) DO UPDATE SET
         report_gz = excluded.report_gz,
         state_key = excluded.state_key,
         computed_at = excluded.computed_at,
         engine_version = excluded.engine_version,
         analysis_version = excluded.analysis_version,
         computed_rev = ?7,
         revalidating_until = '',
         compute_ms = excluded.compute_ms,
         error = excluded.error
       WHERE task_analysis.computed_rev < ?7
          OR task_analysis.engine_version != ?5
          OR task_analysis.analysis_version != ?6`
    )
      .bind(
        taskId,
        blob,
        stateKey,
        computedAt,
        SCORING_ENGINE_VERSION,
        TASK_ANALYSIS_VERSION,
        rev,
        computeMs,
        error
      )
      .run();
  } catch (err) {
    console.error("task_analysis store write failed", err, { taskId, rev });
  }

  return { report, error };
}
