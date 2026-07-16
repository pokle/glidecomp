/**
 * Turnpoint Sequence Resolution
 *
 * Implements the CIVL GAP turnpoint sequence algorithm: given a competition
 * task and a GPS tracklog, finds the valid sequence of turnpoint crossings
 * that represents the pilot's scored flight.
 *
 * The algorithm is designed for transparency — all raw crossings, selection
 * reasons, and distance breakdowns are returned so the scoring decision can
 * be explained to pilots in the UI.
 *
 * The crossing detection lives in ./turnpoint-sequence-crossings, the
 * candidate-path/best-progress helpers in ./turnpoint-sequence-path, and the
 * shared data types/constants in ./turnpoint-sequence-types; this module
 * resolves the scored sequence and revives it from JSON, and re-exports the
 * vocabulary so the public API and existing imports are unchanged.
 *
 * @see /docs/event-detection/turnpoint-sequence-algorithms-research.md
 * @see FAI Sporting Code Section 7F (CIVL GAP)
 */

import type { XCTask } from './xctsk-parser';
import type { IGCFix } from './igc-parser';
import { andoyerDistance, isInsideCylinder } from './geo';
import { getSSSIndex, getEffectiveSSSIndex, getESSIndex, getEffectiveESSIndex, getGoalIndex } from './xctsk-parser';
import { calculateOptimizedTaskLine, computeTurnpointDirections } from './task-optimizer';
import { computeGoalLine, isInGoalSemicircle } from './goal-line';
import {
  resolveStartGates,
  gateIndexForCrossing,
  resolveTaskDeadline,
  resolveLaunchWindowOpen,
} from './time-gates';
import {
  outerDetectionRadius,
  innerDetectionRadius,
  detectCylinderCrossings,
} from './turnpoint-sequence-crossings';
import {
  buildForwardPath,
  buildRemainingPath,
  computeBestProgress,
} from './turnpoint-sequence-path';
import { DEFAULT_CYLINDER_TOLERANCE } from './turnpoint-sequence-types';
import type {
  CylinderCrossing,
  TurnpointReaching,
  BestProgress,
  LegDistance,
  StartGateTaken,
  EarlyStart,
  TaskDeadlineInfo,
  LaunchWindowInfo,
  TurnpointSequenceResult,
  TurnpointSequenceResultJSON,
  NextTPMeasure,
} from './turnpoint-sequence-types';

export {
  DEFAULT_CYLINDER_TOLERANCE,
  MIN_CYLINDER_TOLERANCE_M,
} from './turnpoint-sequence-types';
export type {
  CylinderCrossing,
  TurnpointReaching,
  BestProgress,
  LegDistance,
  StartGateTaken,
  EarlyStart,
  TaskDeadlineInfo,
  LaunchWindowInfo,
  TurnpointSequenceResult,
  CylinderCrossingJSON,
  TurnpointReachingJSON,
  BestProgressJSON,
  StartGateTakenJSON,
  EarlyStartJSON,
  TaskDeadlineInfoJSON,
  LaunchWindowInfoJSON,
  TurnpointSequenceResultJSON,
} from './turnpoint-sequence-types';
export { detectCylinderCrossings } from './turnpoint-sequence-crossings';

/**
 * Resolve the turnpoint sequence for a flight against a competition task.
 *
 * Algorithm (per CIVL GAP / Section 7F):
 * 1. Detect all cylinder crossings per task position
 * 2. Enforce the task deadline (§8.3.c): crossings after the goal deadline
 *    are excluded from sequence resolution (and best-progress distance is
 *    measured only up to the deadline, §11.1); the full crossing list is
 *    still returned so ignored crossings can be explained
 * 3. Enforce the launch window's open time (§8.6.1): SSS crossings before
 *    takeoff.timeOpen prove the pilot was airborne before launching was
 *    allowed and cannot validate a start
 * 4. For gated races: drop SSS crossings before the first start gate
 *    (§8.3 — a start can't validate before the gate opens); when every
 *    crossing is pre-gate, resolve from them anyway and report earlyStart
 * 5. For SSS: use last valid crossing before continuing to next TP
 * 6. For other TPs (ESS and goal included): use first valid crossing after
 *    previous TP reached — outward for an EXIT cylinder (one the route
 *    arrives at from inside, see computeTurnpointDirections) — or, when the
 *    pilot is already on the required side of the boundary at the previous
 *    reaching (nested/overlapping cylinders), credit it at that same moment
 *    (presence-based reaching, §8)
 * 7. For ESS: always first crossing (no re-tries)
 * 8. For multi-gate/elapsed-time: iterate SSS crossings, keep best path
 *    (most TPs reached, then most flown distance, then latest SSS)
 * 9. Snap the start time to the last gate ≤ crossing (§8.3.1) and time the
 *    speed section from the gate (§8.7)
 * 10. Compute optimized leg distances and flown distance
 *
 * @param task - The competition task definition
 * @param fixes - The pilot's GPS tracklog
 * @returns Complete sequence result with scoring data and explanations
 */
export function resolveTurnpointSequence(
  task: XCTask,
  fixes: IGCFix[]
): TurnpointSequenceResult {
  // Optimized task line (one tag point per turnpoint), computed once. The
  // tag points feed best-progress so a pilot's remaining distance to goal
  // is measured to each cylinder's optimal tag — consistent with the leg
  // distances — rather than its nearest edge. It also determines each
  // turnpoint's crossing direction: a cylinder containing the previous tag
  // point is an EXIT cylinder, reached by flying out of it.
  const optimizedLine = calculateOptimizedTaskLine(task);
  const directions = computeTurnpointDirections(task, optimizedLine);
  const allCrossings = detectCylinderCrossings(task, fixes, directions);
  const segmentDistances: number[] = [];
  for (let i = 1; i < optimizedLine.length; i++) {
    segmentDistances.push(andoyerDistance(
      optimizedLine[i - 1].lat, optimizedLine[i - 1].lon,
      optimizedLine[i].lat, optimizedLine[i].lon,
    ));
  }
  const taskDistance = segmentDistances.reduce((sum, d) => sum + d, 0);
  // Tasks are supposed to mark one turnpoint as SSS, but hand-built tasks
  // often omit it. Without a start anchor every pilot would score zero, so
  // when the SSS is missing the first turnpoint (usually the take-off) acts
  // as the start — see getEffectiveSSSIndex.
  const explicitSSSIdx = getSSSIndex(task);
  const sssIdx = getEffectiveSSSIndex(task);
  const sssIsFallback = explicitSSSIdx < 0 && sssIdx >= 0;
  // Same idea for the ESS: when missing, the speed section ends at goal —
  // otherwise time/arrival/leading points exist that no pilot can earn and
  // every goal pilot ties on distance alone. See getEffectiveESSIndex.
  const explicitESSIdx = getESSIndex(task);
  const essIdx = getEffectiveESSIndex(task);
  const essIsFallback = explicitESSIdx < 0 && essIdx >= 0;
  const goalIdx = getGoalIndex(task);
  // Non-null when the task ends at a goal LINE (S7F §6.3.1): reaching and
  // remaining-distance for the goal position use line geometry.
  const goalLine = computeGoalLine(task);

  // Build legs with default completed = false
  const legs: LegDistance[] = segmentDistances.map((dist, i) => ({
    fromTaskIndex: i,
    toTaskIndex: i + 1,
    distance: dist,
    completed: false,
  }));

  // Where the track began relative to each cylinder's detection edge.
  // Feeds the presence-based reaching check in buildForwardPath for the
  // cylinder-never-crossed case (e.g. a goal cylinder so large the whole
  // flight stays inside it). The edge matches crossing detection: outer for
  // ENTER cylinders, inner for EXIT cylinders — so the state machine and
  // the track-start state always agree on which side of the band a fix is.
  const tolerance = task.cylinderTolerance ?? DEFAULT_CYLINDER_TOLERANCE;
  const startedInsideTP = task.turnpoints.map((tp, tpIdx) => {
    if (fixes.length === 0) return false;
    // A LINE goal has no interior; "inside" is the control semicircle.
    if (goalLine && tpIdx === goalIdx) {
      return isInGoalSemicircle(goalLine, fixes[0].latitude, fixes[0].longitude);
    }
    const edge = directions[tpIdx] === 'exit'
      ? innerDetectionRadius(tp.radius, tolerance)
      : outerDetectionRadius(tp.radius, tolerance);
    return andoyerDistance(
      fixes[0].latitude, fixes[0].longitude,
      tp.waypoint.lat, tp.waypoint.lon,
    ) <= edge;
  });

  // Filter SSS crossings by the required direction (e.g. EXIT for paragliding races).
  // If no SSS config or direction is unspecified, accept all crossings for backward compat.
  // The direction rule describes the explicit SSS cylinder; in fallback mode the
  // anchor is the first turnpoint (not a configured start), so no filter applies.
  const requiredDirection = sssIsFallback
    ? undefined
    : task.sss?.direction?.toLowerCase() as 'enter' | 'exit' | undefined;
  const allSSSCrossings = sssIdx >= 0
    ? allCrossings.filter(c => c.taskIndex === sssIdx)
    : [];
  const directionSSSCrossings = requiredDirection
    ? allSSSCrossings.filter(c => c.direction === requiredDirection)
    : allSSSCrossings;

  // Start gates (RACE tasks, §6.3.3/§8.3): resolved before the timing clips
  // below — the deadline's mis-set guard compares against the first gate.
  // The reference instant (any SSS crossing, else the first fix) only
  // places the gates' time-of-day on the right calendar day. Gates describe
  // the configured start cylinder, so — like the direction rule above —
  // they don't apply in fallback-start mode.
  const gateReferenceMs = directionSSSCrossings.length > 0
    ? directionSSSCrossings[0].time.getTime()
    : (fixes.length > 0 ? fixes[0].time.getTime() : null);
  const gates = !sssIsFallback && gateReferenceMs !== null
    ? resolveStartGates(task, gateReferenceMs)
    : null;

  // Task deadline (§8.3.c): crossings after the goal deadline cannot count,
  // and best-progress distance is measured only up to it (§8.6.1, §11.1).
  // Resolved near the END of the flight — the deadline bounds the end of
  // the scoring window. A deadline at or before the first start gate is a
  // task-setting mistake (nobody could score anything) and is ignored, in
  // the same spirit as the SSS/ESS fallbacks for mis-set tasks.
  let deadlineMs = fixes.length > 0
    ? resolveTaskDeadline(task, fixes[fixes.length - 1].time.getTime())
    : null;
  if (deadlineMs !== null && gates && deadlineMs <= gates[0]) deadlineMs = null;

  // Launch window open (§8.6.1, takeoff.timeOpen): a start crossing before
  // the window opens proves the pilot was airborne before launching was
  // allowed, so it cannot validate a start. Like gates, the window
  // describes the configured task, so it doesn't apply in fallback-start
  // mode; an open time at/after the deadline or after the first gate is a
  // task-setting mistake and is ignored.
  let windowOpenMs = !sssIsFallback && fixes.length > 0
    ? resolveLaunchWindowOpen(task, fixes[0].time.getTime())
    : null;
  if (windowOpenMs !== null && deadlineMs !== null && windowOpenMs >= deadlineMs) {
    windowOpenMs = null;
  }
  if (windowOpenMs !== null && gates && windowOpenMs > gates[0]) windowOpenMs = null;

  // The crossings the sequence may be built from: everything at or before
  // the deadline. The full list (allCrossings) is still returned for
  // transparency — the explanation shows ignored crossings with the reason.
  // Dropping only the time-sorted tail never corrupts the inside/outside
  // state the presence-based reaching logic derives from earlier crossings.
  const scoredCrossings = deadlineMs === null
    ? allCrossings
    : allCrossings.filter(c => c.time.getTime() <= deadlineMs);
  const crossingsAfterDeadline = allCrossings.length - scoredCrossings.length;

  const deadlineInfo: TaskDeadlineInfo | undefined = deadlineMs !== null
    ? {
        time: new Date(deadlineMs),
        crossingsAfter: crossingsAfterDeadline,
        trackContinuesPastDeadline:
          fixes.length > 0 && fixes[fixes.length - 1].time.getTime() > deadlineMs,
      }
    : undefined;

  // Group scored crossings by taskIndex
  const crossingsByTP = new Map<number, CylinderCrossing[]>();
  for (const crossing of scoredCrossings) {
    const arr = crossingsByTP.get(crossing.taskIndex);
    if (arr) {
      arr.push(crossing);
    } else {
      crossingsByTP.set(crossing.taskIndex, [crossing]);
    }
  }

  // Start validation order: deadline clip (above), direction, launch-window
  // open, then gates. Pre-window crossings are dropped outright (§8.6.1 —
  // launching before the window has no scored-with-penalty provision);
  // pre-gate crossings are kept only when EVERY crossing is pre-gate, the
  // §12.2 "jumped the gun" case (HG scores the complete flight with a
  // penalty; the PG launch→SSS clamp happens in the scorer) with earlyStart
  // reporting the facts.
  let sssCrossings = deadlineMs === null
    ? directionSSSCrossings
    : directionSSSCrossings.filter(c => c.time.getTime() <= deadlineMs);
  let droppedStartCrossings = 0;
  if (windowOpenMs !== null) {
    const beforeCount = sssCrossings.length;
    sssCrossings = sssCrossings.filter(c => c.time.getTime() >= windowOpenMs);
    droppedStartCrossings = beforeCount - sssCrossings.length;
  }
  const launchWindowInfo: LaunchWindowInfo | undefined = windowOpenMs !== null
    ? { openTime: new Date(windowOpenMs), droppedStartCrossings }
    : undefined;
  if (gates && sssCrossings.length > 0) {
    const legal = sssCrossings.filter(c => c.time.getTime() >= gates[0]);
    if (legal.length > 0) sssCrossings = legal;
  }

  // Fallback start with no crossings: if the track began outside the first
  // turnpoint's cylinder (e.g. the logger started after launch) there is no
  // boundary to cross, so the first fix anchors the sequence — mirroring
  // open-distance scoring's take-off origin. A track that began inside and
  // never crossed out means the pilot never left launch: no start.
  let startSelectionReason: TurnpointReaching['selectionReason'] = 'last_before_next';
  if (sssIsFallback && sssCrossings.length === 0 && fixes.length > 0) {
    const startTP = task.turnpoints[sssIdx];
    const first = fixes[0];
    const startedInside = isInsideCylinder(
      first.latitude, first.longitude,
      startTP.waypoint.lat, startTP.waypoint.lon, startTP.radius,
    );
    if (!startedInside) {
      sssCrossings = [{
        taskIndex: sssIdx,
        fixIndex: 0,
        time: first.time,
        latitude: first.latitude,
        longitude: first.longitude,
        altitude: first.gnssAltitude,
        direction: 'exit',
        distanceToCenter: andoyerDistance(
          first.latitude, first.longitude,
          startTP.waypoint.lat, startTP.waypoint.lon,
        ),
        toleranceCredited: false,
      }];
      startSelectionReason = 'track_start';
    }
  }

  const startFallback = sssIsFallback
    ? (startSelectionReason === 'track_start' ? 'track_start' as const : 'first_turnpoint' as const)
    : undefined;

  if (sssCrossings.length === 0) {
    return {
      crossings: allCrossings,
      sequence: [],
      sssReaching: null,
      essReaching: null,
      madeGoal: false,
      lastTurnpointReached: -1,
      bestProgress: null,
      taskDistance,
      flownDistance: 0,
      legs,
      speedSectionTime: null,
      ...(startFallback ? { startFallback } : {}),
      ...(essIsFallback ? { essFallback: 'last_turnpoint' as const } : {}),
      ...(deadlineInfo ? { deadline: deadlineInfo } : {}),
      ...(launchWindowInfo ? { launchWindow: launchWindowInfo } : {}),
    };
  }

  // How best-progress measures the fix→next-turnpoint distance for a pilot
  // whose last reached turnpoint is lastReachedIdx — see NextTPMeasure.
  // The nearest-edge rule after an exit cylinder applies only to INFERRED
  // exit turnpoints, not the declared-EXIT start: after a normal exit start
  // the onward route is asymmetric and well-determined, and measuring to
  // the tag point there is what matches AirScore's flown distances.
  const nextMeasureFor = (lastReachedIdx: number): NextTPMeasure => {
    const nextIdx = lastReachedIdx + 1;
    if (directions[nextIdx] === 'exit') return { kind: 'exit-boundary' };
    if (nextIdx >= goalIdx) {
      return goalLine ? { kind: 'goal-line', line: goalLine } : { kind: 'edge' };
    }
    if (directions[lastReachedIdx] === 'exit' && lastReachedIdx !== sssIdx) {
      return { kind: 'edge' };
    }
    return { kind: 'tag', point: optimizedLine[nextIdx] };
  };

  // Iterate SSS crossings backwards, try each, keep best path
  let bestSequence: TurnpointReaching[] | null = null;
  let bestTPs = 0;
  let bestFlownDist = 0;
  let bestSSSTime = 0;

  for (let i = sssCrossings.length - 1; i >= 0; i--) {
    const sssCrossing = sssCrossings[i];
    const candidateSequence = buildForwardPath({
      sssCrossing, crossingsByTP, sssIdx, essIdx, goalIdx,
      startedInsideTP, directions, startSelectionReason,
    });

    const tpsReached = candidateSequence.length;
    const madeGoal = tpsReached > 0 &&
      candidateSequence[tpsReached - 1].taskIndex === goalIdx;

    let candidateFlownDist: number;
    if (madeGoal) {
      candidateFlownDist = taskDistance;
    } else if (tpsReached > 0) {
      const lastReaching = candidateSequence[tpsReached - 1];
      const { remainingTPs, remainingLegDistances } =
        buildRemainingPath(task, lastReaching.taskIndex, segmentDistances);
      const progress = computeBestProgress({
        fixes,
        lastReachingTime: lastReaching.time.getTime(),
        remainingTPs,
        remainingLegDistances,
        nextMeasure: nextMeasureFor(lastReaching.taskIndex),
        deadlineMs,
      });
      candidateFlownDist = progress
        ? taskDistance - progress.distanceToGoal
        : 0;
    } else {
      candidateFlownDist = 0;
    }

    const candidateSSSTime = sssCrossing.time.getTime();

    // Compare: most TPs → most distance → latest SSS
    const isBetter =
      tpsReached > bestTPs ||
      (tpsReached === bestTPs && candidateFlownDist > bestFlownDist) ||
      (tpsReached === bestTPs && candidateFlownDist === bestFlownDist && candidateSSSTime > bestSSSTime);

    if (!bestSequence || isBetter) {
      bestSequence = candidateSequence;
      bestTPs = tpsReached;
      bestFlownDist = candidateFlownDist;
      bestSSSTime = candidateSSSTime;
    }
  }

  const sequence = bestSequence!;
  const reachedTaskIndices = new Set(sequence.map(r => r.taskIndex));

  // Mark completed legs
  for (const leg of legs) {
    leg.completed = reachedTaskIndices.has(leg.toTaskIndex);
  }

  // Extract SSS and ESS reachings
  const sssReaching = sequence.find(r => r.taskIndex === sssIdx) ?? null;
  const essReaching = sequence.find(r => r.taskIndex === essIdx) ?? null;

  const madeGoal = sequence.length > 0 &&
    sequence[sequence.length - 1].taskIndex === goalIdx;

  const lastTurnpointReached = sequence.length > 0
    ? sequence[sequence.length - 1].taskIndex
    : -1;

  // Compute bestProgress for non-goal pilots
  let bestProgress: BestProgress | null = null;
  let flownDistance = 0;

  if (madeGoal) {
    flownDistance = taskDistance;
  } else if (sequence.length > 0) {
    const lastReaching = sequence[sequence.length - 1];
    const { remainingTPs, remainingLegDistances } =
      buildRemainingPath(task, lastReaching.taskIndex, segmentDistances);
    bestProgress = computeBestProgress({
      fixes,
      lastReachingTime: lastReaching.time.getTime(),
      remainingTPs,
      remainingLegDistances,
      nextMeasure: nextMeasureFor(lastReaching.taskIndex),
      deadlineMs,
    });
    flownDistance = bestProgress
      ? taskDistance - bestProgress.distanceToGoal
      : 0;
  }

  // Start-gate snapping (§8.3.1): the pilot's official start time is the
  // last gate at or before their crossing; a crossing after the last gate
  // takes the last gate; an early starter is anchored to the first gate.
  let startGate: StartGateTaken | undefined;
  let earlyStart: EarlyStart | undefined;
  if (gates && sssReaching) {
    const crossingMs = sssReaching.time.getTime();
    const gateIdx = gateIndexForCrossing(gates, crossingMs);
    if (gateIdx < 0) {
      earlyStart = {
        crossingTime: sssReaching.time,
        firstGateTime: new Date(gates[0]),
        secondsEarly: (gates[0] - crossingMs) / 1000,
      };
      startGate = { time: new Date(gates[0]), index: 0, gateCount: gates.length };
    } else {
      startGate = { time: new Date(gates[gateIdx]), index: gateIdx, gateCount: gates.length };
    }
  }

  // Speed section time: from the start gate taken when the race has gates
  // (§8.7), otherwise from the pilot's actual crossing (elapsed time).
  let speedSectionTime: number | null = null;
  if (sssReaching && essReaching) {
    const startMs = startGate ? startGate.time.getTime() : sssReaching.time.getTime();
    speedSectionTime = (essReaching.time.getTime() - startMs) / 1000;
  }

  return {
    crossings: allCrossings,
    sequence,
    sssReaching,
    essReaching,
    madeGoal,
    lastTurnpointReached,
    bestProgress,
    taskDistance,
    flownDistance,
    legs,
    speedSectionTime,
    ...(startGate ? { startGate } : {}),
    ...(earlyStart ? { earlyStart } : {}),
    ...(startFallback ? { startFallback } : {}),
    ...(essIsFallback ? { essFallback: 'last_turnpoint' as const } : {}),
    ...(deadlineInfo ? { deadline: deadlineInfo } : {}),
    ...(launchWindowInfo ? { launchWindow: launchWindowInfo } : {}),
  };
}

/** Revive a JSON-round-tripped {@link TurnpointSequenceResult}. */
export function reviveTurnpointSequenceResult(
  raw: TurnpointSequenceResultJSON,
): TurnpointSequenceResult {
  const revive = <T extends { time: string | number }>(
    v: T,
  ): Omit<T, 'time'> & { time: Date } => ({ ...v, time: new Date(v.time) });
  const { startGate, earlyStart, deadline, launchWindow, ...rest } = raw;
  return {
    ...rest,
    crossings: raw.crossings.map(revive),
    sequence: raw.sequence.map(revive),
    sssReaching: raw.sssReaching ? revive(raw.sssReaching) : null,
    essReaching: raw.essReaching ? revive(raw.essReaching) : null,
    bestProgress: raw.bestProgress ? revive(raw.bestProgress) : null,
    ...(startGate ? { startGate: revive(startGate) } : {}),
    ...(earlyStart
      ? {
          earlyStart: {
            ...earlyStart,
            crossingTime: new Date(earlyStart.crossingTime),
            firstGateTime: new Date(earlyStart.firstGateTime),
          },
        }
      : {}),
    ...(deadline ? { deadline: revive(deadline) } : {}),
    ...(launchWindow
      ? {
          launchWindow: {
            ...launchWindow,
            openTime: new Date(launchWindow.openTime),
          },
        }
      : {}),
  };
}
