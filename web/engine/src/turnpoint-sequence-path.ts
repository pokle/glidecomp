/**
 * Forward-path construction and best-progress measurement.
 *
 * Given the raw crossings, builds a candidate turnpoint-reaching sequence for
 * a start crossing and measures a landed-out pilot's furthest progress toward
 * goal. The resolver tries these per start crossing and keeps the best.
 */

import type { XCTask } from './xctsk-parser';
import { fixAltitude, type IGCFix } from './igc-parser';
import { andoyerDistance } from './geo';
import { computeTurnpointDirections, type TurnpointDirection } from './task-optimizer';
import { distanceToGoalLine } from './goal-line';
import type {
  CylinderCrossing,
  TurnpointReaching,
  BestProgress,
  NextTPMeasure,
} from './turnpoint-sequence-types';

/**
 * Build a forward path from an SSS crossing through subsequent turnpoints.
 *
 * Reaching a turnpoint is presence-based (FAI S7F §8 / FS semantics), on the
 * side of the boundary the turnpoint's direction requires: an ENTER cylinder
 * needs the pilot inside it at or after the previous reaching, an EXIT
 * cylinder (one the route arrives at from inside — see
 * {@link computeTurnpointDirections}) needs them outside it. For each TP
 * after SSS that means either the first qualifying boundary crossing
 * at/after the previous reaching time, or — when the pilot is already on
 * the required side at that moment — the previous reaching moment itself.
 *
 * @param startedInsideTP - Per task index: whether the track's FIRST fix lay
 *   inside that cylinder's detection edge (outer for ENTER cylinders, inner
 *   for EXIT). Only consulted for a cylinder with no crossing before the
 *   previous reaching (the pilot's inside/outside state never toggled, so it
 *   is the state at track start).
 * @param directions - Per task index: the required crossing direction
 *   ({@link computeTurnpointDirections}).
 */
interface BuildForwardPathParams {
  sssCrossing: CylinderCrossing;
  crossingsByTP: Map<number, CylinderCrossing[]>;
  sssIdx: number;
  essIdx: number;
  goalIdx: number;
  startedInsideTP: boolean[];
  directions: TurnpointDirection[];
  startSelectionReason?: TurnpointReaching['selectionReason'];
}

export function buildForwardPath(params: BuildForwardPathParams): TurnpointReaching[] {
  const {
    sssCrossing,
    crossingsByTP,
    sssIdx,
    essIdx,
    goalIdx,
    startedInsideTP,
    directions,
    startSelectionReason = 'last_before_next',
  } = params;
  const sequence: TurnpointReaching[] = [];

  // Add SSS reaching
  sequence.push({
    taskIndex: sssCrossing.taskIndex,
    fixIndex: sssCrossing.fixIndex,
    time: sssCrossing.time,
    latitude: sssCrossing.latitude,
    longitude: sssCrossing.longitude,
    altitude: sssCrossing.altitude,
    selectionReason: startSelectionReason,
    candidateCount: crossingsByTP.get(sssIdx)?.length ?? 0,
    toleranceCredited: sssCrossing.toleranceCredited,
  });

  let prevReachingTime = sssCrossing.time.getTime();

  // For each subsequent task position
  for (let tpIdx = sssIdx + 1; tpIdx <= goalIdx; tpIdx++) {
    const tpCrossings = crossingsByTP.get(tpIdx) ?? [];
    const isESS = tpIdx === essIdx;
    const isExit = directions[tpIdx] === 'exit';

    // Presence-based reaching: if the pilot is already on the required side
    // of this cylinder's boundary at the moment the previous turnpoint is
    // reached, the turnpoint is reached at that same moment — no boundary
    // crossing required. For an ENTER cylinder the required side is inside:
    // the nested-cylinder case (e.g. a small final TP inside a big ESS/goal
    // ring), where the only crossing of the big cylinder happens BEFORE the
    // nested TP is tagged, and a pilot who then flies to goal without ever
    // exiting would otherwise be scored landed-out. For an EXIT cylinder the
    // required side is outside: a pilot who tagged the previous turnpoint
    // beyond this cylinder's boundary has already satisfied it. Crossings
    // toggle the pilot's inside/outside state, so the state at the previous
    // reaching is given by the last crossing strictly before it — or, when
    // no crossing precedes it, by where the track began. A crossing exactly
    // AT the previous reaching time is left to the crossing search below, so
    // the identical co-located ESS/goal cylinder keeps its 'first_crossing'
    // reaching from the shared boundary crossing.
    let lastCrossingBefore: CylinderCrossing | null = null;
    for (const crossing of tpCrossings) {
      if (crossing.time.getTime() >= prevReachingTime) break;
      lastCrossingBefore = crossing;
    }
    const insideAtPrevReaching = lastCrossingBefore
      ? lastCrossingBefore.direction === 'enter'
      : startedInsideTP[tpIdx];
    const satisfiedAtPrevReaching = isExit
      ? !insideAtPrevReaching
      : insideAtPrevReaching;

    if (satisfiedAtPrevReaching) {
      const prev = sequence[sequence.length - 1];
      sequence.push({
        taskIndex: tpIdx,
        fixIndex: prev.fixIndex,
        time: prev.time,
        latitude: prev.latitude,
        longitude: prev.longitude,
        altitude: prev.altitude,
        selectionReason: isExit ? 'already_outside' : 'already_inside',
        candidateCount: tpCrossings.length,
        toleranceCredited: lastCrossingBefore?.toleranceCredited ?? false,
        ...(lastCrossingBefore?.goalSemicircleCredited
          ? { goalSemicircleCredited: true }
          : {}),
      });
      continue; // reached at the same moment — prevReachingTime unchanged
    }

    // Find first qualifying crossing at or after the previous reaching time.
    // For an EXIT cylinder only outward crossings qualify — the pilot is
    // inside and must leave; an ENTER cylinder accepts the first crossing
    // (the pilot is outside, so it is necessarily inward).
    //
    // The comparison is >= (not >) so a turnpoint co-located with the
    // previous one is credited from the same physical boundary crossing.
    // The common case is the speed section ending at goal: ESS and goal are
    // the *same* cylinder (same centre and radius), so a single entry emits
    // two crossings — one per task index — carrying the identical
    // interpolated timestamp. A strict > would drop the goal crossing and
    // report a pilot who reached ESS as "landed out". A genuinely tighter
    // co-located cylinder still produces a strictly-later crossing (you
    // reach the wider ring first), so >= never over-credits: it only
    // rescues the identical-cylinder case.
    let validCrossing: CylinderCrossing | null = null;
    for (const crossing of tpCrossings) {
      if (crossing.time.getTime() >= prevReachingTime && (!isExit || crossing.direction === 'exit')) {
        validCrossing = crossing;
        break;
      }
    }

    if (!validCrossing) {
      break; // Pilot didn't reach this TP
    }

    sequence.push({
      taskIndex: validCrossing.taskIndex,
      fixIndex: validCrossing.fixIndex,
      time: validCrossing.time,
      latitude: validCrossing.latitude,
      longitude: validCrossing.longitude,
      altitude: validCrossing.altitude,
      selectionReason: isESS ? 'first_crossing' : 'first_after_previous',
      candidateCount: tpCrossings.length,
      toleranceCredited: validCrossing.toleranceCredited,
      ...(validCrossing.goalSemicircleCredited
        ? { goalSemicircleCredited: true }
        : {}),
    });

    prevReachingTime = validCrossing.time.getTime();
  }

  return sequence;
}

/**
 * Build the list of remaining turnpoints and inter-TP leg distances
 * from the last reached task index to goal.
 */
export function buildRemainingPath(
  task: XCTask,
  lastReachedIndex: number,
  segmentDistances: number[],
): { remainingTPs: Array<{ lat: number; lon: number; radius: number }>; remainingLegDistances: number[] } {
  const remainingTPs: Array<{ lat: number; lon: number; radius: number }> = [];
  for (let i = lastReachedIndex + 1; i < task.turnpoints.length; i++) {
    const tp = task.turnpoints[i];
    remainingTPs.push({ lat: tp.waypoint.lat, lon: tp.waypoint.lon, radius: tp.radius });
  }

  // Leg distances between consecutive remaining TPs
  // segmentDistances[i] = optimized distance from task TP[i] to TP[i+1]
  // We need distances from TP[lastReachedIndex+1] to TP[lastReachedIndex+2], etc.
  const remainingLegDistances: number[] = [];
  for (let i = lastReachedIndex + 1; i < task.turnpoints.length - 1; i++) {
    remainingLegDistances.push(segmentDistances[i]);
  }

  return { remainingTPs, remainingLegDistances };
}

/**
 * Compute best progress for a non-goal pilot.
 * Scans all fixes after the last reaching time to find the point
 * with minimum remaining distance to goal.
 *
 * Per CIVL GAP, remaining distance is the shortest path from the pilot's
 * position through any un-reached intermediate turnpoints to goal — not
 * a straight line to goal.
 *
 * @param remainingTPs - Turnpoints from lastReached+1 to goal (inclusive),
 *   each with lat/lon/radius. When the next unreached TP is goal itself,
 *   this is a single-element array and degenerates to straight-line.
 * @param remainingLegDistances - Optimized distances between consecutive
 *   remaining TPs (length = remainingTPs.length - 1).
 * @param nextMeasure - How to measure the fix→next-turnpoint distance
 *   (see {@link NextTPMeasure}).
 * @param deadlineMs - The task deadline (FAI S7F §11.1): best distance is
 *   measured up until the pilot landed or the deadline, whichever comes
 *   first — fixes after it are not scanned. Null when the task has none.
 *   For a stopped task the caller folds the scored-window end (§12.3.4)
 *   into this same clip.
 * @param altitudeBonus - Stopped tasks only (§12.3.6): credit each scanned
 *   fix a bonus distance of glideRatio × (GNSS altitude − goalAltitude),
 *   clamped to the geometric remaining distance, and pick the best
 *   EFFECTIVE (bonus-adjusted) remaining distance. Null when no bonus
 *   applies (task not stopped, or the pilot landed before the stop).
 */
interface BestProgressParams {
  fixes: IGCFix[];
  lastReachingTime: number;
  remainingTPs: Array<{ lat: number; lon: number; radius: number }>;
  remainingLegDistances: number[];
  nextMeasure: NextTPMeasure;
  deadlineMs: number | null;
  altitudeBonus?: { glideRatio: number; goalAltitude: number } | null;
}

export function computeBestProgress(params: BestProgressParams): BestProgress | null {
  const {
    fixes,
    lastReachingTime,
    remainingTPs,
    remainingLegDistances,
    nextMeasure,
    deadlineMs,
    altitudeBonus = null,
  } = params;
  // Sum of optimized leg distances between remaining TPs (TP[1]→TP[2]→...→Goal)
  let interTPDistance = 0;
  for (const d of remainingLegDistances) {
    interTPDistance += d;
  }

  const nextTP = remainingTPs[0];
  let bestFix: { index: number; distToGoal: number; bonus: number } | null = null;

  for (let i = 0; i < fixes.length; i++) {
    const fix = fixes[i];
    if (fix.time.getTime() <= lastReachingTime) continue;
    // §11.1: flying after the task deadline earns no further distance.
    // (For a stopped task the caller folds the §12.3.4 window end in here.)
    if (deadlineMs !== null && fix.time.getTime() > deadlineMs) break;

    // Distance to the next un-reached turnpoint — see NextTPMeasure for
    // which measurement applies and why. Measuring to a tag point avoids
    // the small over-credit of reaching the nearest edge then jumping to
    // the optimal tag; the edge measurements handle the cases where the
    // tag point is the wrong reference (goal, exit cylinders, and the
    // return leg after one).
    const distToNextTP =
      nextMeasure.kind === 'tag'
        ? andoyerDistance(fix.latitude, fix.longitude, nextMeasure.point.lat, nextMeasure.point.lon)
        : nextMeasure.kind === 'exit-boundary'
          ? Math.max(0, nextTP.radius - andoyerDistance(fix.latitude, fix.longitude, nextTP.lat, nextTP.lon))
          : nextMeasure.kind === 'goal-line'
            ? distanceToGoalLine(nextMeasure.line, fix.latitude, fix.longitude)
            : Math.max(0, andoyerDistance(fix.latitude, fix.longitude, nextTP.lat, nextTP.lon) - nextTP.radius);
    // Total remaining = distance to next TP + optimized path from there to goal
    const geometricDist = distToNextTP + interTPDistance;

    // §12.3.6 altitude bonus (stopped tasks, pilot still flying at the
    // stop): height above goal glides out at the spec's fixed glide ratio.
    // Clamped so the effective remaining distance never goes negative —
    // the bonus can bring a pilot to goal distance, not past it.
    const bonus = altitudeBonus
      ? Math.min(
          geometricDist,
          altitudeBonus.glideRatio *
            Math.max(0, fixAltitude(fix) - altitudeBonus.goalAltitude),
        )
      : 0;
    const distToGoal = geometricDist - bonus;

    if (!bestFix || distToGoal < bestFix.distToGoal) {
      bestFix = { index: i, distToGoal, bonus };
    }
  }

  if (!bestFix) return null;

  const fix = fixes[bestFix.index];
  return {
    fixIndex: bestFix.index,
    time: fix.time,
    latitude: fix.latitude,
    longitude: fix.longitude,
    distanceToGoal: bestFix.distToGoal,
    ...(altitudeBonus
      ? { altitudeBonus: bestFix.bonus, altitude: fixAltitude(fix) }
      : {}),
  };
}
