/**
 * Stopped-task scoring support (FAI S7F §12.3).
 *
 * When a task is stopped mid-flight (weather calldown), the recorded stop
 * announcement time is "scored back" to an earlier task stop time (§12.3.1),
 * every pilot is scored only for a common time window (§12.3.4), landed-out
 * distance earns an altitude bonus (§12.3.6), and a fourth validity factor
 * applies (§12.3.3). This module holds the field-independent pieces: stop-time
 * resolution, the scored-window arithmetic, the §12.3.2 minimum-run rule, and
 * the altitude-bonus constants. The stopped-task validity formula lives with
 * the other validity formulas in ./gap-formulas; the whole-field integration
 * (validity multiplier, §12.3.5 time-points reduction) in ./gap-scoring.
 */

import type { XCTask } from './xctsk-parser';
import { getGoalIndex } from './xctsk-parser';
import { resolveStartGates } from './time-gates';
import type { GAPParameters } from './gap-params';

/**
 * §12.3.6 altitude-bonus glide ratios: a pilot still flying at the task stop
 * is credited the distance their height above goal would glide out to.
 */
export const STOPPED_GLIDE_RATIO_HG = 5.0;
export const STOPPED_GLIDE_RATIO_PG = 4.0;

/** The §12.3.6 altitude-bonus glide ratio for a sport. */
export function stoppedGlideRatio(scoring: 'PG' | 'HG'): number {
  return scoring === 'PG' ? STOPPED_GLIDE_RATIO_PG : STOPPED_GLIDE_RATIO_HG;
}

/**
 * §12.3.1 fallback score-back for a hang-gliding race with a single start
 * gate (or no usable gates): 15 minutes.
 */
export const HG_SINGLE_GATE_SCORE_BACK_SECONDS = 15 * 60;

/** How the task stop time was derived from the announcement (§12.3.1). */
export type ScoreBackKind =
  /** PG: the competition's score-back time (§5.6). */
  | 'pg_score_back'
  /** HG, multiple start gates: one start-gate interval. */
  | 'hg_gate_interval'
  /** HG, single gate (or no usable gates): the fixed 15 minutes. */
  | 'hg_single_gate';

/** The resolved task stop for a stopped task (§12.3.1). */
export interface TaskStopContext {
  /** The recorded task stop announcement time (epoch ms). */
  announcementMs: number;
  /** The scored-back task stop time (epoch ms) the field is scored against. */
  stopTimeMs: number;
  /** Seconds scored back from the announcement. */
  scoreBackSeconds: number;
  /** How the score-back was derived. */
  scoreBackKind: ScoreBackKind;
}

/**
 * Resolve the task stop time from the stop announcement time (§12.3.1):
 *
 * - PG: `stopTime = announcement − competitionScoreBackTime` (§5.6, the
 *   {@link GAPParameters.scoreBackTime} parameter).
 * - HG: one start-gate interval before the announcement, or 15 minutes for
 *   a single start gate (also used when the task has no usable gates —
 *   elapsed-time tasks and gateless races have no interval to take).
 *
 * @param task - The task (its start gates drive the HG interval)
 * @param announcementMs - The recorded stop announcement time (epoch ms),
 *   also the day reference for resolving the gate times-of-day
 * @param params - The competition's GAP parameters
 */
export function resolveTaskStop(
  task: XCTask,
  announcementMs: number,
  params: GAPParameters,
): TaskStopContext {
  let scoreBackSeconds: number;
  let scoreBackKind: ScoreBackKind;
  if (params.scoring === 'PG') {
    scoreBackSeconds = Math.max(0, params.scoreBackTime);
    scoreBackKind = 'pg_score_back';
  } else {
    const gates = resolveStartGates(task, announcementMs);
    if (gates && gates.length >= 2) {
      scoreBackSeconds = (gates[1] - gates[0]) / 1000;
      scoreBackKind = 'hg_gate_interval';
    } else {
      scoreBackSeconds = HG_SINGLE_GATE_SCORE_BACK_SECONDS;
      scoreBackKind = 'hg_single_gate';
    }
  }
  return {
    announcementMs,
    stopTimeMs: announcementMs - scoreBackSeconds * 1000,
    scoreBackSeconds,
    scoreBackKind,
  };
}

/**
 * §12.3.2 minimum run: for a stopped task to be scored, the scored time
 * window must have lasted at least `min(1 hour, nominalTime / 2)`.
 */
export function stoppedMinimumRunSeconds(nominalTimeSeconds: number): number {
  return Math.min(3600, nominalTimeSeconds / 2);
}

/**
 * The goal altitude (m, GNSS) the §12.3.6 altitude bonus is measured above —
 * the goal turnpoint's waypoint altitude, or 0 when the task doesn't carry
 * one (the bonus then overstates by the goal's true elevation; better than
 * no bonus, and honest task files always carry `altSmoothed`).
 */
export function resolveGoalAltitude(task: XCTask): number {
  const goalIdx = getGoalIndex(task);
  if (goalIdx < 0) return 0;
  return task.turnpoints[goalIdx].waypoint.altSmoothed ?? 0;
}

/**
 * §12.3.4 per-pilot scored-window ends for a stopped task.
 *
 * - Race to goal with a single start gate: every pilot shares the window
 *   [start gate, stop time] — returns null (the caller keeps the stop time
 *   as the common window end).
 * - Multiple start gates or elapsed time: every pilot is scored for the
 *   duration the LAST-started pilot had — their own start plus
 *   `stopTime − lastStart`. Pilots who never started keep the stop time.
 *
 * Returns null when the common window applies (single gate, or nobody
 * started); otherwise an array parallel to `startTimesMs` with each pilot's
 * window end (epoch ms).
 *
 * The starts should be the pilots' OFFICIAL start times (gate-snapped in a
 * gated race, actual crossing for elapsed time), from a first scoring pass
 * clipped at the stop time — so a start after the stop can never appear.
 *
 * @param task - The task (gate count decides the single-gate shortcut)
 * @param startTimesMs - Per pilot: official start time, or null if never started
 * @param stopTimeMs - The resolved task stop time ({@link resolveTaskStop})
 */
export function resolveScoredWindowEnds(
  task: XCTask,
  startTimesMs: Array<number | null>,
  stopTimeMs: number,
): number[] | null {
  const started = startTimesMs.filter((t): t is number => t !== null);
  if (started.length === 0) return null;
  const gates = resolveStartGates(task, started[0]);
  if (gates && gates.length === 1) return null; // common window: start → stop
  let lastStart = started[0];
  for (const t of started) if (t > lastStart) lastStart = t;
  const windowMs = Math.max(0, stopTimeMs - lastStart);
  return startTimesMs.map(t => (t === null ? stopTimeMs : t + windowMs));
}
