/**
 * Stale-first weather storage — the D1 `task_weather` table (migration 0023).
 *
 * A third sibling of score-store.ts and field-analysis-store.ts rather than a
 * shared abstraction, for the same reason those two are separate from each
 * other: the contract is the same (reads never fetch; a lease lock makes the
 * background job exactly-once; a guarded write can't record a superseded
 * result), but the invalidation model genuinely differs, and one generalised
 * store would hide that difference instead of documenting it.
 *
 * The difference, stated once: WEATHER IS NOT DERIVED FROM COMPETITION DATA.
 * It is a function of a place and a past interval, and a past interval's
 * weather never changes. So there is no inputs_rev and no bump at the
 * mutation sites — deliberately, not by omission. What could change is WHICH
 * place and interval we should be asking about, and that is captured by the
 * engine's `weatherQueryKey`: move the route or the date and the key stops
 * matching the stored row, which re-fetches on next read. Self-invalidating,
 * with nothing to remember.
 *
 * Freshness is derived, never stored. A row is fresh iff
 *   its query_key matches the task's current key, AND
 *   it was written by this WEATHER_SCHEMA_VERSION, AND
 *   it isn't a provisional answer past its TTL, AND
 *   it isn't a failure still inside its backoff.
 *
 * Like field analysis, the cold path never fetches synchronously: an
 * outbound API call has no business blocking a page render.
 */

import {
  WEATHER_SCHEMA_VERSION,
  fetchTaskWeather,
  parseXCTask,
  weatherQueryForTask,
  weatherQueryKey,
  type TaskWeather,
  type WeatherFetchFn,
  type WeatherProvider,
} from "@glidecomp/engine";
import type { Env } from "./env";

/** One materialized row of the task_weather table. */
export interface TaskWeatherRow {
  task_id: number;
  weather_json: string;
  query_key: string;
  schema_version: number;
  provider_id: string;
  fetched_at: string;
  provisional: number;
  fetching_until: string;
  error: string;
  attempts: number;
}

/** The stored blob is the engine's TaskWeather verbatim. */
export type StoredWeather = TaskWeather;

/**
 * How long one fetch may hold the lock before another may steal it. Short
 * relative to the score/analysis leases because this is one HTTP round trip
 * to a third party, not a whole-field compute — if it hasn't returned in a
 * minute it is wedged, and a retry is the right answer.
 */
export const WEATHER_FETCH_LEASE_MS = 60_000;

/**
 * How long a PROVISIONAL answer is served before re-fetching. Six hours
 * re-checks a same-day task a few times as the model runs and the reanalysis
 * catch up, without hammering the provider for a comp nobody is reading.
 */
export const PROVISIONAL_TTL_MS = 6 * 3_600_000;

/**
 * Backoff after consecutive failures: 15 min, 1 h, 4 h, then daily. A comp
 * with a route in the middle of the ocean, or a provider having a bad week,
 * must not turn every page view into an outbound request.
 */
const BACKOFF_MS = [15 * 60_000, 3_600_000, 4 * 3_600_000, 24 * 3_600_000];

export function backoffMsFor(attempts: number): number {
  if (attempts <= 0) return 0;
  return BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1];
}

/**
 * True when this row should be replaced. `queryKey` is the task's CURRENT
 * key — pass null when it can't be derived (no route, no date), in which
 * case nothing can be fetched and the row is left alone.
 */
export function isWeatherRowStale(
  row: TaskWeatherRow,
  queryKey: string,
  nowMs: number
): boolean {
  if (row.schema_version !== WEATHER_SCHEMA_VERSION) return true;
  if (row.query_key !== queryKey) return true;

  const fetchedMs = Date.parse(row.fetched_at);
  const age = Number.isFinite(fetchedMs) ? nowMs - fetchedMs : Infinity;

  // A failed row is stale only once its backoff has elapsed; until then it
  // is deliberately served as-is so the read path stops re-triggering.
  if (row.error) return age >= backoffMsFor(row.attempts);

  if (row.provisional) return age >= PROVISIONAL_TTL_MS;
  return false;
}

/** True when the row carries a servable answer. */
export function weatherRowHasResult(row: TaskWeatherRow): boolean {
  return row.weather_json !== "";
}

/**
 * Should the read path schedule a fetch for this task right now?
 *
 * The single decision point, because the cold case is the easy one to get
 * wrong: a task whose fetch keeps FAILING has no stored result, so a route
 * that scheduled on "no result" would fire an outbound request on every
 * page view and never back off. A missing row means never attempted (fetch
 * it); any existing row — result or not — is governed by the same staleness
 * rule, which already encodes the failure backoff.
 */
export function shouldFetchWeather(
  row: TaskWeatherRow | null,
  queryKey: string,
  nowMs: number
): boolean {
  if (!row) return true;
  return isWeatherRowStale(row, queryKey, nowMs);
}

/** Decode a row's stored weather (null when absent or corrupt). */
export function decodeWeatherRow(row: TaskWeatherRow): StoredWeather | null {
  if (!weatherRowHasResult(row)) return null;
  try {
    return JSON.parse(row.weather_json) as StoredWeather;
  } catch (err) {
    console.error("weather blob decode failed", err, { taskId: row.task_id });
    return null;
  }
}

export async function readWeatherRow(
  db: D1Database,
  taskId: number
): Promise<TaskWeatherRow | null> {
  return db
    .prepare(`SELECT * FROM task_weather WHERE task_id = ?`)
    .bind(taskId)
    .first<TaskWeatherRow>();
}

// ---------------------------------------------------------------------------
// The task's current query
// ---------------------------------------------------------------------------

/** A task's route and date, as the query derivation needs them. */
interface TaskWeatherInputs {
  xctsk: string | null;
  task_date: string | null;
}

/**
 * The weather query a task currently implies, or null when it can't have one
 * (no route, unparseable route, no date). Shared by the read path and the
 * fetcher so the key they compare is derived exactly once, from one function.
 */
export function queryForTaskRow(task: TaskWeatherInputs) {
  if (!task.xctsk || !task.task_date) return null;
  try {
    // parseXCTask takes the raw JSON TEXT (it also handles the XCTSK: QR
    // prefix), which is exactly what the `xctsk` column holds — do not
    // JSON.parse it first.
    const parsed = parseXCTask(task.xctsk);
    return weatherQueryForTask(parsed, task.task_date);
  } catch (err) {
    console.error("weather query derivation failed", err);
    return null;
  }
}

export async function readTaskWeatherInputs(
  db: D1Database,
  taskId: number
): Promise<TaskWeatherInputs | null> {
  return db
    .prepare(`SELECT xctsk, task_date FROM task WHERE task_id = ?`)
    .bind(taskId)
    .first<TaskWeatherInputs>();
}

// ---------------------------------------------------------------------------
// Invalidation (the explicit kind — the routine kind is the key mismatch)
// ---------------------------------------------------------------------------

/**
 * Force a re-fetch of these tasks' weather by clearing the stored key.
 *
 * NOT called from the mutation sites — the key comparison already handles
 * every routine cause. This is for the admin "refresh weather" action and
 * for recovering a row wedged by a provider outage: clearing query_key
 * makes the row unconditionally stale AND resets the failure backoff, so
 * the next read schedules a fetch immediately.
 *
 * Best-effort like audit(): a failure must never fail the request.
 */
export async function invalidateWeather(
  db: D1Database,
  taskIds: number[]
): Promise<void> {
  if (taskIds.length === 0) return;
  try {
    await db.batch(
      taskIds.map((id) =>
        db
          .prepare(
            `UPDATE task_weather
             SET query_key = '', attempts = 0, error = '', fetching_until = ''
             WHERE task_id = ?`
          )
          .bind(id)
      )
    );
  } catch (err) {
    console.error("invalidateWeather failed", err, { taskIds });
  }
}

// ---------------------------------------------------------------------------
// Fetching: the only writer of weather_json
// ---------------------------------------------------------------------------

export type WeatherStoreEnv = Pick<Env, "DB">;

/**
 * Did this write fail because the task no longer exists?
 *
 * The fetch takes an HTTP round trip, and nothing stops an organiser (or the
 * e2e reseed) deleting the task while it is in flight — the ON DELETE CASCADE
 * removes the weather row, and the result write then fails its foreign key.
 * That is the fetch outliving the task, an expected outcome of scheduling
 * background work, not a fault worth a log line. `task_id → task` is the
 * table's ONLY foreign key, so an FK failure on a task_weather write can
 * mean nothing else.
 */
function isVanishedTaskError(err: unknown): boolean {
  const seen = new Set<unknown>();
  for (let e = err; e instanceof Error && !seen.has(e); e = e.cause as Error) {
    seen.add(e);
    if (/FOREIGN KEY constraint failed/i.test(e.message)) return true;
  }
  return false;
}

/** Structural view of a Hono context — see ScoreStoreContext. */
export interface WeatherStoreContext {
  env: Env;
  executionCtx: { waitUntil(promise: Promise<unknown>): void };
}

/** Injection seam for tests: swap the provider list, the clock, the transport. */
export interface WeatherFetchOverrides {
  providers?: readonly WeatherProvider[];
  nowMs?: number;
  fetchImpl?: WeatherFetchFn;
}

/**
 * workerd's global `fetch`, narrowed to the shape the engine asks for.
 *
 * The engine declares its own minimal fetch and abort types because it
 * compiles without DOM lib; this adapter is where the real platform types
 * meet them, so nothing downstream needs a cast.
 */
const platformFetch: WeatherFetchFn = (url, init) =>
  fetch(url, { signal: init?.signal as AbortSignal | undefined });

/**
 * Schedule a background weather fetch for these tasks. Called from the READ
 * path when it serves a stale or cold row (and from the admin refresh) —
 * never from a mutation, because no mutation changes the weather.
 */
export function scheduleWeatherFetch(
  c: WeatherStoreContext,
  taskIds: number[],
  overrides?: WeatherFetchOverrides
): void {
  if (taskIds.length === 0) return;
  const run = () =>
    Promise.allSettled(taskIds.map((id) => refreshTaskWeather(c.env, id, overrides)));
  try {
    c.executionCtx.waitUntil(run());
  } catch {
    // No ExecutionContext (e.g. tests invoking the app directly).
    void run().catch(() => {});
  }
}

/** Create a task's placeholder row if it has none, leaving any existing row
 * untouched — the lease lock below is an UPDATE and needs something to grab. */
async function ensureWeatherRow(db: D1Database, taskId: number): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO task_weather (task_id) VALUES (?) ON CONFLICT(task_id) DO NOTHING`
      )
      .bind(taskId)
      .run();
  } catch (err) {
    if (isVanishedTaskError(err)) return;
    console.error("ensureWeatherRow failed", err, { taskId });
  }
}

/**
 * Fetch one task's weather if its stored row demands it. Exactly-once under
 * concurrency by the same three steps as the sibling stores: seed a row,
 * take a lease lock, then re-check staleness under the lock before spending
 * an outbound request.
 */
export async function refreshTaskWeather(
  env: WeatherStoreEnv,
  taskId: number,
  overrides?: WeatherFetchOverrides
): Promise<void> {
  const nowMs = overrides?.nowMs ?? Date.now();

  const task = await readTaskWeatherInputs(env.DB, taskId);
  if (!task) return; // deleted under us — the FK cascade cleans up
  const query = queryForTaskRow(task);
  if (!query) return; // no route or no date: nothing to ask about
  const key = weatherQueryKey(query);

  await ensureWeatherRow(env.DB, taskId);

  const lease = new Date(nowMs + WEATHER_FETCH_LEASE_MS).toISOString();
  const lock = await env.DB.prepare(
    `UPDATE task_weather SET fetching_until = ?
     WHERE task_id = ? AND fetching_until < ?`
  )
    .bind(lease, taskId, new Date(nowMs).toISOString())
    .run();
  if (lock.meta.changes === 0) return; // another fetch holds the lock

  const releaseLock = async () => {
    try {
      await env.DB.prepare(
        `UPDATE task_weather SET fetching_until = ''
         WHERE task_id = ? AND fetching_until = ?`
      )
        .bind(taskId, lease)
        .run();
    } catch (err) {
      console.error("weather lock release failed", err, { taskId });
    }
  };

  try {
    const row = await readWeatherRow(env.DB, taskId);
    if (row && weatherRowHasResult(row) && !isWeatherRowStale(row, key, nowMs)) {
      // An earlier trigger finished between our caller seeing staleness and
      // us taking the lock. Don't spend a second request on the same day.
      await releaseLock();
      return;
    }

    const previousAttempts = row?.attempts ?? 0;
    try {
      const weather = await fetchTaskWeather(query, {
        fetchImpl: overrides?.fetchImpl ?? platformFetch,
        nowMs,
        providers: overrides?.providers,
      });
      await storeWeather(env.DB, taskId, key, weather);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("weather fetch failed", err, { taskId });
      await storeWeatherFailure(env.DB, taskId, key, message, previousAttempts + 1, nowMs);
    }
    await releaseLock();
  } catch (err) {
    console.error("weather refresh failed", err, { taskId });
    await releaseLock();
  }
}

/**
 * Record a successful fetch. Writes the key it was fetched FOR, so a task
 * whose route moved while the request was in flight lands as immediately
 * stale rather than as a fresh answer about the wrong place.
 */
async function storeWeather(
  db: D1Database,
  taskId: number,
  queryKey: string,
  weather: TaskWeather
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO task_weather (
           task_id, weather_json, query_key, schema_version, provider_id,
           fetched_at, provisional, fetching_until, error, attempts
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, '', '', 0)
         ON CONFLICT(task_id) DO UPDATE SET
           weather_json = excluded.weather_json,
           query_key = excluded.query_key,
           schema_version = excluded.schema_version,
           provider_id = excluded.provider_id,
           fetched_at = excluded.fetched_at,
           provisional = excluded.provisional,
           fetching_until = '',
           error = '',
           attempts = 0`
      )
      .bind(
        taskId,
        JSON.stringify(weather),
        queryKey,
        WEATHER_SCHEMA_VERSION,
        weather.source.providerId,
        weather.fetchedAt,
        weather.provisional ? 1 : 0
      )
      .run();
  } catch (err) {
    if (isVanishedTaskError(err)) return;
    console.error("task_weather store write failed", err, { taskId });
  }
}

/**
 * Record a failed fetch WITHOUT discarding any answer already stored.
 *
 * The distinction matters: a comp whose provider goes down should keep
 * showing last week's successfully fetched weather, not blank out. So this
 * writes only the failure bookkeeping — which is also what the read path's
 * backoff runs on — and leaves weather_json alone.
 *
 * Unless the KEY moved. A stored answer belongs to the query it was fetched
 * for; if the route or date changed and the fetch for the new window failed,
 * keeping the old blob under the new key would serve last week's weather for
 * a different place as if it were this task's. So the blob is dropped in
 * exactly that case, and only that one.
 */
async function storeWeatherFailure(
  db: D1Database,
  taskId: number,
  queryKey: string,
  error: string,
  attempts: number,
  nowMs: number
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO task_weather (
           task_id, weather_json, query_key, schema_version, provider_id,
           fetched_at, provisional, fetching_until, error, attempts
         ) VALUES (?1, '', ?2, ?3, '', ?4, 0, '', ?5, ?6)
         ON CONFLICT(task_id) DO UPDATE SET
           weather_json = CASE WHEN task_weather.query_key = excluded.query_key
                               THEN task_weather.weather_json ELSE '' END,
           provider_id  = CASE WHEN task_weather.query_key = excluded.query_key
                               THEN task_weather.provider_id ELSE '' END,
           query_key = excluded.query_key,
           schema_version = excluded.schema_version,
           fetched_at = excluded.fetched_at,
           fetching_until = '',
           error = excluded.error,
           attempts = excluded.attempts`
      )
      .bind(
        taskId,
        queryKey,
        WEATHER_SCHEMA_VERSION,
        new Date(nowMs).toISOString(),
        error.slice(0, 500),
        attempts
      )
      .run();
  } catch (err) {
    if (isVanishedTaskError(err)) return;
    console.error("task_weather failure write failed", err, { taskId });
  }
}
