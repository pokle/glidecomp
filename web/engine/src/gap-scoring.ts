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
 * The parameter surface lives in ./gap-params, the per-component formulas in
 * ./gap-formulas, the leading-coefficient pipeline in ./gap-leading, the
 * stopped-task support in ./gap-stopped, and the input/result shapes in
 * ./gap-types; this module holds the whole-field orchestration
 * (scoreFlights / scoreTask) and re-exports them all, so the public API and
 * existing imports are unchanged.
 *
 * @see https://www.fai.org/sites/default/files/civl/documents/sporting_code_s7_f_-_xc_scoring_2026.pdf
 */

import type { XCTask } from './xctsk-parser';
import type { TurnpointSequenceResult, StopResolutionOptions } from './turnpoint-sequence';
import { resolveTurnpointSequence } from './turnpoint-sequence';
import { getSSSIndex, getEffectiveSSSIndex } from './xctsk-parser';
import { calculateOptimizedTaskDistance, getOptimizedSegmentDistances } from './task-optimizer';
import { resolveStartGates, resolveTaskDeadline } from './time-gates';
import { maxBy, minBy } from './array-utils';

import { DEFAULT_GAP_PARAMETERS, leadingFormulaFor, resolveLeadingTimeRatio } from './gap-params';
import type { GAPParameters, DistanceOrigin } from './gap-params';
import {
  calculateTaskValidity,
  calculateWeights,
  calculateDistancePoints,
  calculateDistanceDifficulty,
  calculateDistancePointsHG,
  applyMinimumDistance,
  calculateTimePoints,
  calculateArrivalPoints,
} from './gap-formulas';
import type {
  DistanceScore,
  DistanceDifficulty,
} from './gap-formulas';
import {
  computeLeadingAggregate,
  combineLeadingCoefficient,
  resolveLeadingMaxTime,
  calculateLeadingPoints,
} from './gap-leading';
import type { LeadingFieldTimes } from './gap-leading';
import {
  resolveTaskStop,
  resolveScoredWindowEnds,
  resolveStoppedTaskScore,
  resolveStopTimePointsReduction,
  stoppedGlideRatio,
  resolveGoalAltitude,
} from './gap-stopped';
import { isNeutralisingOutcome } from './gap-types';
import type {
  AvailablePoints,
  BestTimeCandidate,
  FlightScoringData,
  LeadingTimes,
  PilotFlight,
  PilotScore,
  PilotScoreCore,
  ScoreTaskOptions,
  StoppedTaskScore,
  TaskScoreCore,
  TaskScoreResult,
  TaskStats,
} from './gap-types';

export * from './gap-params';
export * from './gap-formulas';
export * from './gap-leading';
export * from './gap-stopped';
export * from './gap-types';

/**
 * Round a point value to one decimal place — the precision the FAI Sporting
 * Code S7F §12 specifies for a pilot's task total (and §13.5: the rounding is
 * done *after* penalties). Used for the total; component points are likewise
 * kept to 0.1 for presentation.
 */
function roundToTenth(x: number): number {
  return Math.round(x * 10) / 10;
}

/**
 * Assign 1-based ranks over an already-sorted score list, in place. Ties —
 * consecutive entries whose key compares equal — share the earlier rank, and
 * the next distinct key resumes at its list position (1, 2, 2, 4: standard
 * competition ranking). The key selector names what a tie means for the
 * format: total points for GAP, distance for open distance.
 */
export function assignRanks<T extends { rank: number }>(
  sorted: T[],
  key: (entry: T) => number,
): void {
  for (let i = 0; i < sorted.length; i++) {
    if (i === 0 || key(sorted[i]) !== key(sorted[i - 1])) {
      sorted[i].rank = i + 1;
    } else {
      sorted[i].rank = sorted[i - 1].rank;
    }
  }
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
  // The trimmed route begins at the start cylinder, but scored distance
  // under this origin begins at the start CROSSING — so the first
  // turnpoint keeps its boundary measurement instead of the §7.2
  // launch-centre rule (which would add the start radius back in).
  return {
    ...task,
    turnpoints: task.turnpoints.slice(sssIdx),
    firstTurnpointAtBoundary: true,
  };
}

// ---------------------------------------------------------------------------
// Main scoring function
// ---------------------------------------------------------------------------

/**
 * A resolved sequence's OFFICIAL start time (epoch ms): the start gate taken
 * in a gated race (§9.2.4.1), otherwise the actual SSS crossing. Null when
 * the pilot never started. The sequence-side twin of officialStartTimeMs in
 * ./gap-types — the one interpretation, wherever the start is read from.
 */
function officialStartFromSequence(result: TurnpointSequenceResult): number | null {
  return result.startGate?.time.getTime()
    ?? result.sssReaching?.time.getTime()
    ?? null;
}

/**
 * Build the compact scoring inputs for one flight from its resolved
 * turnpoint sequence. `includeTrack` attaches the fixes/sequence the
 * leading-coefficient calculation re-scans (only when leading is enabled);
 * otherwise the flight declares it has nothing to lead with.
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
    startTimeMs: officialStartFromSequence(result),
    ...(result.earlyStart
      ? { earlyStartSeconds: result.earlyStart.secondsEarly }
      : {}),
    ...(result.stopInfo
      ? {
          landedBeforeStop: !result.stopInfo.flyingAtStop,
          stoppedAltitudeBonus: result.stopInfo.altitudeBonus,
        }
      : {}),
    leading: includeTrack
      ? { kind: 'track', fixes: pilot.fixes, sequence: result.sequence }
      : { kind: 'none' },
  };
}

/**
 * Whether the field's distance points split into the linear and difficulty
 * halves (FAI S7F §12.1.1). The spec's difficulty calculation is
 * hang-gliding only, so paragliding never uses it whatever the parameter
 * says.
 *
 * Exported so the report card prints the split the scorer actually applied —
 * including for a pilot whose difficulty half is legitimately 0.
 */
export function usesDistanceDifficulty(params: GAPParameters): boolean {
  return params.scoring === 'HG' && params.useDistanceDifficulty;
}

/**
 * The ESS-but-not-goal factor in force (FAI S7F §13.2) — the share of time
 * and arrival points kept by a pilot who reaches ESS but lands before goal.
 * The spec fixes paragliding at 0 (no goal → no time points), so PG ignores
 * the configured value.
 */
export function effectiveEssNotGoalFactor(params: GAPParameters): number {
  return params.scoring === 'PG' ? 0 : params.essNotGoalFactor;
}

/**
 * The speed-section times that count toward the best time (S7F 2026 §9.4.1),
 * in field order.
 *
 * §9.4.1 pins the qualifying set per discipline: in hang-gliding the best
 * time is the fastest pilot to reach ESS, goal or not; in paragliding only
 * pilots who reached goal are considered (a PG pilot cannot earn time points
 * without goal, so the denominator matches who can score).
 */
export function qualifyingSpeedSectionTimes(
  candidates: readonly BestTimeCandidate[],
  scoring: 'PG' | 'HG',
): number[] {
  return candidates
    .filter(c => (scoring === 'HG' ? c.reachedESS : c.madeGoal))
    .map(c => c.speedSectionTime)
    .filter((t): t is number => t !== null && t > 0);
}

/**
 * Best speed-section time (§9.4.1) — the denominator of every pilot's speed
 * fraction — or null when nobody qualifies.
 */
export function bestTimeFrom(
  candidates: readonly BestTimeCandidate[],
  scoring: 'PG' | 'HG',
): number | null {
  const validTimes = qualifyingSpeedSectionTimes(candidates, scoring);
  return validTimes.length > 0 ? minBy(validTimes, t => t) : null;
}

// ---------------------------------------------------------------------------
// The whole-field steps of scoreFlights, in the order it runs them
// ---------------------------------------------------------------------------

/**
 * Step 1: Early starts (FAI S7F §13.3) reshape a pilot's scoring inputs
 * before any field aggregation:
 * - PG: scored only for the launch→SSS distance — a fixed value, whatever
 *   the flight covered; no time/leading/arrival.
 * - HG within jumpTheGunMaxSeconds: complete flight scored; a penalty of
 *   (seconds early ÷ jumpTheGunFactor) points is applied at the total,
 *   floored at the minimum-distance score (not zero).
 * - HG beyond the limit: scored for minimum distance only.
 *
 * Returns the reshaped flights the rest of the scorer reads, plus the outcome
 * per pilot (index-aligned, undefined for a normal start) — steps 5 and 7 both
 * need to know who was neutralised.
 */
function applyEarlyStarts(
  scoringTask: XCTask,
  flights: readonly FlightScoringData[],
  params: GAPParameters,
): {
  outcomes: Array<PilotScoreCore['earlyStartOutcome']>;
  effFlights: FlightScoringData[];
} {
  const sssClampIdx = Math.max(0, getEffectiveSSSIndex(scoringTask));
  const outcomes: Array<PilotScoreCore['earlyStartOutcome']> = flights.map(f => {
    if (!f.earlyStartSeconds || f.earlyStartSeconds <= 0) return undefined;
    if (params.scoring === 'PG') return 'pg_launch_to_sss';
    return f.earlyStartSeconds > params.jumpTheGunMaxSeconds
      ? 'hg_min_distance'
      : 'hg_penalty';
  });
  const anyNeutralized = outcomes.some(isNeutralisingOutcome);
  // Optimized launch→SSS distance — what a PG early starter is scored for.
  // §12.2 awards it as a FIXED value ("as calculated when determining the
  // complete task distance", §7.2), so it is not capped at what the pilot
  // flew: one who jumped the gun and then landed short of their own start
  // still gets the whole launch→SSS leg. Under distanceOrigin 'start' the
  // task is already trimmed to begin at the SSS, so this is 0 and the
  // minimum-distance floor takes over.
  let launchToSssMeters = 0;
  if (anyNeutralized) {
    const segs = getOptimizedSegmentDistances(scoringTask);
    for (let i = 0; i < sssClampIdx; i++) launchToSssMeters += segs[i];
  }
  const effFlights: FlightScoringData[] = flights.map((f, i) => {
    const outcome = outcomes[i];
    if (isNeutralisingOutcome(outcome)) {
      return {
        ...f,
        flownDistance: outcome === 'pg_launch_to_sss'
          ? launchToSssMeters
          : 0, // → minimum-distance floor in step 2
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
  return { outcomes, effFlights };
}

/**
 * Step 2: Gather aggregate statistics — every field-level scalar the
 * per-pilot formulas divide by, from the early-start-reshaped flights.
 *
 * `scoredDistances` (the minimum-distance floor already applied, §12.1) and
 * the HG `difficulty` table come back alongside {@link TaskStats} because
 * step 7 scores each pilot against them, and `essNotGoalFactor` (§13.2)
 * because it is fixed for the field and both the best time and the arrival
 * dock read it.
 *
 * @param numFlying - launched pilots, i.e. the count BEFORE early-start
 *   reshaping (a neutralised pilot still flew).
 */
function gatherFieldStats(
  scoringTask: XCTask,
  effFlights: readonly FlightScoringData[],
  numFlying: number,
  numPresent: number,
  params: GAPParameters,
): {
  stats: TaskStats;
  scoredDistances: number[];
  difficulty: DistanceDifficulty | null;
  essNotGoalFactor: number;
} {
  // Apply minimum distance floor and clamp negative distances
  const scoredDistances = effFlights.map(f =>
    applyMinimumDistance(f.flownDistance, params.minimumDistance)
  );
  const bestDistance = scoredDistances.length > 0 ? maxBy(scoredDistances, d => d) : 0;

  // HG distance difficulty (FAI S7F §12.1.1) — built once from the whole
  // field. Never applies to paragliding (the spec excludes PG).
  const useDifficulty = usesDistanceDifficulty(params);
  const difficulty = useDifficulty
    ? calculateDistanceDifficulty(
        scoredDistances,
        effFlights.map(f => f.madeGoal),
        params.minimumDistance,
      )
    : null;

  const numInGoal = effFlights.reduce((n, f) => n + (f.madeGoal ? 1 : 0), 0);
  const numReachedESS = effFlights.reduce((n, f) => n + (f.reachedESS ? 1 : 0), 0);

  // §13.2: the ESS-but-not-goal factor in force for this field.
  const essNotGoalFactor = effectiveEssNotGoalFactor(params);

  // Best time (§9.4.1) — the denominator of every speed fraction.
  const bestTime = bestTimeFrom(effFlights, params.scoring);

  const taskDistance = calculateOptimizedTaskDistance(scoringTask);

  const goalRatio = numFlying > 0 ? numInGoal / numFlying : 0;

  const stats: TaskStats = {
    numPresent,
    numFlying,
    numInGoal,
    numReachedESS,
    bestDistance,
    bestTime,
    goalRatio,
    taskDistance,
  };
  return { stats, scoredDistances, difficulty, essNotGoalFactor };
}

/**
 * Step 5: Calculate leading coefficients (skip when disabled — expensive
 * tracklog scan).
 *
 * Infinity = "no valid LC in the field" (calculateLeadingPoints then awards
 * no leading points to anyone), so `minLC` comes back Infinity too.
 *
 * Two passes over the field, because §12.3.1's `maxTime` — where a landed-out
 * pilot's graph ends — is itself a field-level number: it needs every pilot's
 * outlanding time before ANY pilot's coefficient can be folded together.
 */
function computeLeadingCoefficients(
  scoringTask: XCTask,
  effFlights: readonly FlightScoringData[],
  outcomes: ReadonlyArray<PilotScoreCore['earlyStartOutcome']>,
  params: GAPParameters,
  stop?: { stopTimeMs: number },
): { coefficients: number[]; minLC: number; times?: LeadingTimes } {
  if (!params.useLeading) {
    return { coefficients: effFlights.map(() => Infinity), minLC: Infinity };
  }

  const allSSSTimes = effFlights
    .map(f => f.sssTimeMs)
    .filter((t): t is number => t !== null);
  const allESSTimes = effFlights
    .map(f => f.essTimeMs)
    .filter((t): t is number => t !== null);

  let taskFirstSSSTime = allSSSTimes.length > 0 ? minBy(allSSSTimes, t => t) : 0;
  // §12.3.1: in a gated race the leading-coefficient time axis starts at
  // the first start gate, not at the field's first actual crossing. Any
  // pilot's crossing works as the day reference for the gate times.
  if (allSSSTimes.length > 0) {
    const gates = resolveStartGates(scoringTask, taskFirstSSSTime);
    if (gates) taskFirstSSSTime = gates[0];
  }

  // Pass 1: the per-pilot aggregates. null = this pilot earns no leading
  // points at all, so they neither take a coefficient nor lend an outlanding
  // time to the field.
  const aggregates = effFlights.map((f, idx) => {
    // Early starters scored only for distance (§13.3) earn no leading
    // points — their cached aggregate must not resurrect a coefficient.
    if (isNeutralisingOutcome(outcomes[idx])) return null;
    // A flight with nothing to lead with earns no leading points: a
    // track-less pilot (manual flight, issue #306) has no tracklog to scan.
    const lead = f.leading;
    if (lead.kind === 'none') return null;
    // Prefer a precomputed aggregate (backend cache); otherwise scan the
    // tracklog now. Either way the field scalars fold in the same way.
    return lead.kind === 'aggregate'
      ? lead.aggregate
      : computeLeadingAggregate(
          lead.fixes, scoringTask, lead.sequence,
          f.sssTimeMs, f.essTimeMs, leadingFormulaFor(params.scoring),
        );
  });

  // The field times. A started pilot who never reached ESS landed out, and
  // their tracklog's last fix is when: that is the `lastOutlandingTime` the
  // spec takes the latest of.
  let lastOutlandingMs: number | null = null;
  for (const agg of aggregates) {
    if (!agg || !agg.valid || agg.reachedESS) continue;
    if (lastOutlandingMs === null || agg.lastFixMs > lastOutlandingMs) {
      lastOutlandingMs = agg.lastFixMs;
    }
  }
  // The goal deadline (§9.2), resolved against the leading clock's origin
  // rather than against any one flight — this is a property of the task, and
  // the field shares one of it. A deadline at or before the first start is
  // the same task-setting mistake resolveTimingWindow ignores.
  let deadlineMs = allSSSTimes.length > 0
    ? resolveTaskDeadline(scoringTask, taskFirstSSSTime)
    : null;
  if (deadlineMs !== null && deadlineMs <= taskFirstSSSTime) deadlineMs = null;

  const fieldTimes: LeadingFieldTimes = {
    firstStartMs: taskFirstSSSTime,
    lastESSMs: allESSTimes.length > 0 ? maxBy(allESSTimes, t => t) : null,
    lastOutlandingMs,
    deadlineMs,
    stopTimeMs: stop ? stop.stopTimeMs : null,
  };
  const maxTime = resolveLeadingMaxTime(fieldTimes);

  // Pass 2: fold the field times in.
  const coefficients = aggregates.map(agg =>
    agg === null
      ? Infinity
      : combineLeadingCoefficient(
          agg, taskFirstSSSTime, maxTime.timeMs, leadingFormulaFor(params.scoring),
        ),
  );

  const finiteLCs = coefficients.filter(lc => isFinite(lc));
  const minLC = finiteLCs.length > 0 ? minBy(finiteLCs, lc => lc) : Infinity;
  return {
    coefficients,
    minLC,
    // With nobody started there is no clock — firstStartMs would be the
    // epoch. Publishing that would put a 1970 timestamp on a page whose whole
    // job is to be checkable.
    ...(allSSSTimes.length > 0
      ? {
          times: {
            ...fieldTimes,
            maxTimeMs: maxTime.timeMs,
            maxTimeSource: maxTime.source,
          },
        }
      : {}),
  };
}

/**
 * Step 6: Determine ESS arrival order for HG arrival points (skip when not
 * needed) — flight index → 1-based arrival position, the sole per-pilot input
 * to the §13.5 formula. A pilot who never reached ESS is absent from the map.
 */
function essArrivalOrder(
  effFlights: readonly FlightScoringData[],
  params: GAPParameters,
): Map<number, number> {
  const essPositionMap = new Map<number, number>();
  if (params.scoring === 'HG' && params.useArrival) {
    effFlights
      .map((f, idx) => ({ idx, time: f.essTimeMs }))
      .filter((entry): entry is { idx: number; time: number } => entry.time !== null)
      .sort((a, b) => a.time - b.time)
      .forEach(({ idx }, position) => {
        essPositionMap.set(idx, position + 1);
      });
  }
  return essPositionMap;
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
 * @param stop - Present when the task was stopped (FAI S7F §13.4): the
 *   resolved task stop time (see {@link resolveTaskStop}). The flights must
 *   already be stop-aware — resolved with the stop's scored windows (their
 *   flownDistance clipped/bonused, landedBeforeStop set); this function adds
 *   the whole-field pieces: the §13.4.2 minimum-run requirement, the
 *   §13.4.3 stopped validity, and the §13.4.5 goal time-points reduction.
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

  // Step 1: Early starts (FAI S7F §13.3) — see applyEarlyStarts.
  const { outcomes: earlyOutcomes, effFlights } = applyEarlyStarts(
    scoringTask, flights, fullParams,
  );

  // Step 2: Gather aggregate statistics
  const { stats, scoredDistances, difficulty, essNotGoalFactor } = gatherFieldStats(
    scoringTask, effFlights, flights.length, actualNumPresent, fullParams,
  );
  const { bestDistance, bestTime, numInGoal, numReachedESS, goalRatio, taskDistance } = stats;

  // §13.4 stopped task — see resolveStoppedTaskScore (gap-stopped.ts). The
  // §13.4.5 time-points reduction is resolved below, once the available
  // points it needs exist, and the published StoppedTaskScore is assembled
  // with both in hand.
  const stoppedCore = stop
    ? resolveStoppedTaskScore(scoringTask, effFlights, numReachedESS, fullParams, stop)
    : undefined;

  // Step 3: Calculate task validity
  const taskValidity = calculateTaskValidity(
    fullParams, scoredDistances, bestDistance, bestTime, actualNumPresent,
    stoppedCore?.stoppedValidity,
  );

  // Step 4: Calculate weights and available points
  const weights = calculateWeights({
    goalRatio,
    scoring: fullParams.scoring,
    useLeading: fullParams.useLeading,
    useArrival: fullParams.useArrival,
    leadingTimeRatio: resolveLeadingTimeRatio(fullParams),
    // S7F 2026 §11, HG: nobody at ESS ⇒ no time or arrival points available.
    numReachedESS,
  });
  const totalAvailable = 1000 * taskValidity.task;
  const baseDistancePoints = totalAvailable * weights.distance;
  const baseTimePoints = totalAvailable * weights.time;

  // §13.4.5 (2026): the stopped-task time/distance points scheme — see
  // resolveStopTimePointsReduction (gap-stopped.ts). The reduction is
  // measured against the PRE-reduction time pool; every goal pilot's time
  // points are cut by it (step 7) and the same amount is added to the day's
  // distance points. With nobody in goal at the stop the task offers no
  // time points at all, and nothing is moved to distance.
  const stopTimeReduction = stoppedCore
    ? resolveStopTimePointsReduction(
        effFlights, stoppedCore, numInGoal, bestTime, baseTimePoints,
      )
    : 0;
  const availablePoints: AvailablePoints = {
    distance: stopTimeReduction > 0
      ? baseDistancePoints + stopTimeReduction
      : baseDistancePoints,
    time: stoppedCore?.requirementMet && numInGoal === 0 ? 0 : baseTimePoints,
    leading: totalAvailable * weights.leading,
    arrival: totalAvailable * weights.arrival,
    total: totalAvailable,
  };
  // Field order matches the old in-place construction, so cached JSON
  // payloads stay byte-identical.
  const stopped: StoppedTaskScore | undefined = stoppedCore
    ? {
        stopTimeMs: stoppedCore.stopTimeMs,
        scoredWindowSeconds: stoppedCore.scoredWindowSeconds,
        minimumRunSeconds: stoppedCore.minimumRunSeconds,
        requirementMet: stoppedCore.requirementMet,
        stoppedValidity: stoppedCore.stoppedValidity,
        timePointsReduction: stopTimeReduction > 0
          ? roundToTenth(stopTimeReduction)
          : 0,
        numLandedBeforeStop: stoppedCore.numLandedBeforeStop,
      }
    : undefined;

  // Step 5: Calculate leading coefficients — see computeLeadingCoefficients.
  const {
    coefficients: leadingCoefficients,
    minLC,
    times: leadingTimes,
  } = computeLeadingCoefficients(
    scoringTask, effFlights, earlyOutcomes, fullParams,
    stopped ? { stopTimeMs: stopped.stopTimeMs } : undefined,
  );

  // Step 6: Determine ESS arrival order — see essArrivalOrder.
  const essPositionMap = essArrivalOrder(effFlights, fullParams);

  // §13.3 floor for the jump-the-gun penalty: the score a pilot would get
  // for exactly the minimum distance (distance points only) — the penalty
  // never drops a pilot below it, unlike the generic §13.5 zero floor.
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
      essNotGoalFactor,
    });
    // §13.4.5 stopped-task reduction — goal pilots only (a goal pilot's own
    // speed time never exceeds the scored window, so this stays ≥ 0; the
    // clamp guards degenerate inputs).
    if (stopTimeReduction > 0 && f.madeGoal) {
      timePts = Math.max(0, timePts - stopTimeReduction);
    }

    const leadPts = calculateLeadingPoints(
      leadingCoefficients[idx], minLC, availablePoints.leading,
    );

    // Arrival order still counts every ESS pilot; §13.2 then docks an
    // ESS-but-not-goal pilot's arrival points by the same factor as time.
    const position = essPositionMap.get(idx) ?? 0;
    const arrPtsFull = position > 0
      ? calculateArrivalPoints(position, numReachedESS, availablePoints.arrival)
      : 0;
    const arrPts = f.madeGoal ? arrPtsFull : arrPtsFull * essNotGoalFactor;

    // Jump the gun (§13.3, HG within the limit): 1 point per
    // jumpTheGunFactor seconds early, floored at the minimum-distance score.
    const outcome = earlyOutcomes[idx];
    const jtgPenalty = outcome === 'hg_penalty' && f.earlyStartSeconds
      ? f.earlyStartSeconds / fullParams.jumpTheGunFactor
      : 0;
    // FAI S7F §12: the total is the component sum rounded to one decimal
    // place; §13.5: rounding is done after penalties, so the jump-the-gun
    // penalty (§12.2) is subtracted before rounding (floored at the
    // minimum-distance score, not zero). The scorekeeper's absolute penalty
    // (§13.5) is applied later in the backend, which re-rounds after it.
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
      distancePoints: roundToTenth(distPts),
      distanceLinearPoints: roundToTenth(distScore.linear),
      distanceDifficultyPoints: roundToTenth(distScore.difficulty),
      timePoints: roundToTenth(timePts),
      leadingPoints: roundToTenth(leadPts),
      arrivalPoints: roundToTenth(arrPts),
      totalScore: total,
      rank: 0, // assigned after sorting
      leadingCoefficient: leadingCoefficients[idx],
      // Transparency for the §13.5 arithmetic: the position the arrival
      // points were computed from, and the ESS time it was ordered by.
      ...(position > 0 ? { arrivalPosition: position } : {}),
      essTimeMs: f.essTimeMs,
      ...(f.earlyStartSeconds && f.earlyStartSeconds > 0
        ? { earlyStartSeconds: f.earlyStartSeconds }
        : {}),
      ...(outcome ? { earlyStartOutcome: outcome } : {}),
      ...(jtgPenalty > 0
        ? { jumpTheGunPenalty: roundToTenth(jtgPenalty) }
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
  assignRanks(pilotScores, p => p.totalScore);

  return {
    parameters: fullParams,
    taskValidity,
    weights,
    availablePoints,
    pilotScores,
    stats,
    ...(stopped ? { stopped } : {}),
    ...(leadingTimes ? { leadingTimes } : {}),
  };
}

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
 * @param options - {@link ScoreTaskOptions} (the §13.4 stop announcement)
 * @returns Complete scored results with transparency data
 */
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

  // Stopped task (§13.4): derive the task stop time from the announcement
  // and build the per-flight stop context (glide ratio + goal altitude for
  // the §13.4.6 bonus). The first pass clips every pilot at the stop time.
  const stopCtx = options.stopAnnouncementMs != null
    ? resolveTaskStop(options.stopAnnouncementMs, fullParams.scoring)
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

  // §13.4.4, multi-gate / elapsed-time stopped tasks: every pilot is scored
  // for the duration the LAST-started pilot had. The per-pilot window ends
  // come from the first pass's official starts (already clipped at the stop
  // time); pilots whose window is the stop time keep their first pass.
  if (stopBase) {
    const starts = results.map(officialStartFromSequence);
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

  // fullParams is the same `{ ...DEFAULT_GAP_PARAMETERS, ...params }` merge
  // scoreFlights performs on whatever it is handed, so passing the resolved
  // set changes nothing — it just avoids a second, silently-parallel merge.
  const core = scoreFlights(
    scoringTask, flights, fullParams, numPresent,
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
