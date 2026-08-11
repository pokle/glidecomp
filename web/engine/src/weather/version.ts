// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Version stamp of the stored weather shape.
 *
 * Its own file (like scoring-version.ts) so the worker's cache can import it
 * without pulling the providers — and their fetch code — into a module graph
 * that only needs a number.
 *
 * Bump it whenever the stored `TaskWeather` shape changes, a provider's
 * variable set changes, or a derived field (cloud base, level heights)
 * changes how it is computed. Every cached row then reads stale and
 * re-fetches on next view, with no migration step.
 *
 * 1 — initial: Open-Meteo archived-forecast + ERA5 providers.
 * 2 — added WeatherSource.resolutionKm and resolved.elevationM, so the UI can
 *     state the grid's cell size and how far its elevation is from the task's
 *     real terrain. Rows written at v1 lack both and re-fetch.
 * 3 — WeatherSource.variables is now narrowed to what an answer actually
 *     delivered rather than what its provider advertises (the archived
 *     forecast claims boundary_layer for dates it has none). Stored rows
 *     carry the old over-claim, which is exactly the thing the UI now reads,
 *     so they must re-fetch.
 * 4 — added the live-forecast provider, and the archives now refuse a window
 *     that hasn't elapsed. Rows written at v3 for a future or still-running
 *     task carry the archived forecast's "modelled" stamp on what was
 *     actually a prediction, and future-dated tasks whose fetch failed hold
 *     an error row that would sit out a backoff of up to 24 hours. Both are
 *     wrong now, so every row re-fetches.
 * 5 — empty-hour detection now derives from the per-variable DELIVERED
 *     predicates instead of a hand-kept field list that had drifted from
 *     `WeatherHour` (it omitted gust, mid and high cloud, and
 *     precipitation). An hour carrying only those readings used to be
 *     dropped as empty, so stored rows may be short of hours they are
 *     entitled to; every row re-fetches.
 */
export const WEATHER_SCHEMA_VERSION = 5;
