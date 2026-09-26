// Copyright (c) 2026, Tushar Pokle.  All rights reserved.
/**
 * Weather features, read out of the archive's `weather/` store.
 *
 * The store is filled by `fetch-weather.ts` through the engine's own
 * providers; this module only reads it. Two datasets are kept apart on
 * purpose — `wx.era5.*` covers the whole 2017–2026 corpus, `wx.fc.*` only
 * 2022+ but adds pressure-level winds and CAPE — because the headline model
 * reports with and without the forecast block, so "did the forecast earn its
 * keep" is answerable rather than assumed.
 *
 * A variable the dataset does not carry is null AND flagged by its own
 * `has_*` indicator, never a zero: ERA5 legitimately has no CAPE, and a model
 * that reads 0 J/kg there has been told something false.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  levelNearestHeight,
  mean,
  type TaskWeather,
  type WeatherHour,
  type WeatherVariable,
} from '@glidecomp/engine';
import { windComponents, type TaskGeometry } from './geometry';
import type { FeatureBlock } from './track-features';

/** The two datasets, and the prefix each gets in a feature row. */
export const WEATHER_DATASETS = [
  { file: 'era5.json', prefix: 'wx.era5.' },
  { file: 'archived-forecast.json', prefix: 'wx.fc.' },
] as const;

/** Every variable a provider can advertise — the indicator columns' domain. */
const VARIABLES: WeatherVariable[] = [
  'surface_wind',
  'surface_gust',
  'surface_temp',
  'level_wind',
  'cloud_cover',
  'boundary_layer',
  'cape',
  'radiation',
  'precipitation',
];

/** Heights AMSL the column is sampled at, where the dataset has levels. */
const LEVEL_HEIGHTS_M = [1500, 2500, 3500];

interface StoredWeather {
  query_key: string;
  weather: TaskWeather;
}

/**
 * Read both datasets for a task and turn them into features.
 *
 * `expectedKey` is the `weatherQueryKey` the engine derives for this task
 * TODAY. A stored answer under a different key is for a different question —
 * the route or the times moved — so it is refused rather than read, and the
 * block reports itself as unavailable until `fetch-weather.ts` refetches.
 */
export function weatherFeatures(
  weatherRoot: string,
  taskDir: string,
  expectedKey: string,
  geom: TaskGeometry,
): FeatureBlock {
  const out: FeatureBlock = {};
  for (const { file, prefix } of WEATHER_DATASETS) {
    const path = join(weatherRoot, taskDir, file);
    let stored: StoredWeather | null = null;
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf-8')) as StoredWeather;
        if (parsed.query_key === expectedKey) stored = parsed;
      } catch {
        stored = null;
      }
    }
    Object.assign(out, datasetFeatures(prefix, stored?.weather ?? null, geom));
  }
  return out;
}

function datasetFeatures(
  prefix: string,
  weather: TaskWeather | null,
  geom: TaskGeometry,
): FeatureBlock {
  const block: FeatureBlock = {};
  const put = (name: string, value: number | null) => {
    block[`${prefix}${name}`] = value;
  };

  const variables = new Set(weather?.source.variables ?? []);
  for (const v of VARIABLES) put(`has_${v}`, weather && variables.has(v) ? 1 : 0);

  const hours = weather?.hours ?? [];
  put('available', weather ? 1 : 0);
  put('hours', weather ? hours.length : null);
  if (!weather || hours.length === 0) {
    for (const name of TASK_WINDOW_FEATURES) put(name, null);
    for (const h of LEVEL_HEIGHTS_M) {
      put(`level_${h}m_speed_kmh`, null);
      put(`level_${h}m_dir_deg`, null);
      put(`level_${h}m_along_course_kmh`, null);
    }
    return block;
  }

  // The middle hour of the task's own window — the query is already the task
  // clock padded an hour each way, so this is the middle of the race.
  const mid = hours[Math.floor(hours.length / 2)];

  put('grid_elevation_offset_m', offset(weather));
  put('surface_wind_kmh', mid.surface.windSpeedKmh);
  put('surface_wind_dir_deg', mid.surface.windDirectionDeg);
  put('surface_wind_trend_kmh_per_h', trend(hours, (h) => h.surface.windSpeedKmh));
  put('surface_gust_kmh', mid.surface.windGustKmh);
  // Gust over mean: how rough the day is, independent of how windy it is.
  put(
    'gust_ratio',
    mid.surface.windGustKmh !== null && mid.surface.windSpeedKmh
      ? mid.surface.windGustKmh / mid.surface.windSpeedKmh
      : null,
  );
  put('temp_c', mid.surface.temperatureC);
  put('dewpoint_c', mid.surface.dewPointC);
  put(
    'spread_c',
    mid.surface.temperatureC !== null && mid.surface.dewPointC !== null
      ? mid.surface.temperatureC - mid.surface.dewPointC
      : null,
  );

  const surfaceWind =
    mid.surface.windSpeedKmh !== null && mid.surface.windDirectionDeg !== null
      ? { speed: mid.surface.windSpeedKmh, from: mid.surface.windDirectionDeg }
      : null;
  const course = surfaceWind
    ? windComponents(surfaceWind.speed, surfaceWind.from, geom.courseBearing)
    : null;
  put('wind_along_course_kmh', course?.along ?? null);
  put('wind_cross_course_kmh', course?.cross ?? null);
  const alongLegs = surfaceWind
    ? geom.legBearings.map((b) => windComponents(surfaceWind.speed, surfaceWind.from, b).along)
    : [];
  put('wind_along_leg_mean_kmh', alongLegs.length ? mean(alongLegs) : null);
  put('wind_along_leg_min_kmh', alongLegs.length ? Math.min(...alongLegs) : null);
  put('wind_along_leg_max_kmh', alongLegs.length ? Math.max(...alongLegs) : null);

  put('blh_mid_m', mid.boundaryLayerDepthM);
  put('blh_peak_m', peak(hours, (h) => h.boundaryLayerDepthM));
  put('lcl_mid_m', mid.cloudBaseAglM);
  put('lcl_peak_m', peak(hours, (h) => h.cloudBaseAglM));
  put('cloud_low_pct', mid.cloud.lowPct);
  put('cloud_total_pct', mid.cloud.totalPct);
  put('cloud_total_mean_pct', average(hours, (h) => h.cloud.totalPct));
  put('radiation_mid_wm2', mid.shortwaveWm2);
  put('radiation_peak_wm2', peak(hours, (h) => h.shortwaveWm2));
  put('cape_mid_jkg', mid.capeJkg);
  put('cape_peak_jkg', peak(hours, (h) => h.capeJkg));
  put('precip_total_mm', total(hours, (h) => h.precipitationMm));

  for (const height of LEVEL_HEIGHTS_M) {
    const level = levelNearestHeight(mid.levels, height);
    put(`level_${height}m_speed_kmh`, level?.windSpeedKmh ?? null);
    put(`level_${height}m_dir_deg`, level?.windDirectionDeg ?? null);
    put(
      `level_${height}m_along_course_kmh`,
      level?.windSpeedKmh != null && level.windDirectionDeg != null
        ? windComponents(level.windSpeedKmh, level.windDirectionDeg, geom.courseBearing).along
        : null,
    );
  }
  return block;
}

/**
 * Every task-window feature name, so an unavailable dataset emits the SAME
 * columns as an available one — a row with fewer keys would silently become a
 * different feature vector downstream.
 */
const TASK_WINDOW_FEATURES = [
  'grid_elevation_offset_m',
  'surface_wind_kmh',
  'surface_wind_dir_deg',
  'surface_wind_trend_kmh_per_h',
  'surface_gust_kmh',
  'gust_ratio',
  'temp_c',
  'dewpoint_c',
  'spread_c',
  'wind_along_course_kmh',
  'wind_cross_course_kmh',
  'wind_along_leg_mean_kmh',
  'wind_along_leg_min_kmh',
  'wind_along_leg_max_kmh',
  'blh_mid_m',
  'blh_peak_m',
  'lcl_mid_m',
  'lcl_peak_m',
  'cloud_low_pct',
  'cloud_total_pct',
  'cloud_total_mean_pct',
  'radiation_mid_wm2',
  'radiation_peak_wm2',
  'cape_mid_jkg',
  'cape_peak_jkg',
  'precip_total_mm',
];

/** How far the model's grid elevation sits from the route's real terrain. */
function offset(weather: TaskWeather): number | null {
  const grid = weather.source.pointElevationM;
  const real = weather.resolved.elevationM;
  return grid === null || real === null ? null : grid - real;
}

function values(hours: WeatherHour[], pick: (h: WeatherHour) => number | null): number[] {
  return hours.map(pick).filter((v): v is number => v !== null && Number.isFinite(v));
}

function peak(hours: WeatherHour[], pick: (h: WeatherHour) => number | null): number | null {
  const vs = values(hours, pick);
  return vs.length === 0 ? null : Math.max(...vs);
}

function total(hours: WeatherHour[], pick: (h: WeatherHour) => number | null): number | null {
  const vs = values(hours, pick);
  return vs.length === 0 ? null : vs.reduce((s, v) => s + v, 0);
}

function average(hours: WeatherHour[], pick: (h: WeatherHour) => number | null): number | null {
  const vs = values(hours, pick);
  return vs.length === 0 ? null : mean(vs);
}

/** Change per hour across the window, by ordinary least squares. */
function trend(hours: WeatherHour[], pick: (h: WeatherHour) => number | null): number | null {
  const xs: number[] = [];
  const ys: number[] = [];
  hours.forEach((h, i) => {
    const v = pick(h);
    if (v !== null && Number.isFinite(v)) {
      xs.push(i);
      ys.push(v);
    }
  });
  if (xs.length < 3) return null;
  const mx = mean(xs);
  const my = mean(ys);
  let cov = 0;
  let varx = 0;
  for (let i = 0; i < xs.length; i++) {
    cov += (xs[i] - mx) * (ys[i] - my);
    varx += (xs[i] - mx) ** 2;
  }
  return varx === 0 ? null : cov / varx;
}
