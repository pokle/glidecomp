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
import type { TurnpointSequenceResult } from './turnpoint-sequence';
import { resolveTurnpointSequence } from './turnpoint-sequence';
import { getESSIndex } from './xctsk-parser';
import { calculateOptimizedTaskDistance } from './task-optimizer';
import { andoyerDistance } from './geo';

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
}

/** Default parameters — reasonable for a typical PG competition. */
export const DEFAULT_GAP_PARAMETERS: GAPParameters = {
  nominalLaunch: 0.96,
  nominalDistance: 70000,
  nominalGoal: 0.2,
  nominalTime: 5400,
  minimumDistance: 5000,
  scoring: 'PG',
  useLeading: true,
  useArrival: true,
};

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
 * Calculate the speed fraction for a pilot.
 * The cube-root formula creates a curve that rewards
 * being close to the fastest time.
 *
 * Times are in seconds but the GAP formula operates in hours.
 */
export function calculateSpeedFraction(
  pilotTimeSeconds: number,
  bestTimeSeconds: number,
): number {
  if (bestTimeSeconds <= 0 || pilotTimeSeconds <= 0) return 0;
  // Convert to hours for the GAP formula
  const pilotTime = pilotTimeSeconds / 3600;
  const bestTime = bestTimeSeconds / 3600;
  const timeDiff = pilotTime - bestTime;
  if (timeDiff <= 0) return 1;
  const sqrtBest = Math.sqrt(bestTime);
  if (sqrtBest <= 0) return 0;
  return Math.max(0, 1 - Math.cbrt((timeDiff * timeDiff) / sqrtBest));
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
): number {
  if (bestTime === null || pilotTime === null) return 0;

  // PG: must make goal to get time points
  if (scoring === 'PG' && !madeGoal) return 0;
  // HG: must reach ESS
  if (scoring === 'HG' && !reachedESS) return 0;

  const sf = calculateSpeedFraction(pilotTime, bestTime);
  return sf * availableTimePoints;
}

// ---------------------------------------------------------------------------
// Leading Coefficient
// ---------------------------------------------------------------------------

/**
 * Calculate the leading coefficient (LC) for a single pilot.
 *
 * LC is the area under the distance-to-ESS vs time curve.
 * The curve uses a "ratchet" — distance never increases even if the
 * pilot flies away from ESS. Lower LC = more leading = more points.
 *
 * @param fixes - Pilot's tracklog fixes
 * @param task - The competition task
 * @param taskFirstSSSTime - Time the first pilot crossed SSS (ms since epoch)
 * @param taskLastESSTime - Time the last pilot reached ESS (ms since epoch), or task deadline
 * @returns Leading coefficient (area value)
 */
export function calculateLeadingCoefficient(
  fixes: IGCFix[],
  task: XCTask,
  taskFirstSSSTime: number,
  taskLastESSTime: number,
  pilotSSSTime: number | null,
  pilotESSTime: number | null,
): number {
  const essIdx = getESSIndex(task);
  if (essIdx < 0 || fixes.length === 0) return Infinity;

  const essTP = task.turnpoints[essIdx];
  const essLat = essTP.waypoint.lat;
  const essLon = essTP.waypoint.lon;
  const essRadius = essTP.radius;

  // If pilot never started, return Infinity (worst LC)
  if (pilotSSSTime === null) return Infinity;

  // Calculate distance to ESS edge at each fix
  // Using ratchet: distance only decreases
  let minDistSoFar = Infinity;
  const points: Array<{ time: number; dist: number }> = [];

  for (const fix of fixes) {
    const t = fix.time.getTime();
    // Only consider fixes from the task window
    if (t < taskFirstSSSTime) continue;
    // Stop at pilot's ESS time or task end
    if (pilotESSTime !== null && t > pilotESSTime) break;
    if (t > taskLastESSTime) break;

    // Only count fixes after pilot's own SSS time
    if (t < pilotSSSTime) continue;

    const distToESS = Math.max(0,
      andoyerDistance(fix.latitude, fix.longitude, essLat, essLon) - essRadius
    );
    minDistSoFar = Math.min(minDistSoFar, distToESS);
    points.push({ time: (t - taskFirstSSSTime) / 1000, dist: minDistSoFar });
  }

  if (points.length < 2) return Infinity;

  // If pilot landed before taskLastESSTime, extend the curve
  // with a flat line at their last distance until taskLastESSTime
  const lastPoint = points[points.length - 1];
  const endTime = (taskLastESSTime - taskFirstSSSTime) / 1000;
  if (pilotESSTime === null && lastPoint.time < endTime) {
    points.push({ time: endTime, dist: lastPoint.dist });
  }

  // Trapezoidal area calculation
  // Use hours × km for the GAP formula units (consistent with speed fraction)
  let area = 0;
  for (let i = 1; i < points.length; i++) {
    const dtHours = (points[i].time - points[i - 1].time) / 3600; // hours
    const avgDistKm = (points[i].dist + points[i - 1].dist) / 2 / 1000; // km
    area += dtHours * avgDistKm;
  }

  return area;
}

// ---------------------------------------------------------------------------
// Leading Points
// ---------------------------------------------------------------------------

/**
 * Calculate leading points for a single pilot.
 * Uses the same cube-root formula as time points, applied to LC values.
 */
export function calculateLeadingPoints(
  pilotLC: number,
  minLC: number,
  availableLeadingPoints: number,
): number {
  if (!isFinite(pilotLC) || !isFinite(minLC) || minLC <= 0) return 0;
  const lcDiff = pilotLC - minLC;
  if (lcDiff <= 0) return availableLeadingPoints;
  const sqrtMin = Math.sqrt(minLC);
  if (sqrtMin <= 0) return 0;
  const factor = Math.max(0, 1 - Math.cbrt((lcDiff * lcDiff) / sqrtMin));
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

  // Step 1: Resolve turnpoint sequences for all pilots
  const pilotResults = pilots.map(pilot => ({
    pilot,
    result: resolveTurnpointSequence(task, pilot.fixes),
  }));

  // Step 2: Gather aggregate statistics
  // Apply minimum distance floor and clamp negative distances
  const scoredDistances = pilotResults.map(pr =>
    applyMinimumDistance(pr.result.flownDistance, fullParams.minimumDistance)
  );
  const bestDistance = scoredDistances.length > 0 ? Math.max(...scoredDistances) : 0;

  const goalPilots = pilotResults.filter(pr => pr.result.madeGoal);
  const essPilots = pilotResults.filter(pr => pr.result.essReaching !== null);
  const numInGoal = goalPilots.length;
  const numReachedESS = essPilots.length;

  // Best time: fastest speed section among goal pilots (PG) or ESS pilots (HG)
  const timeCandidates = fullParams.scoring === 'PG' ? goalPilots : essPilots;
  const validTimes = timeCandidates
    .map(pr => pr.result.speedSectionTime)
    .filter((t): t is number => t !== null && t > 0);
  const bestTime = validTimes.length > 0 ? Math.min(...validTimes) : null;

  const taskDistance = calculateOptimizedTaskDistance(task);

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

    const taskFirstSSSTime = allSSSTimes.length > 0 ? Math.min(...allSSSTimes) : 0;
    const taskLastESSTime = allESSTimes.length > 0 ? Math.max(...allESSTimes) : taskFirstSSSTime + 3600000;

    leadingCoefficients = pilotResults.map(pr => {
      const sssTime = pr.result.sssReaching?.time.getTime() ?? null;
      const essTime = pr.result.essReaching?.time.getTime() ?? null;
      return calculateLeadingCoefficient(
        pr.pilot.fixes, task,
        taskFirstSSSTime, taskLastESSTime,
        sssTime, essTime,
      );
    });

    const finiteLCs = leadingCoefficients.filter(lc => isFinite(lc));
    minLC = finiteLCs.length > 0 ? Math.min(...finiteLCs) : 0;
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
