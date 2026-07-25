// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Task weather — provider-neutral access to what the sky was doing while a
 * task was flown.
 *
 * Read `types.ts` first: it fixes the conventions (wind FROM in degrees,
 * km/h, metres, ISO-UTC hour starts) that make a provider's output drop
 * straight onto the field-analysis day-profile axis beside the wind and
 * climb the pilots' own tracks reveal.
 *
 * Callers use `weatherQueryForTask` + `fetchTaskWeather` and never name a
 * provider. `WEATHER_SCHEMA_VERSION` is the cache's version stamp — bump it
 * whenever the stored shape or a provider's variable set changes, and every
 * cached row rolls to stale with no migration step.
 */

export { WEATHER_SCHEMA_VERSION } from "./version";
export type {
  TaskWeather,
  WeatherFetchContext,
  WeatherFetchFn,
  WeatherHour,
  WeatherLevel,
  WeatherProvider,
  WeatherQuery,
  WeatherSource,
  WeatherSourceKind,
  WeatherVariable,
} from "./types";
export {
  DEFAULT_FLYING_HEIGHT_AGL_M,
  flyingHeightLevel,
  heightToPressureHpa,
  lclHeightAglM,
  levelNearestHeight,
  pressureToHeightM,
} from "./derive";
export {
  DEFAULT_WEATHER_PROVIDERS,
  NoWeatherAvailable,
  fetchTaskWeather,
  selectProviders,
  type FetchTaskWeatherOptions,
} from "./registry";
export {
  openMeteoEra5Provider,
  openMeteoHistoricalForecastProvider,
  openMeteoProviders,
} from "./open-meteo";
export { taskCentroid, weatherQueryForTask, weatherQueryKey } from "./task-query";
