/**
 * Score-explanation formatting helpers.
 *
 * Fixed-metric number/points/duration formatting and the validity-factor
 * decimal reconciliation used across the section builders. Pure functions
 * (the UI localises times via the injected formatTime).
 */

import type { ClassContextInput } from './score-explanation-types';


// ---------------------------------------------------------------------------
// Formatting helpers (fixed metric — the UI can localise via formatTime)
// ---------------------------------------------------------------------------

export function km(meters: number, decimals = 1): string {
  return `${(meters / 1000).toFixed(decimals)} km`;
}

export function pts(points: number): string {
  return `${fmtPoints(points)} pts`;
}

/**
 * Format a point value at the spec's one-decimal precision (S7F §11), dropping
 * a trailing ".0" so whole scores read as whole numbers.
 */
export function fmtPoints(points: number): string {
  const rounded = Math.round(points * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

// Floors like the scores tables do, so the same time never differs by a second.
export function duration(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = m.toString().padStart(2, '0');
  const ss = sec.toString().padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

export function defaultFormatTime(d: Date): string {
  return `${d.toISOString().slice(11, 19)} UTC`;
}

/**
 * The engine computes the points on offer as `1000 × launch × distance ×
 * time` at full precision, so the printed equation can always be made to
 * reconcile — the only question is how many decimal places the factors
 * need. Start at the 2 the GAP spec prints validities at and add decimals
 * until the displayed figures multiply to the displayed total; 5 always
 * suffices (worst-case rounding error 1000 × 3 × 0.5e-5 ≈ 0.015 pt, under
 * the 0.05 pt display step).
 */
export const VALIDITY_MIN_DECIMALS = 2;
export const VALIDITY_MAX_DECIMALS = 5;

export function validityFactorDecimals(
  v: ClassContextInput['task_validity'],
  total: number,
): number {
  for (let d = VALIDITY_MIN_DECIMALS; d < VALIDITY_MAX_DECIMALS; d++) {
    const product = [v.launch, v.distance, v.time].reduce(
      (p, f) => p * Number(f.toFixed(d)),
      1000,
    );
    if (Math.round(product * 10) === Math.round(total * 10)) return d;
  }
  return VALIDITY_MAX_DECIMALS;
}

/**
 * Every equation the explainer prints states an identity the engine computed
 * at full precision, so the printed figures can always be made to visibly
 * reconcile — the only question is how many decimals they need. Find the
 * fewest decimals in [min, max] at which the display-rounded figures
 * (`evaluate`) match the printed result at the 0.1-pt step; when even `max`
 * doesn't reconcile (inconsistent stored data), the caller prints "≈".
 */
export function reconcileDecimals(
  min: number,
  max: number,
  target: number,
  evaluate: (decimals: number) => number,
): { decimals: number; reconciles: boolean } {
  for (let d = min; d <= max; d++) {
    if (Math.round(evaluate(d) * 10) === Math.round(target * 10)) {
      return { decimals: d, reconciles: true };
    }
  }
  return { decimals: min, reconciles: false };
}

/**
 * Available-points figure + factor decimals that make a component equation
 * reconcile. Tries the 0.1-step available first; when the full-precision
 * product sits on a rounding boundary (e.g. 59.951 printing as 60 while
 * factor × 514.4 lands at 59.947), retries with the available at 2 dp.
 */
export function reconcileWithAvailable(
  available: number,
  minDecimals: number,
  maxDecimals: number,
  target: number,
  evaluate: (decimals: number, availableShown: number) => number,
): { availStr: string; decimals: number; reconciles: boolean } {
  for (const availStr of [fmtPoints(available), trimZeros(available.toFixed(2), 1)]) {
    const shown = Number(availStr);
    const r = reconcileDecimals(minDecimals, maxDecimals, target, (d) =>
      evaluate(d, shown),
    );
    if (r.reconciles) return { availStr, ...r };
  }
  return { availStr: fmtPoints(available), decimals: minDecimals, reconciles: false };
}

/** A km figure at the given precision, as the number the reader sees. */
export function kmNum(meters: number, decimals: number): number {
  return Number((meters / 1000).toFixed(decimals));
}

/** A km figure for an equation, trailing zeros trimmed to at least 1 dp. */
export function kmEq(meters: number, decimals: number): string {
  return `${trimZeros((meters / 1000).toFixed(decimals), 1)} km`;
}

/** Trim trailing zeros from a fixed-decimal string, keeping at least `min` decimals. */
export function trimZeros(s: string, min: number): string {
  const dot = s.indexOf('.');
  if (dot === -1) return s;
  let end = s.length;
  while (end - dot - 1 > min && s[end - 1] === '0') end--;
  if (end - dot - 1 === 0) end--;
  return s.slice(0, end);
}

/** A validity factor at the section's precision, e.g. 0.9993 → "0.9993", 1 → "1.00". */
export function fmtValidityFactor(f: number, decimals: number): string {
  return trimZeros(f.toFixed(decimals), VALIDITY_MIN_DECIMALS);
}

/**
 * A validity as a percentage at the section's precision, so a 0.9993 day
 * reads 99.93% rather than a misleading 100%.
 */
export function pctValidity(fraction: number, decimals: number): string {
  const percentDecimals = Math.max(0, decimals - 2);
  return `${trimZeros((fraction * 100).toFixed(percentDecimals), 0)}%`;
}

/** The `1000 × launch × distance × time` equation for the points on offer. */
export function availableTotalDetail(
  v: ClassContextInput['task_validity'],
  total: number,
  decimals: number,
): string {
  const factors = [v.launch, v.distance, v.time].map((f) =>
    fmtValidityFactor(f, decimals),
  );
  const product = factors.reduce((p, f) => p * Number(f), 1000);
  const reconciles = Math.round(product * 10) === Math.round(total * 10);
  const equation = `1000 × ${factors.join(' × ')}`;
  return reconciles
    ? `${equation} = ${fmtPoints(total)}`
    : `${equation} ≈ ${fmtPoints(total)} — the validity factors are shown rounded to ${decimals} decimal places; the points on offer come from their full precision.`;
}
