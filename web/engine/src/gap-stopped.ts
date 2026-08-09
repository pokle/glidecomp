/**
 * Stopped-task scoring support (FAI S7F 2026 §13.4).
 *
 * When a task is stopped mid-flight (weather calldown), the recorded stop
 * announcement time is "scored back" to an earlier task stop time (§13.4.1),
 * every pilot is scored only for a common time window (§13.4.4), landed-out
 * distance earns an altitude bonus (§13.4.6), and a fourth validity factor
 * applies (§13.4.3). This module holds the field-independent pieces: stop-time
 * resolution, the scored-window arithmetic, the §13.4.2 minimum-run rule, and
 * the altitude-bonus constants. The stopped-task validity formula lives with
 * the other validity formulas in ./gap-formulas; the whole-field integration
 * (validity multiplier, §13.4.5 time-points reduction) in ./gap-scoring.
 */

import type { XCTask } from './xctsk-parser';
import { getGoalIndex } from './xctsk-parser';
import { resolveStartGates } from './time-gates';

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
 * excluded from the competition ranking (§15, task validity < 0.05).
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

/**
 * §13.4.4 per-pilot scored-window ends for a stopped task.
 *
 * - Race with a single start gate: every pilot shares the window
 *   [start gate, stop time] — returns null (the caller keeps the stop time
 *   as the common window end).
 * - Multiple start gates or Time Trial: every pilot is scored for the
 *   duration the LAST-started pilot had — their own start plus
 *   `stopTime − lastStart`. Pilots who never started keep the stop time.
 *
 * Returns null when the common window applies (single gate, or nobody
 * started); otherwise an array parallel to `startTimesMs` with each pilot's
 * window end (epoch ms).
 *
 * The starts should be the pilots' OFFICIAL start times (gate-snapped in a
 * gated race, actual crossing in a Time Trial), from a first scoring pass
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
