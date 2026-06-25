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
import { getESSIndex, getSSSIndex } from './xctsk-parser';
import { calculateOptimizedTaskDistance, getOptimizedSegmentDistances } from './task-optimizer';
import { andoyerDistance } from './geo';
import { maxBy, minBy } from './array-utils';

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
  /** Distance component score */
  distancePoints: number;
  /** Time/speed component score */
  timePoints: number;
  /** Leading coefficient component score */
  leadingPoints: number;
  /** Arrival component score (HG only, 0 for PG) */
  arrivalPoints: number;
  /** Sum of all point components, rounded */
  totalScore: number;
  /** Rank position (1-based) */
  rank: number;
  /** Leading coefficient value */
  leadingCoefficient: number;
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
  const essIdx = getESSIndex(task);
  const sssIdx = Math.max(0, getSSSIndex(task));
  // Pilots who never started get the worst possible LC.
  if (essIdx <= sssIdx || fixes.length === 0 || pilotSSSTime === null) {
    return Infinity;
  }

  // Optimized along-course distance from each turnpoint to ESS (meters).
  const segs = getOptimizedSegmentDistances(task);
  const cumToESS: number[] = new Array(essIdx + 1).fill(0);
  for (let j = essIdx - 1; j >= 0; j--) {
    cumToESS[j] = cumToESS[j + 1] + segs[j];
  }
  const ssKm = cumToESS[sssIdx] / 1000; // speed-section length (km)
  if (ssKm <= 0) return Infinity;

  // Reaching time per task index, so we know which turnpoint the pilot is
  // flying toward at each fix (the next un-reached one before ESS).
  const reachTime: Array<number | undefined> = [];
  for (const r of sequence) reachTime[r.taskIndex] = r.time.getTime();

  // Time origin: the pilot's own start for classic, the first pilot's
  // start for weighted (per the GAP2020+ spec wording).
  const startRefSec = (formula === 'classic' ? pilotSSSTime : taskFirstSSSTime) / 1000;
  const endTime = pilotESSTime ?? Infinity;

  let prevBestKm = ssKm; // best_dist_to_ess ratchet, starts at full SS length
  let summing = 0;
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
      const timeSec = tms / 1000 - startRefSec;
      summing += lcContribution(formula, prevBestKm, curBestKm, timeSec, ssKm);
      prevBestKm = curBestKm;
    }
    prevDistKm = distKm;
  }

  if (prevDistKm === null) return Infinity; // no fixes in the leading window
  // Fold the final fix's distance into the ratchet (used by the tail term).
  const bestDistKm = Math.min(prevDistKm, ssKm, prevBestKm);

  // tot_lc_calculation: late-start rectangle (classic only) + land-out
  // tail (no ESS) + normalization.
  if (formula === 'classic') {
    let total = summing;
    if (pilotSSSTime > taskFirstSSSTime) {
      // Full-distance rectangle for the time before this pilot started.
      total += ssKm * ssKm * (pilotSSSTime - taskFirstSSSTime) / 1000;
    }
    if (pilotESSTime === null) {
      const lastFix = fixes[fixes.length - 1].time.getTime();
      const maxTime = Math.max(taskLastESSTime, lastFix);
      total += bestDistKm * bestDistKm * (maxTime - pilotSSSTime) / 1000;
    }
    return total / (1800 * ssKm * ssKm);
  }

  // weighted
  let total = summing;
  if (pilotESSTime === null) {
    const missingTimeSec = (taskLastESSTime - taskFirstSSSTime) / 1000;
    total += weightFalling(bestDistKm / ssKm) * missingTimeSec * bestDistKm;
  }
  return total / (1800 * ssKm);
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
 */
export function calculateLeadingPoints(
  pilotLC: number,
  minLC: number,
  availableLeadingPoints: number,
): number {
  if (!isFinite(pilotLC) || !isFinite(minLC) || minLC <= 0) return 0;
  const lcDiff = pilotLC - minLC;
  if (lcDiff <= 0) return availableLeadingPoints;
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
export function scoreTask(
  task: XCTask,
  pilots: PilotFlight[],
  params: Partial<GAPParameters> = {},
  numPresent?: number,
): TaskScoreResult {
  const fullParams: GAPParameters = { ...DEFAULT_GAP_PARAMETERS, ...params };
  const actualNumPresent = numPresent ?? pilots.length;

  // Apply the distance-origin convention (take-off vs start cylinder) once,
  // up front; everything downstream scores against this task.
  const scoringTask = taskForDistanceOrigin(task, fullParams.distanceOrigin);

  // Step 1: Resolve turnpoint sequences for all pilots
  const pilotResults = pilots.map(pilot => ({
    pilot,
    result: resolveTurnpointSequence(scoringTask, pilot.fixes),
  }));

  // Step 2: Gather aggregate statistics
  // Apply minimum distance floor and clamp negative distances
  const scoredDistances = pilotResults.map(pr =>
    applyMinimumDistance(pr.result.flownDistance, fullParams.minimumDistance)
  );
  const bestDistance = scoredDistances.length > 0 ? maxBy(scoredDistances, d => d) : 0;

  const goalPilots = pilotResults.filter(pr => pr.result.madeGoal);
  const essPilots = pilotResults.filter(pr => pr.result.essReaching !== null);
  const numInGoal = goalPilots.length;
  const numReachedESS = essPilots.length;

  // Best time: fastest speed section among goal pilots (PG) or ESS pilots (HG)
  const timeCandidates = fullParams.scoring === 'PG' ? goalPilots : essPilots;
  const validTimes = timeCandidates
    .map(pr => pr.result.speedSectionTime)
    .filter((t): t is number => t !== null && t > 0);
  const bestTime = validTimes.length > 0 ? minBy(validTimes, t => t) : null;

  const taskDistance = calculateOptimizedTaskDistance(scoringTask);

  const numFlying = pilots.length;
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
  let leadingCoefficients: number[];
  let minLC = 0;

  if (fullParams.useLeading) {
    const allSSSTimes = pilotResults
      .map(pr => pr.result.sssReaching?.time.getTime())
      .filter((t): t is number => t !== undefined);
    const allESSTimes = pilotResults
      .map(pr => pr.result.essReaching?.time.getTime())
      .filter((t): t is number => t !== undefined);

    const taskFirstSSSTime = allSSSTimes.length > 0 ? minBy(allSSSTimes, t => t) : 0;
    const taskLastESSTime = allESSTimes.length > 0 ? maxBy(allESSTimes, t => t) : taskFirstSSSTime + 3600000;

    leadingCoefficients = pilotResults.map(pr => {
      const sssTime = pr.result.sssReaching?.time.getTime() ?? null;
      const essTime = pr.result.essReaching?.time.getTime() ?? null;
      return calculateLeadingCoefficient(
        pr.pilot.fixes, scoringTask, pr.result.sequence,
        taskFirstSSSTime, taskLastESSTime,
        sssTime, essTime,
        fullParams.leadingFormula,
      );
    });

    const finiteLCs = leadingCoefficients.filter(lc => isFinite(lc));
    minLC = finiteLCs.length > 0 ? minBy(finiteLCs, lc => lc) : 0;
  } else {
    leadingCoefficients = pilotResults.map(() => Infinity);
  }

  // Step 6: Determine ESS arrival order for HG arrival points (skip when not needed)
  const essPositionMap = new Map<number, number>();
  if (fullParams.scoring === 'HG' && fullParams.useArrival) {
    pilotResults
      .map((pr, idx) => ({ idx, time: pr.result.essReaching?.time.getTime() }))
      .filter((entry): entry is { idx: number; time: number } => entry.time !== undefined)
      .sort((a, b) => a.time - b.time)
      .forEach(({ idx }, position) => {
        essPositionMap.set(idx, position + 1);
      });
  }

  // Step 7: Score each pilot
  const pilotScores: PilotScore[] = pilotResults.map((pr, idx) => {
    const { result } = pr;
    const { pilot } = pr;
    const pilotScoredDistance = scoredDistances[idx];

    const distPts = calculateDistancePoints(
      pilotScoredDistance, bestDistance, availablePoints.distance,
    );

    const timePts = calculateTimePoints(
      result.speedSectionTime, bestTime,
      result.madeGoal, result.essReaching !== null,
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

    const total = Math.round(distPts + timePts + leadPts + arrPts);

    return {
      pilotName: pilot.pilotName,
      trackFile: pilot.trackFile,
      flownDistance: pilotScoredDistance,
      speedSectionTime: result.speedSectionTime,
      madeGoal: result.madeGoal,
      reachedESS: result.essReaching !== null,
      distancePoints: Math.round(distPts * 10) / 10,
      timePoints: Math.round(timePts * 10) / 10,
      leadingPoints: Math.round(leadPts * 10) / 10,
      arrivalPoints: Math.round(arrPts * 10) / 10,
      totalScore: total,
      rank: 0, // assigned after sorting
      leadingCoefficient: leadingCoefficients[idx],
      turnpointResult: result,
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
