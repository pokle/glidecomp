/**
 * CIVL GAP Multi-Track Task Scoring
 *
 * Implements the CIVL GAP scoring system (FAI Sporting Code Section 7F)
 * for scoring multiple pilots against a single task.
 *
 * Each pilot's score is the sum of distance points, time points,
 * leading points, and arrival points (HG only). The total available
 * points per task = 1000 × TaskValidity.
 *
 * @see https://www.fai.org/sites/default/files/civl/documents/sporting_code_s7_f_-_xc_scoring_2024.pdf
 */

import type { XCTask } from './xctsk-parser';
import type { IGCFix } from './igc-parser';
import type { TurnpointSequenceResult, TurnpointReaching } from './turnpoint-sequence';
import { resolveTurnpointSequence } from './turnpoint-sequence';
import { getSSSIndex, getEffectiveSSSIndex, getEffectiveESSIndex } from './xctsk-parser';
import { calculateOptimizedTaskDistance, getOptimizedSegmentDistances } from './task-optimizer';
import { resolveStartGates } from './time-gates';
import { andoyerDistance } from './geo';
import { maxBy, minBy } from './array-utils';

/**
 * Round a point value to one decimal place — the precision the FAI Sporting
 * Code S7F §11 specifies for a pilot's task total (and §12.4: the rounding is
 * done *after* penalties). Used for the total; component points are likewise
 * kept to 0.1 for presentation.
 */
function roundToTenth(x: number): number {
  return Math.round(x * 10) / 10;
}

// ---------------------------------------------------------------------------
// Competition parameters
// ---------------------------------------------------------------------------

/** GAP competition parameters — set once per competition. */
export interface GAPParameters {
  /** Fraction of pilots expected to launch (default 0.96) */
  nominalLaunch: number;
  /** Expected task distance in meters */
  nominalDistance: number;
  /** Expected fraction of pilots reaching goal (default 0.2) */
  nominalGoal: number;
  /** Expected task duration in seconds (default 5400 = 90 min) */
  nominalTime: number;
  /** Minimum scored distance in meters (default 5000) */
  minimumDistance: number;
  /** Sport type — affects arrival points and some weight calculations */
  scoring: 'PG' | 'HG';
  /** Whether to compute leading (departure) points (default true) */
  useLeading: boolean;
  /** Whether to compute arrival points (default true for HG, ignored for PG) */
  useArrival: boolean;
  /**
   * GAP formula generation (matches AirScore's formula presets). Selects
   * both the leading-coefficient variant and the speed-points exponent:
   * - 'weighted' — GAP2020+ / current FAI S7F: weighted-area leading
   *   envelope; speed exponent 5/6 (the modern default).
   * - 'classic'  — GAP2016/2018 & PWC≤2017: squared-distance leading,
   *   time from each pilot's own start; speed exponent 2/3.
   */
  leadingFormula: LeadingFormula;
  /**
   * Where scored task distance begins, for tasks that define a take-off
   * turnpoint before the SSS:
   * - 'takeoff' — measure from the take-off point through the SSS to goal,
   *   per FAI CIVL GAP / PWCA (the take-off→SSS leg counts). The default.
   * - 'start'   — measure from the start (SSS) cylinder edge, excluding the
   *   take-off→SSS leg (the HGFA/SAFA rule wording; "Move Origin" in the
   *   Davis/SeeYou hang-gliding toolchain).
   *
   * Only affects tasks whose first turnpoint is a TAKEOFF; tasks that
   * begin at the SSS score identically either way.
   */
  distanceOrigin: DistanceOrigin;
  /**
   * Hang-gliding "distance difficulty" (FAI S7F §11.1.1). When true (the
   * default), HG distance points are half linear + half difficulty, where
   * the difficulty half rewards flying past clusters of landed-out pilots.
   * When false, HG uses a pure linear distance fraction. Has no effect on
   * paragliding — the FAI spec excludes difficulty for PG, so PG is always
   * pure linear.
   */
  useDistanceDifficulty: boolean;
  /**
   * Hang-gliding "jump the gun" (FAI S7F §12.2): seconds of early start
   * per 1 penalty point (the spec's X; default 2). Only applies to HG in
   * gated races — a PG early starter is instead scored only for the
   * launch→SSS distance.
   */
  jumpTheGunFactor: number;
  /**
   * Hang-gliding "jump the gun" (FAI S7F §12.2): maximum seconds a pilot
   * may start early and still be scored for the complete flight (the
   * spec's Y; default 300). Beyond this the pilot is scored for minimum
   * distance only.
   */
  jumpTheGunMaxSeconds: number;
}

/** Leading coefficient variant — see {@link GAPParameters.leadingFormula}. */
export type LeadingFormula = 'classic' | 'weighted';

/** Where scored task distance begins — see {@link GAPParameters.distanceOrigin}. */
export type DistanceOrigin = 'takeoff' | 'start';

/** Default parameters — reasonable for a typical HG competition. */
export const DEFAULT_GAP_PARAMETERS: GAPParameters = {
  nominalLaunch: 0.96,
  nominalDistance: 70000,
  nominalGoal: 0.2,
  nominalTime: 5400,
  minimumDistance: 5000,
  scoring: 'HG',
  useLeading: false,
  useArrival: false,
  leadingFormula: 'weighted',
  distanceOrigin: 'takeoff',
  useDistanceDifficulty: true,
  jumpTheGunFactor: 2,
  jumpTheGunMaxSeconds: 300,
};

/**
 * Return the task to use for distance scoring under the given origin.
 *
 * For 'start', any take-off / pre-SSS turnpoints are dropped so the
 * optimized distance begins at the SSS cylinder edge. For 'takeoff', the
 * task is returned unchanged (the optimizer treats a leading TAKEOFF
 * turnpoint as a fixed launch point — see task-optimizer.ts).
 */
export function taskForDistanceOrigin(task: XCTask, origin: DistanceOrigin): XCTask {
  if (origin !== 'start') return task;
  const sssIdx = getSSSIndex(task);
  if (sssIdx <= 0) return task; // already starts at (or before) the SSS
  return { ...task, turnpoints: task.turnpoints.slice(sssIdx) };
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Task validity breakdown. */
export interface TaskValidity {
  launch: number;
  distance: number;
  time: number;
  /** Product of launch × distance × time */
  task: number;
}

/** Available points in each category. */
export interface AvailablePoints {
  distance: number;
  time: number;
  leading: number;
  arrival: number;
  total: number;
}

/** Weight fractions for each scoring component. */
export interface WeightFractions {
  distance: number;
  time: number;
  leading: number;
  arrival: number;
}

/** Individual pilot's scored result. */
export interface PilotScore {
  /** Pilot name from IGC header, or filename */
  pilotName: string;
  /** Source track file path */
  trackFile: string;
  /** Distance flown in meters */
  flownDistance: number;
  /** Speed section time in seconds, null if ESS not reached */
  speedSectionTime: number | null;
  /** Whether the pilot completed the task */
  madeGoal: boolean;
  /** Whether the pilot reached End of Speed Section */
  reachedESS: boolean;
  /** Distance component score (linear + difficulty halves) */
  distancePoints: number;
  /** Linear half of the distance score (the full score when difficulty is off / PG) */
  distanceLinearPoints: number;
  /** Difficulty half of the distance score (0 for PG or when difficulty is off) */
  distanceDifficultyPoints: number;
  /** Time/speed component score */
  timePoints: number;
  /** Leading coefficient component score */
  leadingPoints: number;
  /** Arrival component score (HG only, 0 for PG) */
  arrivalPoints: number;
  /**
   * Sum of all point components, rounded to one decimal place (FAI S7F §11).
   * Any jump-the-gun penalty (§12.2) is applied before this rounding; the
   * scorekeeper's absolute penalty (§12.4) is applied downstream in the
   * backend, which re-rounds after subtracting it. Ranking and tie-breaks use
   * this spec-rounded value — the UI may still display it as whole points.
   */
  totalScore: number;
  /** Rank position (1-based) */
  rank: number;
  /** Leading coefficient value */
  leadingCoefficient: number;
  /**
   * Seconds the pilot started before the first start gate (§12.2), when an
   * early start was detected. Absent for normal starts.
   */
  earlyStartSeconds?: number;
  /**
   * How the early start reshaped the score (§12.2):
   * - 'pg_launch_to_sss' — PG: scored only for the launch→SSS distance
   * - 'hg_penalty' — HG within the limit: full flight scored, penalty applied
   * - 'hg_min_distance' — HG beyond the limit: scored for minimum distance
   */
  earlyStartOutcome?: 'pg_launch_to_sss' | 'hg_penalty' | 'hg_min_distance';
  /**
   * Jump-the-gun penalty points deducted from the total (HG 'hg_penalty'
   * outcome): earlyStartSeconds ÷ jumpTheGunFactor, with the total floored
   * at the minimum-distance score rather than zero (§12.2).
   */
  jumpTheGunPenalty?: number;
  /** Underlying turnpoint sequence result for transparency */
  turnpointResult: TurnpointSequenceResult;
}

/** Complete task scoring result. */
export interface TaskScoreResult {
  parameters: GAPParameters;
  taskValidity: TaskValidity;
  weights: WeightFractions;
  availablePoints: AvailablePoints;
  pilotScores: PilotScore[];
  /** Aggregate stats used in scoring */
  stats: TaskStats;
}

/** Aggregate statistics from all pilots in the task. */
export interface TaskStats {
  numPresent: number;
  numFlying: number;
  numInGoal: number;
  numReachedESS: number;
  bestDistance: number;
  bestTime: number | null;
  goalRatio: number;
  taskDistance: number;
}

// ---------------------------------------------------------------------------
// Input type
// ---------------------------------------------------------------------------

/** A pilot's flight data for scoring. */
export interface PilotFlight {
  /** Pilot name (from IGC header or filename) */
  pilotName: string;
  /** Source file path */
  trackFile: string;
  /** Parsed GPS fixes */
  fixes: IGCFix[];
}

// ---------------------------------------------------------------------------
// Task Validity
// ---------------------------------------------------------------------------

/**
 * Calculate launch validity.
 * Reduced when fewer pilots launch than the nominal threshold.
 */
export function calculateLaunchValidity(
  numFlying: number,
  numPresent: number,
  nominalLaunch: number,
): number {
  if (numPresent === 0) return 0;
  const lvr = Math.min(1, numFlying / (numPresent * nominalLaunch));
  return Math.min(1, Math.max(0,
    0.027 * lvr + 2.917 * lvr * lvr - 1.944 * lvr * lvr * lvr
  ));
}

/**
 * Calculate distance validity.
 * Reduced when pilots don't fly far enough relative to nominal parameters.
 */
export function calculateDistanceValidity(
  pilotDistances: number[],
  bestDistance: number,
  nominalDistance: number,
  nominalGoal: number,
  minimumDistance: number,
): number {
  const numFlying = pilotDistances.length;
  if (numFlying === 0) return 0;

  const sumOverMin = pilotDistances.reduce(
    (sum, d) => sum + Math.max(0, d - minimumDistance), 0
  );

  const a = (nominalGoal + 1) * (nominalDistance - minimumDistance);
  const b = Math.max(0, nominalGoal * (bestDistance - nominalDistance));
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
  return Math.max(0, Math.min(1,
    -0.271 + 2.912 * tvr - 2.098 * tvr * tvr + 0.457 * tvr * tvr * tvr
  ));
}

/**
 * Calculate complete task validity.
 */
export function calculateTaskValidity(
  params: GAPParameters,
  pilotDistances: number[],
  bestDistance: number,
  bestTime: number | null,
  numPresent: number,
): TaskValidity {
  const numFlying = pilotDistances.length;
  const launch = calculateLaunchValidity(numFlying, numPresent, params.nominalLaunch);
  const distance = calculateDistanceValidity(
    pilotDistances, bestDistance,
    params.nominalDistance, params.nominalGoal, params.minimumDistance,
  );
  const time = calculateTimeValidity(
    bestTime, bestDistance,
    params.nominalTime, params.nominalDistance,
  );

  return {
    launch,
    distance,
    time,
    task: launch * distance * time,
  };
}

// ---------------------------------------------------------------------------
// Weight distribution
// ---------------------------------------------------------------------------

/**
 * Calculate weight fractions for the four scoring components.
 *
 * @param useLeading - Whether leading (departure) points are enabled
 * @param useArrival - Whether arrival points are enabled (HG only)
 */
export function calculateWeights(
  goalRatio: number,
  bestDistance: number,
  taskDistance: number,
  scoring: 'PG' | 'HG',
  useLeading = true,
  useArrival = true,
): WeightFractions {
  const gr = goalRatio;

  // Distance weight (same for PG and HG)
  const dw = 0.9 - 1.665 * gr + 1.713 * gr * gr - 0.587 * gr * gr * gr;

  // Arrival weight: HG only, when enabled
  const aw = (scoring === 'HG' && useArrival) ? (1 - dw) / 8 : 0;

  // Leading weight: shared formula, PG doubles the multiplier
  let lw: number;
  if (!useLeading) {
    lw = 0;
  } else if (gr === 0) {
    lw = taskDistance > 0 ? (bestDistance / taskDistance) * 0.1 : 0;
  } else {
    const multiplier = scoring === 'PG' ? 1.4 * 2 : 1.4;
    lw = ((1 - dw) / 8) * multiplier;
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
export function calculateDistancePointsHG(
  pilotDistance: number,
  bestDistance: number,
  availableDistancePoints: number,
  difficulty: DistanceDifficulty,
  madeGoal: boolean,
): DistanceScore {
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
 * Calculate the speed fraction for a pilot, matching AirScore's
 * `pilot_speed` (gap2020+ / current FAI S7F):
 *
 *   SF = max(0, 1 − ((Tp − Tmin) / √Tmin)^e)    with times in hours
 *
 * where e = 5/6 for the modern formula (`weighted`) and 2/3 for the
 * older one (`classic`, AirScore gap.py — the same exponent it uses for
 * the leading factor). Tp/Tmin are speed-section times.
 */
export function calculateSpeedFraction(
  pilotTimeSeconds: number,
  bestTimeSeconds: number,
  exponent: number = 5 / 6,
): number {
  if (bestTimeSeconds <= 0 || pilotTimeSeconds <= 0) return 0;
  if (pilotTimeSeconds <= bestTimeSeconds) return 1;
  // Convert to hours for the GAP formula
  const pilotTime = pilotTimeSeconds / 3600;
  const bestTime = bestTimeSeconds / 3600;
  const sqrtBest = Math.sqrt(bestTime);
  if (sqrtBest <= 0) return 0;
  return Math.max(0, 1 - Math.pow((pilotTime - bestTime) / sqrtBest, exponent));
}

/** Speed-fraction exponent for a GAP formula generation. */
function speedExponent(formula: LeadingFormula): number {
  return formula === 'classic' ? 2 / 3 : 5 / 6;
}

/**
 * Calculate time points for a single pilot.
 * PG: Only pilots who made goal get time points.
 * HG: Pilots who reached ESS get time points.
 */
export function calculateTimePoints(
  pilotTime: number | null,
  bestTime: number | null,
  madeGoal: boolean,
  reachedESS: boolean,
  availableTimePoints: number,
  scoring: 'PG' | 'HG',
  formula: LeadingFormula = 'weighted',
): number {
  if (bestTime === null || pilotTime === null) return 0;

  // PG: must make goal to get time points
  if (scoring === 'PG' && !madeGoal) return 0;
  // HG: must reach ESS
  if (scoring === 'HG' && !reachedESS) return 0;

  const sf = calculateSpeedFraction(pilotTime, bestTime, speedExponent(formula));
  return sf * availableTimePoints;
}

// ---------------------------------------------------------------------------
// Leading Coefficient
// ---------------------------------------------------------------------------

// Leading-area weighting envelope (AirScore weightedarea.py). At p≈1
// (just left SSS) and p≈0 (at ESS) the weight is ~0; it peaks in the
// middle, so leading is rewarded most for being out front mid-course.
function weightRising(p: number): number {
  return Math.pow(1 - Math.pow(10, 9 * p - 9), 5);
}
function weightFalling(p: number): number {
  return Math.pow(1 - Math.pow(10, -3 * p), 2);
}
function leadWeight(p: number): number {
  return weightRising(p) * weightFalling(p);
}

/** Per-fix-interval contribution to the raw leading-coefficient sum. */
function lcContribution(
  formula: LeadingFormula,
  prevBestKm: number,
  curBestKm: number,
  timeSec: number,
  ssKm: number,
): number {
  // Only progress toward ESS (a decrease in best distance) contributes.
  if (prevBestKm <= curBestKm) return 0;
  if (formula === 'classic') {
    // classic: task_time * (best[i-1]² − best[i]²)
    return timeSec * (prevBestKm * prevBestKm - curBestKm * curBestKm);
  }
  // weighted: weight(p) * progress * task_time, with p = best[i] / ssKm
  const w = leadWeight(curBestKm / ssKm);
  if (w === 0) return 0;
  return w * (prevBestKm - curBestKm) * timeSec;
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
  /** Time of the pilot's last fix (epoch ms) — classic land-out tail. */
  lastFixMs: number;
  /**
   * weighted: Σ wᵢ·Δbestᵢ·(tᵢ − pilotSSS), summed against the pilot's OWN
   * start so the epoch-second terms stay small (no catastrophic cancellation).
   * combineLeadingCoefficient re-references it to the field's first start.
   */
  weightedTimeSum: number;
  /** weighted: Σ wᵢ·Δbestᵢ — the multiplier for the start-time shift. */
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
      andoyerDistance(fix.latitude, fix.longitude, tp.waypoint.lat, tp.waypoint.lon) - tp.radius,
    );
    const distKm = (edge + cumToESS[nextReq]) / 1000;

    if (prevDistKm !== null) {
      // AirScore appends this fix's distance to the ratchet window, then
      // weights the interval by this ("next") fix's time.
      const curBestKm = Math.min(prevDistKm, ssKm, prevBestKm);
      if (formula === 'classic') {
        // classic is referenced to the pilot's own start and never rebased,
        // so its times are non-negative as-is — no gate clamp.
        const localTimeSec = tms / 1000 - pilotSSSSec;
        classicSum += lcContribution('classic', prevBestKm, curBestKm, localTimeSec, ssKm);
      } else if (prevBestKm > curBestKm) {
        // weighted: split w·Δbest·time into (Σ w·Δbest·time) and (Σ w·Δbest)
        // so the field's start-time offset can be applied later.
        const w = leadWeight(curBestKm / ssKm);
        if (w !== 0) {
          const delta = w * (prevBestKm - curBestKm);
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
 * Fold the field-level scalars into a per-pilot {@link LeadingAggregate} to
 * produce the final leading coefficient — the cheap, field-dependent half of
 * `tot_lc_calculation` (late-start rectangle for classic, land-out tail, and
 * normalization). Lower LC = more leading = more points.
 *
 * @param agg - The pilot's cached/computed field-independent aggregate
 * @param taskFirstSSSTime - Time the first pilot crossed SSS (ms since epoch)
 * @param taskLastESSTime - Time the last pilot reached ESS (ms since epoch)
 * @param formula - 'weighted' (modern default) or 'classic'
 * @returns Normalized leading coefficient (lower is better), or Infinity
 */
export function combineLeadingCoefficient(
  agg: LeadingAggregate,
  taskFirstSSSTime: number,
  taskLastESSTime: number,
  formula: LeadingFormula = 'weighted',
): number {
  if (!agg.valid) return Infinity;
  const { ssKm, bestDistKm, reachedESS, pilotSSSMs, lastFixMs } = agg;

  if (formula === 'classic') {
    let total = agg.classicSum;
    if (pilotSSSMs > taskFirstSSSTime) {
      // Full-distance rectangle for the time before this pilot started.
      total += ssKm * ssKm * (pilotSSSMs - taskFirstSSSTime) / 1000;
    }
    if (!reachedESS) {
      const maxTime = Math.max(taskLastESSTime, lastFixMs);
      total += bestDistKm * bestDistKm * (maxTime - pilotSSSMs) / 1000;
    }
    return total / (1800 * ssKm * ssKm);
  }

  // weighted: rebase the per-pilot sum from the pilot's own start to the
  // field's first start — Σ w·Δbest·(t − first) = weightedTimeSum + (pilotSSS − first)·weightedDeltaSum.
  const shiftSec = pilotSSSMs / 1000 - taskFirstSSSTime / 1000;
  let total = agg.weightedTimeSum + shiftSec * agg.weightedDeltaSum;
  if (!reachedESS) {
    const missingTimeSec = (taskLastESSTime - taskFirstSSSTime) / 1000;
    total += weightFalling(bestDistKm / ssKm) * missingTimeSec * bestDistKm;
  }
  return total / (1800 * ssKm);
}

/**
 * Calculate the leading coefficient (LC) for a single pilot, matching
 * AirScore's `classic` and `weighted` formulas (CIVL GAP / FAI S7F).
 *
 * The curve is distance-to-ESS measured **along the optimized course**
 * (distance to the next un-reached turnpoint's cylinder edge plus the
 * optimized legs from there to ESS), sampled per fix, with a ratchet:
 * the best distance never increases even if the pilot flies away from ESS.
 * Lower LC = more leading = more points. The raw per-interval sum is then
 * normalized and given a late-start (classic) and/or land-out tail term,
 * exactly as AirScore's `tot_lc_calculation`.
 *
 * Thin wrapper over {@link computeLeadingAggregate} + {@link combineLeadingCoefficient};
 * see those for the cacheable split.
 *
 * @param fixes - Pilot's tracklog fixes (time-ordered)
 * @param task - The competition task
 * @param sequence - The pilot's resolved turnpoint reachings (for progress)
 * @param taskFirstSSSTime - Time the first pilot crossed SSS (ms since epoch)
 * @param taskLastESSTime - Time the last pilot reached ESS (ms since epoch)
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
  taskLastESSTime: number,
  pilotSSSTime: number | null,
  pilotESSTime: number | null,
  formula: LeadingFormula = 'weighted',
): number {
  const agg = computeLeadingAggregate(fixes, task, sequence, pilotSSSTime, pilotESSTime, formula);
  return combineLeadingCoefficient(agg, taskFirstSSSTime, taskLastESSTime, formula);
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
  const af = 0.2 + 0.037 * ac + 0.13 * ac * ac + 0.633 * ac * ac * ac;
  return af * availableArrivalPoints;
}

// ---------------------------------------------------------------------------
// Main scoring function
// ---------------------------------------------------------------------------

/**
 * Score multiple pilots against a single task using the CIVL GAP formula.
 *
 * This is the main entry point for multi-track scoring. It:
 * 1. Resolves turnpoint sequences for each pilot
 * 2. Computes aggregate statistics
 * 3. Calculates task validity
 * 4. Distributes available points
 * 5. Scores each pilot
 * 6. Returns ranked results
 *
 * @param task - The competition task definition
 * @param pilots - Array of pilot flights (name, trackFile, fixes)
 * @param params - GAP competition parameters (uses defaults if not provided)
 * @param numPresent - Number of pilots present at launch (defaults to pilots.length)
 * @returns Complete scored results with transparency data
 */
/**
 * Compact, per-pilot scoring inputs — everything the whole-field GAP
 * aggregation needs from one flight, in a plain-JSON-serializable shape.
 *
 * This is the boundary that lets the scoring backend cache per-track work:
 * resolving a pilot's turnpoint sequence (the expensive tracklog scan) is
 * independent of the rest of the field, so it can be computed once and reused
 * while the cheap field-level aggregation re-runs whenever the roster changes.
 *
 * `fixes` and `sequence` are only needed when {@link GAPParameters.useLeading}
 * is enabled (the leading-coefficient calculation re-scans the tracklog);
 * leave them undefined for the common no-leading case.
 */
export interface FlightScoringData {
  /** Pilot name (from IGC header, filename, or roster) */
  pilotName: string;
  /** Source file path — the unique key used to pair scores back to a pilot */
  trackFile: string;
  /** Raw scored flown distance in metres (pre minimum-distance floor) */
  flownDistance: number;
  /** Whether the pilot completed the task */
  madeGoal: boolean;
  /** Whether the pilot reached End of Speed Section */
  reachedESS: boolean;
  /**
   * Speed section time in seconds, or null if ESS not reached. In a gated
   * race this is already gate-based (ESS time − start gate time, §8.7) —
   * resolveTurnpointSequence computes it that way.
   */
  speedSectionTime: number | null;
  /**
   * SSS reaching time (epoch ms), or null if the pilot never started.
   * Always the pilot's ACTUAL crossing (it anchors the leading-coefficient
   * tracklog scan and places the gates on the right day); the gate-based
   * official start time is already folded into speedSectionTime.
   */
  sssTimeMs: number | null;
  /** ESS reaching time (epoch ms), or null if ESS not reached */
  essTimeMs: number | null;
  /**
   * Seconds the pilot started before the first start gate (§12.2 early
   * start), when detected. Drives the sport-specific early-start scoring
   * (PG launch→SSS clamp, HG jump-the-gun penalty).
   */
  earlyStartSeconds?: number;
  /**
   * Leading calculation input, needed only when useLeading is true. Provide
   * EITHER the precomputed {@link LeadingAggregate} (lets the backend cache the
   * per-track scan and skip the tracklog entirely) OR the raw fixes + sequence
   * (scoreTask's path — the aggregate is then computed on the fly).
   */
  leadingAggregate?: LeadingAggregate;
  /** Tracklog fixes — an alternative to leadingAggregate when useLeading is true */
  fixes?: IGCFix[];
  /** Resolved turnpoint reachings — an alternative to leadingAggregate when useLeading is true */
  sequence?: TurnpointReaching[];
}

/** A scored pilot without the (heavy) transparency turnpoint result. */
export type PilotScoreCore = Omit<PilotScore, 'turnpointResult'>;

/** {@link TaskScoreResult} without the per-pilot turnpoint results. */
export type TaskScoreCore = Omit<TaskScoreResult, 'pilotScores'> & {
  pilotScores: PilotScoreCore[];
};

/**
 * Build the compact scoring inputs for one flight from its resolved
 * turnpoint sequence. `includeTrack` attaches the fixes/sequence needed for
 * the leading-coefficient calculation (only when leading is enabled).
 */
export function toFlightScoringData(
  pilot: PilotFlight,
  result: TurnpointSequenceResult,
  includeTrack: boolean,
): FlightScoringData {
  return {
    pilotName: pilot.pilotName,
    trackFile: pilot.trackFile,
    flownDistance: result.flownDistance,
    madeGoal: result.madeGoal,
    reachedESS: result.essReaching !== null,
    speedSectionTime: result.speedSectionTime,
    sssTimeMs: result.sssReaching?.time.getTime() ?? null,
    essTimeMs: result.essReaching?.time.getTime() ?? null,
    ...(result.earlyStart
      ? { earlyStartSeconds: result.earlyStart.secondsEarly }
      : {}),
    fixes: includeTrack ? pilot.fixes : undefined,
    sequence: includeTrack ? result.sequence : undefined,
  };
}

/**
 * Whole-field GAP aggregation over compact per-pilot inputs.
 *
 * This is the single source of truth for task validity, weight distribution,
 * available points, and per-pilot point breakdowns. {@link scoreTask} feeds it
 * the results of {@link resolveTurnpointSequence}; the competition backend can
 * feed it cached {@link FlightScoringData} to avoid re-parsing unchanged
 * tracks. The returned pilot scores omit `turnpointResult` — callers that need
 * the full transparency data (like scoreTask) re-attach it by trackFile.
 *
 * @param scoringTask - The task, already trimmed for the distance origin
 *   (see {@link taskForDistanceOrigin}). Callers pass the trimmed task so the
 *   optimized distance is computed once here.
 * @param flights - Compact per-pilot scoring inputs
 * @param params - GAP competition parameters (uses defaults if not provided)
 * @param numPresent - Number of pilots present at launch (defaults to flights.length)
 */
export function scoreFlights(
  scoringTask: XCTask,
  flights: FlightScoringData[],
  params: Partial<GAPParameters> = {},
  numPresent?: number,
): TaskScoreCore {
  const fullParams: GAPParameters = { ...DEFAULT_GAP_PARAMETERS, ...params };
  const actualNumPresent = numPresent ?? flights.length;

  // Step 1: Early starts (FAI S7F §12.2) reshape a pilot's scoring inputs
  // before any field aggregation:
  // - PG: scored only for the launch→SSS distance; no time/leading/arrival.
  // - HG within jumpTheGunMaxSeconds: complete flight scored; a penalty of
  //   (seconds early ÷ jumpTheGunFactor) points is applied at the total,
  //   floored at the minimum-distance score (not zero).
  // - HG beyond the limit: scored for minimum distance only.
  const sssClampIdx = Math.max(0, getEffectiveSSSIndex(scoringTask));
  const earlyOutcomes: Array<PilotScoreCore['earlyStartOutcome']> = flights.map(f => {
    if (!f.earlyStartSeconds || f.earlyStartSeconds <= 0) return undefined;
    if (fullParams.scoring === 'PG') return 'pg_launch_to_sss';
    return f.earlyStartSeconds > fullParams.jumpTheGunMaxSeconds
      ? 'hg_min_distance'
      : 'hg_penalty';
  });
  const anyNeutralized = earlyOutcomes.some(
    o => o === 'pg_launch_to_sss' || o === 'hg_min_distance',
  );
  // Optimized launch→SSS distance — what a PG early starter is scored for.
  // Under distanceOrigin 'start' the task is already trimmed to begin at
  // the SSS, so this is 0 and the minimum-distance floor takes over.
  let launchToSssMeters = 0;
  if (anyNeutralized) {
    const segs = getOptimizedSegmentDistances(scoringTask);
    for (let i = 0; i < sssClampIdx; i++) launchToSssMeters += segs[i];
  }
  const effFlights: FlightScoringData[] = flights.map((f, i) => {
    const outcome = earlyOutcomes[i];
    if (outcome === 'pg_launch_to_sss' || outcome === 'hg_min_distance') {
      return {
        ...f,
        flownDistance: outcome === 'pg_launch_to_sss'
          ? Math.min(f.flownDistance, launchToSssMeters)
          : 0, // → minimum-distance floor below
        madeGoal: false,
        reachedESS: false,
        speedSectionTime: null,
        // No valid start for time/leading/arrival purposes.
        sssTimeMs: null,
        essTimeMs: null,
      };
    }
    return f;
  });

  // Step 2: Gather aggregate statistics
  // Apply minimum distance floor and clamp negative distances
  const scoredDistances = effFlights.map(f =>
    applyMinimumDistance(f.flownDistance, fullParams.minimumDistance)
  );
  const bestDistance = scoredDistances.length > 0 ? maxBy(scoredDistances, d => d) : 0;

  // HG distance difficulty (FAI S7F §11.1.1) — built once from the whole
  // field. Never applies to paragliding (the spec excludes PG).
  const useDifficulty = fullParams.scoring === 'HG' && fullParams.useDistanceDifficulty;
  const difficulty = useDifficulty
    ? calculateDistanceDifficulty(
        scoredDistances,
        effFlights.map(f => f.madeGoal),
        fullParams.minimumDistance,
      )
    : null;

  const numInGoal = effFlights.reduce((n, f) => n + (f.madeGoal ? 1 : 0), 0);
  const numReachedESS = effFlights.reduce((n, f) => n + (f.reachedESS ? 1 : 0), 0);

  // Best time: fastest speed section among goal pilots (PG) or ESS pilots (HG)
  const validTimes = effFlights
    .filter(f => (fullParams.scoring === 'PG' ? f.madeGoal : f.reachedESS))
    .map(f => f.speedSectionTime)
    .filter((t): t is number => t !== null && t > 0);
  const bestTime = validTimes.length > 0 ? minBy(validTimes, t => t) : null;

  const taskDistance = calculateOptimizedTaskDistance(scoringTask);

  const numFlying = flights.length;
  const goalRatio = numFlying > 0 ? numInGoal / numFlying : 0;

  const stats: TaskStats = {
    numPresent: actualNumPresent,
    numFlying,
    numInGoal,
    numReachedESS,
    bestDistance,
    bestTime,
    goalRatio,
    taskDistance,
  };

  // Step 3: Calculate task validity
  const taskValidity = calculateTaskValidity(
    fullParams, scoredDistances, bestDistance, bestTime, actualNumPresent,
  );

  // Step 4: Calculate weights and available points
  const weights = calculateWeights(
    goalRatio, bestDistance, taskDistance, fullParams.scoring,
    fullParams.useLeading, fullParams.useArrival,
  );
  const totalAvailable = 1000 * taskValidity.task;
  const availablePoints: AvailablePoints = {
    distance: totalAvailable * weights.distance,
    time: totalAvailable * weights.time,
    leading: totalAvailable * weights.leading,
    arrival: totalAvailable * weights.arrival,
    total: totalAvailable,
  };

  // Step 5: Calculate leading coefficients (skip when disabled — expensive tracklog scan)
  // Infinity = "no valid LC in the field" (calculateLeadingPoints then awards
  // no leading points to anyone).
  let leadingCoefficients: number[];
  let minLC = Infinity;

  if (fullParams.useLeading) {
    const allSSSTimes = effFlights
      .map(f => f.sssTimeMs)
      .filter((t): t is number => t !== null);
    const allESSTimes = effFlights
      .map(f => f.essTimeMs)
      .filter((t): t is number => t !== null);

    let taskFirstSSSTime = allSSSTimes.length > 0 ? minBy(allSSSTimes, t => t) : 0;
    // §11.3.1: in a gated race the leading-coefficient time axis starts at
    // the first start gate, not at the field's first actual crossing. Any
    // pilot's crossing works as the day reference for the gate times.
    if (allSSSTimes.length > 0) {
      const gates = resolveStartGates(scoringTask, taskFirstSSSTime);
      if (gates) taskFirstSSSTime = gates[0];
    }
    const taskLastESSTime = allESSTimes.length > 0 ? maxBy(allESSTimes, t => t) : taskFirstSSSTime + 3600000;

    leadingCoefficients = effFlights.map((f, idx) => {
      // Early starters scored only for distance (§12.2) earn no leading
      // points — their cached aggregate must not resurrect a coefficient.
      const outcome = earlyOutcomes[idx];
      if (outcome === 'pg_launch_to_sss' || outcome === 'hg_min_distance') {
        return Infinity;
      }
      // Prefer a precomputed aggregate (backend cache); otherwise scan the
      // tracklog now. Either way the field scalars fold in the same way.
      let agg = f.leadingAggregate;
      if (!agg) {
        if (!f.fixes || !f.sequence) {
          throw new Error(
            'scoreFlights: useLeading requires a leadingAggregate, or fixes + sequence, in FlightScoringData',
          );
        }
        agg = computeLeadingAggregate(
          f.fixes, scoringTask, f.sequence,
          f.sssTimeMs, f.essTimeMs, fullParams.leadingFormula,
        );
      }
      return combineLeadingCoefficient(
        agg, taskFirstSSSTime, taskLastESSTime, fullParams.leadingFormula,
      );
    });

    const finiteLCs = leadingCoefficients.filter(lc => isFinite(lc));
    if (finiteLCs.length > 0) minLC = minBy(finiteLCs, lc => lc);
  } else {
    leadingCoefficients = flights.map(() => Infinity);
  }

  // Step 6: Determine ESS arrival order for HG arrival points (skip when not needed)
  const essPositionMap = new Map<number, number>();
  if (fullParams.scoring === 'HG' && fullParams.useArrival) {
    effFlights
      .map((f, idx) => ({ idx, time: f.essTimeMs }))
      .filter((entry): entry is { idx: number; time: number } => entry.time !== null)
      .sort((a, b) => a.time - b.time)
      .forEach(({ idx }, position) => {
        essPositionMap.set(idx, position + 1);
      });
  }

  // §12.2 floor for the jump-the-gun penalty: the score a pilot would get
  // for exactly the minimum distance (distance points only) — the penalty
  // never drops a pilot below it, unlike the generic §12.4 zero floor.
  const anyJtgPenalty = earlyOutcomes.some(o => o === 'hg_penalty');
  const scoreForMinDistance = anyJtgPenalty
    ? (difficulty
        ? calculateDistancePointsHG(
            fullParams.minimumDistance, bestDistance,
            availablePoints.distance, difficulty, false,
          ).total
        : calculateDistancePoints(
            fullParams.minimumDistance, bestDistance, availablePoints.distance,
          ))
    : 0;

  // Step 7: Score each pilot
  const pilotScores: PilotScoreCore[] = effFlights.map((f, idx) => {
    const pilotScoredDistance = scoredDistances[idx];

    const distScore: DistanceScore = difficulty
      ? calculateDistancePointsHG(
          pilotScoredDistance, bestDistance, availablePoints.distance,
          difficulty, f.madeGoal,
        )
      : (() => {
          const linear = calculateDistancePoints(
            pilotScoredDistance, bestDistance, availablePoints.distance,
          );
          return { total: linear, linear, difficulty: 0 };
        })();
    const distPts = distScore.total;

    const timePts = calculateTimePoints(
      f.speedSectionTime, bestTime,
      f.madeGoal, f.reachedESS,
      availablePoints.time, fullParams.scoring,
      fullParams.leadingFormula,
    );

    const leadPts = calculateLeadingPoints(
      leadingCoefficients[idx], minLC, availablePoints.leading,
    );

    const position = essPositionMap.get(idx) ?? 0;
    const arrPts = position > 0
      ? calculateArrivalPoints(position, numReachedESS, availablePoints.arrival)
      : 0;

    // Jump the gun (§12.2, HG within the limit): 1 point per
    // jumpTheGunFactor seconds early, floored at the minimum-distance score.
    const outcome = earlyOutcomes[idx];
    const jtgPenalty = outcome === 'hg_penalty' && f.earlyStartSeconds
      ? f.earlyStartSeconds / fullParams.jumpTheGunFactor
      : 0;
    // FAI S7F §11: the total is the component sum rounded to one decimal
    // place; §12.4: rounding is done after penalties, so the jump-the-gun
    // penalty (§12.2) is subtracted before rounding (floored at the
    // minimum-distance score, not zero). The scorekeeper's absolute penalty
    // (§12.4) is applied later in the backend, which re-rounds after it.
    const rawTotal = distPts + timePts + leadPts + arrPts;
    const total = roundToTenth(
      jtgPenalty > 0 ? Math.max(rawTotal - jtgPenalty, scoreForMinDistance) : rawTotal,
    );

    return {
      pilotName: f.pilotName,
      trackFile: f.trackFile,
      flownDistance: pilotScoredDistance,
      speedSectionTime: f.speedSectionTime,
      madeGoal: f.madeGoal,
      reachedESS: f.reachedESS,
      distancePoints: Math.round(distPts * 10) / 10,
      distanceLinearPoints: Math.round(distScore.linear * 10) / 10,
      distanceDifficultyPoints: Math.round(distScore.difficulty * 10) / 10,
      timePoints: Math.round(timePts * 10) / 10,
      leadingPoints: Math.round(leadPts * 10) / 10,
      arrivalPoints: Math.round(arrPts * 10) / 10,
      totalScore: total,
      rank: 0, // assigned after sorting
      leadingCoefficient: leadingCoefficients[idx],
      ...(f.earlyStartSeconds && f.earlyStartSeconds > 0
        ? { earlyStartSeconds: f.earlyStartSeconds }
        : {}),
      ...(outcome ? { earlyStartOutcome: outcome } : {}),
      ...(jtgPenalty > 0
        ? { jumpTheGunPenalty: Math.round(jtgPenalty * 10) / 10 }
        : {}),
    };
  });

  // Sort by total score descending, then by distance descending
  pilotScores.sort((a, b) => {
    if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
    return b.flownDistance - a.flownDistance;
  });

  // Assign ranks (handle ties)
  for (let i = 0; i < pilotScores.length; i++) {
    if (i === 0 || pilotScores[i].totalScore !== pilotScores[i - 1].totalScore) {
      pilotScores[i].rank = i + 1;
    } else {
      pilotScores[i].rank = pilotScores[i - 1].rank;
    }
  }

  return {
    parameters: fullParams,
    taskValidity,
    weights,
    availablePoints,
    pilotScores,
    stats,
  };
}

export function scoreTask(
  task: XCTask,
  pilots: PilotFlight[],
  params: Partial<GAPParameters> = {},
  numPresent?: number,
): TaskScoreResult {
  const fullParams: GAPParameters = { ...DEFAULT_GAP_PARAMETERS, ...params };

  // Apply the distance-origin convention (take-off vs start cylinder) once,
  // up front; everything downstream scores against this task.
  const scoringTask = taskForDistanceOrigin(task, fullParams.distanceOrigin);

  // Step 1: Resolve turnpoint sequences for all pilots (the per-pilot,
  // field-independent work), then aggregate over the whole field.
  const results = pilots.map(pilot =>
    resolveTurnpointSequence(scoringTask, pilot.fixes)
  );
  const flights = pilots.map((pilot, idx) =>
    toFlightScoringData(pilot, results[idx], fullParams.useLeading)
  );

  const core = scoreFlights(scoringTask, flights, params, numPresent);

  // Re-attach the per-pilot turnpoint result (transparency data) by trackFile,
  // the same unique key the sorted scores carry.
  const resultByTrack = new Map(
    pilots.map((pilot, idx) => [pilot.trackFile, results[idx]]),
  );
  const pilotScores: PilotScore[] = core.pilotScores.map(ps => ({
    ...ps,
    turnpointResult: resultByTrack.get(ps.trackFile)!,
  }));

  return { ...core, pilotScores };
}
