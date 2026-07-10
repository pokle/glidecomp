/**
 * Manual Flight Scoring
 *
 * Scores a pilot who took off (verified by launch marshals) but has no valid
 * tracklog — FAI S7F §8.4. Instead of a GPS track, the input is the last
 * turnpoint the pilot legally reached plus where they landed. From those two
 * facts this module computes a made-good distance along the optimised course
 * and produces a synthetic {@link FlightScoringData} that feeds `scoreFlights`
 * exactly like a tracked pilot (counting toward `numFlying`, S7F §9.1).
 *
 * The "last turnpoint reached" is essential, not optional: scored land-out
 * distance is a function of the trajectory (which cylinders were tagged, in
 * order), not just the endpoint. Two pilots landing at the same coordinate —
 * one who rounded TP1→TP2→TP3, one who flew straight rounding nothing —
 * score very differently, and a landing point alone can't tell them apart.
 *
 * All geometry reuses {@link calculateOptimizedTaskLine} and the same
 * remaining-distance routing as `computeBestProgress` (turnpoint-sequence.ts),
 * so a manual flight scores consistently with how a real track at the same
 * point and turnpoint would.
 *
 * @see /docs/... issue #306
 * @see FAI Sporting Code Section 7F (CIVL GAP) §8.4
 */

import type { XCTask } from './xctsk-parser';
import { getGoalIndex } from './xctsk-parser';
import { calculateOptimizedTaskLine } from './task-optimizer';
import { andoyerDistance } from './geo';
import type { FlightScoringData } from './gap-scoring';

/**
 * A manually-reported flight for a pilot with no tracklog.
 *
 * `lastReachedIndex` and `landing` are given in the frame of the task passed
 * alongside them — which must be the SAME task used for scoring, i.e. already
 * trimmed for the distance origin (see `taskForDistanceOrigin` in
 * gap-scoring.ts). Indices are positions in `task.turnpoints[]`.
 */
export interface ManualFlight {
  /** Pilot display name (from the roster). */
  pilotName: string;
  /**
   * Unique key used to pair the score back to the pilot, mirroring a track's
   * file path — e.g. `manual:<comp_pilot_id>`. Must be distinct from any real
   * track's `trackFile` in the same field.
   */
  trackFile: string;
  /**
   * Index into `task.turnpoints[]` of the last turnpoint the pilot legally
   * reached — the admin-vouched anchor. Use the (effective) SSS index for a
   * pilot who only left the start, the goal index for a pilot in goal.
   */
  lastReachedIndex: number;
  /** Where the pilot landed (or their position in goal). */
  landing: { lat: number; lon: number };
  /**
   * Speed-section time in seconds, for a pilot in goal
   * (`lastReachedIndex` === goal). Enables time / speed points. Ignored for a
   * land-out. In a gated race this should already be the effective
   * gate-based speed-section time (S7F §8.7), matching a tracked pilot.
   */
  durationSeconds?: number | null;
}

/**
 * The made-good geometry of a manual flight — the scored distance AND the
 * routed line the UI draws, so a track-less pilot's score-details page can
 * show the landing point and the remaining route to goal exactly like a
 * landed-out tracked pilot's best-progress line.
 */
export interface ManualFlightGeometry {
  /** Scored distance made good in metres (floored at the banked distance). */
  madeGood: number;
  /** Remaining routed distance from the landing point to goal in metres
   * (0 when in goal). Drawn as the routed line's label. */
  distanceToGoal: number;
  /** Whether the pilot reached goal (last reached turnpoint is the goal). */
  madeGoal: boolean;
  /** The landing point. */
  landing: { lat: number; lon: number };
  /**
   * Routed polyline for the map: [landing, next-TP tag point, …tag points…,
   * goal tag point] — the same "from here, through each un-reached turnpoint,
   * to goal" line drawn for a landed-out track. Empty when in goal (nothing
   * remains) or when there is no scored start.
   */
  routeToGoal: { lat: number; lon: number }[];
  /** Index of the last reached turnpoint (as passed in). */
  lastReachedIndex: number;
}

/**
 * Compute the full made-good geometry of a manual flight.
 *
 * The scored distance mirrors the CIVL GAP flown-distance rule for a single
 * point: `madeGood = taskDistance − remaining(point, from lastReachedIndex)`,
 * where `remaining` routes from the landing point to the next un-reached
 * turnpoint's optimal tag point, then along the optimised legs to goal — the
 * exact routing `computeBestProgress` uses per fix (an intermediate turnpoint
 * is measured to its tag point; the goal cylinder to its nearest edge).
 *
 * Turnpoint order is respected two ways:
 * - `madeGood` is floored at the optimised distance already banked by reaching
 *   `lastReachedIndex` — reaching a turnpoint can never score less than getting
 *   there, however far back the pilot then landed.
 * - A landing point beyond the next turnpoint is measured by closest approach
 *   to that turnpoint, never credited past it.
 *
 * @param task - The scoring task (already trimmed for the distance origin).
 * @param lastReachedIndex - Position in `task.turnpoints[]` of the last reached
 *   turnpoint. < 0 → no start; ≥ goal → in goal.
 * @param point - The landing point.
 */
export function manualFlightGeometry(
  task: XCTask,
  lastReachedIndex: number,
  point: { lat: number; lon: number },
): ManualFlightGeometry {
  const optimizedLine = calculateOptimizedTaskLine(task);
  const goalIdx = getGoalIndex(task);
  const base: ManualFlightGeometry = {
    madeGood: 0,
    distanceToGoal: 0,
    madeGoal: false,
    landing: { lat: point.lat, lon: point.lon },
    routeToGoal: [],
    lastReachedIndex,
  };
  if (optimizedLine.length < 2) return base;

  // Cumulative optimised distance from the origin to each turnpoint's tag
  // point. cum[i] is the along-course distance banked by reaching turnpoint i.
  const cum: number[] = new Array(optimizedLine.length).fill(0);
  for (let i = 1; i < optimizedLine.length; i++) {
    cum[i] = cum[i - 1] + andoyerDistance(
      optimizedLine[i - 1].lat, optimizedLine[i - 1].lon,
      optimizedLine[i].lat, optimizedLine[i].lon,
    );
  }
  const taskDistance = cum[cum.length - 1];

  // Clamp the anchor into range: below the origin means no scored start;
  // at or past goal means the pilot is in goal (full task distance).
  const anchor = Math.min(lastReachedIndex, goalIdx);
  if (anchor < 0) return { ...base, distanceToGoal: taskDistance };
  if (anchor >= goalIdx) {
    return { ...base, madeGood: taskDistance, madeGoal: true };
  }

  const bankedToAnchor = cum[anchor]; // the floor
  const nextIdx = anchor + 1;
  const nextIsGoal = nextIdx >= goalIdx;
  const nextTP = task.turnpoints[nextIdx];
  const distToNextTP = nextIsGoal
    ? Math.max(0, andoyerDistance(
        point.lat, point.lon, nextTP.waypoint.lat, nextTP.waypoint.lon,
      ) - nextTP.radius)
    : andoyerDistance(
        point.lat, point.lon,
        optimizedLine[nextIdx].lat, optimizedLine[nextIdx].lon,
      );
  const interTPDistance = taskDistance - cum[nextIdx];
  const distanceToGoal = distToNextTP + interTPDistance;
  const madeGoodFromPoint = taskDistance - distanceToGoal;
  const madeGood = Math.min(taskDistance, Math.max(bankedToAnchor, madeGoodFromPoint));

  // The drawn line: from the landing point, through each un-reached turnpoint's
  // optimal tag point, to the goal tag — same convention as the tracked
  // best-progress route (calculateOptimizedTaskLine.slice(nextIdx)).
  const routeToGoal = [
    { lat: point.lat, lon: point.lon },
    ...optimizedLine.slice(nextIdx).map((p) => ({ lat: p.lat, lon: p.lon })),
  ];

  return {
    madeGood,
    distanceToGoal,
    madeGoal: false,
    landing: { lat: point.lat, lon: point.lon },
    routeToGoal,
    lastReachedIndex,
  };
}

/**
 * Distance made good toward goal from an arbitrary landing point, given the
 * last turnpoint the pilot legally reached. Thin wrapper over
 * {@link manualFlightGeometry} — see it for the routing and floor rules.
 *
 * @param task - The scoring task (already trimmed for the distance origin).
 * @param lastReachedIndex - Position in `task.turnpoints[]` of the last
 *   reached turnpoint. < 0 → no start (0 m); ≥ goal → in goal (task distance).
 * @param point - The landing point.
 * @returns Made-good distance in metres, in `[0, taskDistance]`.
 */
export function distanceMadeGoodTo(
  task: XCTask,
  lastReachedIndex: number,
  point: { lat: number; lon: number },
): number {
  return manualFlightGeometry(task, lastReachedIndex, point).madeGood;
}

/**
 * Build the synthetic {@link FlightScoringData} for a manual flight, ready to
 * feed straight into `scoreFlights` beside real tracked pilots.
 *
 * The flight bypasses `resolveTurnpointSequence` entirely — there is no track
 * to resolve. `flownDistance` is the made-good distance; `madeGoal` is derived
 * from the reported last turnpoint; a duration (when in goal) becomes the
 * speed-section time so the pilot earns time / speed points. There are no
 * tracklog timestamps, so `sssTimeMs` / `essTimeMs` are null — a manual flight
 * carries no leading-coefficient contribution and does not anchor the field's
 * start / ESS times.
 *
 * @param task - The scoring task (already trimmed for the distance origin),
 *   in the same frame as `flight.lastReachedIndex`.
 * @param flight - The reported manual flight.
 */
export function manualFlightScoringData(
  task: XCTask,
  flight: ManualFlight,
): FlightScoringData {
  const goalIdx = getGoalIndex(task);
  const madeGoal = goalIdx >= 0 && flight.lastReachedIndex >= goalIdx;
  const flownDistance = distanceMadeGoodTo(task, flight.lastReachedIndex, flight.landing);

  // Duration only counts in goal (S7F: no ESS timing without reaching it).
  const duration = madeGoal ? (flight.durationSeconds ?? null) : null;
  const speedSectionTime = duration !== null && duration > 0 ? duration : null;

  return {
    pilotName: flight.pilotName,
    trackFile: flight.trackFile,
    flownDistance,
    madeGoal,
    // A pilot in goal necessarily crossed ESS; a land-out did not.
    reachedESS: madeGoal,
    speedSectionTime,
    // No tracklog → no timestamps for leading / gate anchoring.
    sssTimeMs: null,
    essTimeMs: null,
  };
}
