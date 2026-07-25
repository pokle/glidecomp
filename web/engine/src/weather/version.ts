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
 */
export const WEATHER_SCHEMA_VERSION = 1;
