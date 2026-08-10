/**
 * CIVL GAP per-component scoring formulas.
 *
 * The individually testable pieces of the GAP formula (FAI S7F): task
 * validity, weight distribution, and distance / time / arrival points. Each
 * is a pure function of its inputs; the leading-coefficient pipeline lives in
 * ./gap-leading, and the whole-field orchestration that drives them all in
 * ./gap-scoring.
 */

import type { GAPParameters } from './gap-params';
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
/** Arrival-points curve in the arrival ratio (S7F 2026 §13.5, HG only). */
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
   * Stopped-task validity (FAI S7F §13.4.3) — the fourth factor, present
   * only when the task was stopped. 1 when anyone reached ESS; 0 when the
   * stopped task didn't run long enough to be scored (§13.4.2).
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
 * Inputs to the §13.4.3 stopped-task validity formula, all distances in
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
 * Stopped-task validity (FAI S7F §13.4.3) — the fourth validity factor for
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
 * @param stoppedValidity - The §13.4.3 stopped-task validity factor, present
 *   only when the task was stopped ({@link calculateStoppedTaskValidity} — or
 *   0 when the stopped task failed the §13.4.2 minimum-run requirement).
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
 * Distance-difficulty curve for a hang-gliding task (FAI S7F §12.1.1).
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
 * Build the distance-difficulty curve from the field (FAI S7F §12.1.1).
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
 * (FAI S7F §12.1.1): half linear (distance / 2·best) + half difficulty.
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
  /**
   * §13.2 share of time points a pilot keeps when they reach ESS but not
   * goal — the EFFECTIVE factor for the field (see effectiveEssNotGoalFactor
   * in ./gap-scoring): the configured HG share, 0 for PG (the spec fixes
   * paragliding at 0, so no goal means no time points). Defaults to the
   * engine baseline (0.8).
   */
  essNotGoalFactor?: number;
}

/**
 * Calculate time points for a single pilot (S7F 2026 §12.2).
 * No ESS crossing earns no time points; a pilot who reaches ESS but lands
 * before goal keeps only `essNotGoalFactor` of them (§13.2) — reaching goal
 * "validates" the speed section. The caller resolves the factor per
 * discipline: 0 for PG (fixed by the spec), the configured share (default
 * 0.8) for HG.
 */
export function calculateTimePoints({
  pilotTime,
  bestTime,
  madeGoal,
  reachedESS,
  availableTimePoints,
  essNotGoalFactor = DEFAULT_GAP_PARAMETERS.essNotGoalFactor,
}: TimePointsInput): number {
  if (bestTime === null || pilotTime === null) return 0;
  if (!reachedESS) return 0;
  const sf = calculateSpeedFraction(pilotTime, bestTime);
  const points = sf * availableTimePoints;
  // §13.2: ESS but no goal keeps only the effective share (0 for PG).
  return madeGoal ? points : points * essNotGoalFactor;
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
