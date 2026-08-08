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
import { fixAltitude, type IGCFix } from './igc-parser';
import { andoyerDistance, isInsideCylinder } from './geo';
import { getSSSIndex, getEffectiveSSSIndex, getESSIndex, getEffectiveESSIndex, getGoalIndex } from './xctsk-parser';
import {
  calculateOptimizedTaskLine,
  computeTurnpointDirections,
  type TurnpointDirection,
} from './task-optimizer';
import { computeGoalLine, isInGoalSemicircle, type GoalLine } from './goal-line';
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
  StopResolutionOptions,
  TaskStopInfo,
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
  StopResolutionOptions,
  TaskStopInfo,
  TurnpointSequenceResult,
  CylinderCrossingJSON,
  TurnpointReachingJSON,
  BestProgressJSON,
  StartGateTakenJSON,
  EarlyStartJSON,
  TaskDeadlineInfoJSON,
  LaunchWindowInfoJSON,
  TaskStopInfoJSON,
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
 * @param options - Optional stopped-task context (FAI S7F §12.3): when
 *   `options.stop` is set the scored flight is clipped to the pilot's
 *   scored time window (§12.3.4), a pilot at/after ESS at the window end is
 *   scored for their complete flight (§12.3.5), and a pilot still flying at
 *   the window end earns the altitude bonus (§12.3.6). The result then
 *   carries {@link TaskStopInfo} for transparency.
 * @returns Complete sequence result with scoring data and explanations
 */
export function resolveTurnpointSequence(
  task: XCTask,
  fixes: IGCFix[],
  options?: { stop?: StopResolutionOptions | null },
): TurnpointSequenceResult {
  const stop = options?.stop ?? null;
  if (!stop) return resolveSequenceOnce(task, fixes, null);

  const windowEndMs = stop.windowEndMs ?? stop.stopTimeMs;
  const bonusOpts = { glideRatio: stop.glideRatio, goalAltitude: stop.goalAltitude };
  // "Still flying at the stop": the tracklog reaches the scored-window end.
  // (Comp tracklogs end at landing; a logger left running on the ground can
  // only earn a bonus near zero, since ground altitude ≈ landing altitude.)
  const flyingAtStop = fixes.length > 0 &&
    fixes[fixes.length - 1].time.getTime() >= windowEndMs;

  // Probe pass without the stop: decides the §12.3.5 exemption (a pilot
  // at/after ESS at the window end is scored for the complete flight) and
  // already IS the final answer for a pilot who landed before the stop.
  const probe = resolveSequenceOnce(task, fixes, null);
  const essBeforeStop = probe.essReaching !== null &&
    probe.essReaching.time.getTime() <= windowEndMs;

  let result: TurnpointSequenceResult;
  let bonusApplied = false;
  let clipped = false;
  if (!flyingAtStop) {
    // Landed before the window end: nothing to clip, no altitude bonus.
    result = probe;
  } else if (essBeforeStop) {
    // §12.3.5: complete flight scored, including anything after the stop.
    // A landed-out pilot (between ESS and goal) still gets the §12.3.6
    // altitude bonus over the whole flight; a goal pilot needs no re-run.
    if (probe.madeGoal) {
      result = probe;
    } else {
      result = resolveSequenceOnce(task, fixes, { windowEndMs: null, altitudeBonus: bonusOpts });
      bonusApplied = true;
    }
  } else {
    // §12.3.4: scored only up to the window end — crossings after it can't
    // count and distance is measured only up to it, with the bonus.
    result = resolveSequenceOnce(task, fixes, { windowEndMs, altitudeBonus: bonusOpts });
    bonusApplied = true;
    clipped = true;
  }

  // Crossings excluded by the stop clip (those already past the task
  // deadline are the deadline's, not the stop's).
  const deadlineMs = result.deadline ? result.deadline.time.getTime() : null;
  const crossingsAfterStop = clipped
    ? result.crossings.filter(c => {
        const t = c.time.getTime();
        return t > windowEndMs && (deadlineMs === null || t <= deadlineMs);
      }).length
    : 0;

  const stopInfo: TaskStopInfo = {
    stopTime: new Date(stop.stopTimeMs),
    windowEnd: new Date(windowEndMs),
    essBeforeStop,
    flyingAtStop,
    crossingsAfterStop,
    altitudeBonus: bonusApplied ? (result.bestProgress?.altitudeBonus ?? 0) : 0,
    ...(bonusApplied && result.bestProgress?.altitude !== undefined
      ? { bestPointAltitude: result.bestProgress.altitude }
      : {}),
    glideRatio: stop.glideRatio,
    goalAltitude: stop.goalAltitude,
  };
  return { ...result, stopInfo };
}

/**
 * The clip a stopped task places on one flight's resolution: crossings
 * after `windowEndMs` are excluded and best-progress stops scanning there
 * (null = no clip, used for the §12.3.5 complete-flight case); when
 * `altitudeBonus` is set the best-progress scan credits the §12.3.6 bonus.
 */
interface StopClip {
  windowEndMs: number | null;
  altitudeBonus: { glideRatio: number; goalAltitude: number } | null;
}

/**
 * One resolution pass — the stop-unaware algorithm (see the public wrapper).
 *
 * The body is the pipeline the algorithm summary on
 * {@link resolveTurnpointSequence} sets out. Each phase is one of the private
 * steps below it, which carries the FAI citation for the rule it applies.
 */
function resolveSequenceOnce(
  task: XCTask,
  fixes: IGCFix[],
  stopClip: StopClip | null,
): TurnpointSequenceResult {
  const geometry = computeTaskGeometry(task);
  const anchors = resolveTaskAnchors(task);
  const { directions, segmentDistances, taskDistance } = geometry;
  const allCrossings = detectCylinderCrossings(task, fixes, directions);

  // Build legs with default completed = false
  const legs: LegDistance[] = segmentDistances.map((dist, i) => ({
    fromTaskIndex: i,
    toTaskIndex: i + 1,
    distance: dist,
    completed: false,
  }));

  const startedInsideTP = resolveTrackStartInside(task, fixes, geometry, anchors);
  const directionSSSCrossings = filterStartCrossingsByDirection(task, allCrossings, anchors);
  const timing = resolveTimingWindow({ task, fixes, anchors, directionSSSCrossings, stopClip });
  const { gates, deadlineMs, clipMs } = timing;

  // The crossings the sequence may be built from: everything at or before
  // the scored-flight end. The full list (allCrossings) is still returned
  // for transparency — the explanation shows ignored crossings with the
  // reason. Dropping only the time-sorted tail never corrupts the
  // inside/outside state the presence-based reaching logic derives from
  // earlier crossings.
  const scoredCrossings = clipMs === null
    ? allCrossings
    : allCrossings.filter(c => c.time.getTime() <= clipMs);
  const deadlineInfo = describeTaskDeadline(deadlineMs, allCrossings, fixes);
  const crossingsByTP = groupCrossingsByTurnpoint(scoredCrossings);

  const { sssCrossings, launchWindowInfo, startSelectionReason } = resolveStartCrossings({
    task, fixes, anchors, directionSSSCrossings, timing,
  });

  const startFallback = anchors.sssIsFallback
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
      ...(anchors.essIsFallback ? { essFallback: 'last_turnpoint' as const } : {}),
      ...(deadlineInfo ? { deadline: deadlineInfo } : {}),
      ...(launchWindowInfo ? { launchWindow: launchWindowInfo } : {}),
    };
  }

  const scan: ProgressScan = {
    task,
    fixes,
    geometry,
    goalIdx: anchors.goalIdx,
    nextMeasureFor: nextTPMeasurer(geometry, anchors),
    clipMs,
    altitudeBonus: stopClip?.altitudeBonus ?? null,
  };

  const sequence = chooseBestSequence({
    sssCrossings, crossingsByTP, anchors, geometry,
    startedInsideTP, startSelectionReason, scan,
  });
  const reachedTaskIndices = new Set(sequence.map(r => r.taskIndex));

  // Mark completed legs
  for (const leg of legs) {
    leg.completed = reachedTaskIndices.has(leg.toTaskIndex);
  }

  // Extract SSS and ESS reachings
  const sssReaching = sequence.find(r => r.taskIndex === anchors.sssIdx) ?? null;
  const essReaching = sequence.find(r => r.taskIndex === anchors.essIdx) ?? null;

  const madeGoal = sequence.length > 0 &&
    sequence[sequence.length - 1].taskIndex === anchors.goalIdx;

  const lastTurnpointReached = sequence.length > 0
    ? sequence[sequence.length - 1].taskIndex
    : -1;

  // Flown distance, with the best-progress fix a non-goal pilot is measured to
  const { bestProgress, flownDistance } = measureSequenceDistance(scan, sequence);

  const gateTaken = gates && sssReaching ? snapToStartGate(gates, sssReaching) : null;
  const startGate = gateTaken?.startGate;
  const earlyStart = gateTaken?.earlyStart;

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
    ...(anchors.essIsFallback ? { essFallback: 'last_turnpoint' as const } : {}),
    ...(deadlineInfo ? { deadline: deadlineInfo } : {}),
    ...(launchWindowInfo ? { launchWindow: launchWindowInfo } : {}),
  };
}

// ---------------------------------------------------------------------------
// The pipeline's steps. Each is private to this module and pure in its
// inputs; the FAI citation for a step lives with the step.
// ---------------------------------------------------------------------------

/**
 * The task's fixed geometry — the same for every pilot, computed once per
 * resolution pass.
 */
interface TaskGeometry {
  /** The optimized task line: one optimal tag point per turnpoint. */
  optimizedLine: { lat: number; lon: number }[];
  /** Per task index: the direction a crossing must have to count. */
  directions: TurnpointDirection[];
  /** segmentDistances[i] = optimized distance from task TP[i] to TP[i+1]. */
  segmentDistances: number[];
  /** The optimized task distance — the sum of the segments. */
  taskDistance: number;
}

/**
 * Optimized task line (one tag point per turnpoint), computed once. The
 * tag points feed best-progress's cheap 'approx' measure (candidate-start
 * ranking and the exact search's seed — the scored remaining distance is
 * the §8.6.1 per-fix route optimisation). It also determines each
 * turnpoint's crossing direction: a cylinder containing the previous tag
 * point is an EXIT cylinder, reached by flying out of it.
 */
function computeTaskGeometry(task: XCTask): TaskGeometry {
  const optimizedLine = calculateOptimizedTaskLine(task);
  const directions = computeTurnpointDirections(task, optimizedLine);
  const segmentDistances: number[] = [];
  for (let i = 1; i < optimizedLine.length; i++) {
    segmentDistances.push(andoyerDistance(
      optimizedLine[i - 1].lat, optimizedLine[i - 1].lon,
      optimizedLine[i].lat, optimizedLine[i].lon,
    ));
  }
  const taskDistance = segmentDistances.reduce((sum, d) => sum + d, 0);
  return { optimizedLine, directions, segmentDistances, taskDistance };
}

/** Where the scored flight starts and ends on the route. */
interface TaskAnchors {
  sssIdx: number;
  /** The first turnpoint is standing in for a start the task never declared. */
  sssIsFallback: boolean;
  essIdx: number;
  /** Goal is standing in for an end of speed section the task never declared. */
  essIsFallback: boolean;
  goalIdx: number;
  /**
   * Non-null when the task ends at a goal LINE (S7F §6.3.1): reaching and
   * remaining-distance for the goal position use line geometry.
   */
  goalLine: GoalLine | null;
}

function resolveTaskAnchors(task: XCTask): TaskAnchors {
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
  const goalLine = computeGoalLine(task);
  return { sssIdx, sssIsFallback, essIdx, essIsFallback, goalIdx, goalLine };
}

/**
 * Where the track began relative to each cylinder's detection edge.
 *
 * Feeds the presence-based reaching check in buildForwardPath for the
 * cylinder-never-crossed case (e.g. a goal cylinder so large the whole
 * flight stays inside it). The edge matches crossing detection: outer for
 * ENTER cylinders, inner for EXIT cylinders — so the state machine and
 * the track-start state always agree on which side of the band a fix is.
 */
function resolveTrackStartInside(
  task: XCTask,
  fixes: IGCFix[],
  { directions }: TaskGeometry,
  { goalIdx, goalLine }: TaskAnchors,
): boolean[] {
  const tolerance = task.cylinderTolerance ?? DEFAULT_CYLINDER_TOLERANCE;
  return task.turnpoints.map((tp, tpIdx) => {
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
}

/**
 * Filter SSS crossings by the required direction (e.g. EXIT for paragliding
 * races). If no SSS config or direction is unspecified, accept all crossings
 * for backward compat. The direction rule describes the explicit SSS
 * cylinder; in fallback mode the anchor is the first turnpoint (not a
 * configured start), so no filter applies.
 */
function filterStartCrossingsByDirection(
  task: XCTask,
  allCrossings: CylinderCrossing[],
  { sssIdx, sssIsFallback }: TaskAnchors,
): CylinderCrossing[] {
  const requiredDirection = sssIsFallback
    ? undefined
    : task.sss?.direction?.toLowerCase() as 'enter' | 'exit' | undefined;
  const allSSSCrossings = sssIdx >= 0
    ? allCrossings.filter(c => c.taskIndex === sssIdx)
    : [];
  return requiredDirection
    ? allSSSCrossings.filter(c => c.direction === requiredDirection)
    : allSSSCrossings;
}

/** The times that bound one pilot's scored flight. */
interface TimingWindow {
  /** Sorted absolute start-gate times (§6.3.3/§8.3); null when ungated. */
  gates: number[] | null;
  /** The goal deadline (§8.3.c); null when there is none or it is mis-set. */
  deadlineMs: number | null;
  /** The launch window's open time (§8.6.1); null when it doesn't apply. */
  windowOpenMs: number | null;
  /** The scored-flight end: the deadline and a stop's window end, whichever is first. */
  clipMs: number | null;
}

interface TimingWindowParams {
  task: XCTask;
  fixes: IGCFix[];
  anchors: TaskAnchors;
  /** SSS crossings that passed the direction rule, in time order. */
  directionSSSCrossings: CylinderCrossing[];
  stopClip: StopClip | null;
}

function resolveTimingWindow(params: TimingWindowParams): TimingWindow {
  const { task, fixes, anchors, directionSSSCrossings, stopClip } = params;
  const { sssIsFallback } = anchors;

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

  // The scored-flight end: the task deadline and — for a stopped task — the
  // pilot's scored-window end (§12.3.4), whichever comes first. Crossings
  // after it can't count and best-progress distance stops there.
  const stopEndMs = stopClip?.windowEndMs ?? null;
  const clipMs = deadlineMs === null
    ? stopEndMs
    : stopEndMs === null
      ? deadlineMs
      : Math.min(deadlineMs, stopEndMs);

  return { gates, deadlineMs, windowOpenMs, clipMs };
}

/**
 * The deadline as the explanation reports it (§8.3.c): how many crossings it
 * ignored, and whether the pilot kept flying past it. Counted over ALL
 * crossings, not the scored ones — the ignored crossings are the finding.
 */
function describeTaskDeadline(
  deadlineMs: number | null,
  allCrossings: CylinderCrossing[],
  fixes: IGCFix[],
): TaskDeadlineInfo | undefined {
  if (deadlineMs === null) return undefined;
  const crossingsAfter = allCrossings.reduce(
    (n, c) => n + (c.time.getTime() > deadlineMs ? 1 : 0), 0,
  );
  return {
    time: new Date(deadlineMs),
    crossingsAfter,
    trackContinuesPastDeadline:
      fixes.length > 0 && fixes[fixes.length - 1].time.getTime() > deadlineMs,
  };
}

/** Group scored crossings by taskIndex, each list left in time order. */
function groupCrossingsByTurnpoint(
  scoredCrossings: CylinderCrossing[],
): Map<number, CylinderCrossing[]> {
  const crossingsByTP = new Map<number, CylinderCrossing[]>();
  for (const crossing of scoredCrossings) {
    const arr = crossingsByTP.get(crossing.taskIndex);
    if (arr) {
      arr.push(crossing);
    } else {
      crossingsByTP.set(crossing.taskIndex, [crossing]);
    }
  }
  return crossingsByTP;
}

interface StartCrossingsParams {
  task: XCTask;
  fixes: IGCFix[];
  anchors: TaskAnchors;
  directionSSSCrossings: CylinderCrossing[];
  timing: TimingWindow;
}

interface StartCrossings {
  /** The start crossings a sequence may be built from, in time order. */
  sssCrossings: CylinderCrossing[];
  launchWindowInfo: LaunchWindowInfo | undefined;
  /** How the chosen start reaching is explained on the report card. */
  startSelectionReason: TurnpointReaching['selectionReason'];
}

/**
 * Start validation order: deadline clip (the caller's), direction (already
 * applied), launch-window open, then gates. Pre-window crossings are dropped
 * outright (§8.6.1 — launching before the window has no scored-with-penalty
 * provision); pre-gate crossings are kept only when EVERY crossing is
 * pre-gate, the §12.2 "jumped the gun" case (HG scores the complete flight
 * with a penalty; the PG launch→SSS clamp happens in the scorer) with
 * earlyStart reporting the facts.
 */
function resolveStartCrossings(params: StartCrossingsParams): StartCrossings {
  const { task, fixes, anchors, directionSSSCrossings, timing } = params;
  const { sssIdx, sssIsFallback } = anchors;
  const { gates, windowOpenMs, clipMs } = timing;

  let sssCrossings = clipMs === null
    ? directionSSSCrossings
    : directionSSSCrossings.filter(c => c.time.getTime() <= clipMs);
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
        altitude: fixAltitude(first),
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

  return { sssCrossings, launchWindowInfo, startSelectionReason };
}

/**
 * How best-progress's cheap 'approx' mode measures the fix→next-turnpoint
 * distance for a pilot whose last reached turnpoint is lastReachedIdx —
 * see NextTPMeasure (the scored measurement is the §8.6.1 per-fix route
 * optimisation; this ranks candidate starts and seeds the exact search).
 * The nearest-edge rule after an exit cylinder applies only to INFERRED
 * exit turnpoints, not the declared-EXIT start: after a normal exit start
 * the onward route is asymmetric and well-determined, so the tag point is
 * the better approximation there.
 */
function nextTPMeasurer(
  { directions, optimizedLine }: TaskGeometry,
  { sssIdx, goalIdx, goalLine }: TaskAnchors,
): (lastReachedIdx: number) => NextTPMeasure {
  return (lastReachedIdx: number): NextTPMeasure => {
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
}

/**
 * Everything the flown-distance measurement depends on, fixed for the whole
 * pass — so the candidate loop and the final answer measure identically.
 */
interface ProgressScan {
  task: XCTask;
  fixes: IGCFix[];
  geometry: TaskGeometry;
  goalIdx: number;
  nextMeasureFor: (lastReachedIdx: number) => NextTPMeasure;
  /** The scored-flight end (§11.1, §12.3.4): the scan stops there. */
  clipMs: number | null;
  /** The §12.3.6 stopped-task altitude bonus; null when none applies. */
  altitudeBonus: { glideRatio: number; goalAltitude: number } | null;
}

/**
 * How far along the task a resolved sequence flew.
 *
 * A goal pilot flew the whole task. Anyone who reached at least one
 * turnpoint is credited to their best progress — the scanned fix with the
 * least remaining distance to goal — and gets that fix returned for the
 * explanation. A pilot with no reaching flew no scored distance.
 *
 * `mode` selects the remaining-distance measurement (see
 * {@link computeBestProgress}): 'exact' — the §8.6.1 per-fix shortest-path
 * optimisation — for the sequence that scores; 'approx' — the cheap
 * tag/edge measure — for ranking candidate start choices against each
 * other, where hundreds of exact optimisations per pilot would buy
 * nothing (candidates differ by whole turnpoints, not metres).
 */
function measureSequenceDistance(
  scan: ProgressScan,
  sequence: TurnpointReaching[],
  mode: 'approx' | 'exact' = 'exact',
): { bestProgress: BestProgress | null; flownDistance: number } {
  const { task, fixes, geometry, goalIdx, nextMeasureFor, clipMs, altitudeBonus } = scan;
  const madeGoal = sequence.length > 0 &&
    sequence[sequence.length - 1].taskIndex === goalIdx;
  if (madeGoal) return { bestProgress: null, flownDistance: geometry.taskDistance };
  if (sequence.length === 0) return { bestProgress: null, flownDistance: 0 };

  const lastReaching = sequence[sequence.length - 1];
  const { remainingTPs, remainingLegDistances } =
    buildRemainingPath(task, lastReaching.taskIndex, geometry.segmentDistances);
  const bestProgress = computeBestProgress({
    task,
    lastReachedIndex: lastReaching.taskIndex,
    fixes,
    lastReachingTime: lastReaching.time.getTime(),
    remainingTPs,
    remainingLegDistances,
    nextMeasure: nextMeasureFor(lastReaching.taskIndex),
    deadlineMs: clipMs,
    altitudeBonus,
  }, mode);
  return {
    bestProgress,
    flownDistance: bestProgress
      ? geometry.taskDistance - bestProgress.distanceToGoal
      : 0,
  };
}

interface BestSequenceParams {
  /** Non-empty: the caller returns the no-start result before getting here. */
  sssCrossings: CylinderCrossing[];
  crossingsByTP: Map<number, CylinderCrossing[]>;
  anchors: TaskAnchors;
  geometry: TaskGeometry;
  startedInsideTP: boolean[];
  startSelectionReason: TurnpointReaching['selectionReason'];
  scan: ProgressScan;
}

/**
 * For multi-gate/elapsed-time starts: iterate the SSS crossings, try each,
 * and keep the best path — most TPs reached, then most flown distance, then
 * latest SSS (step 8 of the algorithm on {@link resolveTurnpointSequence}).
 */
function chooseBestSequence(params: BestSequenceParams): TurnpointReaching[] {
  const {
    sssCrossings, crossingsByTP, anchors, geometry,
    startedInsideTP, startSelectionReason, scan,
  } = params;
  const { sssIdx, essIdx, goalIdx } = anchors;

  // Iterate SSS crossings backwards, try each, keep best path
  let bestSequence: TurnpointReaching[] | null = null;
  let bestTPs = 0;
  let bestFlownDist = 0;
  let bestSSSTime = 0;

  for (let i = sssCrossings.length - 1; i >= 0; i--) {
    const sssCrossing = sssCrossings[i];
    const candidateSequence = buildForwardPath({
      sssCrossing, crossingsByTP, sssIdx, essIdx, goalIdx,
      startedInsideTP, directions: geometry.directions, startSelectionReason,
    });

    const tpsReached = candidateSequence.length;
    // Ranking only — the winner is re-measured with the exact §8.6.1
    // measurement by the caller (see measureSequenceDistance's mode).
    const { flownDistance: candidateFlownDist } =
      measureSequenceDistance(scan, candidateSequence, 'approx');
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

  return bestSequence!;
}

/**
 * Start-gate snapping (§8.3.1): the pilot's official start time is the
 * last gate at or before their crossing; a crossing after the last gate
 * takes the last gate; an early starter is anchored to the first gate.
 */
function snapToStartGate(
  gates: number[],
  sssReaching: TurnpointReaching,
): { startGate: StartGateTaken; earlyStart?: EarlyStart } {
  const crossingMs = sssReaching.time.getTime();
  const gateIdx = gateIndexForCrossing(gates, crossingMs);
  if (gateIdx < 0) {
    return {
      startGate: { time: new Date(gates[0]), index: 0, gateCount: gates.length },
      earlyStart: {
        crossingTime: sssReaching.time,
        firstGateTime: new Date(gates[0]),
        secondsEarly: (gates[0] - crossingMs) / 1000,
      },
    };
  }
  return {
    startGate: { time: new Date(gates[gateIdx]), index: gateIdx, gateCount: gates.length },
  };
}

/** Revive a JSON-round-tripped {@link TurnpointSequenceResult}. */
export function reviveTurnpointSequenceResult(
  raw: TurnpointSequenceResultJSON,
): TurnpointSequenceResult {
  const revive = <T extends { time: string | number }>(
    v: T,
  ): Omit<T, 'time'> & { time: Date } => ({ ...v, time: new Date(v.time) });
  const { startGate, earlyStart, deadline, launchWindow, stopInfo, ...rest } = raw;
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
    ...(stopInfo
      ? {
          stopInfo: {
            ...stopInfo,
            stopTime: new Date(stopInfo.stopTime),
            windowEnd: new Date(stopInfo.windowEnd),
          },
        }
      : {}),
  };
}
