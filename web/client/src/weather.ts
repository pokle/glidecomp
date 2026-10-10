/**
 * Wire shape of the task-weather endpoint, plus re-exports of the engine's
 * weather types.
 *
 * Re-exported rather than redeclared, exactly as analysis/types.ts does
 * for the report types: the provider decides what a `WeatherHour` contains,
 * and a second hand-written copy here would drift the moment a provider is
 * added.
 */
export type {
  TaskWeather,
  WeatherHour,
  WeatherLevel,
  WeatherSource,
  WeatherSourceKind,
  WeatherVariable,
} from "@glidecomp/engine";
export {
  DEFAULT_FLYING_HEIGHT_AGL_M,
  flyingHeightLevel,
  levelNearestHeight,
} from "@glidecomp/engine";

import type { TaskWeather } from "@glidecomp/engine";

/** GET /api/comp/:comp_id/task/:task_id/weather */
export interface TaskWeatherData {
  task_id: string;
  comp_id: string;
  /** The organizer's free-text account of the day. Empty string when unset. */
  notes: string;
  /** Null while pending, or when the task has no route to look up. */
  weather: TaskWeather | null;
  /** A refresh is on its way — usually a provisional same-day answer firming
   * up, not a wrong one. */
  stale: boolean;
  /** Never fetched yet; one is being fetched in the background. Poll. */
  pending: boolean;
  /**
   * The task is set further ahead than any forecast reaches — a real state of
   * a comp laid out weeks in advance, and the only "no weather" case that
   * resolves itself with the passage of time. Distinct from `error` because
   * it is the one the UI can safely put in its own words; the rest are
   * provider failures, whose text is for an admin, not a reader.
   */
  too_far_ahead: boolean;
  /** Why there is no weather (no route, or every provider failed). */
  error: string | null;
}

/**
 * How to describe a source's `kind` to a reader, in the fewest words that
 * still prevent the central misreading — that these numbers were measured at
 * launch. They were not: they are a grid cell, kilometres wide, and the
 * organizer's notes are the only local ground truth on the page.
 */
export function sourceKindLabel(kind: string): string {
  switch (kind) {
    case "model":
      return "modelled";
    // A day that hasn't happened (or hasn't finished). Same model as
    // "modelled", opposite side of the event — which is the one distinction a
    // reader must never have to work out for themselves.
    case "forecast":
      return "forecast";
    case "reanalysis":
      return "reanalysis";
    case "observation":
      return "observed";
    default:
      return kind;
  }
}
