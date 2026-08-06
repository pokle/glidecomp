/**
 * Task weather endpoints — what the sky was doing while the task was flown,
 * or what it is expected to do for a task that hasn't been flown yet. Tasks
 * are commonly set the day before, so the FUTURE case is a first-class one:
 * the engine's registry answers it from a live forecast, and this route only
 * has to know that a task set beyond the forecast horizon gets a "not yet"
 * instead of a spinner (`too_far_ahead`).
 *
 * Two independent things travel together here because a reader wants both at
 * once and they answer each other:
 *
 *   `weather` — hourly modelled conditions from an outside provider (see
 *               the engine's weather/ module). Objective, gridded, and
 *               explicitly NOT an observation of the launch.
 *   `notes`   — the organizer's own prose ("overdeveloped by 2pm, glass off
 *               at 3"). Subjective, local, and the only source that knows
 *               what a 9 km grid cell cannot.
 *
 * PUBLIC, with the same visibility rule as scores and field analysis:
 * readable by anyone for a normal comp, admin-only for a hidden `test` comp,
 * which 404s rather than 403s so the endpoint's existence isn't a signal.
 *
 * Stale-first (see weather-store.ts) with field analysis's departure: the
 * cold path NEVER fetches synchronously. Blocking a page render on a
 * third-party HTTP request would make GlideComp's availability depend on
 * Open-Meteo's, so a cold task returns `pending: true`, schedules the fetch,
 * and the UI polls. Notes are served immediately either way — they come from
 * our own database and must not wait on anyone's weather API.
 *
 * Notes are WRITTEN through the task PATCH (`weather_notes`), not here:
 * they're a column on `task`, and one mutation endpoint per resource keeps
 * the audit and validation in a single place.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { AuthedEnv } from "../env";
import { sqidsMiddleware } from "../middleware/sqids";
import { optionalAuth, requireAuth, requireCompAdmin } from "../middleware/auth";
import { isCompAdmin } from "../super-admin";
import { audit } from "../audit";
import { encodeId } from "../sqids";
import {
  decodeWeatherRow,
  invalidateWeather,
  queryForTaskRow,
  readWeatherRow,
  scheduleWeatherFetch,
  shouldFetchWeather,
  weatherRowHasResult,
  type TaskWeatherRow,
} from "../weather-store";
import {
  FORECAST_HORIZON_DAYS,
  beyondForecastHorizon,
  weatherQueryKey,
} from "@glidecomp/engine";

/**
 * Who may read task weather. Public for a normal comp; a hidden `test` comp
 * stays admin-only. Mirrors canViewFieldAnalysis exactly — if that rule
 * changes, this one changes with it.
 */
async function canViewWeather(
  c: Context<AuthedEnv>,
  compId: number,
  isTest: boolean
): Promise<boolean> {
  if (!isTest) return true;
  const user = c.var.user;
  if (!user) return false;
  return isCompAdmin(c.env.DB, compId, user);
}

/**
 * Cache-Control for weather responses.
 *
 * Longer-lived than scores by design: a settled past day's weather is
 * immutable, so once a row is neither provisional nor stale it can sit in a
 * shared cache for an hour. A signed-in viewer still gets `no-store`, since
 * the same URL serves hidden test comps to admins.
 */
function cacheControl(c: Context<AuthedEnv>, stale: boolean): string {
  if (c.var.user) return "private, no-store";
  if (stale) return "public, max-age=60, must-revalidate";
  return "public, max-age=3600, must-revalidate";
}

/** The task fields both endpoints need. */
interface TaskRow {
  task_id: number;
  name: string;
  xctsk: string | null;
  task_date: string | null;
  weather_notes: string | null;
}

export const weatherRoutes = new Hono<AuthedEnv>()

  // ── GET /api/comp/:comp_id/task/:task_id/weather ──
  .get(
    "/api/comp/:comp_id/task/:task_id/weather",
    optionalAuth,
    sqidsMiddleware,
    async (c) => {
      const compId = c.var.ids.comp_id!;
      const taskId = c.var.ids.task_id!;
      const alphabet = c.env.SQIDS_ALPHABET;

      const comp = await c.env.DB.prepare(
        "SELECT comp_id, test FROM comp WHERE comp_id = ?"
      )
        .bind(compId)
        .first<{ comp_id: number; test: number }>();
      if (!comp) return c.json({ error: "Not found" }, 404);
      if (!(await canViewWeather(c, compId, !!comp.test)))
        return c.json({ error: "Not found" }, 404);

      const task = await c.env.DB.prepare(
        `SELECT task_id, name, xctsk, task_date, weather_notes
         FROM task WHERE task_id = ? AND comp_id = ?`
      )
        .bind(taskId, compId)
        .first<TaskRow>();
      if (!task) return c.json({ error: "Task not found" }, 404);

      const notes = task.weather_notes ?? "";
      const base = {
        task_id: encodeId(alphabet, taskId),
        comp_id: encodeId(alphabet, compId),
        notes,
      };

      // A task with no route (or no date) has no place and no window to ask
      // about. That is a permanent state of this task, not a pending fetch —
      // say so, so the UI shows an explanation instead of a spinner.
      const query = queryForTaskRow(task);
      if (!query) {
        return c.json(
          {
            ...base,
            weather: null,
            stale: false,
            pending: false,
            too_far_ahead: false,
            error: "Task has no route or date — nothing to look up the weather for",
          },
          200,
          { "Cache-Control": cacheControl(c, false) }
        );
      }

      const key = weatherQueryKey(query);
      const row = await readWeatherRow(c.env.DB, taskId);
      const nowMs = Date.now();

      // A comp can be laid out weeks ahead, and no forecast reaches that far.
      // Saying so is both kinder and cheaper than scheduling a fetch that can
      // only fail and then hold the task in a backoff of up to a day — which
      // is precisely the window in which the forecast becomes available.
      const tooFarAhead = beyondForecastHorizon(query, nowMs);
      const wantsFetch = !tooFarAhead && shouldFetchWeather(row, key, nowMs);
      if (wantsFetch) scheduleWeatherFetch(c, [taskId]);

      if (row && weatherRowHasResult(row)) {
        const weather = decodeWeatherRow(row);
        if (weather) {
          return c.json(
            {
              ...base,
              weather,
              // Stale here means "a refresh is on its way", not "wrong" — a
              // settled past day's weather doesn't change, so the common
              // stale case is a provisional same-day answer firming up.
              stale: wantsFetch,
              pending: false,
              too_far_ahead: false,
              error: row.error || null,
            },
            200,
            {
              "X-Cache": wantsFetch ? "HIT-STALE" : "HIT",
              "Cache-Control": cacheControl(c, wantsFetch),
            }
          );
        }
        // Corrupt blob on a row that claims a result: self-heal by clearing
        // the key so the scheduled fetch below can't bail as already-fresh.
        await invalidateWeather(c.env.DB, [taskId]);
        scheduleWeatherFetch(c, [taskId]);
      }

      // No servable answer. Either the task is further ahead than anyone can
      // forecast, or it has never been fetched (pending, the fetch is
      // scheduled above), or every attempt failed and we're inside the
      // backoff — in which case report the failure rather than a spinner that
      // will never resolve.
      const failing = row?.error && !wantsFetch;
      return c.json(
        {
          ...base,
          weather: null,
          stale: !tooFarAhead,
          pending: !failing && !tooFarAhead,
          too_far_ahead: tooFarAhead,
          error: tooFarAhead
            ? `No forecast reaches more than ${FORECAST_HORIZON_DAYS} days ahead`
            : failing
              ? row!.error
              : null,
        },
        200,
        { "X-Cache": "MISS", "Cache-Control": cacheControl(c, !tooFarAhead) }
      );
    }
  )

  // ── POST /api/comp/:comp_id/task/:task_id/weather/refresh ──
  //
  // Explicit "fetch it again". The key comparison already re-fetches after
  // any route or date change, so this is for recovering a task whose
  // provider was down (clearing the failure backoff) or for pulling a fresh
  // answer once a provisional day has settled.
  .post(
    "/api/comp/:comp_id/task/:task_id/weather/refresh",
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

      await invalidateWeather(c.env.DB, [taskId]);
      scheduleWeatherFetch(c, [taskId]);

      await audit(c.env.DB, c.var.user, compId, {
        subject_type: "task",
        subject_id: taskId,
        subject_name: task.name,
        description: `Triggered a weather re-fetch for task "${task.name}"`,
      });

      return c.json({ ok: true });
    }
  );

export type { TaskWeatherRow };
