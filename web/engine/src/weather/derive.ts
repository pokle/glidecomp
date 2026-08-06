// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Pure atmospheric helpers shared by every weather provider.
 *
 * These are the only place a number gets INVENTED rather than fetched, so
 * they live apart from the adapters and are unit-tested directly. Each one
 * returns null rather than a plausible-looking guess when its inputs are
 * missing — a null draws nothing, whereas a fabricated cloud base gets read
 * as fact by a pilot.
 */

import { bearingFromComponents } from "../geo";
import type { WeatherLevel } from "./types";

/** ISA sea-level pressure, hPa. */
const ISA_SEA_LEVEL_HPA = 1013.25;

/**
 * Lifting condensation level in metres ABOVE GROUND from the surface
 * temperature/dewpoint spread — Espy's rule, the estimate every free-flying
 * pilot already does in their head: ~125 m of cloud base per °C of spread.
 *
 * Deliberately the crude form rather than a full parcel ascent: it is what
 * pilots quote, it needs only the two variables every provider carries, and
 * its error (a few hundred metres in a deep dry mix) is smaller than the
 * difference between a model grid cell and the actual launch.
 *
 * Returns null when either input is missing or the air is saturated
 * (spread ≤ 0), where the concept has no useful reading.
 */
export function lclHeightAglM(
  temperatureC: number | null | undefined,
  dewPointC: number | null | undefined
): number | null {
  if (typeof temperatureC !== "number" || typeof dewPointC !== "number") return null;
  if (!Number.isFinite(temperatureC) || !Number.isFinite(dewPointC)) return null;
  const spread = temperatureC - dewPointC;
  if (spread <= 0) return null;
  return 125 * spread;
}

/**
 * Approximate geometric height AMSL of a pressure level, by the ISA
 * barometric formula.
 *
 * Approximate on purpose: the true height of, say, 850 hPa moves by a few
 * hundred metres with the airmass, but the UI uses this only to LABEL a
 * level ("~1500 m") and to pick which level is nearest flying height. Both
 * survive that error; nothing is scored from it.
 */
export function pressureToHeightM(pressureHpa: number): number {
  return 44330.77 * (1 - Math.pow(pressureHpa / ISA_SEA_LEVEL_HPA, 0.1902632));
}

/** Inverse of `pressureToHeightM` — the ISA pressure at a height AMSL. */
export function heightToPressureHpa(heightM: number): number {
  return ISA_SEA_LEVEL_HPA * Math.pow(1 - heightM / 44330.77, 1 / 0.1902632);
}

/**
 * The level nearest a target height AMSL, ignoring levels with no wind.
 * Returns null when the column is empty or entirely windless.
 */
export function levelNearestHeight(
  levels: readonly WeatherLevel[],
  targetHeightM: number
): WeatherLevel | null {
  let best: WeatherLevel | null = null;
  let bestGap = Infinity;
  for (const level of levels) {
    if (level.windSpeedKmh === null || level.windDirectionDeg === null) continue;
    const gap = Math.abs(level.heightM - targetHeightM);
    if (gap < bestGap) {
      best = level;
      bestGap = gap;
    }
  }
  return best;
}

/**
 * How high above the terrain "flying height" sits when we have nothing
 * better to go on. A metre figure rather than a pressure level because
 * terrain elevation varies far more between comps than the airmass does:
 * 1000 m AGL is a working thermal on the Corryong ridge and over Birchip
 * alike, whereas a fixed 850 hPa would be underground in the Alps.
 */
export const DEFAULT_FLYING_HEIGHT_AGL_M = 1000;

/**
 * Pick the level that best represents the air pilots were actually flying
 * in: nearest to `terrainElevationM + aboveGroundM`.
 *
 * This is what makes the modelled wind comparable to the pilot-derived wind
 * from circle drift. Comparing that against a 10 m surface wind — which is
 * what a naive integration would plot — reads as a contradiction when it is
 * just two different heights: at Corryong the surface ran 8–18 km/h while
 * 900 hPa ran 30–42 km/h on the same afternoon.
 */
export function flyingHeightLevel(
  levels: readonly WeatherLevel[],
  terrainElevationM: number | null,
  aboveGroundM: number = DEFAULT_FLYING_HEIGHT_AGL_M
): WeatherLevel | null {
  const base = terrainElevationM ?? 0;
  return levelNearestHeight(levels, base + aboveGroundM);
}

/**
 * Vector-interpolate an hour's level winds to a height AMSL — the model's
 * wind at a specific altitude, for comparing against a wind measured from
 * tracks at that altitude (the thermal-shape cross-check).
 *
 * Interpolation happens on the u/v components, not on speed and direction
 * separately: two levels 40° apart average to the vector between them, where
 * a naive direction average through north would swing the wrong way.
 *
 * Heights outside the column clamp to the nearest level rather than
 * extrapolating — the column's ends are real readings; a projected gradient
 * past them is not. Null when the hour carries no usable levels.
 */
export function windAtHeight(
  levels: readonly WeatherLevel[],
  heightM: number
): { directionDeg: number; speedKmh: number } | null {
  const usable = levels.filter(
    (l): l is WeatherLevel & { windDirectionDeg: number; windSpeedKmh: number } =>
      l.windDirectionDeg !== null && l.windSpeedKmh !== null
  );
  if (usable.length === 0) return null;
  const sorted = [...usable].sort((a, b) => a.heightM - b.heightM);
  const toVec = (l: { windDirectionDeg: number; windSpeedKmh: number }) => {
    const rad = (l.windDirectionDeg * Math.PI) / 180;
    return { u: l.windSpeedKmh * Math.sin(rad), v: l.windSpeedKmh * Math.cos(rad) };
  };
  let u: number;
  let v: number;
  if (heightM <= sorted[0].heightM) {
    ({ u, v } = toVec(sorted[0]));
  } else if (heightM >= sorted[sorted.length - 1].heightM) {
    ({ u, v } = toVec(sorted[sorted.length - 1]));
  } else {
    let i = 1;
    while (sorted[i].heightM < heightM) i++;
    const lo = sorted[i - 1];
    const hi = sorted[i];
    const t = (heightM - lo.heightM) / (hi.heightM - lo.heightM);
    const a = toVec(lo);
    const b = toVec(hi);
    u = a.u + (b.u - a.u) * t;
    v = a.v + (b.v - a.v) * t;
  }
  const speedKmh = Math.hypot(u, v);
  const directionDeg = bearingFromComponents(u, v);
  return { directionDeg, speedKmh };
}
