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
 * @see /docs/event-detection/turnpoint-sequence-algorithms-research.md
 * @see FAI Sporting Code Section 7F (CIVL GAP)
 */

import type { XCTask } from './xctsk-parser';
import type { IGCFix } from './igc-parser';
import { andoyerDistance, isInsideCylinder } from './geo';
import { getSSSIndex, getEffectiveSSSIndex, getESSIndex, getEffectiveESSIndex, getGoalIndex } from './xctsk-parser';
import { calculateOptimizedTaskLine } from './task-optimizer';

// ---------------------------------------------------------------------------
// Raw crossing detection
// ---------------------------------------------------------------------------

/**
 * A single boundary crossing of a turnpoint cylinder.
 *
 * Recorded when consecutive tracklog fixes lie on opposite sides of a
 * cylinder boundary. Crossings are tracked per task position (index into
 * XCTask.turnpoints[]), NOT per waypoint — the same waypoint appearing
 * at two task positions produces independent crossings.
 */
export interface CylinderCrossing {
  /** Index into XCTask.turnpoints[] (task position, not waypoint identity) */
  taskIndex: number;

  /** Index of the fix AFTER the boundary transition in the IGCFix[] array */
  fixIndex: number;

  /** Interpolated time at the cylinder boundary */
  time: Date;

  /** Interpolated latitude at the cylinder boundary */
  latitude: number;

  /** Interpolated longitude at the cylinder boundary */
  longitude: number;

  /** Whether the pilot crossed inward (enter) or outward (exit) */
  direction: 'enter' | 'exit';

  /** Interpolated GNSS altitude at the cylinder boundary (meters) */
  altitude: number;

  /** Distance from the crossing point to the cylinder center (meters) */
  distanceToCenter: number;
}

// ---------------------------------------------------------------------------
// Resolved sequence
// ---------------------------------------------------------------------------

/**
 * A scored turnpoint reaching — one entry in the resolved sequence.
 *
 * "Reaching" is the CIVL GAP term for when a turnpoint is officially
 * achieved for scoring purposes. The algorithm selects one reaching from
 * potentially many raw crossings per task position.
 */
export interface TurnpointReaching {
  /** Index into XCTask.turnpoints[] */
  taskIndex: number;

  /** Fix index in the IGCFix[] array */
  fixIndex: number;

  /** Reaching time (interpolated crossing time) */
  time: Date;

  /** Latitude at the crossing point */
  latitude: number;

  /** Longitude at the crossing point */
  longitude: number;

  /** Interpolated GNSS altitude at the crossing point (meters) */
  altitude: number;

  /**
   * Why this crossing was selected over other candidates.
   * Designed to be explainable to pilots:
   * - 'last_before_next': SSS rule — last crossing before continuing to next TP
   * - 'first_after_previous': Standard rule — first crossing after previous TP reached
   * - 'first_crossing': ESS rule — always first crossing, no re-tries
   * - 'track_start': No-SSS fallback only — the track began outside the first
   *   turnpoint's cylinder with no crossing, so the first fix anchors the start
   */
  selectionReason: 'last_before_next' | 'first_after_previous' | 'first_crossing' | 'track_start';

  /**
   * How many candidate crossings existed for this task position.
   * Helps the UI explain: "3 crossings detected, this one was selected because..."
   */
  candidateCount: number;
}

// ---------------------------------------------------------------------------
// Distance and progress
// ---------------------------------------------------------------------------

/**
 * Furthest progress past the last reached turnpoint.
 * Used for distance scoring when the pilot doesn't make goal.
 *
 * Per CIVL GAP: flown distance = task distance − shortest remaining
 * distance to goal. This records the tracklog point where that remaining
 * distance was minimized.
 */
export interface BestProgress {
  /** Fix index where minimum remaining distance occurs */
  fixIndex: number;

  /** Time at the best progress point */
  time: Date;

  /** Latitude at the best progress point */
  latitude: number;

  /** Longitude at the best progress point */
  longitude: number;

  /** Shortest remaining distance to goal from this point (meters) */
  distanceToGoal: number;
}

/**
 * Per-leg distance breakdown for transparency.
 * One entry per task leg (between consecutive turnpoints in the task).
 */
export interface LegDistance {
  /** Task index of the leg start turnpoint */
  fromTaskIndex: number;

  /** Task index of the leg end turnpoint */
  toTaskIndex: number;

  /** Optimized leg distance in meters (shortest path touching cylinder edges) */
  distance: number;

  /** Whether the pilot completed this leg (reached the toTaskIndex turnpoint) */
  completed: boolean;
}

// ---------------------------------------------------------------------------
// Complete result
// ---------------------------------------------------------------------------

/**
 * Complete result of turnpoint sequence resolution for one flight.
 *
 * Designed for transparency — contains all data needed to explain
 * the scoring decision to the pilot in the UI: raw crossings, resolved
 * sequence with selection reasons, distance breakdown per leg, and
 * speed section timing.
 */
export interface TurnpointSequenceResult {
  /** All raw cylinder crossings detected across all task positions, sorted by time */
  crossings: CylinderCrossing[];

  /**
   * Resolved sequence of turnpoint reachings in task order.
   * Only includes turnpoints that were actually reached.
   * Each entry includes selectionReason explaining why that crossing was chosen.
   */
  sequence: TurnpointReaching[];

  /** The scored start (SSS reaching), or null if pilot never started */
  sssReaching: TurnpointReaching | null;

  /** The ESS reaching, or null if ESS not reached */
  essReaching: TurnpointReaching | null;

  /** True if the pilot completed the entire task (reached goal) */
  madeGoal: boolean;

  /** Index of last reached TP in XCTask.turnpoints[], -1 if none reached */
  lastTurnpointReached: number;

  /** Best progress past last reached TP; null if made goal or never started */
  bestProgress: BestProgress | null;

  // --- Distance scoring ---

  /**
   * Total optimized task distance in meters (from the first turnpoint to
   * goal via cylinder edges). When the first turnpoint is a TAKEOFF, the
   * launch→SSS leg is included; pass a task trimmed to the SSS to exclude
   * it (see taskForDistanceOrigin in gap-scoring).
   */
  taskDistance: number;

  /**
   * Scored flown distance in meters.
   * - Goal pilots: taskDistance
   * - Non-goal: taskDistance - bestProgress.distanceToGoal
   * - No start: 0
   */
  flownDistance: number;

  /**
   * Per-leg distance breakdown. One entry per consecutive turnpoint pair.
   * Shows optimized distance and whether the pilot completed each leg.
   */
  legs: LegDistance[];

  // --- Speed scoring ---

  /**
   * Speed section time in seconds (SSS reaching time to ESS reaching time).
   * Null if SSS or ESS not reached.
   */
  speedSectionTime: number | null;

  /**
   * How the start was anchored when the task defines no SSS-typed turnpoint
   * (a common task-setting mistake that would otherwise zero every score):
   * - 'first_turnpoint' — crossings of the first turnpoint (usually the
   *   TAKEOFF) acted as the start
   * - 'track_start' — the track began outside the first turnpoint's cylinder
   *   with no crossing (e.g. the logger started after launch), so the first
   *   fix anchored the sequence
   * Absent when the task has an explicit SSS turnpoint.
   */
  startFallback?: 'first_turnpoint' | 'track_start';

  /**
   * Set when the task defines no ESS-typed turnpoint (the other half of the
   * mis-set-task trap): the speed section is taken to end at goal — the last
   * turnpoint — per the usual race-to-goal convention, so speed-section
   * times, time points, and arrival order still exist. Absent when the task
   * has an explicit ESS turnpoint.
   */
  essFallback?: 'last_turnpoint';
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Detect all cylinder boundary crossings in the tracklog.
 *
 * Scans consecutive fix pairs and records every transition across a
 * turnpoint cylinder boundary. Each crossing is tracked per task position
 * index, not per waypoint identity. Crossings are interpolated between
 * the two fixes that straddle the boundary.
 *
 * Exported separately so the UI can visualize all crossings on the map
 * independently of the sequence resolution.
 *
 * @param task - The competition task definition
 * @param fixes - The pilot's GPS tracklog
 * @returns All crossings sorted by time
 */
export function detectCylinderCrossings(
  task: XCTask,
  fixes: IGCFix[]
): CylinderCrossing[] {
  if (fixes.length < 2) return [];

  const crossings: CylinderCrossing[] = [];

  // CIVL GAP cylinder tolerance: expand radius for crossing detection.
  // Default 0.5% (Cat 2 maximum) to compensate for distance calculation differences.
  const tolerance = task.cylinderTolerance ?? 0.005;

  const DEG = Math.PI / 180;

  for (let tpIdx = 0; tpIdx < task.turnpoints.length; tpIdx++) {
    const tp = task.turnpoints[tpIdx];
    const centerLat = tp.waypoint.lat;
    const centerLon = tp.waypoint.lon;
    const radius = tp.radius * (1 + tolerance);

    // Conservative lat/lon bounding box around the cylinder. Any point inside
    // the cylinder is guaranteed to fall inside this box, so a fix outside the
    // box is definitely outside the cylinder and can skip the (much costlier)
    // ellipsoidal distance call. The denominators under-estimate metres-per-
    // degree and a 1% margin is added, so the box strictly contains the
    // cylinder — this is a pure speed-up with no effect on which fixes are
    // classified inside/outside. (Assumes tasks don't span the ±180° meridian,
    // the same assumption the linear crossing interpolation below already makes.)
    const latDelta = (radius / 110540) * 1.01;
    const cosLat = Math.cos((Math.abs(centerLat) + latDelta) * DEG);
    const lonDelta = (radius / (111000 * Math.max(cosLat, 1e-6))) * 1.01;

    const isInside = (lat: number, lon: number): boolean => {
      const dLat = lat - centerLat;
      if (dLat > latDelta || dLat < -latDelta) return false;
      const dLon = lon - centerLon;
      if (dLon > lonDelta || dLon < -lonDelta) return false;
      return andoyerDistance(lat, lon, centerLat, centerLon) <= radius;
    };

    let prevInside = isInside(fixes[0].latitude, fixes[0].longitude);

    for (let fixIdx = 1; fixIdx < fixes.length; fixIdx++) {
      const currInside = isInside(fixes[fixIdx].latitude, fixes[fixIdx].longitude);

      if (prevInside !== currInside) {
        const prevFix = fixes[fixIdx - 1];
        const currFix = fixes[fixIdx];
        const direction: 'enter' | 'exit' = currInside ? 'enter' : 'exit';

        // Interpolate crossing point between the two fixes
        const prevDist = andoyerDistance(
          prevFix.latitude, prevFix.longitude, centerLat, centerLon
        );
        const currDist = andoyerDistance(
          currFix.latitude, currFix.longitude, centerLat, centerLon
        );

        // Interpolate to the nominal radius (without tolerance)
        const nominalRadius = tp.radius;
        let t = (prevDist - nominalRadius) / (prevDist - currDist);
        t = Math.max(0, Math.min(1, t));

        const crossingLat = prevFix.latitude + t * (currFix.latitude - prevFix.latitude);
        const crossingLon = prevFix.longitude + t * (currFix.longitude - prevFix.longitude);
        const crossingAlt = prevFix.gnssAltitude + t * (currFix.gnssAltitude - prevFix.gnssAltitude);

        const prevTime = prevFix.time.getTime();
        const currTime = currFix.time.getTime();
        const crossingTime = new Date(prevTime + t * (currTime - prevTime));

        const distanceToCenter = andoyerDistance(
          crossingLat, crossingLon, centerLat, centerLon
        );

        crossings.push({
          taskIndex: tpIdx,
          fixIndex: fixIdx,
          time: crossingTime,
          latitude: crossingLat,
          longitude: crossingLon,
          altitude: crossingAlt,
          direction,
          distanceToCenter,
        });
      }

      prevInside = currInside;
    }
  }

  // Sort all crossings by time
  crossings.sort((a, b) => a.time.getTime() - b.time.getTime());

  return crossings;
}

/**
 * Build a forward path from an SSS crossing through subsequent turnpoints.
 * For each TP after SSS, find the first crossing with time > previous reaching time.
 */
function buildForwardPath(
  sssCrossing: CylinderCrossing,
  crossingsByTP: Map<number, CylinderCrossing[]>,
  sssIdx: number,
  essIdx: number,
  goalIdx: number,
  startSelectionReason: TurnpointReaching['selectionReason'] = 'last_before_next',
): TurnpointReaching[] {
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
  });

  let prevReachingTime = sssCrossing.time.getTime();

  // For each subsequent task position
  for (let tpIdx = sssIdx + 1; tpIdx <= goalIdx; tpIdx++) {
    const tpCrossings = crossingsByTP.get(tpIdx) ?? [];
    const isESS = tpIdx === essIdx;

    // Find first crossing after previous reaching time
    let validCrossing: CylinderCrossing | null = null;
    for (const crossing of tpCrossings) {
      if (crossing.time.getTime() > prevReachingTime) {
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
    });

    prevReachingTime = validCrossing.time.getTime();
  }

  return sequence;
}

/**
 * Build the list of remaining turnpoints and inter-TP leg distances
 * from the last reached task index to goal.
 */
function buildRemainingPath(
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
 */
function computeBestProgress(
  fixes: IGCFix[],
  lastReachingTime: number,
  remainingTPs: Array<{ lat: number; lon: number; radius: number }>,
  remainingLegDistances: number[],
  nextTagPoint: { lat: number; lon: number } | null,
): BestProgress | null {
  // Sum of optimized leg distances between remaining TPs (TP[1]→TP[2]→...→Goal)
  let interTPDistance = 0;
  for (const d of remainingLegDistances) {
    interTPDistance += d;
  }

  const nextTP = remainingTPs[0];
  let bestFix: { index: number; distToGoal: number } | null = null;

  for (let i = 0; i < fixes.length; i++) {
    const fix = fixes[i];
    if (fix.time.getTime() <= lastReachingTime) continue;

    // Distance to the next un-reached turnpoint. For an intermediate
    // turnpoint we measure to its optimal tag point, so the remaining route
    // stays continuous with the onward optimized legs (avoids the small
    // over-credit of measuring to the nearest edge then jumping to the
    // optimal tag). The goal cylinder has no onward leg, so the pilot only
    // needs to reach it — use the nearest edge there.
    const distToNextTP = nextTagPoint
      ? andoyerDistance(fix.latitude, fix.longitude, nextTagPoint.lat, nextTagPoint.lon)
      : Math.max(0, andoyerDistance(fix.latitude, fix.longitude, nextTP.lat, nextTP.lon) - nextTP.radius);
    // Total remaining = distance to next TP + optimized path from there to goal
    const distToGoal = distToNextTP + interTPDistance;

    if (!bestFix || distToGoal < bestFix.distToGoal) {
      bestFix = { index: i, distToGoal };
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
  };
}

/**
 * Resolve the turnpoint sequence for a flight against a competition task.
 *
 * Algorithm (per CIVL GAP / Section 7F):
 * 1. Detect all cylinder crossings per task position
 * 2. For SSS: use last valid crossing before continuing to next TP
 * 3. For other TPs: use first valid crossing after previous TP reached
 * 4. For ESS: always first crossing (no re-tries)
 * 5. For multi-gate/elapsed-time: iterate SSS crossings, keep best path
 *    (most TPs reached, then most flown distance, then latest SSS)
 * 6. Compute optimized leg distances and flown distance
 *
 * @param task - The competition task definition
 * @param fixes - The pilot's GPS tracklog
 * @returns Complete sequence result with scoring data and explanations
 */
export function resolveTurnpointSequence(
  task: XCTask,
  fixes: IGCFix[]
): TurnpointSequenceResult {
  const allCrossings = detectCylinderCrossings(task, fixes);
  // Optimized task line (one tag point per turnpoint), computed once. The
  // tag points feed best-progress so a pilot's remaining distance to goal
  // is measured to each cylinder's optimal tag — consistent with the leg
  // distances — rather than its nearest edge.
  const optimizedLine = calculateOptimizedTaskLine(task);
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

  // Build legs with default completed = false
  const legs: LegDistance[] = segmentDistances.map((dist, i) => ({
    fromTaskIndex: i,
    toTaskIndex: i + 1,
    distance: dist,
    completed: false,
  }));

  // Group crossings by taskIndex
  const crossingsByTP = new Map<number, CylinderCrossing[]>();
  for (const crossing of allCrossings) {
    const arr = crossingsByTP.get(crossing.taskIndex);
    if (arr) {
      arr.push(crossing);
    } else {
      crossingsByTP.set(crossing.taskIndex, [crossing]);
    }
  }

  // Filter SSS crossings by the required direction (e.g. EXIT for paragliding races).
  // If no SSS config or direction is unspecified, accept all crossings for backward compat.
  // The direction rule describes the explicit SSS cylinder; in fallback mode the
  // anchor is the first turnpoint (not a configured start), so no filter applies.
  const requiredDirection = sssIsFallback
    ? undefined
    : task.sss?.direction?.toLowerCase() as 'enter' | 'exit' | undefined;
  const allSSSCrossings = sssIdx >= 0 ? (crossingsByTP.get(sssIdx) ?? []) : [];
  let sssCrossings = requiredDirection
    ? allSSSCrossings.filter(c => c.direction === requiredDirection)
    : allSSSCrossings;

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
    };
  }

  // Iterate SSS crossings backwards, try each, keep best path
  let bestSequence: TurnpointReaching[] | null = null;
  let bestTPs = 0;
  let bestFlownDist = 0;
  let bestSSSTime = 0;

  for (let i = sssCrossings.length - 1; i >= 0; i--) {
    const sssCrossing = sssCrossings[i];
    const candidateSequence = buildForwardPath(
      sssCrossing, crossingsByTP, sssIdx, essIdx, goalIdx, startSelectionReason
    );

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
      const nextIdx = lastReaching.taskIndex + 1;
      const nextTag = nextIdx < goalIdx ? optimizedLine[nextIdx] : null;
      const progress = computeBestProgress(
        fixes, lastReaching.time.getTime(), remainingTPs, remainingLegDistances, nextTag
      );
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
    const nextIdx = lastReaching.taskIndex + 1;
    const nextTag = nextIdx < goalIdx ? optimizedLine[nextIdx] : null;
    bestProgress = computeBestProgress(
      fixes, lastReaching.time.getTime(), remainingTPs, remainingLegDistances, nextTag
    );
    flownDistance = bestProgress
      ? taskDistance - bestProgress.distanceToGoal
      : 0;
  }

  // Speed section time
  let speedSectionTime: number | null = null;
  if (sssReaching && essReaching) {
    speedSectionTime = (essReaching.time.getTime() - sssReaching.time.getTime()) / 1000;
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
    ...(startFallback ? { startFallback } : {}),
    ...(essIsFallback ? { essFallback: 'last_turnpoint' as const } : {}),
  };
}

// ---------------------------------------------------------------------------
// JSON wire form
// ---------------------------------------------------------------------------

/** {@link CylinderCrossing} as it arrives over JSON — `time` serialized. */
export type CylinderCrossingJSON = Omit<CylinderCrossing, 'time'> & {
  time: string | number;
};

/** {@link TurnpointReaching} as it arrives over JSON — `time` serialized. */
export type TurnpointReachingJSON = Omit<TurnpointReaching, 'time'> & {
  time: string | number;
};

/** {@link BestProgress} as it arrives over JSON — `time` serialized. */
export type BestProgressJSON = Omit<BestProgress, 'time'> & {
  time: string | number;
};

/**
 * {@link TurnpointSequenceResult} as it arrives over JSON. `Date` fields
 * serialize to ISO strings (JSON.stringify's default) or epoch milliseconds;
 * {@link reviveTurnpointSequenceResult} turns either back into `Date`s.
 * This is the wire format of the competition API's per-pilot analysis
 * endpoint, which feeds the score-details explanation.
 */
export interface TurnpointSequenceResultJSON
  extends Omit<
    TurnpointSequenceResult,
    'crossings' | 'sequence' | 'sssReaching' | 'essReaching' | 'bestProgress'
  > {
  crossings: CylinderCrossingJSON[];
  sequence: TurnpointReachingJSON[];
  sssReaching: TurnpointReachingJSON | null;
  essReaching: TurnpointReachingJSON | null;
  bestProgress: BestProgressJSON | null;
}

/** Revive a JSON-round-tripped {@link TurnpointSequenceResult}. */
export function reviveTurnpointSequenceResult(
  raw: TurnpointSequenceResultJSON,
): TurnpointSequenceResult {
  const revive = <T extends { time: string | number }>(
    v: T,
  ): Omit<T, 'time'> & { time: Date } => ({ ...v, time: new Date(v.time) });
  return {
    ...raw,
    crossings: raw.crossings.map(revive),
    sequence: raw.sequence.map(revive),
    sssReaching: raw.sssReaching ? revive(raw.sssReaching) : null,
    essReaching: raw.essReaching ? revive(raw.essReaching) : null,
    bestProgress: raw.bestProgress ? revive(raw.bestProgress) : null,
  };
}
