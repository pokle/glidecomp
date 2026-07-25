/**
 * Pure helpers behind the panel's weather charts.
 *
 * Extracted from the components so the judgement calls — what counts as the
 * usable ceiling, how much cover reads as "some cloud" — are unit-testable
 * without rendering SVG, and so the two components that need the same rule
 * cannot drift apart.
 */

import type { WeatherHour } from "@/react/weather/types";

const HOUR_MS = 3_600_000;

/**
 * Cloud cover percentage → fill opacity for a lane cell.
 *
 * The floor at the first non-zero percent is the point: 5 % cover and clear
 * sky are different days for a free-flying pilot (one has markers), and a
 * linear ramp from zero would render both as blank.
 */
export function coverOpacity(pct: number): number {
  if (!Number.isFinite(pct) || pct <= 0) return 0;
  return 0.12 + 0.78 * Math.min(1, pct / 100);
}

/**
 * The height a pilot could actually use in an hour: the LOWER of the mixed
 * layer top and the condensation level, since whichever comes first is the
 * ceiling. Falls back to whichever single one the dataset supplied, and null
 * when it supplied neither.
 */
export function usableCeilingM(
  boundaryLayerDepthM: number | null,
  cloudBaseAglM: number | null
): number | null {
  if (boundaryLayerDepthM !== null && cloudBaseAglM !== null) {
    return Math.min(boundaryLayerDepthM, cloudBaseAglM);
  }
  return boundaryLayerDepthM ?? cloudBaseAglM;
}

/**
 * Was this a blue day at this hour — thermals topping out below any cloud?
 * Null when the two heights aren't both known, because "blue" is a
 * comparison and one number cannot make it.
 */
export function isBlueHour(hour: WeatherHour): boolean | null {
  const { boundaryLayerDepthM, cloudBaseAglM } = hour;
  if (boundaryLayerDepthM === null || cloudBaseAglM === null) return null;
  return cloudBaseAglM > boundaryLayerDepthM;
}

/**
 * Every instant a weather series occupies — each hour's start AND end, so
 * the shared time axis spans the full width of the last hour's column rather
 * than stopping at the point where it begins.
 */
export function weatherInstants(hours: readonly { t: string }[]): number[] {
  const out: number[] = [];
  for (const h of hours) {
    const t = new Date(h.t).getTime();
    if (!Number.isFinite(t)) continue;
    out.push(t, t + HOUR_MS);
  }
  return out;
}
