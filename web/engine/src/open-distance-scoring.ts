/**
 * Open Distance Task Scoring
 *
 * Scores an "open distance" task: every pilot launches from the same spot
 * (a single TAKEOFF turnpoint) and flies as far as they can — there is no
 * goal and no speed section. A pilot's score is simply the metres of open
 * distance achieved: the straight-line (WGS84) distance from the point the
 * pilot exits the take-off cylinder to the single furthest fix they reached.
 *
 * This is the classic free-flight "open distance" format, as opposed to the
 * CIVL GAP race-to-goal / elapsed-time scoring in gap-scoring.ts.
 *
 * The result reuses the GAP {@link TaskScoreResult} shape so the competition
 * API can map pilots to scores identically for both formats. GAP-only fields
 * (time / leading / arrival points, validity, speed section) carry neutral
 * placeholder values here — they do not apply to open distance.
 */

import type { XCTask } from './xctsk-parser';
import { detectCylinderCrossings, type TurnpointSequenceResult } from './turnpoint-sequence';
import { andoyerDistance, isInsideCylinder } from './geo';
import {
  DEFAULT_GAP_PARAMETERS,
  type PilotFlight,
  type PilotScore,
  type TaskScoreResult,
  type TaskStats,
} from './gap-scoring';

/**
 * The take-off origin for one pilot: the interpolated point at which the
 * pilot leaves the take-off cylinder, plus the fix index from which distance
 * is measured.
 */
interface OpenDistanceOrigin {
  latitude: number;
  longitude: number;
  /** Measure distance over fixes at or after this index. */
  fromFixIndex: number;
}

/**
 * Resolve the take-off exit origin for one flight.
 *
 * Origin = the pilot's *last* outward crossing of the take-off cylinder
 * (turnpoint index 0). Using the last exit — rather than the first — is
 * robust to GPS jitter and to pilots who bounce in and out of the cylinder
 * near launch before committing to the flight; it is the point at which they
 * definitively leave to go on task.
 *
 * When no take-off exit is detected there are two distinct cases:
 * - The pilot started *inside* the cylinder and never crossed out — they
 *   never left launch, so there is no scored distance (returns null → 0 m).
 * - The pilot's track began *outside* the cylinder (e.g. the logger started
 *   after launch): there is no boundary point to measure from, so the first
 *   fix is used as the origin and the flight still scores.
 *
 * A flight with no fixes, or a task with no turnpoints, has no origin (null).
 */
function resolveTakeoffExit(
  task: XCTask,
  fixes: PilotFlight['fixes'],
): OpenDistanceOrigin | null {
  const takeoff = task.turnpoints[0];
  if (fixes.length === 0 || !takeoff) return null;

  // detectCylinderCrossings returns crossings sorted by time; the take-off is
  // turnpoint 0, and each 'exit' crossing carries the interpolated boundary
  // point. The last such crossing is the definitive departure.
  const crossings = detectCylinderCrossings(task, fixes);
  let lastExit: (typeof crossings)[number] | null = null;
  for (const crossing of crossings) {
    if (crossing.taskIndex === 0 && crossing.direction === 'exit') {
      lastExit = crossing;
    }
  }

  if (lastExit) {
    return {
      latitude: lastExit.latitude,
      longitude: lastExit.longitude,
      fromFixIndex: lastExit.fixIndex,
    };
  }

  // No exit crossing. If the first fix is inside the take-off cylinder the
  // pilot never left (any departure would have produced an exit crossing), so
  // there is no scored distance. Otherwise the track started airborne outside
  // the cylinder — fall back to the first fix as the origin.
  const startedInside = isInsideCylinder(
    fixes[0].latitude, fixes[0].longitude,
    takeoff.waypoint.lat, takeoff.waypoint.lon, takeoff.radius,
  );
  if (startedInside) return null;

  return {
    latitude: fixes[0].latitude,
    longitude: fixes[0].longitude,
    fromFixIndex: 0,
  };
}

/**
 * Open distance (metres) for one flight: the furthest straight-line distance
 * from the take-off exit origin to any fix flown at or after that exit.
 * Returns 0 for a pilot who never leaves the take-off cylinder.
 */
function openDistanceForFlight(task: XCTask, pilot: PilotFlight): number {
  const origin = resolveTakeoffExit(task, pilot.fixes);
  if (!origin) return 0;

  let furthest = 0;
  for (let i = origin.fromFixIndex; i < pilot.fixes.length; i++) {
    const fix = pilot.fixes[i];
    const d = andoyerDistance(origin.latitude, origin.longitude, fix.latitude, fix.longitude);
    if (d > furthest) furthest = d;
  }
  return furthest;
}

/**
 * Build a minimal {@link TurnpointSequenceResult} for open distance. There is
 * no start/ESS/goal and no per-leg task line, so most fields are empty; the
 * scored open distance is carried in `flownDistance` for transparency.
 */
function openDistanceTurnpointResult(distance: number): TurnpointSequenceResult {
  return {
    crossings: [],
    sequence: [],
    sssReaching: null,
    essReaching: null,
    madeGoal: false,
    lastTurnpointReached: -1,
    bestProgress: null,
    taskDistance: 0,
    flownDistance: distance,
    legs: [],
    speedSectionTime: null,
  };
}

/**
 * Score an open-distance task for a field of pilots.
 *
 * Each pilot's total score equals their open distance in metres (rounded to
 * the nearest metre); pilots are ranked by that distance, furthest first.
 *
 * @param task    The task — its first turnpoint is the take-off. Additional
 *                turnpoints (if any) are ignored; distance is always open
 *                distance from the take-off exit.
 * @param pilots  Parsed flights to score.
 * @param numPresent Optional count of pilots present (for stats only).
 */
export function scoreOpenDistance(
  task: XCTask,
  pilots: PilotFlight[],
  numPresent?: number,
): TaskScoreResult {
  const scored = pilots.map((pilot) => ({
    pilot,
    distance: openDistanceForFlight(task, pilot),
  }));

  const pilotScores: PilotScore[] = scored.map(({ pilot, distance }) => {
    const score = Math.round(distance);
    return {
      pilotName: pilot.pilotName,
      trackFile: pilot.trackFile,
      flownDistance: distance,
      speedSectionTime: null,
      madeGoal: false,
      reachedESS: false,
      // The distance component IS the whole score for open distance.
      distancePoints: score,
      distanceLinearPoints: score,
      distanceDifficultyPoints: 0,
      timePoints: 0,
      leadingPoints: 0,
      arrivalPoints: 0,
      totalScore: score,
      rank: 0, // assigned after sorting
      leadingCoefficient: 0,
      turnpointResult: openDistanceTurnpointResult(distance),
    };
  });

  // Rank by distance, furthest first (ties share a rank).
  pilotScores.sort((a, b) => b.flownDistance - a.flownDistance);
  for (let i = 0; i < pilotScores.length; i++) {
    if (i === 0 || pilotScores[i].flownDistance !== pilotScores[i - 1].flownDistance) {
      pilotScores[i].rank = i + 1;
    } else {
      pilotScores[i].rank = pilotScores[i - 1].rank;
    }
  }

  const bestDistance = pilotScores.length > 0 ? pilotScores[0].flownDistance : 0;

  const stats: TaskStats = {
    numPresent: numPresent ?? pilots.length,
    numFlying: pilots.length,
    numInGoal: 0,
    numReachedESS: 0,
    bestDistance,
    bestTime: null,
    goalRatio: 0,
    taskDistance: 0,
  };

  // Open distance has no GAP validity, weighting, or 1000-point pool. These
  // fields exist only to satisfy the shared TaskScoreResult shape and are not
  // surfaced in the open-distance UI.
  return {
    parameters: DEFAULT_GAP_PARAMETERS,
    taskValidity: { launch: 1, distance: 1, time: 1, task: 1 },
    weights: { distance: 1, time: 0, leading: 0, arrival: 0 },
    availablePoints: { distance: 0, time: 0, leading: 0, arrival: 0, total: 0 },
    pilotScores,
    stats,
  };
}
