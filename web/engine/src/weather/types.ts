// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Provider-neutral weather types.
 *
 * Nothing in this file knows that Open-Meteo exists. A provider is anything
 * that can turn a `WeatherQuery` (a point, an elevation, and an interval)
 * into a `TaskWeather` (hourly rows plus a source credit), so adding a
 * regional source later — the Bureau of Meteorology for Australian comps,
 * say — is one new file plus one registry entry, with no change here, in the
 * store, or in the charts.
 *
 * Conventions, fixed across every provider so the UI never has to ask:
 *   * Wind DIRECTION is degrees the wind blows FROM (0–360), matching the
 *     engine's own `circularMeanWind` and the task-analysis tables.
 *   * Wind SPEED is km/h. The frontend converts at the display boundary via
 *     `unitDisplay`, exactly as it does for the pilot-derived wind.
 *   * Heights are metres. `heightM` on a level is AMSL; boundary-layer depth
 *     and cloud base are AGL, because that is how pilots read them — the
 *     field names say which.
 *   * Times are ISO 8601 UTC instants naming the START of the hour the row
 *     describes, so they drop straight onto the day-profile time axis.
 *
 * A provider reports what it could NOT supply rather than faking it: every
 * numeric field is nullable and `source.variables` lists what this dataset
 * actually carries. ERA5, for instance, has no pressure-level winds and no
 * CAPE, so a 2020 comp legitimately gets a thinner report than a 2026 one,
 * and the charts hide the panels they have no data for.
 */

/** What the caller wants weather for: a point, and an interval around it. */
export interface WeatherQuery {
  /** Representative point — in practice the task's turnpoint centroid. */
  lat: number;
  lon: number;
  /**
   * Terrain elevation at that point in metres AMSL, when known. Providers
   * use it to decide which levels count as "flying height"; when null they
   * fall back to the elevation their own grid reports.
   */
  elevationM?: number | null;
  /** Interval of interest as epoch ms UTC. Providers round OUT to whole hours. */
  fromMs: number;
  toMs: number;
}

/** The variables a dataset can carry. A provider advertises its own set so
 * callers can degrade gracefully instead of probing for nulls. */
export type WeatherVariable =
  | "surface_wind"
  | "surface_gust"
  | "surface_temp"
  | "level_wind"
  | "cloud_cover"
  | "boundary_layer"
  | "cape"
  | "radiation"
  | "precipitation";

/**
 * How the numbers were produced. Pilots must never read a model run as an
 * observation, so this is carried all the way to the chart caption.
 */
export type WeatherSourceKind =
  /** An operational forecast model run, archived. Closest to "what happened". */
  | "model"
  /**
   * A LIVE forecast: a day that has not happened yet, or has not finished.
   * The same model as "model" above, caught on the other side of the event —
   * which is the whole reason it is a separate kind. A reader must be able to
   * tell a prediction from a record without checking the date.
   */
  | "forecast"
  /** A reanalysis (ERA5 and friends): consistent, coarse, hindsight-fitted. */
  | "reanalysis"
  /** Actual instrument readings (METAR, AWS, radiosonde). */
  | "observation";

/** Everything needed to credit — and caveat — a weather series on screen. */
export interface WeatherSource {
  /** Stable id of the provider that served this, e.g. "open-meteo". */
  providerId: string;
  /** The dataset actually used, short enough for a chart corner:
   * "ECMWF IFS 9 km", "ERA5 25 km". */
  model: string;
  /** Human credit line, e.g. "Open-Meteo (ECMWF IFS)". */
  attribution: string;
  /** Where a reader can check the source themselves. */
  attributionUrl: string;
  /** Licence short name, e.g. "CC BY 4.0" — CC BY *requires* we show this. */
  license: string;
  kind: WeatherSourceKind;
  /**
   * Nominal grid spacing in km, or null when the dataset cannot honestly
   * state one.
   *
   * Null is a real answer, not a gap to fill in later. Open-Meteo's
   * "best match" selects a different underlying model per location and does
   * NOT report which one it chose — verified against the live API, including
   * a multi-model request, which shows best_match returning values matching
   * none of the named candidates. Printing a number we inferred from the
   * region would be a guess presented as provenance, which is worse than
   * saying the resolution varies.
   */
  resolutionKm: number | null;
  /** Variables this dataset carries; anything absent is null in every row. */
  variables: WeatherVariable[];
  /** The grid point actually served, which is rarely the point asked for. */
  pointLat: number;
  pointLon: number;
  /**
   * Grid elevation in metres AMSL — the datum for the AGL fields below, and
   * routinely hundreds of metres off the real terrain, because a model cell
   * kilometres wide averages a ridge and its valley into one number. Compare
   * it against `TaskWeather.resolved.elevationM` before reading any AGL
   * height as a height above launch.
   */
  pointElevationM: number | null;
}

/** Wind (and temperature) at one height in the column. */
export interface WeatherLevel {
  /** Pressure level in hPa, for providers that work in pressure; else null. */
  pressureHpa: number | null;
  /** Approximate geometric height AMSL in metres — what the UI labels with. */
  heightM: number;
  /** Degrees the wind blows FROM. */
  windDirectionDeg: number | null;
  windSpeedKmh: number | null;
  temperatureC: number | null;
}

/** One hour of weather at the query point. */
export interface WeatherHour {
  /** ISO 8601 UTC instant, start of the hour this row describes. */
  t: string;
  /** Screen-height conditions — what launch feels. */
  surface: {
    windDirectionDeg: number | null;
    windSpeedKmh: number | null;
    windGustKmh: number | null;
    temperatureC: number | null;
    dewPointC: number | null;
  };
  /** The column, ascending by height. Empty when the dataset has no levels. */
  levels: WeatherLevel[];
  cloud: {
    lowPct: number | null;
    midPct: number | null;
    highPct: number | null;
    totalPct: number | null;
  };
  /** Depth of the mixed layer in metres AGL — the modelled thermal ceiling. */
  boundaryLayerDepthM: number | null;
  /** Convective available potential energy, J/kg. Overdevelopment risk. */
  capeJkg: number | null;
  /** Incoming shortwave radiation, W/m² — the engine driving the thermals. */
  shortwaveWm2: number | null;
  precipitationMm: number | null;
  /**
   * DERIVED, not fetched: lifting condensation level in metres AGL from the
   * surface temperature/dewpoint spread — the classic cumulus base estimate.
   * Null when the inputs are missing. See `lclHeightAglM`.
   */
  cloudBaseAglM: number | null;
}

/** A provider's answer: the rows, plus who says so and how confidently. */
export interface TaskWeather {
  source: WeatherSource;
  /**
   * The query as resolved (hours rounded out), echoed so a consumer can say
   * how far the answer is from what was asked — the offset between this
   * point and `source.pointLat/Lon`, and between this elevation and
   * `source.pointElevationM`, are the two numbers that tell a reader how
   * much to trust the series.
   */
  resolved: {
    lat: number;
    lon: number;
    /** Real terrain elevation of the task in metres AMSL, from its
     * turnpoints; null when the route carries no altitudes. */
    elevationM: number | null;
    fromMs: number;
    toMs: number;
  };
  /** Ascending by time, one row per hour, gaps included as all-null rows. */
  hours: WeatherHour[];
  /**
   * True when the dataset behind this answer may still change — fetched
   * inside the source's publication lag (ERA5 runs ~5 days behind). The
   * store keeps re-fetching a provisional answer until it settles.
   */
  provisional: boolean;
  /** ISO instant the fetch completed. */
  fetchedAt: string;
}

/**
 * Structural stand-in for the platform's `AbortSignal`.
 *
 * Spelled out rather than referenced because the engine compiles with
 * `lib: ["ES2022"]` and no DOM types — that purity is what lets the same
 * code run in the browser, in workerd, and under Bun. A real AbortSignal
 * satisfies this shape, so callers pass theirs straight in.
 */
export type WeatherAbortSignal = { readonly aborted: boolean };

/**
 * The `fetch` shape providers depend on — injected, never imported, so the
 * worker, the CLI, and tests can each supply their own. Mirrors the frontend
 * loaders' `FetchFn` convention.
 *
 * Narrowed to the four members the adapters actually touch, which is also
 * what makes a provider testable with an eight-line stub instead of a mock
 * of the whole Response interface.
 */
export type WeatherFetchFn = (
  input: string,
  init?: { signal?: WeatherAbortSignal }
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

/** Ambient inputs a provider needs but must not reach for itself. */
export interface WeatherFetchContext {
  fetchImpl: WeatherFetchFn;
  /** "Now" as epoch ms, injected so provisionality is deterministic in tests. */
  nowMs: number;
  signal?: WeatherAbortSignal;
}

/**
 * A source of task weather.
 *
 * Implementations must be pure with respect to their arguments: everything
 * ambient (network, clock) arrives in the context. That is what lets the
 * worker cache aggressively and the tests run offline.
 */
export interface WeatherProvider {
  /** Stable id, persisted in the cache row — changing it invalidates rows. */
  id: string;
  /** Human name for logs and admin UI. */
  label: string;
  /**
   * Selection weight; the highest supporting provider wins. Regional
   * sources sit ABOVE the global fallback, so an Australian provider added
   * later takes Australian comps without touching call sites.
   */
  priority: number;
  /** Can this provider answer this query at all (region, era, coverage)? */
  supports(query: WeatherQuery): boolean;
  fetch(query: WeatherQuery, ctx: WeatherFetchContext): Promise<TaskWeather>;
}
