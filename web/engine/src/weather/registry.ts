// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Provider selection and the one entry point callers use.
 *
 * The whole point of this file is that call sites name no provider. They ask
 * for the weather over a point and an interval; the registry picks whoever
 * supports it, highest priority first, and falls through to the next on
 * failure. Adding a regional source (a Bureau of Meteorology adapter for
 * Australian comps) means writing the adapter and putting it in the list —
 * the store, the route, and the charts never learn it exists.
 *
 * Fall-through is deliberate rather than fail-fast: a regional provider
 * having an outage should degrade a comp to the coarse global dataset, not
 * blank the panel. Which one actually answered is recorded in
 * `TaskWeather.source` and shown on the chart, so the reader always knows
 * what they are looking at.
 */

import { openMeteoProviders } from "./open-meteo";
import type {
  TaskWeather,
  WeatherFetchContext,
  WeatherProvider,
  WeatherQuery,
} from "./types";

/**
 * The providers shipped today, in no particular order — `selectProviders`
 * sorts by priority. Open-Meteo contributes two: the archived
 * high-resolution forecast for recent comps, and ERA5 reanalysis for the
 * back-catalogue that predates it.
 */
export const DEFAULT_WEATHER_PROVIDERS: readonly WeatherProvider[] = [
  ...openMeteoProviders(),
];

/** Providers that can serve this query, best first. */
export function selectProviders(
  query: WeatherQuery,
  providers: readonly WeatherProvider[] = DEFAULT_WEATHER_PROVIDERS
): WeatherProvider[] {
  return providers
    .filter((p) => {
      try {
        return p.supports(query);
      } catch {
        return false;
      }
    })
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
}

/** Thrown when no provider covers the query, or every candidate failed. */
export class NoWeatherAvailable extends Error {
  /** Per-provider failure text, for the store's error column. */
  readonly attempts: { providerId: string; error: string }[];

  constructor(message: string, attempts: { providerId: string; error: string }[] = []) {
    super(message);
    this.name = "NoWeatherAvailable";
    this.attempts = attempts;
  }
}

export interface FetchTaskWeatherOptions extends WeatherFetchContext {
  /** Override the registry — tests pass fakes, admin tooling pins one source. */
  providers?: readonly WeatherProvider[];
}

/**
 * Fetch the weather over a task from the best available source.
 *
 * Tries each supporting provider in priority order and returns the first
 * answer that carries at least one hour. A provider that throws, or that
 * returns an empty series (the archive simply has nothing for that day yet),
 * is treated the same way: log the reason and fall through.
 */
export async function fetchTaskWeather(
  query: WeatherQuery,
  opts: FetchTaskWeatherOptions
): Promise<TaskWeather> {
  const candidates = selectProviders(query, opts.providers ?? DEFAULT_WEATHER_PROVIDERS);
  if (candidates.length === 0) {
    throw new NoWeatherAvailable(
      `No weather provider covers ${query.lat.toFixed(3)},${query.lon.toFixed(3)} ` +
        `at ${new Date(query.fromMs).toISOString()}`
    );
  }

  const attempts: { providerId: string; error: string }[] = [];
  for (const provider of candidates) {
    try {
      const weather = await provider.fetch(query, opts);
      if (weather.hours.length > 0) return weather;
      attempts.push({ providerId: provider.id, error: "returned no hours" });
    } catch (err) {
      attempts.push({
        providerId: provider.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  throw new NoWeatherAvailable(
    `Every weather provider failed: ${attempts
      .map((a) => `${a.providerId} (${a.error})`)
      .join("; ")}`,
    attempts
  );
}
