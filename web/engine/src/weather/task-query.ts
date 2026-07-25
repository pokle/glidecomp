// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Turning a task into a `WeatherQuery` — where and when to ask about.
 *
 * Lives in the engine, not the worker, so the CLI report, the worker's cache
 * and any future backfill script all derive the SAME query for a task. That
 * matters more than it looks: the query is what the cache is keyed on, so
 * two call sites disagreeing by an hour would each fetch and store their own
 * copy of the same day.
 */

import type { XCTask } from "../xctsk-parser";
import { resolveLaunchWindowOpen, resolveStartGates, resolveTaskDeadline } from "../time-gates";
import type { WeatherQuery } from "./types";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * Hours of padding either side of the task's own clock. An hour before the
 * window opens shows the morning that set the day up (was the inversion
 * still there at 10?), and an hour past the deadline catches the glass-off
 * that the last pilots landed in.
 */
const PAD_HOURS = 1;

/** Fallback span when a task defines no times at all: 08:00–20:00 local-ish,
 * expressed in UTC around the task date. Wide enough to contain any flying
 * day, narrow enough that the request stays one day of hourly data. */
const FALLBACK_START_HOUR_UTC = 0;
const FALLBACK_END_HOUR_UTC = 24;

/** Mean position of a task's turnpoints — the point the weather is asked
 * about. A task can span 100 km, so this is a representative sample, not a
 * claim that the whole route shared one sky; the report says which grid
 * point actually answered. */
export function taskCentroid(task: XCTask): { lat: number; lon: number } | null {
  const pts = task.turnpoints ?? [];
  if (pts.length === 0) return null;
  let lat = 0;
  let lon = 0;
  for (const tp of pts) {
    lat += tp.waypoint.lat;
    lon += tp.waypoint.lon;
  }
  return { lat: lat / pts.length, lon: lon / pts.length };
}

/**
 * Mean elevation of a task's turnpoints in metres AMSL, or null when the
 * route carries no altitudes.
 *
 * Worth deriving rather than leaning on the provider's own grid elevation,
 * which is routinely hundreds of metres out: a model cell kilometres wide
 * averages a ridge and its valley into one figure. Corryong's Task 1 runs
 * from a 932 m launch down to a 276 m goal, mean 543 m — while the grid
 * point reports 298 m.
 *
 * The MEAN, matching the centroid: the query asks about one representative
 * point over the whole course, so the elevation should describe the same
 * thing. Launch alone would overstate the terrain for a task that spends
 * most of its distance over the flats.
 */
export function taskElevationM(task: XCTask): number | null {
  const alts = (task.turnpoints ?? [])
    .map((tp) => tp.waypoint.altSmoothed)
    .filter((a): a is number => typeof a === "number" && Number.isFinite(a));
  if (alts.length === 0) return null;
  return alts.reduce((sum, a) => sum + a, 0) / alts.length;
}

/**
 * Build the weather query for a task.
 *
 * The window runs from the earliest of (launch window open, first start
 * gate) to the goal deadline, padded by an hour each way. A task missing
 * those fields — plenty of real ones do — falls back to the whole UTC day of
 * `taskDate`, which for an Australian comp still brackets the flying.
 *
 * `taskDate` is the task's ISO date (YYYY-MM-DD); it anchors the
 * time-of-day gates, which carry no date of their own.
 */
export function weatherQueryForTask(
  task: XCTask,
  taskDate: string,
  opts?: { elevationM?: number | null; padHours?: number }
): WeatherQuery | null {
  const centre = taskCentroid(task);
  if (!centre) return null;

  const dayStartMs = Date.parse(`${taskDate}T00:00:00Z`);
  if (!Number.isFinite(dayStartMs)) return null;

  // Anchor the gates at midday so `resolveTimeOfDayNear` cannot snap an
  // early-morning window onto the previous day.
  const referenceMs = dayStartMs + 12 * HOUR_MS;
  const padMs = (opts?.padHours ?? PAD_HOURS) * HOUR_MS;

  const gates = resolveStartGates(task, referenceMs);
  const candidatesStart = [
    resolveLaunchWindowOpen(task, referenceMs),
    gates && gates.length > 0 ? gates[0] : null,
  ].filter((v): v is number => v !== null);
  const deadline = resolveTaskDeadline(task, referenceMs);

  let fromMs: number;
  let toMs: number;
  if (candidatesStart.length > 0 && deadline !== null) {
    fromMs = Math.min(...candidatesStart) - padMs;
    toMs = deadline + padMs;
  } else {
    fromMs = dayStartMs + FALLBACK_START_HOUR_UTC * HOUR_MS;
    toMs = dayStartMs + FALLBACK_END_HOUR_UTC * HOUR_MS;
  }

  // A malformed task can resolve to a backwards or absurd window; clamp to
  // the task's own day rather than requesting a decade of hourly data.
  if (!(toMs > fromMs) || toMs - fromMs > 2 * DAY_MS) {
    fromMs = dayStartMs;
    toMs = dayStartMs + DAY_MS;
  }

  return {
    lat: centre.lat,
    lon: centre.lon,
    // The route's own terrain, unless the caller knows better. Providers use
    // it to pick which level counts as flying height, so taking it from the
    // task rather than from the provider's smoothed grid keeps that pick
    // honest.
    elevationM: opts?.elevationM ?? taskElevationM(task),
    fromMs,
    toMs,
  };
}

/**
 * Stable identity of a query, for cache keying. Two queries with the same
 * key describe the same request and may share a stored answer; any change to
 * the task's route or date moves the point or the window and so moves the
 * key, which is what makes the cache self-invalidating without a bump at the
 * mutation sites.
 *
 * Coordinates are rounded to ~10 m, well under any provider's grid, so
 * floating-point noise in a re-parsed route cannot cause a re-fetch.
 */
export function weatherQueryKey(query: WeatherQuery): string {
  return [
    query.lat.toFixed(4),
    query.lon.toFixed(4),
    Math.round(query.fromMs / HOUR_MS),
    Math.round(query.toMs / HOUR_MS),
  ].join(":");
}
