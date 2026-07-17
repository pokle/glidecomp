/**
 * CIVL GAP Multi-Track Task Scoring
 *
 * Implements the CIVL GAP scoring system (FAI Sporting Code Section 7F)
 * for scoring multiple pilots against a single task.
 *
 * Each pilot's score is the sum of distance points, time points,
 * leading points, and arrival points (HG only). The total available
 * points per task = 1000 x TaskValidity.
 *
 * The parameter surface lives in ./gap-params and the per-component formulas
 * in ./gap-formulas; this module holds the whole-field orchestration
 * (scoreFlights / scoreTask) and the result types, and re-exports both so the
 * public API and existing imports are unchanged.
 *
 * @see https://www.fai.org/sites/default/files/civl/documents/sporting_code_s7_f_-_xc_scoring_2024.pdf
 */

import type { XCTask } from './xctsk-parser';
import type { IGCFix } from './igc-parser';
import type { TurnpointSequenceResult, TurnpointReaching, StopResolutionOptions } from './turnpoint-sequence';
import { resolveTurnpointSequence } from './turnpoint-sequence';
import { getSSSIndex, getEffectiveSSSIndex, getEffectiveESSIndex } from './xctsk-parser';
import { calculateOptimizedTaskDistance, getOptimizedSegmentDistances } from './task-optimizer';
import { resolveStartGates } from './time-gates';
import { maxBy, minBy } from './array-utils';

import { DEFAULT_GAP_PARAMETERS } from './gap-params';
import type { GAPParameters, DistanceOrigin } from './gap-params';
import {
  calculateTaskValidity,
  calculateStoppedTaskValidity,
  calculateWeights,
  calculateDistancePoints,
  calculateDistanceDifficulty,
  calculateDistancePointsHG,
  applyMinimumDistance,
  calculateTimePoints,
  resolveTimePointsExponent,
  computeLeadingAggregate,
  combineLeadingCoefficient,
  calculateLeadingPoints,
  calculateArrivalPoints,
} from './gap-formulas';
import type {
  TaskValidity,
  WeightFractions,
  DistanceScore,
  LeadingAggregate,
} from './gap-formulas';
import {
  resolveTaskStop,
  resolveScoredWindowEnds,
  stoppedGlideRatio,
  stoppedMinimumRunSeconds,
  resolveGoalAltitude,
} from './gap-stopped';

export * from './gap-params';
export * from './gap-formulas';
export * from './gap-stopped';

/**
 * Round a point value to one decimal place — the precision the FAI Sporting
 * Code S7F §11 specifies for a pilot's task total (and §12.4: the rounding is
 * done *after* penalties). Used for the total; component points are likewise
 * kept to 0.1 for presentation.
 */
function roundToTenth(x: number): number {
  return Math.round(x * 10) / 10;
}

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

/** Available points in each category. */
export interface AvailablePoints {
  distance: number;
  time: number;
  leading: number;
  arrival: number;
  total: number;
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
  /**
   * Stopped tasks only (§12.3.6): the altitude-bonus distance (meters)
   * folded into this pilot's flownDistance. Absent when no bonus applied.
   */
  stoppedAltitudeBonus?: number;
  /** Underlying turnpoint sequence result for transparency */
  turnpointResult: TurnpointSequenceResult;
}

/**
 * The whole-field stopped-task outcome (FAI S7F §12.3), present on the
 * result when the task was scored as stopped.
 */
export interface StoppedTaskScore {
  /** The resolved task stop time (epoch ms) the field was scored against (§12.3.1). */
  stopTimeMs: number;
  /**
   * Seconds from the scored-window start — the race start for a
   * single-start-gate race, otherwise the last pilot's start — to the stop
   * time (§12.3.2/§12.3.4). Null when nobody started before the stop.
   */
  scoredWindowSeconds: number | null;
  /** §12.3.2 minimum run: min(1 h, nominalTime ÷ 2), in seconds. */
  minimumRunSeconds: number;
  /**
   * Whether the stopped task ran long enough to be scored (§12.3.2). When
   * false the stopped validity is 0, so every pilot scores 0 — the closest
   * scoreable representation of "the task cannot be scored".
   */
  requirementMet: boolean;
  /** The §12.3.3 stopped-task validity applied (0 when requirementMet is false). */
  stoppedValidity: number;
  /**
   * §12.3.5: the fixed time-points reduction applied to every goal pilot —
   * the time points a pilot reaching ESS exactly at the end of the scored
   * window would get (removes the goal/landed-short discontinuity). 0 when
   * nobody made goal or no best time exists.
   */
  timePointsReduction: number;
  /** Launched pilots who landed before the stop (feeds §12.3.3). */
  numLandedBeforeStop: number;
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
  /** Present when the task was scored as stopped (FAI S7F §12.3). */
  stopped?: StoppedTaskScore;
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
   * The pilot's OFFICIAL start time (epoch ms): the start gate taken in a
   * gated race (§8.3.1), otherwise the actual crossing. Feeds the stopped-
   * task scored-window arithmetic (§12.3.2/§12.3.4). Null/absent when the
   * pilot never started (older cached data may omit it — sssTimeMs is the
   * fallback).
   */
  startTimeMs?: number | null;
  /**
   * Stopped tasks only: whether the pilot landed before the task stop
   * (their tracklog ends before the scored-window end). Feeds the §12.3.3
   * stopped validity. Absent (counted as landed) for track-less pilots.
   */
  landedBeforeStop?: boolean;
  /**
   * Stopped tasks only (§12.3.6): the altitude-bonus distance (meters)
   * already folded into flownDistance, passed through for transparency.
   */
  stoppedAltitudeBonus?: number;
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
  /**
   * True for a track-less pilot (a manual flight, issue #306): there is no
   * tracklog to scan, so the flight legitimately carries none of
   * {@link leadingAggregate}/{@link fixes}/{@link sequence}. Such a pilot earns
   * no leading points (LC = Infinity) — distinct from a tracked pilot whose
   * leading data was mis-wired, which {@link scoreFlights} still throws on.
   */
  trackless?: boolean;
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
    startTimeMs: result.startGate?.time.getTime()
      ?? result.sssReaching?.time.getTime()
      ?? null,
    ...(result.earlyStart
      ? { earlyStartSeconds: result.earlyStart.secondsEarly }
      : {}),
    ...(result.stopInfo
      ? {
          landedBeforeStop: !result.stopInfo.flyingAtStop,
          stoppedAltitudeBonus: result.stopInfo.altitudeBonus,
        }
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
 * @param stop - Present when the task was stopped (FAI S7F §12.3): the
 *   resolved task stop time (see {@link resolveTaskStop}). The flights must
 *   already be stop-aware — resolved with the stop's scored windows (their
 *   flownDistance clipped/bonused, landedBeforeStop set); this function adds
 *   the whole-field pieces: the §12.3.2 minimum-run requirement, the
 *   §12.3.3 stopped validity, and the §12.3.5 goal time-points reduction.
 */
export function scoreFlights(
  scoringTask: XCTask,
  flights: FlightScoringData[],
  params: Partial<GAPParameters> = {},
  numPresent?: number,
  stop?: { stopTimeMs: number },
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
        startTimeMs: null,
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

  // §12.1: the ESS-but-not-goal factor — the share of time and arrival
  // points kept by a pilot who reaches ESS but lands before goal. The spec
  // fixes paragliding at 0 (no goal → no time points), so PG ignores the
  // configured value.
  const essNotGoalFactor =
    fullParams.scoring === 'PG' ? 0 : fullParams.essNotGoalFactor;

  // Best time (§11.2.1) — matching AirScore's pilot_speed: while the
  // ESS-but-not-goal factor keeps a share of time points (HG default 0.8),
  // the best time is the fastest pilot to reach ESS, goal or not, so the
  // docked pilots' speed fractions stay on the same scale; when the factor
  // is 0 (always for PG) it is goal-validated exactly as the spec reads.
  const validTimes = effFlights
    .filter(f => (essNotGoalFactor > 0 ? f.reachedESS : f.madeGoal))
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

  // §12.3 stopped task: the scored-window duration (§12.3.4), the
  // minimum-run requirement (§12.3.2), and the stopped validity (§12.3.3).
  let stopped: StoppedTaskScore | undefined;
  if (stop) {
    // Scored-window start: the race start for a single-start-gate race,
    // otherwise (multi-gate / elapsed time) the LAST pilot's official start.
    const startTimes = effFlights
      .map(f => f.startTimeMs ?? f.sssTimeMs)
      .filter((t): t is number => t !== null);
    const gates = resolveStartGates(
      scoringTask,
      startTimes.length > 0 ? startTimes[0] : stop.stopTimeMs,
    );
    let windowStartMs: number | null = null;
    if (gates && gates.length === 1) windowStartMs = gates[0];
    else if (startTimes.length > 0) windowStartMs = maxBy(startTimes, t => t);
    const scoredWindowSeconds = windowStartMs !== null
      ? Math.max(0, (stop.stopTimeMs - windowStartMs) / 1000)
      : null;
    const minimumRunSeconds = stoppedMinimumRunSeconds(fullParams.nominalTime);
    const requirementMet = scoredWindowSeconds !== null
      && scoredWindowSeconds >= minimumRunSeconds;

    // §12.3.3 inputs: raw flown distances (bonus included), pilots landed
    // before the stop (track-less pilots count as landed), and the
    // optimized launch→ESS distance.
    const numLandedBeforeStop = effFlights.reduce(
      (n, f) => n + (f.landedBeforeStop !== false ? 1 : 0), 0,
    );
    const essIdxForDist = Math.max(0, getEffectiveESSIndex(scoringTask));
    const segs = getOptimizedSegmentDistances(scoringTask);
    let launchToEssDistance = 0;
    for (let i = 0; i < essIdxForDist && i < segs.length; i++) {
      launchToEssDistance += segs[i];
    }
    const formulaValidity = calculateStoppedTaskValidity({
      pilotDistances: effFlights.map(f => Math.max(0, f.flownDistance)),
      numReachedESS,
      numLandedBeforeStop,
      launchToEssDistance,
    });
    // A stopped task that didn't run the minimum time "cannot be scored"
    // (§12.3.2): stopped validity 0 zeroes every pilot while keeping the
    // other validity factors honest for the explanation.
    const stoppedValidity = requirementMet ? formulaValidity : 0;
    stopped = {
      stopTimeMs: stop.stopTimeMs,
      scoredWindowSeconds,
      minimumRunSeconds,
      requirementMet,
      stoppedValidity,
      timePointsReduction: 0, // finalized below, once available points exist
      numLandedBeforeStop,
    };
  }

  // Step 3: Calculate task validity
  const taskValidity = calculateTaskValidity(
    fullParams, scoredDistances, bestDistance, bestTime, actualNumPresent,
    stopped?.stoppedValidity,
  );

  // Step 4: Calculate weights and available points
  const weights = calculateWeights({
    goalRatio,
    bestDistance,
    taskDistance,
    scoring: fullParams.scoring,
    useLeading: fullParams.useLeading,
    useArrival: fullParams.useArrival,
    leadingWeightFormula: fullParams.leadingWeightFormula,
    leadingTimeRatio: fullParams.leadingTimeRatio,
  });
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
      // A track-less pilot (manual flight) has no tracklog to lead with, so it
      // earns no leading points — before demanding leading inputs below.
      if (f.trackless) return Infinity;
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
  // Time-points exponent (§11.2), resolved once for the field. Decoupled from
  // the leading-coefficient variant (issue #258); backward-compatible when only
  // leadingFormula was stored.
  const timeExponent = resolveTimePointsExponent(fullParams);

  // §12.3.5: every goal pilot's time points are reduced by the points a
  // pilot reaching ESS exactly at the end of the scored window would get —
  // removing the discontinuity against pilots stopped between ESS and goal.
  let stopTimeReduction = 0;
  if (
    stopped?.requirementMet &&
    stopped.scoredWindowSeconds !== null &&
    bestTime !== null &&
    numInGoal > 0
  ) {
    stopTimeReduction = calculateTimePoints({
      pilotTime: stopped.scoredWindowSeconds,
      bestTime,
      madeGoal: true,
      reachedESS: true,
      availableTimePoints: availablePoints.time,
      scoring: fullParams.scoring,
      exponent: timeExponent,
      essNotGoalFactor,
    });
    stopped.timePointsReduction = Math.round(stopTimeReduction * 10) / 10;
  }

  const anyJtgPenalty = earlyOutcomes.some(o => o === 'hg_penalty');
  const scoreForMinDistance = anyJtgPenalty
    ? (difficulty
        ? calculateDistancePointsHG({
            pilotDistance: fullParams.minimumDistance,
            bestDistance,
            availableDistancePoints: availablePoints.distance,
            difficulty,
            madeGoal: false,
          }).total
        : calculateDistancePoints(
            fullParams.minimumDistance, bestDistance, availablePoints.distance,
          ))
    : 0;

  // Step 7: Score each pilot
  const pilotScores: PilotScoreCore[] = effFlights.map((f, idx) => {
    const pilotScoredDistance = scoredDistances[idx];

    const distScore: DistanceScore = difficulty
      ? calculateDistancePointsHG({
          pilotDistance: pilotScoredDistance,
          bestDistance,
          availableDistancePoints: availablePoints.distance,
          difficulty,
          madeGoal: f.madeGoal,
        })
      : (() => {
          const linear = calculateDistancePoints(
            pilotScoredDistance, bestDistance, availablePoints.distance,
          );
          return { total: linear, linear, difficulty: 0 };
        })();
    const distPts = distScore.total;

    let timePts = calculateTimePoints({
      pilotTime: f.speedSectionTime,
      bestTime,
      madeGoal: f.madeGoal,
      reachedESS: f.reachedESS,
      availableTimePoints: availablePoints.time,
      scoring: fullParams.scoring,
      exponent: timeExponent,
      essNotGoalFactor,
    });
    // §12.3.5 stopped-task reduction — goal pilots only (a goal pilot's own
    // speed time never exceeds the scored window, so this stays ≥ 0; the
    // clamp guards degenerate inputs).
    if (stopTimeReduction > 0 && f.madeGoal) {
      timePts = Math.max(0, timePts - stopTimeReduction);
    }

    const leadPts = calculateLeadingPoints(
      leadingCoefficients[idx], minLC, availablePoints.leading,
    );

    // Arrival order still counts every ESS pilot; §12.1 then docks an
    // ESS-but-not-goal pilot's arrival points by the same factor as time.
    const position = essPositionMap.get(idx) ?? 0;
    const arrPtsFull = position > 0
      ? calculateArrivalPoints(position, numReachedESS, availablePoints.arrival)
      : 0;
    const arrPts = f.madeGoal ? arrPtsFull : arrPtsFull * essNotGoalFactor;

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
      ...(f.stoppedAltitudeBonus && f.stoppedAltitudeBonus > 0
        ? { stoppedAltitudeBonus: f.stoppedAltitudeBonus }
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
    ...(stopped ? { stopped } : {}),
  };
}

/** Options for {@link scoreTask} beyond the parameter set. */
export interface ScoreTaskOptions {
  /**
   * The task stop announcement time (epoch ms) when the task was stopped
   * (FAI S7F §12.3). The task stop time is derived from it per §12.3.1
   * (PG: minus {@link GAPParameters.scoreBackTime}; HG: minus one start-gate
   * interval, or 15 minutes with a single gate) and the whole §12.3
   * machinery applies. Omit/null for a normally completed task.
   */
  stopAnnouncementMs?: number | null;
}

export function scoreTask(
  task: XCTask,
  pilots: PilotFlight[],
  params: Partial<GAPParameters> = {},
  numPresent?: number,
  options: ScoreTaskOptions = {},
): TaskScoreResult {
  const fullParams: GAPParameters = { ...DEFAULT_GAP_PARAMETERS, ...params };

  // Apply the distance-origin convention (take-off vs start cylinder) once,
  // up front; everything downstream scores against this task.
  const scoringTask = taskForDistanceOrigin(task, fullParams.distanceOrigin);

  // Stopped task (§12.3): derive the task stop time from the announcement
  // and build the per-flight stop context (glide ratio + goal altitude for
  // the §12.3.6 bonus). The first pass clips every pilot at the stop time.
  const stopCtx = options.stopAnnouncementMs != null
    ? resolveTaskStop(scoringTask, options.stopAnnouncementMs, fullParams)
    : null;
  const stopBase: StopResolutionOptions | null = stopCtx
    ? {
        stopTimeMs: stopCtx.stopTimeMs,
        glideRatio: stoppedGlideRatio(fullParams.scoring),
        goalAltitude: resolveGoalAltitude(scoringTask),
      }
    : null;

  // Step 1: Resolve turnpoint sequences for all pilots (the per-pilot,
  // field-independent work), then aggregate over the whole field.
  let results = pilots.map(pilot =>
    resolveTurnpointSequence(
      scoringTask, pilot.fixes,
      stopBase ? { stop: stopBase } : undefined,
    )
  );

  // §12.3.4, multi-gate / elapsed-time stopped tasks: every pilot is scored
  // for the duration the LAST-started pilot had. The per-pilot window ends
  // come from the first pass's official starts (already clipped at the stop
  // time); pilots whose window is the stop time keep their first pass.
  if (stopBase) {
    const starts = results.map(r =>
      r.startGate?.time.getTime() ?? r.sssReaching?.time.getTime() ?? null,
    );
    const windowEnds = resolveScoredWindowEnds(
      scoringTask, starts, stopBase.stopTimeMs,
    );
    if (windowEnds) {
      results = results.map((r, idx) =>
        windowEnds[idx] < stopBase.stopTimeMs
          ? resolveTurnpointSequence(scoringTask, pilots[idx].fixes, {
              stop: { ...stopBase, windowEndMs: windowEnds[idx] },
            })
          : r,
      );
    }
  }

  const flights = pilots.map((pilot, idx) =>
    toFlightScoringData(pilot, results[idx], fullParams.useLeading)
  );

  const core = scoreFlights(
    scoringTask, flights, params, numPresent,
    stopCtx ? { stopTimeMs: stopCtx.stopTimeMs } : undefined,
  );

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
