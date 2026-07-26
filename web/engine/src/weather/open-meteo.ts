// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Open-Meteo adapters — the three `WeatherProvider`s shipped today.
 *
 * Open-Meteo is the starting source because it needs no API key, publishes
 * under CC BY 4.0, and covers everywhere GlideComp has comps. It exposes
 * datasets with genuinely different capabilities and different eras, so it
 * becomes three providers rather than one with a mode flag:
 *
 *   Historical Forecast (2022→)  Archived runs of the operational models,
 *                                1–25 km, initialised from real observations
 *                                and therefore close to what the day
 *                                actually did. Carries pressure-level winds
 *                                and CAPE — the variables a free-flying
 *                                pilot cares about most.
 *   ERA5 reanalysis (1940→)      Global reanalysis at ~25 km. The only
 *                                option for the back-catalogue (Unungra
 *                                2020, the archived Corryong years), but it
 *                                has NO pressure-level winds and NO CAPE.
 *                                Verified against the live API, not assumed:
 *                                requesting them returns units "undefined"
 *                                and a column of nulls.
 *   Forecast (→ today + 15)      The live operational run: the only source
 *                                that can answer for a task day that hasn't
 *                                happened yet. Same variables as the
 *                                archived forecast, and the same model — it
 *                                IS that model, before the day it describes.
 *
 * The capability asymmetry is exactly why `WeatherSource.variables` exists.
 * An older comp gets a thinner report and the charts drop the panels they
 * have no data for, rather than drawing an empty axis or, worse, a
 * fabricated one.
 *
 * The ERA-boundary asymmetry is why `WeatherSource.kind` exists, and why the
 * archives refuse an unelapsed window (see `requireElapsedWindow`): a
 * prediction and a record of what happened must never reach a pilot wearing
 * the same label.
 *
 * Attribution is not optional: CC BY 4.0 requires the credit that
 * `WeatherSource.attribution` carries to the chart. The free tier is also
 * non-commercial — if GlideComp ever charges, this file is where the
 * customer endpoint or a self-hosted base URL goes.
 */

import { lclHeightAglM, pressureToHeightM } from "./derive";
import type {
  TaskWeather,
  WeatherFetchContext,
  WeatherHour,
  WeatherLevel,
  WeatherProvider,
  WeatherQuery,
  WeatherSourceKind,
  WeatherVariable,
} from "./types";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * Pressure levels worth asking for. Roughly 550 m to 3000 m AMSL by ISA —
 * launch height through the top of a good day in the Australian Alps, at a
 * spacing that lets `flyingHeightLevel` land near any comp's working band.
 * Higher levels exist but describe air no free-flying pilot reaches.
 */
const PRESSURE_LEVELS_HPA = [950, 925, 900, 850, 800, 700] as const;

/** Surface variables both archives carry. */
const SURFACE_VARIABLES = [
  "temperature_2m",
  "dew_point_2m",
  "wind_speed_10m",
  "wind_direction_10m",
  "wind_gusts_10m",
  "cloud_cover",
  "cloud_cover_low",
  "cloud_cover_mid",
  "cloud_cover_high",
  "precipitation",
  "boundary_layer_height",
  "shortwave_radiation",
] as const;

/** The response shape we rely on. Everything else in the payload is ignored. */
interface OpenMeteoResponse {
  latitude?: number;
  longitude?: number;
  elevation?: number;
  error?: boolean;
  reason?: string;
  hourly?: Record<string, (number | null)[] | string[]>;
}

/** ISO date (YYYY-MM-DD) of an instant in UTC. */
function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Numeric column, or an all-undefined stand-in when the key is absent. */
function column(
  hourly: Record<string, unknown> | undefined,
  key: string
): (number | null)[] | null {
  const raw = hourly?.[key];
  return Array.isArray(raw) ? (raw as (number | null)[]) : null;
}

/** Cell value as a finite number, or null for missing/absent/NaN. */
function cell(col: (number | null)[] | null, i: number): number | null {
  if (!col) return null;
  const v = col[i];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** True when a row carries no usable reading at all — the archive has not
 * reached this day yet. Such rows are dropped so the registry can fall
 * through to another provider instead of caching a blank day. */
function isEmptyHour(h: WeatherHour): boolean {
  const nums = [
    h.surface.windSpeedKmh,
    h.surface.windDirectionDeg,
    h.surface.temperatureC,
    h.surface.dewPointC,
    h.cloud.totalPct,
    h.cloud.lowPct,
    h.boundaryLayerDepthM,
    h.capeJkg,
    h.shortwaveWm2,
  ];
  if (nums.some((v) => v !== null)) return false;
  return !h.levels.some((l) => l.windSpeedKmh !== null);
}

/**
 * Does a mapped answer actually CARRY each variable, one predicate per
 * variable? Asked of the rows, not of the request.
 */
const DELIVERED: Record<WeatherVariable, (hours: WeatherHour[]) => boolean> = {
  surface_wind: (hs) =>
    hs.some((h) => h.surface.windSpeedKmh !== null || h.surface.windDirectionDeg !== null),
  surface_gust: (hs) => hs.some((h) => h.surface.windGustKmh !== null),
  surface_temp: (hs) =>
    hs.some((h) => h.surface.temperatureC !== null || h.surface.dewPointC !== null),
  level_wind: (hs) => hs.some((h) => h.levels.some((l) => l.windSpeedKmh !== null)),
  cloud_cover: (hs) =>
    hs.some(
      (h) =>
        h.cloud.totalPct !== null ||
        h.cloud.lowPct !== null ||
        h.cloud.midPct !== null ||
        h.cloud.highPct !== null
    ),
  boundary_layer: (hs) => hs.some((h) => h.boundaryLayerDepthM !== null),
  cape: (hs) => hs.some((h) => h.capeJkg !== null),
  radiation: (hs) => hs.some((h) => h.shortwaveWm2 !== null),
  precipitation: (hs) => hs.some((h) => h.precipitationMm !== null),
};

/**
 * The variables a provider ADVERTISED, narrowed to the ones this particular
 * answer delivered.
 *
 * `WeatherSource.variables` is the contract a consumer degrades against —
 * "this dataset has no upper wind, so don't draw an empty axis" — and a
 * static per-provider list cannot keep that promise, because coverage varies
 * by date within one dataset. Open-Meteo's archived forecast is the case that
 * forced this: it advertises `boundary_layer`, and honours it, but only from
 * around September 2024. Every earlier day returns a column of nulls, so a
 * 2024 competition drew a cloud-base line with no thermal top beside it and
 * nothing on the chart able to say why. Asking the rows makes the claim true
 * per answer, and lets the UI distinguish "this dataset hasn't got it" from
 * "the fetch failed".
 *
 * Order follows the provider's own list, so the field stays stable and
 * comparable between answers.
 */
function deliveredVariables(
  claimed: readonly WeatherVariable[],
  hours: WeatherHour[]
): WeatherVariable[] {
  return claimed.filter((v) => DELIVERED[v](hours));
}

/** Shared query builder + response mapper for both Open-Meteo archives. */
async function fetchOpenMeteo(
  opts: {
    baseUrl: string;
    pressureLevels: readonly number[];
    extraVariables: readonly string[];
    providerId: string;
    model: string;
    attribution: string;
    kind: WeatherSourceKind;
    resolutionKm: number | null;
    variables: WeatherVariable[];
    /** Publication lag in ms; a fetch inside it may still be revised. */
    settleMs: number;
  },
  query: WeatherQuery,
  ctx: WeatherFetchContext
): Promise<TaskWeather> {
  // Round the interval out to whole hours so the returned rows tile the
  // requested window rather than clipping its first and last hour.
  const fromMs = Math.floor(query.fromMs / HOUR_MS) * HOUR_MS;
  const toMs = Math.ceil(query.toMs / HOUR_MS) * HOUR_MS;

  const hourlyVars = [
    ...SURFACE_VARIABLES,
    ...opts.extraVariables,
    ...opts.pressureLevels.flatMap((hpa) => [
      `wind_speed_${hpa}hPa`,
      `wind_direction_${hpa}hPa`,
      `temperature_${hpa}hPa`,
    ]),
  ];

  // Hand-rolled rather than URLSearchParams: the engine compiles with
  // `lib: ["ES2022"]` and no DOM types, so that global isn't in scope here.
  const params: [string, string][] = [
    ["latitude", query.lat.toFixed(4)],
    ["longitude", query.lon.toFixed(4)],
    // The API works in whole days; we slice to the requested hours below.
    ["start_date", utcDate(fromMs)],
    ["end_date", utcDate(toMs)],
    ["hourly", hourlyVars.join(",")],
    // UTC in, UTC out. The competition zone is a PRESENTATION concern the
    // frontend already handles on the shared day-profile axis; asking the
    // API to localise would put two zone conversions in the pipeline.
    ["timezone", "UTC"],
    ["wind_speed_unit", "kmh"],
  ];
  const url =
    `${opts.baseUrl}?` +
    params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  const res = await ctx.fetchImpl(url, { signal: ctx.signal });
  if (!res.ok) {
    // Open-Meteo puts a useful `reason` in the error body; surface it, since
    // it lands in the store's error column and is all an admin will see.
    let reason = "";
    try {
      reason = (await res.text()).slice(0, 200);
    } catch {
      // Body already consumed or unreadable — the status is enough.
    }
    throw new Error(`${opts.providerId}: HTTP ${res.status}${reason ? ` — ${reason}` : ""}`);
  }

  const body = (await res.json()) as OpenMeteoResponse;
  if (body.error) throw new Error(`${opts.providerId}: ${body.reason ?? "unknown error"}`);

  const hourly = body.hourly as Record<string, unknown> | undefined;
  const times = Array.isArray(hourly?.["time"]) ? (hourly["time"] as string[]) : [];

  const cols = {
    temp: column(hourly, "temperature_2m"),
    dew: column(hourly, "dew_point_2m"),
    windSpeed: column(hourly, "wind_speed_10m"),
    windDir: column(hourly, "wind_direction_10m"),
    gust: column(hourly, "wind_gusts_10m"),
    cloud: column(hourly, "cloud_cover"),
    cloudLow: column(hourly, "cloud_cover_low"),
    cloudMid: column(hourly, "cloud_cover_mid"),
    cloudHigh: column(hourly, "cloud_cover_high"),
    precip: column(hourly, "precipitation"),
    blh: column(hourly, "boundary_layer_height"),
    swr: column(hourly, "shortwave_radiation"),
    cape: column(hourly, "cape"),
  };
  const levelCols = opts.pressureLevels.map((hpa) => ({
    hpa,
    heightM: pressureToHeightM(hpa),
    speed: column(hourly, `wind_speed_${hpa}hPa`),
    dir: column(hourly, `wind_direction_${hpa}hPa`),
    temp: column(hourly, `temperature_${hpa}hPa`),
  }));

  const hours: WeatherHour[] = [];
  for (let i = 0; i < times.length; i++) {
    // `timezone=UTC` yields "2026-01-10T02:00" with no offset marker; make
    // the instant explicit rather than letting Date guess local time.
    const tMs = Date.parse(`${times[i]}Z`);
    if (!Number.isFinite(tMs) || tMs < fromMs || tMs >= toMs) continue;

    const levels: WeatherLevel[] = levelCols
      .map((l) => ({
        pressureHpa: l.hpa,
        heightM: Math.round(l.heightM),
        windSpeedKmh: cell(l.speed, i),
        windDirectionDeg: cell(l.dir, i),
        temperatureC: cell(l.temp, i),
      }))
      .filter((l) => l.windSpeedKmh !== null || l.temperatureC !== null)
      .sort((a, b) => a.heightM - b.heightM);

    const temperatureC = cell(cols.temp, i);
    const dewPointC = cell(cols.dew, i);
    const hour: WeatherHour = {
      t: new Date(tMs).toISOString(),
      surface: {
        windDirectionDeg: cell(cols.windDir, i),
        windSpeedKmh: cell(cols.windSpeed, i),
        windGustKmh: cell(cols.gust, i),
        temperatureC,
        dewPointC,
      },
      levels,
      cloud: {
        lowPct: cell(cols.cloudLow, i),
        midPct: cell(cols.cloudMid, i),
        highPct: cell(cols.cloudHigh, i),
        totalPct: cell(cols.cloud, i),
      },
      boundaryLayerDepthM: cell(cols.blh, i),
      capeJkg: cell(cols.cape, i),
      shortwaveWm2: cell(cols.swr, i),
      precipitationMm: cell(cols.precip, i),
      cloudBaseAglM: lclHeightAglM(temperatureC, dewPointC),
    };
    if (!isEmptyHour(hour)) hours.push(hour);
  }
  hours.sort((a, b) => a.t.localeCompare(b.t));

  return {
    source: {
      providerId: opts.providerId,
      model: opts.model,
      attribution: opts.attribution,
      attributionUrl: "https://open-meteo.com/",
      license: "CC BY 4.0",
      kind: opts.kind,
      resolutionKm: opts.resolutionKm,
      variables: deliveredVariables(opts.variables, hours),
      pointLat: body.latitude ?? query.lat,
      pointLon: body.longitude ?? query.lon,
      pointElevationM: typeof body.elevation === "number" ? body.elevation : null,
    },
    resolved: {
      lat: query.lat,
      lon: query.lon,
      elevationM: query.elevationM ?? null,
      fromMs,
      toMs,
    },
    hours,
    provisional: ctx.nowMs - toMs < opts.settleMs,
    fetchedAt: new Date(ctx.nowMs).toISOString(),
  };
}

/** First date the archived-forecast dataset reliably covers. The docs say
 * "around 2021/2022" depending on model; 2022 is the conservative line, and
 * anything earlier falls through to ERA5 which covers it properly. */
const HISTORICAL_FORECAST_FROM_MS = Date.UTC(2022, 0, 1);

/**
 * How many whole UTC days ahead a forecast reaches.
 *
 * Open-Meteo publishes 16 forecast days counting today, so `start_date` may
 * be at most today + 15. Probed against the live API on 2026-07-26, which
 * answered anything later with "Parameter 'start_date' is out of allowed
 * range from 2026-04-24 to 2026-08-10". Whole DAYS rather than a duration
 * because that is the shape of the API's own rule: it validates the date we
 * send, not the instant.
 */
export const FORECAST_HORIZON_DAYS = 15;

/** Whole-day index of an instant in UTC — the unit the API's range works in. */
function utcDayIndex(ms: number): number {
  return Math.floor(ms / DAY_MS);
}

/**
 * True when a query starts further ahead than anything can see.
 *
 * Exported for the read path, which uses it to tell a reader "not yet" about
 * a task set up weeks in advance, rather than scheduling a fetch that can
 * only fail and then sit out a backoff. Named for the question it answers
 * rather than for Open-Meteo: it describes OUR forward reach, and it lives
 * beside the constant only because Open-Meteo is what sets that reach today.
 * The day a longer-range provider joins the registry, both move.
 */
export function beyondForecastHorizon(query: WeatherQuery, nowMs: number): boolean {
  return utcDayIndex(query.fromMs) - utcDayIndex(nowMs) > FORECAST_HORIZON_DAYS;
}

/**
 * The archives answer for elapsed time only.
 *
 * Both archive endpoints will happily serve a FUTURE day — verified against
 * the live API, which returned, for a date days ahead, the current forecast
 * run byte-for-byte identical to what api.open-meteo.com gives. That is the
 * trap this guard closes. Served through the archived-forecast adapter, a
 * prediction would reach the reader stamped "archived forecast, modelled",
 * indistinguishable from a run initialised on the day it describes — and
 * `WeatherSource.kind` exists precisely so that confusion is impossible.
 *
 * The split is by the window's END, so a task still being flown counts as a
 * prediction until its last hour is behind us. Conservative in the safe
 * direction (calling real data a forecast misleads nobody; the reverse
 * does), and self-healing: once the day is over, the archives take the row
 * back on its next refresh and the label settles into "archived".
 *
 * It lives in `fetch` rather than `supports` because `supports` sees only the
 * query — the clock is ambient and arrives with the context.
 */
function requireElapsedWindow(
  providerId: string,
  query: WeatherQuery,
  ctx: WeatherFetchContext
): void {
  if (query.toMs > ctx.nowMs) {
    throw new Error(
      `${providerId}: the task's window has not elapsed — the forecast provider owns it`
    );
  }
}

/**
 * Open-Meteo's archived operational forecasts — the preferred source for any
 * comp from 2022 on. Priority 50 leaves room beneath it for a global
 * fallback and above it for regional sources added later (a BOM adapter for
 * Australian comps would sit at, say, 80 and win without touching callers).
 *
 * `variables` below is what this dataset carries AT ITS BEST; coverage varies
 * by date inside it and `deliveredVariables()` narrows the claim to each
 * answer. `boundary_layer` is the known gap — populated from around
 * September 2024, null for every earlier day (verified against the live API
 * for 2022-12, 2024-01, 2024-08 → null; 2024-09 on → present, and null for
 * every named model, not just best_match). Comps before then get no thermal
 * top, and the chart says so rather than leaving the reader to wonder.
 */
export function openMeteoHistoricalForecastProvider(): WeatherProvider {
  return {
    id: "open-meteo-historical-forecast",
    label: "Open-Meteo archived forecast",
    priority: 50,
    supports: (q) => q.fromMs >= HISTORICAL_FORECAST_FROM_MS,
    fetch: async (q, ctx) => {
      requireElapsedWindow("open-meteo-historical-forecast", q, ctx);
      return fetchOpenMeteo(
        {
          baseUrl: "https://historical-forecast-api.open-meteo.com/v1/forecast",
          pressureLevels: PRESSURE_LEVELS_HPA,
          extraVariables: ["cape"],
          providerId: "open-meteo-historical-forecast",
          model: "Open-Meteo best-match (ECMWF/regional)",
          attribution: "Open-Meteo archived forecast",
          kind: "model",
          // Null, and staying null: best_match picks a different underlying
          // model per location (1 km to 25 km) and the API does not report
          // which. See the field's doc comment in types.ts.
          resolutionKm: null,
          variables: [
            "surface_wind",
            "surface_gust",
            "surface_temp",
            "level_wind",
            "cloud_cover",
            "boundary_layer",
            "cape",
            "radiation",
            "precipitation",
          ],
          // Recent runs can still be revised; re-fetch anything younger than
          // three days rather than freezing a provisional answer forever.
          settleMs: 3 * DAY_MS,
        },
        q,
        ctx
      );
    },
  };
}

/**
 * ERA5 reanalysis — the back-catalogue fallback, 1940 to five days ago.
 *
 * Requests no pressure levels and no CAPE because this dataset genuinely
 * lacks them; asking anyway would spend URL length to receive a column of
 * nulls. `variables` says so, and the charts respond by hiding those panels.
 */
export function openMeteoEra5Provider(): WeatherProvider {
  return {
    id: "open-meteo-era5",
    label: "Open-Meteo ERA5 reanalysis",
    priority: 10,
    supports: () => true,
    fetch: async (q, ctx) => {
      requireElapsedWindow("open-meteo-era5", q, ctx);
      return fetchOpenMeteo(
        {
          baseUrl: "https://archive-api.open-meteo.com/v1/archive",
          pressureLevels: [],
          extraVariables: [],
          providerId: "open-meteo-era5",
          model: "ERA5 reanalysis",
          attribution: "Open-Meteo ERA5 reanalysis",
          kind: "reanalysis",
          // ERA5 is a single global 0.25° grid — a resolution we can state
          // as fact rather than infer.
          resolutionKm: 25,
          variables: [
            "surface_wind",
            "surface_gust",
            "surface_temp",
            "cloud_cover",
            "boundary_layer",
            "radiation",
            "precipitation",
          ],
          // ERA5 publishes about five days behind; give it a week to settle.
          settleMs: 7 * DAY_MS,
        },
        q,
        ctx
      );
    },
  };
}

/**
 * Open-Meteo's LIVE forecast — the only source that can answer for a task day
 * that hasn't happened yet.
 *
 * Tasks are routinely set the evening before, and sometimes the whole comp is
 * laid out days ahead; a task page with no weather on it is at its least
 * useful exactly when a pilot most wants to look, which is before they fly.
 *
 * Same model and same variables as the archived forecast — it IS that model,
 * caught before the day it describes — so what separates them is not
 * capability but `kind`. This one says `forecast`, and everything downstream
 * (the in-plot source tag, the attribution line, a screen reader's chart
 * label) repeats that word, so nobody reads a prediction as a record. The
 * archives refuse an unelapsed window for the same reason.
 *
 * The era split is a clean partition, enforced in `fetch` on both sides
 * because `supports` cannot see the clock: the archives take windows that
 * have ended, this takes windows that have not. No gap, no overlap, and no
 * ordering subtlety — the priority below the archived forecast only says
 * where the fall-through goes if that partition is ever relaxed.
 *
 * Every answer here is provisional by construction (`nowMs - toMs` is
 * negative for any window this provider accepts), so the store re-fetches on
 * its six-hour TTL as new model runs land, and the row collapses into the
 * archived truth on the first refresh after the day is flown.
 */
export function openMeteoForecastProvider(): WeatherProvider {
  return {
    id: "open-meteo-forecast",
    label: "Open-Meteo forecast",
    priority: 40,
    supports: () => true,
    fetch: async (q, ctx) => {
      if (q.toMs <= ctx.nowMs) {
        throw new Error(
          "open-meteo-forecast: the task's window has elapsed — the archives own it"
        );
      }
      if (beyondForecastHorizon(q, ctx.nowMs)) {
        // Refused here rather than left to the API's 400, so a comp laid out
        // a month ahead costs no outbound requests and no failure backoff.
        throw new Error(
          `open-meteo-forecast: the task starts more than ${FORECAST_HORIZON_DAYS} days ` +
            `ahead, past the forecast horizon`
        );
      }
      return fetchOpenMeteo(
        {
          baseUrl: "https://api.open-meteo.com/v1/forecast",
          pressureLevels: PRESSURE_LEVELS_HPA,
          extraVariables: ["cape"],
          providerId: "open-meteo-forecast",
          model: "Open-Meteo best-match (ECMWF/regional)",
          attribution: "Open-Meteo forecast",
          kind: "forecast",
          // Same story as the archived forecast: best_match picks a model per
          // location and the API does not report which.
          resolutionKm: null,
          variables: [
            "surface_wind",
            "surface_gust",
            "surface_temp",
            "level_wind",
            "cloud_cover",
            "boundary_layer",
            "cape",
            "radiation",
            "precipitation",
          ],
          // Nominal only: a window this provider accepts always ends in the
          // future, so the answer is provisional whatever this says. A
          // prediction never settles — it gets superseded by the archives.
          settleMs: 3 * DAY_MS,
        },
        q,
        ctx
      );
    },
  };
}

/** All three Open-Meteo providers, for the default registry. */
export function openMeteoProviders(): WeatherProvider[] {
  return [
    openMeteoHistoricalForecastProvider(),
    openMeteoEra5Provider(),
    openMeteoForecastProvider(),
  ];
}
