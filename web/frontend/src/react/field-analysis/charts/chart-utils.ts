/**
 * Pure chart math for the field-analysis charts — scales, ticks, quantiles —
 * plus the tick-label formatter.
 *
 * Deliberately hand-rolled rather than d3-scale: the charts here need a
 * linear scale, nice ticks, and quantiles — ~80 lines of arithmetic that is
 * unit-testable, tree-shakeable, and adds zero bytes of dependency. If a
 * future chart needs time scales, zoom, or transitions, reach for a library
 * then; these helpers are scoped to field-analysis and are not a chart
 * framework.
 */
import { formatMetricValue } from "../types";

/**
 * An axis/strip tick label: the engine's number formatting plus a unit
 * suffix, so the scale reads without hunting for the unit elsewhere.
 *
 * The suffix vocabulary is the engine's metric `unit` set. Minutes are
 * "min", never "m" — "m" already means metres in that vocabulary (e.g. the
 * ESS altitude margin), and "5 m" behind the leader would read as metres.
 * `count` and `ratio` are unitless and stay bare.
 *
 * All-zero decimals are trimmed ("20.0 min" → "20 min"): nice ticks are
 * round by construction, and the engine's fixed decimal places are a table
 * convention, not an axis one. Fractional ticks ("2.5 m/s") keep theirs.
 */
export function formatTickValue(unit: string, value: number): string {
  const num = formatMetricValue(unit, value).replace(/\.0+$/, "");
  switch (unit) {
    case "pct":
      return `${num}%`;
    case "m/s":
    case "km/h":
    case "mph":
    case "kts":
    case "fpm":
    case "s":
    case "min":
    case "m":
    case "ft":
      return `${num} ${unit}`;
    default:
      return num;
  }
}

/** [min, max] of the finite values, or null when there are none. */
export function extent(values: number[]): [number, number] | null {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return min <= max ? [min, max] : null;
}

/**
 * Maps [d0, d1] linearly onto [r0, r1]. A degenerate domain (d0 === d1, e.g.
 * every pilot produced the same value) maps everything to the range midpoint
 * rather than dividing by zero.
 */
export function linearScale(
  [d0, d1]: [number, number],
  [r0, r1]: [number, number]
): (v: number) => number {
  const span = d1 - d0;
  if (span === 0) return () => (r0 + r1) / 2;
  return (v: number) => r0 + ((v - d0) / span) * (r1 - r0);
}

/**
 * Round tick values covering [d0, d1] at a step of 1, 2, or 5 × 10^k —
 * the d3 "nice ticks" algorithm, without d3. Ticks are clamped inside the
 * domain, so the caller's scale never has to render outside its plot area.
 * A degenerate domain yields the single value.
 */
export function niceTicks([d0, d1]: [number, number], count = 5): number[] {
  if (d0 === d1) return [d0];
  const span = d1 - d0;
  const rawStep = span / Math.max(1, count);
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const residual = rawStep / magnitude;
  // d3's √-midpoint thresholds, so a requested count of 4 over [-1, 1]
  // yields halves rather than jumping straight to whole numbers.
  const step =
    (residual >= Math.sqrt(50) ? 10 : residual >= Math.sqrt(10) ? 5 : residual >= Math.sqrt(2) ? 2 : 1) *
    magnitude;
  // Fractional steps are inexact in float, so snap each tick to the step's
  // decimal precision (0.30000000000000004 → 0.3) — steps are 1/2/5 × 10^k,
  // so 10^k's exponent bounds the decimals needed.
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  const ticks: number[] = [];
  const first = Math.ceil(d0 / step);
  const last = Math.floor(d1 / step + 1e-9);
  for (let i = first; i <= last; i++) {
    ticks.push(Number((i * step).toFixed(decimals)));
  }
  return ticks;
}

/**
 * Nudges label positions apart so none sit closer than minGap, keeping each
 * as near its desired spot as the others allow, clamped to [lo, hi].
 *
 * Used for the scatter's direct labels: the top-3 pilots are adjacent ranks,
 * a few pixels apart vertically — unspread, their names print on top of each
 * other. Best-effort: if [lo, hi] cannot fit them all at minGap, the lower
 * bound wins and the tail compresses.
 *
 * Returns adjusted positions in the same order as the input.
 */
export function spreadLabels(
  desired: number[],
  minGap: number,
  lo: number,
  hi: number
): number[] {
  const order = desired.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);
  const ys = order.map((o) => o.y);
  for (let k = 1; k < ys.length; k++) ys[k] = Math.max(ys[k], ys[k - 1] + minGap);
  if (ys.length > 0) ys[ys.length - 1] = Math.min(ys[ys.length - 1], hi);
  for (let k = ys.length - 2; k >= 0; k--) ys[k] = Math.min(ys[k], ys[k + 1] - minGap);
  for (let k = 0; k < ys.length; k++) ys[k] = Math.max(ys[k], lo);
  const out = new Array<number>(desired.length);
  order.forEach((o, k) => {
    out[o.i] = ys[k];
  });
  return out;
}

/**
 * The p-quantile (0 ≤ p ≤ 1) of an ASCENDING-sorted array, linearly
 * interpolated (R-7, the same rule d3 and numpy default to).
 */
export function quantileSorted(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Midrank percentile of v within values, 0–100: the share of the field
 * strictly below v plus half of those equal to it. A lone value is the 50th
 * percentile, not the 0th or 100th.
 */
export function percentileRank(values: number[], v: number): number {
  if (values.length === 0) return NaN;
  let below = 0;
  let equal = 0;
  for (const w of values) {
    if (w < v) below++;
    else if (w === v) equal++;
  }
  return ((below + equal / 2) / values.length) * 100;
}

/**
 * Percentile oriented so that 100 = best in field, per the metric's
 * direction. 'lower'-is-better metrics invert; 'neutral' metrics return the
 * RAW percentile — orientation would claim a quality direction the metric
 * doesn't have (and auto-orienting by the observed ρ sign would bake one
 * day's noise into that claim, which the explainability rule forbids).
 */
export function directionAdjustedPercentile(
  direction: "higher" | "lower" | "neutral",
  values: number[],
  v: number
): number {
  const pct = percentileRank(values, v);
  return direction === "lower" ? 100 - pct : pct;
}
