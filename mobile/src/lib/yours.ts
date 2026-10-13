/**
 * The reader's own place in a competition: their row in the series scores,
 * and their flight on a task. Pure, for the comp view's "You" group and the
 * task view's "Your track" (IA §6, §7).
 */
import type { PilotFlight } from '@glidecomp/client/account';
import { formatTaskDate, todayInZone } from '@glidecomp/client/format';
import { hhmmInZone } from '@glidecomp/client/time';
import type { CompPilotScore } from '@glidecomp/client/scores-views';
import type { CompScores } from '@glidecomp/client/types';

export interface SeriesPlace {
  pilot: CompPilotScore;
  pilotClass: string;
  fieldSize: number;
}

/** A pilot's series row and the size of their class, or null if unscored. */
export function findSeriesPilot(scores: CompScores, compPilotId: string): SeriesPlace | null {
  for (const cls of scores.class_scores) {
    const pilot = cls.pilots.find((p) => p.comp_pilot_id === compPilotId);
    if (pilot) return { pilot, pilotClass: cls.pilot_class, fieldSize: cls.pilots.length };
  }
  return null;
}

/** The reader's flight on this task, if they have one. */
export function flightOnTask(flights: readonly PilotFlight[] | undefined, taskId: string): PilotFlight | null {
  return flights?.find((f) => f.task_id === taskId) ?? null;
}

/**
 * When a track was handed in, in the comp's zone: "14:52" on the task's own
 * day (the usual case), "9 Jan, 14:52" on any other.
 */
export function submittedWhen(recordedAt: string, taskDate: string, timeZone: string | null): string {
  const at = new Date(recordedAt);
  if (Number.isNaN(at.getTime())) return '';
  const zone = timeZone ?? undefined;
  let day: string;
  try {
    day = todayInZone(timeZone, at);
  } catch {
    day = todayInZone(null, at);
  }
  const time = hhmmInZone(at, zone);
  return day === taskDate ? time : `${formatTaskDate(day, { day: 'numeric', month: 'short' })}, ${time}`;
}
