/**
 * Shared helpers for the score-explanation section builders.
 *
 * The task-position vocabulary every narrative uses — the label for a
 * turnpoint, its waypoint name, and the map anchor for a reaching — plus the
 * two published-payload adapters more than one section needs: the best-time
 * candidate the scorer's own `bestTimeFrom` reads, and the leading-weight
 * sentence the validity section prints.
 */

import type { XCTask, Turnpoint } from '../xctsk-parser';
import { getGoalIndex } from '../xctsk-parser';
import type { TurnpointReaching } from '../turnpoint-sequence';
import type { BestTimeCandidate, GAPParameters } from '../gap-scoring';
import { resolveLeadingTimeRatio } from '../gap-scoring';
import type {
  ClassContextInput,
  ClassPilotInput,
  ExplanationAnchor,
  ExplanationAnchorKind,
} from '../score-explanation-types';

/**
 * Read a published class pilot as a {@link BestTimeCandidate}, so the report
 * card's best time (FAI S7F §9.4.1) comes from {@link bestTimeFrom} — the
 * scorer's own function — rather than a hand-copied filter. Only the field
 * names differ between the scored shape and the published one.
 */
export function bestTimeCandidate(pilot: ClassPilotInput): BestTimeCandidate {
  return {
    madeGoal: pilot.made_goal,
    reachedESS: pilot.reached_ess,
    speedSectionTime: pilot.speed_section_time,
  };
}

/**
 * The class as the scorer saw it: withheld tracklogs are seated at 0 after
 * scoring (track-quality.ts), so any figure derived from the field — a best,
 * a leader, a distribution — must leave them out or it describes a field the
 * engine never scored.
 */
export function scoredPilots(classContext: ClassContextInput): ClassPilotInput[] {
  return classContext.pilots.filter((p) => !p.track_excluded);
}

/**
 * How many pilots in the class reached the end of the speed section.
 *
 * The published count is the divisor the scorer actually used; counting rows
 * is the fallback for payloads written before `validity_inputs` existed.
 */
export function pilotsAtEss(classContext: ClassContextInput): number {
  return (
    classContext.validity_inputs?.num_reached_ess ??
    classContext.pilots.filter((p) => p.reached_ess).length
  );
}

/**
 * Did FAI S7F §11's "nobody reaches ESS" rule zero this class's available time
 * and arrival points?
 *
 * Stated in the spec's HG box, so HG only — paragliding arrives at a zero time
 * weight through its own GoalRatio = 0 leading weight instead, which
 * {@link leadingWeightDetail} already spells out.
 *
 * Gated on the PUBLISHED available time being zero as well as on the field
 * count: the stale-first store keeps serving bodies written before the rule
 * existed, and those carry a non-zero time figure that this sentence would
 * flatly contradict. A whole-day zero (a stopped task that failed §13.4.2)
 * is excluded for the same reason — nothing was on offer there for any
 * component, which is a different finding with its own row.
 */
export function noEssPointsZeroed(
  classContext: ClassContextInput,
  params: GAPParameters,
): boolean {
  return (
    params.scoring === 'HG' &&
    classContext.available_points.total > 0 &&
    classContext.available_points.time === 0 &&
    pilotsAtEss(classContext) === 0
  );
}

/** Human label for a task position: Takeoff / Start / TP3 / ESS / Goal. */
export function turnpointLabel(task: XCTask, taskIndex: number): string {
  const tp: Turnpoint | undefined = task.turnpoints[taskIndex];
  if (!tp) return `TP${taskIndex + 1}`;
  if (tp.type === 'TAKEOFF') return 'Takeoff';
  if (tp.type === 'SSS') return 'Start';
  if (tp.type === 'ESS') return 'ESS';
  if (taskIndex === getGoalIndex(task)) return 'Goal';
  return `TP${taskIndex + 1}`;
}

export function turnpointName(task: XCTask, taskIndex: number): string {
  return task.turnpoints[taskIndex]?.waypoint.name ?? '';
}

export function reachingAnchor(
  r: TurnpointReaching,
  kind: ExplanationAnchorKind,
): ExplanationAnchor {
  return {
    kind,
    latitude: r.latitude,
    longitude: r.longitude,
    altitude: r.altitude,
    timeMs: r.time.getTime(),
  };
}

/**
 * Spell out the §11 leading↔time split for this task, so the explanation is
 * self-describing. The PG no-goal rule is the surprising branch, so it is
 * stated for paragliding; hang gliding takes the plain ratio.
 */
export function leadingWeightDetail(params: GAPParameters): string | undefined {
  const ratioPct = Math.round(resolveLeadingTimeRatio(params) * 100);
  if (params.scoring !== 'PG') {
    return `Leading weight follows the FAI S7F 2026 §11 formula: ${ratioPct}% of the non-distance weight (the task's Leading Time Ratio) goes to leading.`;
  }
  return `Leading weight follows the FAI S7F 2026 §11 formula: ${ratioPct}% of the non-distance weight (the task's Leading Time Ratio) goes to leading when someone makes goal, and all of it when nobody does.`;
}
