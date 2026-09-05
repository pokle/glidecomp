/**
 * Pure chart math for the task-analysis charts — scales, ticks, quantiles —
 * plus the tick-label formatter.
 *
 * Deliberately hand-rolled rather than d3-scale: the charts here need a
 * linear scale, nice ticks, and quantiles — ~80 lines of arithmetic that is
 * unit-testable, tree-shakeable, and adds zero bytes of dependency. If a
 * future chart needs time scales, zoom, or transitions, reach for a library
 * then; these helpers are scoped to task-analysis and are not a chart
 * framework.
 */
import { formatMetricValue, type MetricReport } from "../types";
import { unitWords } from "../units";
import { extent, linearScale, niceTicks, spreadLabels } from "@/react/charts/scale";

// Moved to charts/scale.ts when the report card's score charts needed the
// same geometry; re-exported so this module's callers and tests are unchanged.
export { extent, linearScale, niceTicks, spreadLabels };

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

/**
 * The x axis's name: the metric and the unit it is measured in. `count` and
 * `ratio` are unitless in the engine's vocabulary — `formatTickValue` leaves
 * their ticks bare for the same reason — so they get no parenthetical rather
 * than a meaningless "(count)".
 */
export function axisTitleFor(metric: Pick<MetricReport, "label" | "unit">): string {
  return metric.unit === "count" || metric.unit === "ratio"
    ? metric.label
    : `${metric.label} (${unitWords(metric.unit)})`;
}

/** One sample of a fitted trend, in DATA space (not pixels). */
export interface TrendPoint {
  x: number;
  y: number;
}

/** Fewer pairs than this and a local fit is just joining the dots. */
export const MIN_TREND_POINTS = 4;

/**
 * Neighbourhood width as a fraction of n. Small fields get every point (so
 * the fit degenerates to one robust straight line — with 10 pilots there is
 * no local structure to find, only noise to trace); bigger fields settle at
 * 60%, which is stiff enough to stay a *trend* rather than a wiggle chasing
 * individual gaggles. Tuned by eye against Corryong 2026 fields of 29–46
 * pilots: 50% traced visible bumps that the dots did not support.
 */
function defaultBandwidth(n: number): number {
  return Math.min(1, Math.max(0.6, 18 / n));
}

/**
 * LOESS — locally weighted quadratic regression — sampled across the x range.
 * The curve that follows the general trend of a scatter without asserting the
 * trend is a straight line.
 *
 * Why not a plain least-squares line: the relationships here are ranked by
 * *Spearman* ρ, which only claims monotonicity, and several are visibly
 * curved (the leaders and the tail both climb slowly, the middle does not).
 * A straight line chords through those, sitting in empty space. Each sample
 * is a local parabola over its q nearest neighbours with tricube distance
 * weights, so the fit can bend with the field. Bisquare robust passes are
 * available (`robustIterations`) but off by default: they down-weight the
 * leaders and the tail — the points that *are* the bend.
 *
 * Returns null when there is nothing fittable: too few pairs, or every x
 * identical (a vertical stack has no trend, only a value).
 *
 * NOTE: local quadratic regression EXTRAPOLATES at the edges — with one
 * pilot far out on the right, the curve there is an extension of the
 * field's trend, not evidence about that pilot. Callers plotting against a
 * bounded axis (rank) should clamp the fitted y into the axis domain.
 */
export function loessTrend(
  xs: number[],
  ys: number[],
  {
    bandwidth,
    steps = 48,
    robustIterations = 0,
    degree = 2,
  }: {
    bandwidth?: number;
    steps?: number;
    robustIterations?: number;
    /** 2 = local parabola (the published trend). 1 = local line. */
    degree?: 1 | 2;
  } = {}
): TrendPoint[] | null {
  const pairs: TrendPoint[] = [];
  for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
    if (Number.isFinite(xs[i]) && Number.isFinite(ys[i])) pairs.push({ x: xs[i], y: ys[i] });
  }
  pairs.sort((a, b) => a.x - b.x);
  const n = pairs.length;
  if (n < MIN_TREND_POINTS) return null;
  const px = pairs.map((p) => p.x);
  const py = pairs.map((p) => p.y);
  if (!(px[n - 1] > px[0])) return null;

  const minQ = degree === 2 ? 4 : 3;
  const q = Math.min(n, Math.max(minQ, Math.round((bandwidth ?? defaultBandwidth(n)) * n)));
  const fitAt = degree === 2 ? localQuadratic : localLinear;
  const robust = new Array<number>(n).fill(1);
  for (let it = 0; it < robustIterations; it++) {
    const residuals = px.map((x, i) => Math.abs(py[i] - fitAt(px, py, robust, x, q)));
    // 6 × the median absolute residual is Cleveland's scale: a point off by
    // more than that is treated as an outlier and drops out entirely.
    const scale = 6 * quantileSorted([...residuals].sort((a, b) => a - b), 0.5);
    if (!(scale > 0)) break; // a perfect fit — nothing to down-weight
    for (let i = 0; i < n; i++) {
      const u = residuals[i] / scale;
      robust[i] = u >= 1 ? 0 : (1 - u * u) ** 2;
    }
  }

  // Sample the fit WHERE THE DATA IS, falling back to an even grid only when
  // the observations outnumber it. This matters for the count metrics (0, 1,
  // 2, 3 thermals): on an even grid the curve draws a flat plateau across
  // x ∈ [0, 0.7] and then a near-vertical wall up to x = 1, implying both
  // that fractional values exist and that something happens at 0.75. Sampled
  // at the observed values it is one straight segment from the fit at 0 to
  // the fit at 1 — which is all a polyline between two points ever claimed.
  const distinct = px.filter((x, i) => i === 0 || x !== px[i - 1]);
  const at =
    distinct.length <= steps
      ? distinct
      : Array.from({ length: steps + 1 }, (_, s) => px[0] + ((px[n - 1] - px[0]) * s) / steps);
  return at.map((x) => ({ x, y: fitAt(px, py, robust, x, q) }));
}

/** Slide a q-wide window so x sits as near its centre as the ends allow. */
function windowBounds(px: number[], x: number, q: number): { lo: number; hi: number; far: number } {
  const n = px.length;
  let lo = 0;
  let hi = q - 1;
  while (hi < n - 1 && x - px[lo] > px[hi + 1] - x) {
    lo++;
    hi++;
  }
  return { lo, hi, far: Math.max(x - px[lo], px[hi] - x) };
}

function tricubeWeights(
  px: number[],
  robust: number[],
  x: number,
  lo: number,
  hi: number,
  far: number
): { w: number[]; sw: number } {
  const w: number[] = [];
  let sw = 0;
  for (let i = lo; i <= hi; i++) {
    const t = far > 0 ? Math.abs(px[i] - x) / far : 0;
    const wi = (t >= 1 ? 0 : (1 - t ** 3) ** 3) * robust[i];
    w.push(wi);
    sw += wi;
  }
  return { w, sw };
}

function windowMean(py: number[], lo: number, hi: number): number {
  let sum = 0;
  for (let i = lo; i <= hi; i++) sum += py[i];
  return sum / (hi - lo + 1);
}

/**
 * The LOESS fit at one x: weighted least squares over the q nearest
 * neighbours, tricube-weighted by distance and scaled by the caller's
 * robustness weights. `px` must be ascending.
 */
function localLinear(
  px: number[],
  py: number[],
  robust: number[],
  x: number,
  q: number
): number {
  const { lo, hi, far } = windowBounds(px, x, q);
  const { w, sw } = tricubeWeights(px, robust, x, lo, hi, far);
  if (!(sw > 0)) {
    // Every neighbour was zeroed (all robustness weights gone, or a
    // single-point window at its own tricube edge): fall back to the plain
    // mean of the window rather than dividing by zero.
    return windowMean(py, lo, hi);
  }

  // Centred second pass — E[x²] − E[x]² loses precision when the values are
  // large and their spread is small (e.g. altitudes in metres).
  let swx = 0;
  let swy = 0;
  for (let i = lo; i <= hi; i++) {
    swx += w[i - lo] * px[i];
    swy += w[i - lo] * py[i];
  }
  const mx = swx / sw;
  const my = swy / sw;
  let sxx = 0;
  let sxy = 0;
  for (let i = lo; i <= hi; i++) {
    const dx = px[i] - mx;
    sxx += w[i - lo] * dx * dx;
    sxy += w[i - lo] * dx * (py[i] - my);
  }
  const slope = sxx > 1e-12 ? sxy / sxx : 0;
  return my + slope * (x - mx);
}

/**
 * Local quadratic: same neighbourhood and tricube weights as {@link localLinear},
 * but a parabola in each window. ŷ at the evaluation x is β₀ of the weighted
 * fit in scaled coordinates z = (xᵢ − x) / far, so the constant term is the
 * value on the curve (Cleveland 1979, degree 2). Falls back to the linear
 * fit when the 3×3 is singular — a window of two distinct x cannot support
 * a parabola.
 */
function localQuadratic(
  px: number[],
  py: number[],
  robust: number[],
  x: number,
  q: number
): number {
  const { lo, hi, far } = windowBounds(px, x, q);
  const { w, sw } = tricubeWeights(px, robust, x, lo, hi, far);
  if (!(sw > 0)) return windowMean(py, lo, hi);
  if (!(far > 0)) {
    let sy = 0;
    for (let i = lo; i <= hi; i++) sy += w[i - lo] * py[i];
    return sy / sw;
  }

  const A = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const b = [0, 0, 0];
  for (let i = lo; i <= hi; i++) {
    const wi = w[i - lo];
    if (!(wi > 0)) continue;
    const z = (px[i] - x) / far;
    const row = [1, z, z * z];
    for (let r = 0; r < 3; r++) {
      b[r] += wi * row[r] * py[i];
      for (let c = 0; c < 3; c++) A[r][c] += wi * row[r] * row[c];
    }
  }
  const beta = solveLinearSystem(A, b);
  if (!beta) return localLinear(px, py, robust, x, q);
  return beta[0];
}

/** Gaussian elimination with partial pivoting. Null when the matrix is singular. */
function solveLinearSystem(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let k = 0; k < n; k++) {
    let piv = k;
    for (let i = k + 1; i < n; i++) {
      if (Math.abs(M[i][k]) > Math.abs(M[piv][k])) piv = i;
    }
    if (!(Math.abs(M[piv][k]) > 1e-12)) return null;
    [M[k], M[piv]] = [M[piv], M[k]];
    const diag = M[k][k];
    for (let j = k; j <= n; j++) M[k][j] /= diag;
    for (let i = 0; i < n; i++) {
      if (i === k) continue;
      const f = M[i][k];
      for (let j = k; j <= n; j++) M[i][j] -= f * M[k][j];
    }
  }
  return M.map((row) => row[n]);
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

/**
 * ρ re-expressed against {@link directionAdjustedPercentile}'s orientation:
 * POSITIVE when the end of the metric that scores 100 there is the end that
 * went with better ranks, negative when it ran the other way, ~0 when the
 * metric said nothing. 0 when the metric earned no coefficient at all.
 *
 * `MetricCorrelation.rho` is signed against rank, where rank 1 is best, so a
 * 'higher'-is-better metric that behaved as advertised earns a NEGATIVE ρ —
 * hence the flip. 'neutral' metrics keep the raw percentile, whose high end is
 * the high value, so they orient the same way as 'higher'.
 *
 * This is a presentation ORDER key, not a re-orientation of anyone's values:
 * it says where to put a column, never what a cell means. Shading a cell by
 * the observed ρ sign is the thing `directionAdjustedPercentile` refuses to
 * do, and this must not become a back door to it.
 */
export function orientedRho(
  metric: Pick<MetricReport, "direction" | "correlation">
): number {
  if (!metric.correlation) return 0;
  return (metric.direction === "lower" ? 1 : -1) * metric.correlation.rho;
}
