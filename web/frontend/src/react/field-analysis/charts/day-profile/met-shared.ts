/**
 * Pure helpers behind the panel's weather charts.
 *
 * Extracted from the components so the judgement calls — what counts as the
 * usable ceiling, how much cover reads as "some cloud" — are unit-testable
 * without rendering SVG, and so the two components that need the same rule
 * cannot drift apart.
 */

import { andoyerDistance } from "@glidecomp/engine";
import type { TaskWeather, WeatherHour } from "@/react/weather/types";

const HOUR_MS = 3_600_000;

/**
 * How far the provider's grid point sits from the point we asked about, in
 * km, and how far its terrain is from the task's own.
 *
 * Both numbers are provenance a reader needs and neither is guessable from
 * the charts. A model cell kilometres wide averages a ridge and its valley
 * into one elevation: Corryong's Task 1 spans a 932 m launch to a 276 m
 * goal (mean 543 m) while the grid point reports 298 m. Every AGL height on
 * the thermal chart is measured from THAT datum, so a reader comparing them
 * against a pilot's altitude deserves to know the gap.
 *
 * Returns nulls rather than zeros where the inputs are missing, so the UI
 * can omit a clause instead of asserting "0 m away".
 */
export function sampleOffset(weather: TaskWeather): {
  distanceKm: number | null;
  elevationDeltaM: number | null;
} {
  const { source, resolved } = weather;
  // Project rule: never hand-roll geo maths — geo.ts owns the WGS84 formulas.
  const distanceKm =
    Number.isFinite(source.pointLat) && Number.isFinite(resolved.lat)
      ? andoyerDistance(resolved.lat, resolved.lon, source.pointLat, source.pointLon) / 1000
      : null;
  const elevationDeltaM =
    source.pointElevationM !== null && resolved.elevationM !== null
      ? source.pointElevationM - resolved.elevationM
      : null;
  return { distanceKm, elevationDeltaM };
}

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
 * Push two inline series labels apart so they stay legible where their lines
 * converge, keeping both inside `[top, bottom]`.
 *
 * Needed because these labels sit at the END of their lines, and the two
 * lines meeting there is not an edge case — it is the interesting day. Cloud
 * base crossing the mixed-layer top is exactly when a blue day turns into a
 * cumulus one, and that is precisely where the two labels would overprint
 * into unreadable mush.
 *
 * `a` is nudged up and `b` down, preserving which is which; if the band is
 * too short for the gap, they are centred in it and the caller accepts the
 * overlap rather than drawing outside the plot.
 */
export function separateLabels(
  a: number,
  b: number,
  [top, bottom]: [number, number],
  minGap = 11
): [number, number] {
  const clamp = (v: number) => Math.min(bottom, Math.max(top, v));
  let ya = clamp(a);
  let yb = clamp(b);
  const gap = yb - ya;
  if (gap >= minGap) return [ya, yb];

  const mid = (ya + yb) / 2;
  ya = mid - minGap / 2;
  yb = mid + minGap / 2;

  // Shift the pair as a unit back inside the band before giving up on it.
  if (ya < top) {
    yb += top - ya;
    ya = top;
  }
  if (yb > bottom) {
    ya -= yb - bottom;
    yb = bottom;
  }
  return [clamp(ya), clamp(yb)];
}

/** Per-character widths as a fraction of the font size, for the UI sans at
 * label sizes. Four buckets is enough: the caller only needs to know roughly
 * where a right-anchored label starts. */
const CHAR_EM: { chars: string; em: number }[] = [
  { chars: "iltfIj.,:;'`!|()[]{}", em: 0.33 },
  { chars: " ", em: 0.3 },
  { chars: "mwMW@", em: 0.92 },
  { chars: "ABCDEFGHJKLNOPQRSTUVXYZ0123456789%°", em: 0.65 },
];
const DEFAULT_EM = 0.6;

/**
 * How wide `text` will render at `fontPx`, near enough to place something
 * beside it.
 *
 * SVG has no layout, so the only exact answer needs a live DOM measurement —
 * which these charts deliberately avoid (they render identically in a test,
 * on a server, and in a browser). The table is calibrated against
 * `getComputedTextLength()` for the labels these charts actually draw, and
 * deliberately tuned to run a hair WIDE (0–3 units on those strings), so the
 * error shows up as a slightly generous gap rather than as an overlap.
 */
export function approxTextWidth(text: string, fontPx: number): number {
  let em = 0;
  for (const ch of text) {
    em += CHAR_EM.find((bucket) => bucket.chars.includes(ch))?.em ?? DEFAULT_EM;
  }
  return em * fontPx;
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
