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
import type {
  ClassContextInput,
  ClassPilotInput,
  ExplanationAnchor,
  ExplanationAnchorKind,
} from '../score-explanation-types';

/**
 * Read a published class pilot as a {@link BestTimeCandidate}, so the report
 * card's best time (FAI S7F §11.2.1) comes from {@link bestTimeFrom} — the
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
 * Did FAI S7F §10's "nobody reaches ESS" rule zero this class's available time
 * and arrival points?
 *
 * Stated in the spec's HG box, so HG only — paragliding arrives at a zero time
 * weight through its own GoalRatio = 0 leading weight instead, which
 * {@link leadingWeightDetail} already spells out.
 *
 * Gated on the PUBLISHED available time being zero as well as on the field
 * count: the stale-first store keeps serving bodies written before the rule
 * existed, and those carry a non-zero time figure that this sentence would
 * flatly contradict. A whole-day zero (a stopped task that failed §12.3.2)
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
 * Name the leading-weight generation that set this task's leading↔time split,
 * so the explanation is self-describing (issue #257). Hang gliding is
 * generation-independent, so it needs no note.
 */
export function leadingWeightDetail(params: GAPParameters): string | undefined {
  if (params.scoring !== 'PG') return undefined;
  if (params.leadingWeightFormula === 's7f2024') {
    const ratioPct = Math.round(params.leadingTimeRatio * 100);
    return `Leading weight follows the FAI S7F 2024 §10 formula: ${ratioPct}% of the non-distance weight (LeadingTimeRatio) goes to leading when someone makes goal, and all of it when nobody does.`;
  }
  if (params.leadingWeightFormula === 's7f2020') {
    return 'Weights follow the FAI S7F 2020–2022 §10 formula (PWC-derived): distance weight 0.838 when nobody makes goal, else 0.805 − 1.374·GR + 1.413·GR² − 0.484·GR³; leading weight fixed at 0.162; time takes the remainder.';
  }
  return 'Leading weight follows the GAP2020 formula (the GAP2016/2018 weights, AirScore legacy parity): 35% of the non-distance weight when someone makes goal, and 0.1 × best distance ÷ task distance when nobody does.';
}
