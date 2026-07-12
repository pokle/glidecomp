/**
 * Open Distance Task Scoring
 *
 * Scores an "open distance" task: every pilot launches from the same spot
 * (a single TAKEOFF turnpoint) and flies as far as they can — there is no
 * goal and no speed section. The take-off cylinder exists only to define
 * where scored distance begins: a pilot's score is the metres of open
 * distance achieved — the straight-line (WGS84) distance from the take-off
 * cylinder *edge* to the furthest fix they reached, i.e. the furthest fix's
 * distance from the cylinder centre minus the radius. Where (or how many
 * times) the pilot crossed the cylinder boundary is irrelevant; a pilot
 * whose every fix stays inside the cylinder never left it and scores 0.
 *
 * This is the classic free-flight "open distance" format, as opposed to the
 * CIVL GAP race-to-goal / elapsed-time scoring in gap-scoring.ts. It is the
 * same measurement {@link manualOpenDistanceGeometry} applies to a track-less
 * pilot's landing point.
 *
 * The result reuses the GAP {@link TaskScoreResult} shape so the competition
 * API can map pilots to scores identically for both formats. GAP-only fields
 * (time / leading / arrival points, validity, speed section) carry neutral
 * placeholder values here — they do not apply to open distance.
 */

import type { XCTask } from './xctsk-parser';
import type { TurnpointSequenceResult } from './turnpoint-sequence';
import { andoyerDistance, calculateBearingRadians, destinationPoint } from './geo';
import {
  DEFAULT_GAP_PARAMETERS,
  type PilotFlight,
  type PilotScore,
  type TaskScoreResult,
  type TaskStats,
} from './gap-scoring';

/**
 * Whether a task is an open-distance task: a single TAKEOFF turnpoint (the
 * geometry the competition backend enforces for open-distance comps), or a
 * task that declares itself `OPEN-DISTANCE`. Lets the UI pick the right
 * scoring treatment from the task alone, without competition context.
 */
export function isOpenDistanceTask(task: XCTask): boolean {
  if (task.taskType === 'OPEN-DISTANCE') return true;
  return task.turnpoints.length === 1 && task.turnpoints[0].type === 'TAKEOFF';
}

/**
 * The two endpoints of one flight's scored open-distance line, plus the
 * distance between them. `origin` is the point on the take-off cylinder edge
 * on the bearing to the furthest fix — the start of the scored line. It is a
 * derived point, not a track fix (which is why it carries no fix index);
 * `furthest` is the fix the scored distance is measured to.
 */
export interface OpenDistanceGeometry {
  origin: { latitude: number; longitude: number };
  furthest: { latitude: number; longitude: number; fixIndex: number };
  /** Straight-line distance origin → furthest, metres. */
  distance: number;
}

/**
 * Resolve the scored open-distance geometry for one flight: the furthest fix
 * from the take-off cylinder centre, and the point on the cylinder edge toward
 * it that the scored distance is measured from. Boundary crossings play no
 * part — a mid-flight return through the launch cylinder changes nothing.
 * Returns null for a pilot who never leaves the take-off cylinder (every fix
 * inside it; scored 0, nothing to draw).
 *
 * This is the explainable/drawable form of {@link openDistanceForFlight} —
 * same origin and distance, but keeping both endpoints so the UI can render
 * the scored line and annotate it.
 */
export function openDistanceGeometryForFlight(
  task: XCTask,
  pilot: PilotFlight,
): OpenDistanceGeometry | null {
  const takeoff = task.turnpoints[0];
  if (pilot.fixes.length === 0 || !takeoff) return null;
  const center = takeoff.waypoint;

  let furthestFromCenter = 0;
  let furthestIndex = 0;
  for (let i = 0; i < pilot.fixes.length; i++) {
    const fix = pilot.fixes[i];
    const d = andoyerDistance(center.lat, center.lon, fix.latitude, fix.longitude);
    if (d > furthestFromCenter) {
      furthestFromCenter = d;
      furthestIndex = i;
    }
  }

  const distance = furthestFromCenter - takeoff.radius;
  if (distance <= 0) return null; // never left the take-off cylinder

  const furthestFix = pilot.fixes[furthestIndex];
  const bearing = calculateBearingRadians(
    center.lat, center.lon,
    furthestFix.latitude, furthestFix.longitude,
  );
  const edge = destinationPoint(center.lat, center.lon, takeoff.radius, bearing);

  return {
    origin: { latitude: edge.lat, longitude: edge.lon },
    furthest: {
      latitude: furthestFix.latitude,
      longitude: furthestFix.longitude,
      fixIndex: furthestIndex,
    },
    distance,
  };
}

/**
 * Open distance (metres) for one flight: the furthest fix's distance from the
 * take-off cylinder centre minus the cylinder radius — how far beyond the
 * cylinder edge the pilot got. Returns 0 for a pilot who never leaves the
 * take-off cylinder.
 *
 * This is the field-independent, cacheable per-track unit — it depends only on
 * the pilot's own track and the take-off, so the backend caches it per track
 * (mirrors {@link toFlightScoringData} for GAP).
 */
export function openDistanceForFlight(task: XCTask, pilot: PilotFlight): number {
  return openDistanceGeometryForFlight(task, pilot)?.distance ?? 0;
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
 * Per-pilot open-distance scoring input — the field-independent result of one
 * flight (its open distance in metres). Because it depends only on the pilot's
 * own track and the take-off, the backend caches it per track and reuses it
 * across recomputes (mirrors {@link FlightScoringData} for GAP).
 */
export interface OpenDistanceFlightData {
  pilotName: string;
  trackFile: string;
  /** Open distance flown in metres (take-off cylinder edge → furthest fix). */
  distance: number;
}

/**
 * Aggregate pre-computed per-pilot open distances into a task result: rank the
 * field furthest-first and build the (neutral) {@link TaskScoreResult}
 * scaffolding. Each pilot's total score equals their open distance in metres
 * (rounded). Open distance has no GAP validity, weighting, time/leading/arrival
 * points, or 1000-point pool — those fields exist only to satisfy the shared
 * result shape and are not surfaced in the open-distance UI.
 *
 * This is the field-aggregation half of open-distance scoring (mirrors
 * {@link scoreFlights} for GAP); the competition backend feeds it cached
 * per-track distances so unchanged tracks are never re-fetched or re-parsed.
 */
export function scoreOpenDistanceFlights(
  flights: OpenDistanceFlightData[],
  numPresent?: number,
): TaskScoreResult {
  const pilotScores: PilotScore[] = flights.map((flight) => {
    const distance = flight.distance;
    const score = Math.round(distance);
    return {
      pilotName: flight.pilotName,
      trackFile: flight.trackFile,
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
    numPresent: numPresent ?? flights.length,
    numFlying: flights.length,
    numInGoal: 0,
    numReachedESS: 0,
    bestDistance,
    bestTime: null,
    goalRatio: 0,
    taskDistance: 0,
  };

  return {
    parameters: DEFAULT_GAP_PARAMETERS,
    taskValidity: { launch: 1, distance: 1, time: 1, task: 1 },
    weights: { distance: 1, time: 0, leading: 0, arrival: 0 },
    availablePoints: { distance: 0, time: 0, leading: 0, arrival: 0, total: 0 },
    pilotScores,
    stats,
  };
}

/**
 * Score an open-distance task for a field of pilots: compute each pilot's open
 * distance from their fixes, then aggregate. Convenience wrapper over
 * {@link openDistanceForFlight} + {@link scoreOpenDistanceFlights} — the
 * backend calls those two separately so it can cache the per-track distance.
 *
 * @param task    The task — its first turnpoint is the take-off. Additional
 *                turnpoints (if any) are ignored; distance is always open
 *                distance from the take-off cylinder edge.
 * @param pilots  Parsed flights to score.
 * @param numPresent Optional count of pilots present (for stats only).
 */
export function scoreOpenDistance(
  task: XCTask,
  pilots: PilotFlight[],
  numPresent?: number,
): TaskScoreResult {
  const flights: OpenDistanceFlightData[] = pilots.map((pilot) => ({
    pilotName: pilot.pilotName,
    trackFile: pilot.trackFile,
    distance: openDistanceForFlight(task, pilot),
  }));
  return scoreOpenDistanceFlights(flights, numPresent);
}
