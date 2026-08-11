/**
 * Stopped-task scoring support (FAI S7F 2026 §13.4).
 *
 * When a task is stopped mid-flight (weather calldown), the recorded stop
 * announcement time is "scored back" to an earlier task stop time (§13.4.1),
 * every pilot is scored only for a common time window (§13.4.4), landed-out
 * distance earns an altitude bonus (§13.4.6), and a fourth validity factor
 * applies (§13.4.3). This module holds every stopped-task piece short of the
 * final integration: stop-time resolution, the one §13.4.4 scored-window
 * derivation ({@link resolveScoredWindow}), the §13.4.2 minimum-run rule, the
 * altitude-bonus constants, the whole-field stopped outcome
 * ({@link resolveStoppedTaskScore}) and the §13.4.5 time-points reduction
 * ({@link resolveStopTimePointsReduction}). The stopped-task validity formula
 * lives with the other validity formulas in ./gap-formulas; ./gap-scoring
 * multiplies the validity in and applies the reduction to the field.
 */

import type { XCTask } from './xctsk-parser';
import { getGoalIndex, getEffectiveESSIndex } from './xctsk-parser';
import { getOptimizedSegmentDistances } from './task-optimizer';
import { resolveStartGates } from './time-gates';
import { maxBy } from './array-utils';
import { calculateStoppedTaskValidity, calculateTimePoints } from './gap-formulas';
import type { GAPParameters } from './gap-params';
import { officialStartTimeMs } from './gap-types';
import type { FlightScoringData, StoppedTaskScore } from './gap-types';

/**
 * §13.4.6 altitude-bonus glide ratios: a pilot still flying at the task stop
 * is credited the distance their height above goal would glide out to. The
 * PG ratio is 2.5 since the 2025 edition (was 4.0), confirmed at 2.5 for
 * 2026 by CIVL Bureau decision for consistency with PWCA rules.
 */
export const STOPPED_GLIDE_RATIO_HG = 5.0;
export const STOPPED_GLIDE_RATIO_PG = 2.5;

/** The §13.4.6 altitude-bonus glide ratio for a sport. */
export function stoppedGlideRatio(scoring: 'PG' | 'HG'): number {
  return scoring === 'PG' ? STOPPED_GLIDE_RATIO_PG : STOPPED_GLIDE_RATIO_HG;
}

/**
 * §13.4.1 score-back times — fixed values in the 2026 edition (the PG
 * competition parameter and the HG gate-interval rule are both gone).
 */
export const SCORE_BACK_SECONDS_HG = 15 * 60;
export const SCORE_BACK_SECONDS_PG = 5 * 60;

/** The §13.4.1 score-back time for a sport. */
export function scoreBackSecondsFor(scoring: 'PG' | 'HG'): number {
  return scoring === 'PG' ? SCORE_BACK_SECONDS_PG : SCORE_BACK_SECONDS_HG;
}

/** The resolved task stop for a stopped task (§13.4.1). */
export interface TaskStopContext {
  /** The recorded task stop announcement time (epoch ms). */
  announcementMs: number;
  /** The scored-back task stop time (epoch ms) the field is scored against. */
  stopTimeMs: number;
  /** Seconds scored back from the announcement. */
  scoreBackSeconds: number;
}

/**
 * Resolve the task stop time from the stop announcement time (§13.4.1):
 * `taskStopTime = taskStopAnnouncementTime − scoreBackTime`, with the fixed
 * score-back of 15 minutes for hang gliding and 5 minutes for paragliding.
 *
 * @param announcementMs - The recorded stop announcement time (epoch ms)
 * @param scoring - The discipline (drives the fixed score-back)
 */
export function resolveTaskStop(
  announcementMs: number,
  scoring: 'PG' | 'HG',
): TaskStopContext {
  const scoreBackSeconds = scoreBackSecondsFor(scoring);
  return {
    announcementMs,
    stopTimeMs: announcementMs - scoreBackSeconds * 1000,
    scoreBackSeconds,
  };
}

/**
 * §13.4.2 minimum duration: a stopped hang-gliding task is scored only when
 * the scored time window lasted at least `min(1 hour, nominalTime / 2)`.
 * Paragliding has no minimum — instead, low-validity stopped PG tasks are
 * excluded from the competition ranking (§16, task validity < 0.05).
 */
export function stoppedMinimumRunSeconds(
  nominalTimeSeconds: number,
  scoring: 'PG' | 'HG',
): number {
  if (scoring === 'PG') return 0;
  return Math.min(3600, nominalTimeSeconds / 2);
}

/**
 * The goal altitude (m, GNSS) the §13.4.6 altitude bonus is measured above —
 * the goal turnpoint's waypoint altitude, or 0 when the task doesn't carry
 * one (the bonus then overstates by the goal's true elevation; better than
 * no bonus, and honest task files always carry `altSmoothed`).
 */
export function resolveGoalAltitude(task: XCTask): number {
  const goalIdx = getGoalIndex(task);
  if (goalIdx < 0) return 0;
  return task.turnpoints[goalIdx].waypoint.altSmoothed ?? 0;
}

/** The §13.4.4 scored window as {@link resolveScoredWindow} derived it. */
export interface ScoredWindow {
  /**
   * When the scored window starts: the race start for a single-start-gate
   * race, otherwise the LAST pilot's official start. Null when nobody
   * started (and no single gate pins the start regardless).
   */
  windowStartMs: number | null;
  /**
   * Per-pilot window ends (epoch ms), parallel to the starts passed in.
   * Null when the common window applies — single start gate, or nobody
   * started — and every pilot keeps the stop time as their window end.
   */
  windowEndsMs: number[] | null;
}

/**
 * The single §13.4.4 scored-window derivation for a stopped task.
 *
 * - Race with a single start gate: every pilot shares the window
 *   [start gate, stop time] — the window start is the gate, and the ends
 *   come back null (the caller keeps the stop time as the common end).
 * - Multiple start gates or Time Trial: every pilot is scored for the
 *   duration the LAST-started pilot had — the window start is that last
 *   start, and each pilot's end is their own start plus
 *   `stopTime − lastStart`. Pilots who never started keep the stop time.
 *
 * The starts should be the pilots' OFFICIAL start times (gate-snapped in a
 * gated race, actual crossing in a Time Trial — see officialStartTimeMs in
 * ./gap-types), from a first scoring pass clipped at the stop time — so a
 * start after the stop can never appear.
 *
 * @param task - The task (gate count decides the single-gate shortcut)
 * @param startTimesMs - Per pilot: official start time, or null if never started
 * @param stopTimeMs - The resolved task stop time ({@link resolveTaskStop})
 */
export function resolveScoredWindow(
  task: XCTask,
  startTimesMs: ReadonlyArray<number | null>,
  stopTimeMs: number,
): ScoredWindow {
  const started = startTimesMs.filter((t): t is number => t !== null);
  // Any pilot's start anchors the gates on the right day; with nobody
  // started the stop time itself is the day reference.
  const gates = resolveStartGates(
    task, started.length > 0 ? started[0] : stopTimeMs,
  );
  if (gates && gates.length === 1) {
    // Common window: start gate → stop, for every pilot.
    return { windowStartMs: gates[0], windowEndsMs: null };
  }
  if (started.length === 0) return { windowStartMs: null, windowEndsMs: null };
  const lastStart = maxBy(started, t => t);
  const windowMs = Math.max(0, stopTimeMs - lastStart);
  return {
    windowStartMs: lastStart,
    windowEndsMs: startTimesMs.map(t => (t === null ? stopTimeMs : t + windowMs)),
  };
}

/**
 * §13.4.4 per-pilot scored-window ends for a stopped task — the
 * {@link resolveScoredWindow} ends alone, for callers (like the competition
 * backend) that re-resolve pilots against their individual windows.
 *
 * Returns null when the common window applies (single gate, or nobody
 * started); otherwise an array parallel to `startTimesMs` with each pilot's
 * window end (epoch ms).
 */
export function resolveScoredWindowEnds(
  task: XCTask,
  startTimesMs: Array<number | null>,
  stopTimeMs: number,
): number[] | null {
  return resolveScoredWindow(task, startTimesMs, stopTimeMs).windowEndsMs;
}

/**
 * §13.4 stopped task: the scored-window duration (§13.4.4), the
 * minimum-run requirement (§13.4.2), and the stopped validity (§13.4.3).
 *
 * Returns everything but the §13.4.5 `timePointsReduction` — that needs the
 * day's available time points, which in turn need the stopped validity
 * returned here, so scoreFlights computes it afterwards (see
 * {@link resolveStopTimePointsReduction}) and assembles the final
 * StoppedTaskScore once, with both in hand.
 */
export function resolveStoppedTaskScore(
  scoringTask: XCTask,
  effFlights: readonly FlightScoringData[],
  numReachedESS: number,
  params: GAPParameters,
  stop: { stopTimeMs: number },
): Omit<StoppedTaskScore, 'timePointsReduction'> {
  // Scored-window start (§13.4.4): the race start for a single-start-gate
  // race, otherwise (multi-gate / elapsed time) the LAST pilot's official
  // start.
  const { windowStartMs } = resolveScoredWindow(
    scoringTask,
    effFlights.map(f => officialStartTimeMs(f)),
    stop.stopTimeMs,
  );
  const scoredWindowSeconds = windowStartMs !== null
    ? Math.max(0, (stop.stopTimeMs - windowStartMs) / 1000)
    : null;
  const minimumRunSeconds = stoppedMinimumRunSeconds(
    params.nominalTime, params.scoring,
  );
  const requirementMet = scoredWindowSeconds !== null
    && scoredWindowSeconds >= minimumRunSeconds;

  // §13.4.3 inputs: raw flown distances (bonus included), pilots landed
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
  // (§13.4.2): stopped validity 0 zeroes every pilot while keeping the
  // other validity factors honest for the explanation.
  const stoppedValidity = requirementMet ? formulaValidity : 0;
  return {
    stopTimeMs: stop.stopTimeMs,
    scoredWindowSeconds,
    minimumRunSeconds,
    requirementMet,
    stoppedValidity,
    numLandedBeforeStop,
  };
}

/**
 * §13.4.5 (2026): the stopped-task time-points reduction, UNROUNDED.
 *
 *  1. Nobody in goal at the stop → the task offers no time points at all,
 *     and nothing is moved to distance — the reduction is 0 (the caller
 *     zeroes the available time points).
 *  2. Somebody in goal:
 *     a. pilots between ESS and goal at the stop exist → the reduction is
 *        the time points the best of THEM would have received had they
 *        completed the flight to goal (standard §12.2 arithmetic on their
 *        own speed-section time — max over the set covers both the
 *        single-gate "earliest ESS crossing" and the multi-gate/Time
 *        Trial "smallest start→ESS time" reference-pilot definitions);
 *     b. none exist → the reduction is the time points of a hypothetical
 *        pilot reaching ESS exactly at the end of the scored window.
 *     Every goal pilot's time points are reduced by it, and the same
 *     amount is ADDED to the available distance points for the task.
 *
 * Pure: the caller applies the reduction to the field (and rounds the
 * published copy). `availableTimePoints` must be the PRE-reduction time
 * pool the §12.2 arithmetic runs against.
 */
export function resolveStopTimePointsReduction(
  effFlights: readonly FlightScoringData[],
  stopped: Pick<StoppedTaskScore, 'requirementMet' | 'scoredWindowSeconds'>,
  numInGoal: number,
  bestTime: number | null,
  availableTimePoints: number,
): number {
  if (!stopped.requirementMet || numInGoal === 0 || bestTime === null) return 0;
  const betweenTimes = effFlights
    .filter(f => f.reachedESS && !f.madeGoal)
    .map(f => f.speedSectionTime)
    .filter((t): t is number => t !== null && t > 0);
  const wouldBeTimePoints = (pilotTime: number) =>
    calculateTimePoints({
      pilotTime,
      bestTime,
      madeGoal: true,
      reachedESS: true,
      availableTimePoints,
    });
  if (betweenTimes.length > 0) {
    return maxBy(betweenTimes.map(wouldBeTimePoints), x => x);
  }
  if (stopped.scoredWindowSeconds !== null) {
    return wouldBeTimePoints(stopped.scoredWindowSeconds);
  }
  return 0;
}
