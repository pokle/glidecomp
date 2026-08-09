/**
 * CIVL GAP per-component scoring formulas.
 *
 * The individually testable pieces of the GAP formula (FAI S7F): task
 * validity, weight distribution, distance / time / leading / arrival points,
 * and the leading-coefficient pipeline. Each is a pure function of its inputs;
 * the whole-field orchestration that drives them lives in ./gap-scoring.
 */

import type { XCTask } from './xctsk-parser';
import type { IGCFix } from './igc-parser';
import type { TurnpointReaching } from './turnpoint-sequence';
import { getEffectiveSSSIndex, getEffectiveESSIndex } from './xctsk-parser';
import { getOptimizedSegmentDistances } from './task-optimizer';
import { resolveStartGates } from './time-gates';
import { ellipsoidDistance } from './geo';
import type { GAPParameters, LeadingFormula } from './gap-params';
import {
  DEFAULT_GAP_PARAMETERS,
  NOMINAL_LAUNCH,
  NOMINAL_GOAL,
  defaultLeadingTimeRatio,
} from './gap-params';

/** Coefficients of a cubic c0 + c1·x + c2·x² + c3·x³. */
interface Cubic {
  c0: number;
  c1: number;
  c2: number;
  c3: number;
}

/**
 * Evaluate a cubic at x. The FAI S7F validity/arrival curves are fixed
 * polynomials whose coefficients carry no independent meaning — naming them
 * (below) and evaluating here keeps each formula readable while the term
 * grouping (left-to-right multiply then add) stays bit-identical to writing
 * `c1*x + c2*x*x + c3*x*x*x` out inline, so scores never move.
 */
function poly3(x: number, { c0, c1, c2, c3 }: Cubic): number {
  return c0 + c1 * x + c2 * x * x + c3 * x * x * x;
}

// FAI S7F 2026 validity/arrival polynomial coefficients (the spec's own
// numbers).
/**
 * Launch-validity curve in the launch-validity ratio (S7F 2026 §10.1).
 * The linear coefficient is 0.028 — the 2025 edition corrected a typo
 * (0.027) that had stood since about 2014.
 */
const LAUNCH_VALIDITY_CUBIC: Cubic = { c0: 0, c1: 0.028, c2: 2.917, c3: -1.944 };
/** Time-validity curve in the time-validity ratio (S7F 2026 §10.3). */
const TIME_VALIDITY_CUBIC: Cubic = { c0: -0.271, c1: 2.912, c2: -2.098, c3: 0.457 };
/** Arrival-points curve in the arrival ratio (S7F 2026 §12.4, HG only). */
const ARRIVAL_POINTS_CUBIC: Cubic = { c0: 0.2, c1: 0.037, c2: 0.13, c3: 0.633 };

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Task validity breakdown. */
export interface TaskValidity {
  launch: number;
  distance: number;
  time: number;
  /**
   * Stopped-task validity (FAI S7F §12.3.3) — the fourth factor, present
   * only when the task was stopped. 1 when anyone reached ESS; 0 when the
   * stopped task didn't run long enough to be scored (§12.3.2).
   */
  stopped?: number;
  /** Product of launch × distance × time (× stopped when the task was stopped) */
  task: number;
}

/** Weight fractions for each scoring component. */
export interface WeightFractions {
  distance: number;
  time: number;
  leading: number;
  arrival: number;
}

// ---------------------------------------------------------------------------
// Task Validity
// ---------------------------------------------------------------------------

/**
 * Calculate launch validity (S7F 2026 §10.1).
 * Reduced when fewer pilots launch than the fixed 96% nominal threshold.
 */
export function calculateLaunchValidity(
  numFlying: number,
  numPresent: number,
): number {
  if (numPresent === 0) return 0;
  const lvr = Math.min(1, numFlying / (numPresent * NOMINAL_LAUNCH));
  return Math.min(1, Math.max(0, poly3(lvr, LAUNCH_VALIDITY_CUBIC)));
}

/**
 * Calculate distance validity (S7F 2026 §10.2).
 * Reduced when pilots don't fly far enough relative to nominal parameters.
 * The formula's DistanceWeight (nominal goal) is fixed at 30% by the spec.
 */
export function calculateDistanceValidity(
  pilotDistances: number[],
  bestDistance: number,
  nominalDistance: number,
  minimumDistance: number,
): number {
  const numFlying = pilotDistances.length;
  if (numFlying === 0) return 0;

  const sumOverMin = pilotDistances.reduce(
    (sum, d) => sum + Math.max(0, d - minimumDistance), 0
  );

  const a = (NOMINAL_GOAL + 1) * (nominalDistance - minimumDistance);
  const b = Math.max(0, NOMINAL_GOAL * (bestDistance - nominalDistance));
  const nominalDistArea = (a + b) / 2;

  if (nominalDistArea <= 0) return 0;

  const dvr = sumOverMin / (numFlying * nominalDistArea);
  return Math.min(1, Math.max(0, dvr));
}

/**
 * Calculate time validity.
 * Reduced when the fastest time is too short relative to nominal time.
 */
export function calculateTimeValidity(
  bestTime: number | null,
  bestDistance: number,
  nominalTime: number,
  nominalDistance: number,
): number {
  let x: number;
  if (bestTime !== null && bestTime > 0) {
    x = bestTime / nominalTime;
  } else {
    x = bestDistance / nominalDistance;
  }
  const tvr = Math.min(1, x);
  return Math.max(0, Math.min(1, poly3(tvr, TIME_VALIDITY_CUBIC)));
}

/**
 * Inputs to the §12.3.3 stopped-task validity formula, all distances in
 * METRES (the formula itself works in km, per the spec).
 */
export interface StoppedValidityInputs {
  /** Pilots' flown distances (m) — every launched pilot, bonus included. */
  pilotDistances: number[];
  /** How many of the launched pilots reached the end of the speed section. */
  numReachedESS: number;
  /** Launched pilots who landed before the task stop time. */
  numLandedBeforeStop: number;
  /** Optimized distance from launch to the end of the speed section (m). */
  launchToEssDistance: number;
}

/**
 * Stopped-task validity (FAI S7F §12.3.3) — the fourth validity factor for
 * a stopped task:
 *
 *   NumberOfPilotsReachedESS > 0 : StoppedTaskValidity = 1
 *   NumberOfPilotsReachedESS = 0 :
 *     min(1, √((BestDistFlown − AvgDistFlown) / (TaskDistLaunchToESS −
 *       BestDistFlown + 1) × √(StDevDistFlown / 5)) +
 *       (NumPilotsLandedBeforeStop / NumPilotsLaunched)³)
 *
 * with distances in km and the sample standard deviation, matching AirScore.
 * Degenerate inputs (nobody launched, best distance at/past the ESS with the
 * +1 km buffer) clamp rather than produce NaN.
 */
export function calculateStoppedTaskValidity(inputs: StoppedValidityInputs): number {
  const { pilotDistances, numReachedESS, numLandedBeforeStop, launchToEssDistance } = inputs;
  if (numReachedESS > 0) return 1;
  const launched = pilotDistances.length;
  if (launched === 0) return 0;

  const distancesKm = pilotDistances.map(d => d / 1000);
  const bestKm = distancesKm.reduce((max, d) => Math.max(max, d), 0);
  const avgKm = distancesKm.reduce((sum, d) => sum + d, 0) / launched;
  // Sample standard deviation (n − 1), 0 for a single pilot.
  let stDevKm = 0;
  if (launched > 1) {
    const sumSq = distancesKm.reduce((sum, d) => sum + (d - avgKm) * (d - avgKm), 0);
    stDevKm = Math.sqrt(sumSq / (launched - 1));
  }

  const denomKm = launchToEssDistance / 1000 - bestKm + 1;
  const spread = denomKm > 0 && bestKm > avgKm
    ? Math.sqrt(((bestKm - avgKm) / denomKm) * Math.sqrt(stDevKm / 5))
    : 0;
  const landedRatio = numLandedBeforeStop / launched;
  return Math.min(1, spread + landedRatio * landedRatio * landedRatio);
}

/**
 * Calculate complete task validity.
 *
 * @param stoppedValidity - The §12.3.3 stopped-task validity factor, present
 *   only when the task was stopped ({@link calculateStoppedTaskValidity} — or
 *   0 when the stopped task failed the §12.3.2 minimum-run requirement).
 */
export function calculateTaskValidity(
  params: GAPParameters,
  pilotDistances: number[],
  bestDistance: number,
  bestTime: number | null,
  numPresent: number,
  stoppedValidity?: number,
): TaskValidity {
  const numFlying = pilotDistances.length;
  const launch = calculateLaunchValidity(numFlying, numPresent);
  const distance = calculateDistanceValidity(
    pilotDistances, bestDistance,
    params.nominalDistance, params.minimumDistance,
  );
  const time = calculateTimeValidity(
    bestTime, bestDistance,
    params.nominalTime, params.nominalDistance,
  );

  return {
    launch,
    distance,
    time,
    ...(stoppedValidity !== undefined ? { stopped: stoppedValidity } : {}),
    task: launch * distance * time * (stoppedValidity ?? 1),
  };
}

// ---------------------------------------------------------------------------
// Weight distribution
// ---------------------------------------------------------------------------

/**
 * Calculate weight fractions for the four scoring components (S7F 2026 §11).
 */
export interface WeightInputs {
  goalRatio: number;
  scoring: 'PG' | 'HG';
  /** Leading (departure) points enabled. Default true. */
  useLeading?: boolean;
  /** Arrival points enabled (HG only). Default true. */
  useArrival?: boolean;
  /**
   * §11 LeadingTimeRatio (0–0.26). Defaults to the discipline default
   * (26% PG, 17.5% HG).
   */
  leadingTimeRatio?: number;
  /**
   * How many pilots reached the end of the speed section (HG only, §11).
   * Zero triggers the spec's "nobody at ESS" rule below; omit it when the
   * count is unknown and the rule is left unapplied.
   */
  numReachedESS?: number;
}

export function calculateWeights(inputs: WeightInputs): WeightFractions {
  const {
    goalRatio,
    scoring,
    useLeading = true,
    useArrival = true,
    numReachedESS,
  } = inputs;
  const gr = goalRatio;
  const ltr = inputs.leadingTimeRatio ?? defaultLeadingTimeRatio(scoring);

  // Distance weight (§11): one polynomial, both disciplines.
  const dw = 0.9 - 1.665 * gr + 1.713 * gr * gr - 0.587 * gr * gr * gr;

  // Arrival weight (§11): HG only, when enabled — 12.5% of the non-distance
  // weight. (HG Class 2 would be 0; the engine does not model HG classes.)
  const aw = (scoring === 'HG' && useArrival) ? (1 - dw) / 8 : 0;

  // Leading weight (§11): LeadingTimeRatio of the non-distance weight, both
  // disciplines — except that for PG, when nobody makes goal, time points
  // are unearnable and *all* the non-distance weight goes to leading.
  let lw: number;
  if (!useLeading) {
    lw = 0;
  } else if (scoring === 'PG' && gr === 0) {
    lw = 1 - dw;
  } else {
    lw = (1 - dw) * ltr;
  }

  // S7F 2026 §11 (HG box): "if nobody reaches ESS, then a maximum of 900
  // points are available for distance and 18 points for leading but, of
  // course, no points for time nor arrival". Nothing is redistributed — the
  // spec leaves the remaining weight unallocated, so these fractions
  // deliberately sum to less than 1 and the day's points on offer stop at
  // distance + leading.
  //
  // No pilot's score moves: time points require an ESS crossing and the
  // arrival positions are empty, so both components were already zero for
  // everyone. What changes is what the scoreboard claims was on offer.
  if (scoring === 'HG' && numReachedESS === 0) {
    return { distance: dw, time: 0, leading: lw, arrival: 0 };
  }

  const tw = Math.max(0, 1 - dw - lw - aw);

  return { distance: dw, time: tw, leading: lw, arrival: aw };
}

// ---------------------------------------------------------------------------
// Distance Points
// ---------------------------------------------------------------------------

/**
 * Calculate distance points for a single pilot (PG/linear formula).
 * Uses linear distance fraction: distance / bestDistance.
 *
 * @param pilotDistance - Pilot's scored distance (already clamped to minimumDistance)
 * @param bestDistance - Best distance among all pilots
 * @param availableDistancePoints - Total available distance points
 */
export function calculateDistancePoints(
  pilotDistance: number,
  bestDistance: number,
  availableDistancePoints: number,
): number {
  if (bestDistance <= 0) return 0;
  return (pilotDistance / bestDistance) * availableDistancePoints;
}

/**
 * Distance-difficulty curve for a hang-gliding task (FAI S7F §11.1.1).
 * Holds the cumulative "difficulty score" per 100 m slot (0 … 0.5) so each
 * pilot's difficulty fraction can be looked up with sub-slot interpolation.
 */
export interface DistanceDifficulty {
  /** Cumulative difficulty score per 100 m slot (0 … 0.5). */
  readonly diffScore: number[];
  /** Difficulty fraction (0 … 0.5) for a scored distance in metres. */
  fractionFor(distanceMeters: number): number;
}

/**
 * Build the distance-difficulty curve from the field (FAI S7F §11.1.1).
 *
 * Only landed-out pilots shape the curve; goal pilots are excluded.
 * Distances are bucketed into 100 m slots, with sub-minimum distances
 * lumped at the minimum-distance slot. For each slot the "difficulty" is
 * the number of pilots who landed within a look-ahead window past it; the
 * relative difficulty is each slot's share of twice the total, and the
 * difficulty score is the running cumulative — flat at/below minimum
 * distance and capped at 0.5 at the best landed-out distance. The result
 * is that flying past a cluster of landed pilots is worth more points.
 *
 * @param scoredDistances - per-pilot distance in metres, floored to minimum
 * @param madeGoal - per-pilot goal flag (same order as scoredDistances)
 * @param minimumDistance - minimum scored distance in metres
 */
export function calculateDistanceDifficulty(
  scoredDistances: number[],
  madeGoal: boolean[],
  minimumDistance: number,
): DistanceDifficulty {
  const minSlot = Math.trunc(minimumDistance / 100); // metres → 100 m slots

  // Landed-out distances only. If everyone made goal, seed a single dummy
  // pilot at minimum distance so the min-distance score still computes.
  const loDist: number[] = [];
  for (let i = 0; i < scoredDistances.length; i++) {
    if (!madeGoal[i]) loDist.push(scoredDistances[i]);
  }
  if (loDist.length === 0) loDist.push(minimumDistance);
  const pilotsLo = loDist.length;

  // Histogram of landed-out pilots per slot (sub-minimum lumped at minSlot).
  const spread = new Map<number, number>();
  let bestSlot = 0;
  let bestKm = 0;
  for (const d of loDist) {
    const s = Math.max(Math.trunc(d / 100), minSlot);
    spread.set(s, (spread.get(s) ?? 0) + 1);
    if (s > bestSlot) bestSlot = s;
    if (d / 1000 > bestKm) bestKm = d / 1000;
  }
  if (bestKm === 0) return { diffScore: [], fractionFor: () => 0 };

  const bestSlotR = Math.trunc((bestSlot + 10) / 10) * 10; // round up to next 10
  // Best distance flown (incl. goal pilots) sizes the look-ahead window.
  const bestFlownKm = Math.max(...scoredDistances, minimumDistance) / 1000;
  const lookAhead = Math.max(30, Math.round((30 * bestFlownKm) / pilotsLo));

  // Difficulty[i] = pilots who landed within [i, i+lookAhead).
  const difficulty: number[] = new Array(bestSlotR).fill(0);
  for (let i = 0; i < bestSlotR; i++) {
    let sum = 0;
    const top = Math.min(i + lookAhead, bestSlotR);
    for (let x = i; x < top; x++) sum += spread.get(x) ?? 0;
    difficulty[i] = sum;
  }
  const sumDiff = difficulty.reduce((a, b) => a + b, 0);
  const rel = (i: number) => (sumDiff > 0 ? (0.5 * difficulty[i]) / sumDiff : 0);

  // Cumulative difficulty score: seed = sum of relative difficulties at or
  // below the minimum-distance slot (flat there), then accumulate up to the
  // best landed-out slot, capped at 0.5 beyond it.
  let cum = 0;
  for (let i = 0; i <= Math.min(minSlot, bestSlotR - 1); i++) cum += rel(i);
  const seed = cum;
  const diffScore: number[] = new Array(bestSlotR).fill(0.5);
  for (let i = 0; i < bestSlotR; i++) {
    if (i <= minSlot) {
      diffScore[i] = seed;
    } else if (i >= bestSlot) {
      diffScore[i] = 0.5;
    } else {
      cum += rel(i);
      diffScore[i] = cum;
    }
  }

  return {
    diffScore,
    fractionFor(distanceMeters: number): number {
      const slot = Math.trunc(distanceMeters / 100);
      if (slot >= diffScore.length - 1) return 0.5;
      const base = diffScore[slot];
      const next = diffScore[slot + 1];
      // Interpolate within the slot only when the next slot is strictly
      // higher (matches the FAI/AirScore step-then-interpolate behaviour).
      if (next > base) return base + (next - base) * (distanceMeters / 100 - slot);
      return base;
    },
  };
}

/** Distance-score breakdown: linear half + difficulty half. */
export interface DistanceScore {
  total: number;
  linear: number;
  difficulty: number;
}

/**
 * Distance points for a hang-gliding pilot with the difficulty split
 * (FAI S7F §11.1.1): half linear (distance / 2·best) + half difficulty.
 * Goal pilots get the full available distance points (0.5 + 0.5).
 */
export interface DistancePointsHGInput {
  pilotDistance: number;
  bestDistance: number;
  availableDistancePoints: number;
  difficulty: DistanceDifficulty;
  madeGoal: boolean;
}

export function calculateDistancePointsHG({
  pilotDistance,
  bestDistance,
  availableDistancePoints,
  difficulty,
  madeGoal,
}: DistancePointsHGInput): DistanceScore {
  if (bestDistance <= 0) return { total: 0, linear: 0, difficulty: 0 };
  if (madeGoal) {
    const half = availableDistancePoints * 0.5;
    return { total: availableDistancePoints, linear: half, difficulty: half };
  }
  const linear = ((0.5 * pilotDistance) / bestDistance) * availableDistancePoints;
  const diff = difficulty.fractionFor(pilotDistance) * availableDistancePoints;
  return { total: linear + diff, linear, difficulty: diff };
}

/**
 * Apply minimum distance floor and clamp to non-negative.
 * Per CIVL GAP, pilots who flew less than minimumDistance are scored
 * as if they flew minimumDistance.
 */
export function applyMinimumDistance(
  flownDistance: number,
  minimumDistance: number,
): number {
  return Math.max(minimumDistance, flownDistance, 0);
}

// ---------------------------------------------------------------------------
// Time Points
// ---------------------------------------------------------------------------

/**
 * The S7F 2026 §12.2 time-points exponent: the speed fraction falls off with
 * the 5/6 power (the spec writes it as the 6th root of the 5th power).
 */
const SPEED_FRACTION_EXPONENT = 5 / 6;

/**
 * Calculate the speed fraction for a pilot (S7F 2026 §12.2):
 *
 *   SF = max(0, 1 − ((Tp − Tmin) / √Tmin)^(5/6))    with times in hours
 *
 * Tp/Tmin are speed-section times.
 */
export function calculateSpeedFraction(
  pilotTimeSeconds: number,
  bestTimeSeconds: number,
): number {
  if (bestTimeSeconds <= 0 || pilotTimeSeconds <= 0) return 0;
  if (pilotTimeSeconds <= bestTimeSeconds) return 1;
  // Convert to hours for the GAP formula
  const pilotTime = pilotTimeSeconds / 3600;
  const bestTime = bestTimeSeconds / 3600;
  const sqrtBest = Math.sqrt(bestTime);
  if (sqrtBest <= 0) return 0;
  return Math.max(
    0,
    1 - Math.pow((pilotTime - bestTime) / sqrtBest, SPEED_FRACTION_EXPONENT),
  );
}

/** Inputs to {@link calculateTimePoints} for one pilot. */
export interface TimePointsInput {
  /** Pilot's speed-section time in seconds, or null if ESS not reached. */
  pilotTime: number | null;
  /** Fastest qualifying speed-section time in the class (seconds), or null. */
  bestTime: number | null;
  /** Whether the pilot reached goal. */
  madeGoal: boolean;
  /** Whether the pilot reached the end of the speed section. */
  reachedESS: boolean;
  /** Time points available to the class. */
  availableTimePoints: number;
  /** Sport — PG requires goal, HG requires ESS, to earn any time points. */
  scoring: 'PG' | 'HG';
  /**
   * §13.2 share of time points an HG pilot keeps when they reach ESS but not
   * goal. Defaults to the engine baseline (0.8). PG is fixed at 0 by the spec.
   */
  essNotGoalFactor?: number;
}

/**
 * Calculate time points for a single pilot (S7F 2026 §12.2).
 * PG: Only pilots who made goal get time points (§13.2 fixes the
 * ESS-but-not-goal parameter at 0 for paragliding).
 * HG: Pilots who reached ESS get time points, but a pilot who does not go
 * on to reach goal keeps only `essNotGoalFactor` of them (§13.2,
 * default 0.8) — reaching goal "validates" the speed section.
 */
export function calculateTimePoints({
  pilotTime,
  bestTime,
  madeGoal,
  reachedESS,
  availableTimePoints,
  scoring,
  essNotGoalFactor = DEFAULT_GAP_PARAMETERS.essNotGoalFactor,
}: TimePointsInput): number {
  if (bestTime === null || pilotTime === null) return 0;

  // PG: must make goal to get time points
  if (scoring === 'PG' && !madeGoal) return 0;
  // HG: must reach ESS
  if (scoring === 'HG' && !reachedESS) return 0;

  const sf = calculateSpeedFraction(pilotTime, bestTime);
  const points = sf * availableTimePoints;
  // §13.2: an HG pilot with ESS but no goal keeps only the configured share.
  if (scoring === 'HG' && !madeGoal) return points * essNotGoalFactor;
  return points;
}

// ---------------------------------------------------------------------------
// Leading Coefficient
// ---------------------------------------------------------------------------

// Leading-area weighting envelope (S7F 2026 §12.3.1, PG). Written here in
// terms of the REMAINING fraction p = minToESS / speedSectionDistance; the
// spec writes weight(v) over the done fraction v = 1 − p, with
// weight(v) = weightRising(1 − v) · weightFalling(1 − v) — the same curve.
// At p≈1 (just left SSS) and p≈0 (at ESS) the weight is ~0; it peaks in the
// middle, so leading is rewarded most for being out front mid-course.
function weightRising(p: number): number {
  return Math.pow(1 - Math.pow(10, 9 * p - 9), 5);
}
function weightFalling(p: number): number {
  return Math.pow(1 - Math.pow(10, -3 * p), 2);
}
/**
 * The §12.3.1 leading-weight envelope at remaining fraction p — exported for
 * the derivative check in tests ({@link leadWeightIntegral} must integrate
 * exactly this curve) and for the report card's chart sampling.
 */
export function leadWeight(p: number): number {
  return weightRising(p) * weightFalling(p);
}

// Binomial coefficients of (1 − u)^5 and (1 − v)^2 — the envelope expands
// into 18 exponential terms, so its integral has an exact closed form.
const RISING_COEFFS = [1, -5, 10, -10, 5, -1];
const FALLING_COEFFS = [1, -2, 1];
const LN10 = Math.LN10;

/**
 * Cumulative integral of the leading-weight envelope over the remaining
 * fraction: W(p) = ∫₀^p leadWeight(q) dq, exactly.
 *
 * The §12.3.1 leadingArea integrates weight(x) over the DONE fraction x;
 * with x = 1 − q that interval integral is a difference of this cumulative:
 * ∫_{done(prev)}^{done(cur)} weight(x) dx = W(p_prev) − W(p_cur), where
 * p = minToESS / speedSectionDistance at each end.
 *
 * Derivation: leadWeight(q) = (1 − 10^{9q−9})⁵ · (1 − 10^{−3q})² expands to
 * Σⱼₖ aⱼbₖ · 10^{−9j} · 10^{(9j−3k)q}; each term integrates to
 * 10^{(9j−3k)q} / ((9j−3k)·ln10) except the (0,0) constant term, which
 * integrates to q. Exact and deterministic — no quadrature error to move a
 * score between runs.
 */
export function leadWeightIntegral(p: number): number {
  const q = Math.min(1, Math.max(0, p));
  let total = 0;
  for (let j = 0; j <= 5; j++) {
    for (let k = 0; k <= 2; k++) {
      const c = RISING_COEFFS[j] * FALLING_COEFFS[k] * Math.pow(10, -9 * j);
      const alpha = 9 * j - 3 * k;
      if (alpha === 0) {
        total += c * q;
      } else {
        const scale = alpha * LN10;
        total += (c * (Math.pow(10, alpha * q) - 1)) / scale;
      }
    }
  }
  return total;
}

/**
 * The field-independent part of a pilot's leading coefficient.
 *
 * The leading coefficient depends on the whole field only through two
 * scalars — the first pilot's start time and the last pilot's ESS time.
 * Everything else is a single-pilot tracklog scan. {@link computeLeadingAggregate}
 * does that scan once and captures the per-pilot pieces here, so the backend
 * can cache it per track and {@link combineLeadingCoefficient} can fold in the
 * field scalars cheaply — no re-scan when another pilot uploads.
 *
 * Plain numbers/booleans only, so it JSON round-trips losslessly.
 */
export interface LeadingAggregate {
  /** false → pilot never started / had no in-window fixes; LC is Infinity. */
  valid: boolean;
  /** Speed-section length along the optimized course (km). */
  ssKm: number;
  /** Best (minimum) distance-to-ESS reached along the course (km). */
  bestDistKm: number;
  /** Whether the pilot reached ESS (drives the land-out tail term). */
  reachedESS: boolean;
  /** Pilot's own SSS reaching time (epoch ms). */
  pilotSSSMs: number;
  /**
   * Time of the pilot's last fix (epoch ms) — when the pilot didn't reach
   * ESS this is their outlanding time, which the field's §11.3.1 `maxTime`
   * is the latest of (see {@link resolveLeadingMaxTime}).
   */
  lastFixMs: number;
  /**
   * weighted (S7F 2026 §12.3.1): Σ minToESSᵢ·ΔWᵢ·(tᵢ − pilotSSS), where ΔWᵢ
   * is the exact weight-envelope integral over the done-fraction interval —
   * summed against the pilot's OWN start so the epoch-second terms stay
   * small (no catastrophic cancellation). combineLeadingCoefficient
   * re-references it to the field's first start.
   */
  weightedTimeSum: number;
  /** weighted: Σ minToESSᵢ·ΔWᵢ — the multiplier for the start-time shift. */
  weightedDeltaSum: number;
  /** classic: the field-independent Σ (already referenced to the pilot's own start). */
  classicSum: number;
}

/**
 * Scan one pilot's tracklog and capture the field-independent pieces of the
 * leading coefficient (see {@link LeadingAggregate}). This is the expensive
 * per-fix pass; it is independent of the rest of the field, so it can be
 * computed once and cached.
 *
 * @param fixes - Pilot's tracklog fixes (time-ordered)
 * @param task - The competition task (already trimmed for the distance origin)
 * @param sequence - The pilot's resolved turnpoint reachings (for progress)
 * @param pilotSSSTime - The pilot's own start time (ms), or null if no start
 * @param pilotESSTime - The pilot's ESS time (ms), or null if not reached
 * @param formula - 'weighted' (modern default) or 'classic'
 */
export function computeLeadingAggregate(
  fixes: IGCFix[],
  task: XCTask,
  sequence: TurnpointReaching[],
  pilotSSSTime: number | null,
  pilotESSTime: number | null,
  formula: LeadingFormula = 'weighted',
): LeadingAggregate {
  const invalid: LeadingAggregate = {
    valid: false, ssKm: 0, bestDistKm: 0,
    reachedESS: pilotESSTime !== null,
    pilotSSSMs: pilotSSSTime ?? 0, lastFixMs: 0,
    weightedTimeSum: 0, weightedDeltaSum: 0, classicSum: 0,
  };

  const essIdx = getEffectiveESSIndex(task);
  const sssIdx = Math.max(0, getEffectiveSSSIndex(task));
  // Pilots who never started get the worst possible LC.
  if (essIdx <= sssIdx || fixes.length === 0 || pilotSSSTime === null) {
    return invalid;
  }

  // Optimized along-course distance from each turnpoint to ESS (meters).
  const segs = getOptimizedSegmentDistances(task);
  const cumToESS: number[] = new Array(essIdx + 1).fill(0);
  for (let j = essIdx - 1; j >= 0; j--) {
    cumToESS[j] = cumToESS[j + 1] + segs[j];
  }
  const ssKm = cumToESS[sssIdx] / 1000; // speed-section length (km)
  if (ssKm <= 0) return invalid;

  // Reaching time per task index, so we know which turnpoint the pilot is
  // flying toward at each fix (the next un-reached one before ESS).
  const reachTime: Array<number | undefined> = [];
  for (const r of sequence) reachTime[r.taskIndex] = r.time.getTime();

  // Reference times to the pilot's OWN start. For classic this is exactly the
  // spec's time origin; for weighted it keeps the summed terms small and is
  // rebased to the field's first start in combineLeadingCoefficient.
  const pilotSSSSec = pilotSSSTime / 1000;
  const endTime = pilotESSTime ?? Infinity;

  // §11.3.1/§12.2: in a gated race the leading clock starts at the first
  // gate. An early ("jump the gun") starter's own SSS crossing precedes it,
  // so once combineLeadingCoefficient rebases the sum to the gate their
  // pre-gate progress would contribute NEGATIVE time — driving their LC
  // below every honest leader's and, at LC ≤ 0, zeroing the whole field's
  // leading points. Clamp each fix's time at the first gate so pre-gate
  // progress counts as happening at gate-open. Gates resolve from the task
  // alone (the pilot's own crossing just anchors them on the right day), so
  // this stays field-independent and cacheable.
  const gates = resolveStartGates(task, pilotSSSTime);
  const clockStartMs = gates ? gates[0] : -Infinity;

  let prevBestKm = ssKm; // best_dist_to_ess ratchet, starts at full SS length
  let weightedTimeSum = 0;
  let weightedDeltaSum = 0;
  let classicSum = 0;
  let nextReq = Math.min(sssIdx + 1, essIdx);
  let prevDistKm: number | null = null;

  for (const fix of fixes) {
    const tms = fix.time.getTime();
    if (tms < pilotSSSTime) continue;
    if (tms > endTime) break;

    // Advance to the next un-reached required turnpoint (capped at ESS).
    while (
      nextReq < essIdx &&
      reachTime[nextReq] !== undefined &&
      (reachTime[nextReq] as number) <= tms
    ) {
      nextReq++;
    }
    const tp = task.turnpoints[nextReq];
    const edge = Math.max(
      0,
      ellipsoidDistance(fix.latitude, fix.longitude, tp.waypoint.lat, tp.waypoint.lon) - tp.radius,
    );
    const distKm = (edge + cumToESS[nextReq]) / 1000;

    if (prevDistKm !== null) {
      // The ratchet appends this fix's distance to the window, then weights
      // the interval by this ("next") fix's time — the spec's taskTime(tpᵢ).
      const curBestKm = Math.min(prevDistKm, ssKm, prevBestKm);
      if (formula === 'classic') {
        // classic (HG, §12.3.1): task_time · (best[i−1]² − best[i]²).
        // Referenced to the pilot's own start and never rebased, so its
        // times are non-negative as-is — no gate clamp.
        if (prevBestKm > curBestKm) {
          const localTimeSec = tms / 1000 - pilotSSSSec;
          classicSum +=
            localTimeSec * (prevBestKm * prevBestKm - curBestKm * curBestKm);
        }
      } else if (prevBestKm > curBestKm) {
        // weighted (PG, S7F 2026 §12.3.1):
        //   minToESS(tpᵢ) · taskTime(tpᵢ) · ∫ weight(x) dx
        // over the done-fraction interval this fix advanced through. Split
        // the taskTime factor into (Σ Δ·time) and (Σ Δ) so the field's
        // start-time offset can be applied later.
        const delta =
          curBestKm *
          (leadWeightIntegral(prevBestKm / ssKm) -
            leadWeightIntegral(curBestKm / ssKm));
        if (delta !== 0) {
          weightedTimeSum += delta * (Math.max(tms, clockStartMs) / 1000 - pilotSSSSec);
          weightedDeltaSum += delta;
        }
      }
      prevBestKm = curBestKm;
    }
    prevDistKm = distKm;
  }

  if (prevDistKm === null) return invalid; // no fixes in the leading window
  // Fold the final fix's distance into the ratchet (used by the tail term).
  const bestDistKm = Math.min(prevDistKm, ssKm, prevBestKm);

  return {
    valid: true, ssKm, bestDistKm,
    reachedESS: pilotESSTime !== null,
    pilotSSSMs: pilotSSSTime,
    lastFixMs: fixes[fixes.length - 1].time.getTime(),
    weightedTimeSum, weightedDeltaSum, classicSum,
  };
}

/**
 * The whole-field times the §11.3.1 leading clock is built from. Absolute
 * epoch milliseconds throughout; {@link resolveLeadingMaxTime} turns them
 * into the single `maxTime` the land-out tail runs to.
 */
export interface LeadingFieldTimes {
  /**
   * The leading clock's origin (`firstTaskStartTime`): the first start gate
   * in a gated race, otherwise the first SSS crossing in the field.
   */
  firstStartMs: number;
  /** When the last pilot reached ESS, or null when nobody did. */
  lastESSMs: number | null;
  /**
   * When the last landed-out pilot landed — the end of the latest tracklog
   * among pilots who never reached ESS — or null when nobody landed out.
   */
  lastOutlandingMs: number | null;
  /** The task's goal deadline (§8.3.c), or null when the task sets none. */
  deadlineMs: number | null;
  /** The task stop time (§12.3.1) on a stopped task, else null. */
  stopTimeMs: number | null;
}

/** Which of the {@link LeadingFieldTimes} the resolved `maxTime` came from. */
export type LeadingMaxTimeSource =
  | 'last_outlanding'
  | 'last_ess'
  | 'deadline'
  | 'stop'
  | 'fallback';

/** A resolved §11.3.1 `maxTime`, and the field time it came from. */
export interface LeadingMaxTime {
  /** The instant the land-out tail runs to (epoch ms). */
  timeMs: number;
  source: LeadingMaxTimeSource;
}

/**
 * How long the tail runs when the field gives nothing to measure it by —
 * nobody reached ESS and nobody has a scannable tracklog. Arbitrary, and
 * only reachable on a degenerate field.
 */
const LEADING_TAIL_FALLBACK_MS = 3_600_000;

/**
 * Resolve the field's §11.3.1 `maxTime`:
 *
 *   maxTime = min(max(lastOutlandingTime, lastESStime), taskDeadline)
 *
 * This is the instant a landed-out pilot's leading graph is carried to, and
 * it is a property of the FIELD, not of the pilot: "for pilots who land out
 * after the last pilot reached ESS, the calculation keeps going until they
 * land" extends the clock for everyone still owed a tail, not only for the
 * pilot who flew longest.
 *
 * A stopped task (§12.3.1) bounds it the same way the deadline does —
 * nothing after the stop time is scored, so a tracklog that kept recording
 * past it cannot lengthen anyone's tail.
 */
export function resolveLeadingMaxTime(times: LeadingFieldTimes): LeadingMaxTime {
  const { firstStartMs, lastESSMs, lastOutlandingMs, deadlineMs, stopTimeMs } = times;

  let timeMs: number;
  let source: LeadingMaxTimeSource;
  if (lastOutlandingMs !== null && (lastESSMs === null || lastOutlandingMs > lastESSMs)) {
    timeMs = lastOutlandingMs;
    source = 'last_outlanding';
  } else if (lastESSMs !== null) {
    timeMs = lastESSMs;
    source = 'last_ess';
  } else {
    timeMs = firstStartMs + LEADING_TAIL_FALLBACK_MS;
    source = 'fallback';
  }

  // The two caps. Reported as the source when either actually bites, because
  // "the tail stopped at the deadline" is a different fact about the day from
  // "the tail stopped when the last pilot landed".
  if (stopTimeMs !== null && stopTimeMs < timeMs) {
    timeMs = stopTimeMs;
    source = 'stop';
  }
  if (deadlineMs !== null && deadlineMs < timeMs) {
    timeMs = deadlineMs;
    source = 'deadline';
  }
  return { timeMs, source };
}

/**
 * Fold the field-level scalars into a per-pilot {@link LeadingAggregate} to
 * produce the final leading coefficient — the cheap, field-dependent half of
 * `tot_lc_calculation` (late-start rectangle for classic, land-out tail, and
 * normalization). Lower LC = more leading = more points.
 *
 * @param agg - The pilot's cached/computed field-independent aggregate
 * @param taskFirstSSSTime - The leading clock's origin (ms since epoch): the
 *   first start gate, else the field's first SSS crossing
 * @param taskMaxTime - The field's §11.3.1 `maxTime` (ms since epoch), from
 *   {@link resolveLeadingMaxTime} — where a landed-out pilot's graph ends
 * @param formula - 'weighted' (modern default) or 'classic'
 * @returns Normalized leading coefficient (lower is better), or Infinity
 */
export function combineLeadingCoefficient(
  agg: LeadingAggregate,
  taskFirstSSSTime: number,
  taskMaxTime: number,
  formula: LeadingFormula = 'weighted',
): number {
  if (!agg.valid) return Infinity;
  const { ssKm, bestDistKm, reachedESS, pilotSSSMs } = agg;

  if (formula === 'classic') {
    let total = agg.classicSum;
    if (pilotSSSMs > taskFirstSSSTime) {
      // Full-distance rectangle for the time before this pilot started.
      total += ssKm * ssKm * (pilotSSSMs - taskFirstSSSTime) / 1000;
    }
    if (!reachedESS) {
      // Measured from the pilot's own start because classicSum is: the
      // rectangle above already carries the graph back to the field's first
      // start. Floored at zero — the deadline cap can land maxTime before a
      // very late starter's own crossing, and a NEGATIVE tail would hand
      // that pilot the field's best coefficient.
      total += bestDistKm * bestDistKm * Math.max(0, taskMaxTime - pilotSSSMs) / 1000;
    }
    return total / (1800 * ssKm * ssKm);
  }

  // weighted: rebase the per-pilot sum from the pilot's own start to the
  // field's first start — Σ Δ·(t − first) = weightedTimeSum + (pilotSSS − first)·weightedDeltaSum.
  const shiftSec = pilotSSSMs / 1000 - taskFirstSSSTime / 1000;
  let total = agg.weightedTimeSum + shiftSec * agg.weightedDeltaSum;
  if (!reachedESS) {
    // §12.3.1 missingArea: minToESS(best) · maxTime · ∫ weight over the
    // remaining (never-flown) part of the speed section.
    const missingTimeSec = Math.max(0, (taskMaxTime - taskFirstSSSTime) / 1000);
    total += bestDistKm * missingTimeSec * leadWeightIntegral(bestDistKm / ssKm);
  }
  return total / (1800 * ssKm);
}

/**
 * Calculate the leading coefficient (LC) for a single pilot — the `classic`
 * (HG) and `weighted` (PG) formulas of CIVL GAP / FAI S7F §11.3.1.
 *
 * The curve is distance-to-ESS measured **along the optimized course**
 * (distance to the next un-reached turnpoint's cylinder edge plus the
 * optimized legs from there to ESS), sampled per fix, with a ratchet:
 * the best distance never increases even if the pilot flies away from ESS.
 * Lower LC = more leading = more points. The raw per-interval sum is then
 * normalized and given a late-start (classic) and/or land-out tail term, as
 * in AirScore's `tot_lc_calculation` — except that the tail runs to the
 * spec's field-level `maxTime` (issue #585) rather than to AirScore's
 * per-pilot landing / last-ESS time.
 *
 * Thin wrapper over {@link computeLeadingAggregate} + {@link combineLeadingCoefficient};
 * see those for the cacheable split.
 *
 * @param fixes - Pilot's tracklog fixes (time-ordered)
 * @param task - The competition task
 * @param sequence - The pilot's resolved turnpoint reachings (for progress)
 * @param taskFirstSSSTime - The leading clock's origin (ms since epoch)
 * @param taskMaxTime - The field's §11.3.1 `maxTime` (ms since epoch), from
 *   {@link resolveLeadingMaxTime}
 * @param pilotSSSTime - The pilot's own start time (ms), or null if no start
 * @param pilotESSTime - The pilot's ESS time (ms), or null if not reached
 * @param formula - 'weighted' (modern default) or 'classic'
 * @returns Normalized leading coefficient (lower is better), or Infinity
 */
export function calculateLeadingCoefficient(
  fixes: IGCFix[],
  task: XCTask,
  sequence: TurnpointReaching[],
  taskFirstSSSTime: number,
  taskMaxTime: number,
  pilotSSSTime: number | null,
  pilotESSTime: number | null,
  formula: LeadingFormula = 'weighted',
): number {
  const agg = computeLeadingAggregate(fixes, task, sequence, pilotSSSTime, pilotESSTime, formula);
  return combineLeadingCoefficient(agg, taskFirstSSSTime, taskMaxTime, formula);
}

// ---------------------------------------------------------------------------
// Leading Points
// ---------------------------------------------------------------------------

/**
 * Calculate leading points for a single pilot.
 *
 * LeadingFactor = max(0, 1 − ((LCp − LCmin) / √LCmin)^(2/3)), and
 * LeadingPoints = LeadingFactor × available — exactly AirScore's
 * `pilot_leadout` (gap.py / pwc.py). The pilot with the best (minimum)
 * LC scores full points; others fall off with the 2/3-power curve.
 *
 * "No valid LC in the field" is signalled by a non-finite minLC (pilots
 * without a valid LC already carry Infinity themselves) — NOT by minLC ≤ 0.
 * A genuinely non-positive minLC is a degenerate input (the LC pipeline
 * produces positive coefficients); the √LCmin normalization is undefined
 * there, so the pilot(s) holding the minimum still take full points and
 * everyone else takes none, rather than zeroing the whole field.
 */
export function calculateLeadingPoints(
  pilotLC: number,
  minLC: number,
  availableLeadingPoints: number,
): number {
  if (!isFinite(pilotLC) || !isFinite(minLC)) return 0;
  const lcDiff = pilotLC - minLC;
  if (lcDiff <= 0) return availableLeadingPoints;
  if (minLC <= 0) return 0; // degenerate normalization — see docblock
  // ((LCp − LCmin) / √LCmin)^(2/3) === cbrt((LCp − LCmin)² / LCmin)
  const factor = Math.max(0, 1 - Math.cbrt((lcDiff * lcDiff) / minLC));
  return factor * availableLeadingPoints;
}

// ---------------------------------------------------------------------------
// Arrival Points (HG only)
// ---------------------------------------------------------------------------

/**
 * Calculate arrival points for a hang gliding pilot.
 */
export function calculateArrivalPoints(
  positionAtESS: number,
  numPilotsAtESS: number,
  availableArrivalPoints: number,
): number {
  if (numPilotsAtESS <= 0 || positionAtESS <= 0) return 0;
  const ac = 1 - (positionAtESS - 1) / numPilotsAtESS;
  const af = poly3(ac, ARRIVAL_POINTS_CUBIC);
  return af * availableArrivalPoints;
}
