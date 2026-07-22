// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Small dependency-free statistics helpers for field analysis.
 *
 * Spearman correlation is the field-analysis eval: each behavioural metric is
 * correlated against GAP rank to find which behaviours separate the
 * leaderboard. Ties get average ranks (the standard Spearman treatment), so a
 * field where many pilots share a value doesn't fabricate correlation.
 */

/**
 * Linear-interpolated percentile of an ASCENDING-sorted array.
 * `p` in [0, 100]. NaN for an empty array.
 */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0];
  const pos = (Math.min(100, Math.max(0, p)) / 100) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Median of an UNSORTED array. NaN for empty. */
export function median(values: number[]): number {
  return percentile([...values].sort((a, b) => a - b), 50);
}

/** Arithmetic mean. NaN for empty. */
export function mean(values: number[]): number {
  if (values.length === 0) return NaN;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/**
 * 1-based ranks with ties given their average rank (Spearman tie treatment):
 * [10, 20, 20, 30] → [1, 2.5, 2.5, 4].
 */
export function rankWithTies(values: number[]): number[] {
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(values.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1].v === order[i].v) j++;
    const avgRank = (i + j) / 2 + 1; // 1-based average of positions i..j
    for (let k = i; k <= j; k++) ranks[order[k].i] = avgRank;
    i = j + 1;
  }
  return ranks;
}

/**
 * Spearman rank correlation of two parallel series: Pearson correlation of
 * their tied ranks. Returns NaN when n < 3 or either series is constant.
 */
export function spearman(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return NaN;
  const ra = rankWithTies(a.slice(0, n));
  const rb = rankWithTies(b.slice(0, n));
  const ma = mean(ra);
  const mb = mean(rb);
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    const da = ra[i] - ma;
    const db = rb[i] - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  if (va === 0 || vb === 0) return NaN;
  return cov / Math.sqrt(va * vb);
}

/**
 * Approximate two-tailed α = 0.05 critical |ρ| for a Spearman correlation of
 * n pairs — the "noise floor": shuffled ranks produce |ρ| this large 5% of
 * the time, so an observed |ρ| below it is indistinguishable from luck.
 *
 * Uses the t-approximation t = ρ·√((n−2)/(1−ρ²)) inverted at t₀.₉₇₅,ₙ₋₂
 * (Cornish–Fisher expansion for the t quantile; exact small-df values where
 * the expansion is poor). Within a few percent of exact permutation tables —
 * fine for a verdict gate, documented as approximate.
 * NaN for n < 3 (no correlation is computed there at all).
 */
export function spearmanNoiseFloor(n: number): number {
  if (n < 3) return NaN;
  const df = n - 2;
  // t quantile at 0.975 for df degrees of freedom.
  let t: number;
  if (df === 1) t = 12.706;
  else if (df === 2) t = 4.303;
  else {
    const z = 1.959964; // Φ⁻¹(0.975)
    t =
      z +
      (z ** 3 + z) / (4 * df) +
      (5 * z ** 5 + 16 * z ** 3 + 3 * z) / (96 * df * df) +
      (3 * z ** 7 + 19 * z ** 5 + 17 * z ** 3 - 15 * z) / (384 * df ** 3);
  }
  return Math.min(1, t / Math.sqrt(df + t * t));
}

/** A wind sample for {@link circularMeanWind}: speed m/s, direction ° FROM. */
export interface WindSample {
  speed: number;
  direction: number;
}

/** Vector-averaged wind: speed (m/s), direction (° FROM), sample count. */
export interface MeanWind {
  speed: number;
  direction: number;
  n: number;
}

/**
 * Vector (u/v component) average of wind estimates. Averaging components
 * rather than angles keeps a 350°/10° pair from averaging to 180°, and lets
 * conflicting estimates cancel — a low mean speed over many samples honestly
 * reads as "light and variable". Null when no samples.
 */
export function circularMeanWind(samples: WindSample[]): MeanWind | null {
  if (samples.length === 0) return null;
  // Wind FROM `direction` blows TOWARD direction+180: velocity components
  // u (east) = -speed·sin(dir), v (north) = -speed·cos(dir).
  let u = 0;
  let v = 0;
  for (const s of samples) {
    const rad = (s.direction * Math.PI) / 180;
    u += -s.speed * Math.sin(rad);
    v += -s.speed * Math.cos(rad);
  }
  u /= samples.length;
  v /= samples.length;
  const speed = Math.hypot(u, v);
  const direction = ((Math.atan2(-u, -v) * 180) / Math.PI + 360) % 360;
  return { speed, direction, n: samples.length };
}
