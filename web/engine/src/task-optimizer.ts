/**
 * Task Optimization
 *
 * Calculates the optimized (shortest) path through a competition task by finding
 * the optimal point to tag each turnpoint cylinder. Uses iterative convergence
 * matching the CIVL GAP specification (Section 7F, Annex A).
 *
 * @see /docs/optimized-task-line-spec.md - Full algorithm documentation
 * @see /docs/research/task-optimization-comparison.md - Comparison with AirScore/CIVL
 */

import {
  andoyerDistance,
  calculateBearingRadians,
  destinationPoint,
  localEastNorth
} from './geo';

import type { XCTask } from './xctsk-parser';
import { getSSSIndex, getESSIndex } from './xctsk-parser';
import { computeGoalLine, goalLinePointAt, type GoalLine } from './goal-line';

/** A geographic point in this module's (lat, lon) convention. */
type LatLon = { lat: number; lon: number };

/**
 * The ESS index the optimizer must pin (FAI S7F Annex A §3.2.4): "The end
 * of speed section is taken from its center position, so that its fix is
 * pinned to the preceding points, rather than any subsequent points at a
 * different position." Only an explicit mid-route ESS pins — an ESS at the
 * last turnpoint is already the route's destination and gets the same
 * nearest-point treatment there. -1 when nothing pins.
 *
 * The pin makes the task path's launch→ESS prefix equal the §6.4.2
 * launchToESSPath (its own shortest-path optimisation) by construction, so
 * slicing the task path at the ESS yields the spec's launch-to-ESS and
 * speed-section distances, and the task distance deliberately kinks at ESS.
 */
function pinnedESSIndex(task: XCTask): number {
  const essIdx = getESSIndex(task);
  return essIdx > 0 && essIdx < task.turnpoints.length - 1 ? essIdx : -1;
}

/**
 * Find the optimal point on a circle that minimizes total path distance.
 *
 * For a circle at position (centerLat, centerLon) with radius r, find the point
 * on its perimeter that minimizes: distance(prevPoint, circlePoint) + distance(circlePoint, nextPoint)
 *
 * Uses golden section search — the cost function is unimodal (single minimum),
 * so this converges in O(log(1/ε)) iterations (~30 for ε=1e-5).
 */
function findOptimalCirclePoint(
  prev: LatLon,
  center: LatLon,
  radius: number,
  next: LatLon
): LatLon {
  // When the prev→next leg passes straight through the cylinder, every
  // point of the chord is equally optimal (the path is the straight leg)
  // and a numeric search would land arbitrarily along it. Annex A resolves
  // the tie by construction: the fix is the boundary point nearest the
  // chord's closest approach to the centre (the perpendicular foot
  // projected onto the circle) — deterministic, and what AirScore's
  // published per-leg cumulatives reflect. Adds only centimetres over the
  // flat chord. Planar approximation is placement-only; distances stay
  // ellipsoidal.
  const crossing = chordCrossingPoint(prev, center, radius, next);
  if (crossing) return crossing;

  const cost = (angle: number): number => {
    const point = destinationPoint(center.lat, center.lon, radius, angle);
    const d1 = andoyerDistance(prev.lat, prev.lon, point.lat, point.lon);
    const d2 = andoyerDistance(point.lat, point.lon, next.lat, next.lon);
    return d1 + d2;
  };

  const phi = (1 + Math.sqrt(5)) / 2;
  const resphi = 2 - phi;

  let a = 0;
  let b = 2 * Math.PI;
  const tol = 1e-5;

  let x1 = a + resphi * (b - a);
  let x2 = b - resphi * (b - a);
  let f1 = cost(x1);
  let f2 = cost(x2);

  while (Math.abs(b - a) > tol) {
    if (f1 < f2) {
      b = x2;
      x2 = x1;
      f2 = f1;
      x1 = a + resphi * (b - a);
      f1 = cost(x1);
    } else {
      a = x1;
      x1 = x2;
      f1 = f2;
      x2 = b - resphi * (b - a);
      f2 = cost(x2);
    }
  }

  const optimalAngle = (a + b) / 2;
  return destinationPoint(center.lat, center.lon, radius, optimalAngle);
}

/**
 * The deterministic fix for a cylinder the prev→next leg crosses straight
 * through (see the caller). Returns null unless both endpoints lie outside
 * the cylinder AND the segment between them passes inside it — the flat-
 * cost chord case. Endpoints inside the cylinder (overlapping zones) keep
 * the numeric search, whose cost is not flat there.
 */
function chordCrossingPoint(
  prev: LatLon,
  center: LatLon,
  radius: number,
  next: LatLon
): LatLon | null {
  const a = localEastNorth(center.lat, center.lon, prev.lat, prev.lon);
  const b = localEastNorth(center.lat, center.lon, next.lat, next.lon);
  const aDist = Math.hypot(a.east, a.north);
  const bDist = Math.hypot(b.east, b.north);
  if (aDist <= radius || bDist <= radius) return null;
  const dx = b.east - a.east;
  const dy = b.north - a.north;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return null;
  // Perpendicular foot from the centre (the frame origin) onto the segment.
  const t = -(a.east * dx + a.north * dy) / lenSq;
  if (t <= 0 || t >= 1) return null;
  const fe = a.east + t * dx;
  const fn = a.north + t * dy;
  const footDist = Math.hypot(fe, fn);
  if (footDist >= radius) return null;
  // Project the foot radially onto the boundary; a foot AT the centre has
  // no direction — fall back to the numeric search for that degeneracy.
  if (footDist < 1e-9) return null;
  const bearing = Math.atan2(fe, fn);
  return destinationPoint(center.lat, center.lon, radius, bearing);
}

/**
 * Closest point on a goal line to a given point — the optimal "tag" of a
 * LINE goal (S7F §6.2.3.1): the task ends where the shortest route meets the
 * line. Golden-section search over the position along the line; distance to
 * a geodesic segment is unimodal, so this converges like the circle search.
 */
function findOptimalGoalLinePoint(
  prevLat: number,
  prevLon: number,
  goalLine: GoalLine
): { lat: number; lon: number } {
  const cost = (t: number): number => {
    const point = goalLinePointAt(goalLine, t);
    return andoyerDistance(prevLat, prevLon, point.lat, point.lon);
  };

  const phi = (1 + Math.sqrt(5)) / 2;
  const resphi = 2 - phi;

  let a = 0;
  let b = 1;
  const tol = 1e-7;

  let x1 = a + resphi * (b - a);
  let x2 = b - resphi * (b - a);
  let f1 = cost(x1);
  let f2 = cost(x2);

  while (Math.abs(b - a) > tol) {
    if (f1 < f2) {
      b = x2;
      x2 = x1;
      f2 = f1;
      x1 = a + resphi * (b - a);
      f1 = cost(x1);
    } else {
      a = x1;
      x1 = x2;
      f1 = f2;
      x2 = b - resphi * (b - a);
      f2 = cost(x2);
    }
  }

  return goalLinePointAt(goalLine, (a + b) / 2);
}

/**
 * Run a single forward pass of the optimization, producing one touching
 * point per turnpoint cylinder.
 *
 * For intermediate turnpoints, each point is optimized using the previous
 * optimized point and the next point (either the next already-optimized
 * point from a previous iteration, or the next turnpoint center on the
 * first pass).
 */
function optimizePass(
  task: XCTask,
  previousPath: { lat: number; lon: number }[] | null,
  goalLine: GoalLine | null,
  pinnedIdx: number,
): { lat: number; lon: number }[] {
  const path: { lat: number; lon: number }[] = [];
  const n = task.turnpoints.length;

  for (let i = 0; i < n; i++) {
    const tp = task.turnpoints[i];

    if (i === 0) {
      // Launch: the first turnpoint's CENTRE, whatever its type or radius
      // (Annex A §2.2 — "the distance is measured from the center of the
      // launch waypoint, regardless of whether it has been given a
      // radius"). A route that begins at the start cylinder therefore
      // includes the centre→boundary kilometres, matching AirScore.
      // The one exception is the explicit boundary directive — see
      // XCTask.firstTurnpointAtBoundary.
      if (task.firstTurnpointAtBoundary && tp.radius > 0) {
        const nextPoint = previousPath
          ? previousPath[1]
          : { lat: task.turnpoints[1].waypoint.lat, lon: task.turnpoints[1].waypoint.lon };
        const bearing = calculateBearingRadians(
          tp.waypoint.lat, tp.waypoint.lon,
          nextPoint.lat, nextPoint.lon
        );
        path.push(destinationPoint(tp.waypoint.lat, tp.waypoint.lon, tp.radius, bearing));
      } else {
        path.push({ lat: tp.waypoint.lat, lon: tp.waypoint.lon });
      }
    } else if (i === n - 1 || i === pinnedIdx) {
      // Last turnpoint, or the pinned ESS (Annex A §3.2.4): nearest point
      // on the cylinder toward the previous optimised point — the incoming
      // leg alone places the fix; anything beyond continues FROM it. For a
      // LINE goal, the closest point on the line segment.
      const prevPoint = path[path.length - 1];
      if (goalLine && i === n - 1) {
        path.push(findOptimalGoalLinePoint(prevPoint.lat, prevPoint.lon, goalLine));
      } else {
        // Nearest boundary point: from the CENTRE, walk the radius toward
        // the previous point. (Reversing the prev→centre bearing instead
        // is off by the meridian convergence — tens of metres of lateral
        // drift on a long leg.)
        const bearing = calculateBearingRadians(
          tp.waypoint.lat, tp.waypoint.lon,
          prevPoint.lat, prevPoint.lon
        );
        path.push(destinationPoint(tp.waypoint.lat, tp.waypoint.lon, tp.radius, bearing));
      }
    } else {
      // Intermediate: minimize distance through this cylinder
      const prevPoint = path[path.length - 1];
      // Use next optimized point from previous iteration if available,
      // otherwise fall back to next turnpoint center
      const nextPoint = previousPath
        ? previousPath[i + 1]
        : { lat: task.turnpoints[i + 1].waypoint.lat, lon: task.turnpoints[i + 1].waypoint.lon };

      path.push(findOptimalCirclePoint(
        prevPoint,
        { lat: tp.waypoint.lat, lon: tp.waypoint.lon },
        tp.radius,
        nextPoint
      ));
    }
  }

  return path;
}

/** Sum path distance for a sequence of points */
function pathDistance(path: { lat: number; lon: number }[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    total += andoyerDistance(path[i - 1].lat, path[i - 1].lon, path[i].lat, path[i].lon);
  }
  return total;
}

/**
 * The §8.6.1 remaining route from an arbitrary position: the shortest path
 * of the route {point(position), un-reached control zones…, goal},
 * optimised with the §6.4.1 algorithm exactly as the task line is — the
 * position is the route's first element (a bare point), the un-reached
 * turnpoints keep their types (so a mid-route ESS still pins, Annex A
 * §3.2.4) and the goal keeps its cylinder/LINE handling.
 *
 * This is the measurement behind a landed-out pilot's flown distance
 * (`taskDistance − remaining`), replacing any fixed-tag approximation: the
 * optimal crossing points depend on where the route is anchored, so they
 * must be re-derived per position.
 *
 * @param task - The scoring task (already trimmed for the distance origin)
 * @param lastReachedIndex - Index of the last turnpoint reached; the route
 *   runs through indices lastReachedIndex+1 … goal.
 * @param position - Where the route starts (a track fix, a landing point).
 * @returns The optimised line (first element = the position) and its
 *   distance, or null when nothing remains (position at/past goal).
 */
export function optimizeRemainingRoute(
  task: XCTask,
  lastReachedIndex: number,
  position: LatLon,
): { line: LatLon[]; distance: number } | null {
  const n = task.turnpoints.length;
  if (lastReachedIndex >= n - 1) return null;
  const synthetic: XCTask = {
    ...task,
    firstTurnpointAtBoundary: undefined,
    turnpoints: [
      {
        type: 'TAKEOFF',
        radius: 0,
        waypoint: { name: 'position', lat: position.lat, lon: position.lon },
      },
      ...task.turnpoints.slice(lastReachedIndex + 1),
    ],
  };
  // The goal line (when the task has one) is resolved from the TASK's own
  // final leg, never from the synthetic route — see computeOptimizedTaskLine.
  const line = computeOptimizedTaskLine(synthetic, computeGoalLine(task));
  return { line, distance: pathDistance(line) };
}

/**
 * Cache of optimised lines, keyed on the exact task object PLUS a cheap
 * content key: the task line is recomputed per pilot during sequence
 * resolution (and again by every explainer), and the optimisation is by far
 * the most expensive part. The content key guards the one live mutation
 * site (the analysis page's task editor adjusts radii in place), so a
 * stale entry can never be served for edited geometry.
 */
const taskLineCache = new WeakMap<XCTask, { key: string; line: LatLon[] }>();

function taskGeometryKey(task: XCTask): string {
  let key = task.goal?.type === 'LINE' ? 'L' : 'C';
  if (task.firstTurnpointAtBoundary) key += 'B';
  for (const tp of task.turnpoints) {
    key += `|${tp.type ?? ''};${tp.radius};${tp.waypoint.lat};${tp.waypoint.lon}`;
  }
  return key;
}

/**
 * Calculate the optimized task line with iterative convergence.
 *
 * Runs multiple forward passes, each time using the previous iteration's
 * optimized points as targets for the next turnpoint. Converges when the
 * total path distance changes by less than 1 meter between iterations
 * (Annex A: tolerance 1 m), keeping the best path found.
 *
 * Two Annex A placement rules apply within each pass: the first point is
 * the launch CENTRE (§2.2), and an explicit mid-route ESS is pinned to the
 * incoming leg (§3.2.4) — see {@link pinnedESSIndex}.
 *
 * @param task The competition task with turnpoint cylinders
 * @returns Array of lat/lon coordinates representing the optimized path
 */
export function calculateOptimizedTaskLine(task: XCTask): { lat: number; lon: number }[] {
  if (task.turnpoints.length === 0) return [];
  if (task.turnpoints.length === 1) {
    return [{ lat: task.turnpoints[0].waypoint.lat, lon: task.turnpoints[0].waypoint.lon }];
  }

  const key = taskGeometryKey(task);
  const cached = taskLineCache.get(task);
  if (cached && cached.key === key) return cached.line;

  const line = computeOptimizedTaskLine(task, computeGoalLine(task));
  taskLineCache.set(task, { key, line });
  return line;
}

/**
 * @param goalLine - The resolved goal line, or null for a cylinder goal.
 *   Passed in (not derived here) because a remaining-route caller anchors
 *   the route at a pilot's position: the goal line's direction comes from
 *   the TASK's final leg, and re-deriving it from the synthetic route
 *   would tilt the line toward the pilot.
 */
function computeOptimizedTaskLine(task: XCTask, goalLine: GoalLine | null): LatLon[] {

  if (task.turnpoints.length === 2) {
    const tp1 = task.turnpoints[0];
    const tp2 = task.turnpoints[1];
    const start = task.firstTurnpointAtBoundary && tp1.radius > 0
      ? destinationPoint(
          tp1.waypoint.lat, tp1.waypoint.lon, tp1.radius,
          calculateBearingRadians(
            tp1.waypoint.lat, tp1.waypoint.lon,
            tp2.waypoint.lat, tp2.waypoint.lon,
          ),
        )
      : { lat: tp1.waypoint.lat, lon: tp1.waypoint.lon };
    // Nearest boundary point from the goal's centre toward the start (see
    // the same construction in optimizePass).
    const backBearing = calculateBearingRadians(
      tp2.waypoint.lat, tp2.waypoint.lon,
      start.lat, start.lon
    );
    return [
      start,
      goalLine
        ? findOptimalGoalLinePoint(start.lat, start.lon, goalLine)
        : destinationPoint(tp2.waypoint.lat, tp2.waypoint.lon, tp2.radius, backBearing)
    ];
  }

  const pinnedIdx = pinnedESSIndex(task);

  // First pass: no previous path to reference
  let path = optimizePass(task, null, goalLine, pinnedIdx);
  let prevDistance = pathDistance(path);

  // Iterate until convergence (< 1m change) or max iterations. A pass that
  // improves is ADOPTED before the convergence check — Annex A keeps the
  // converged positions, so the final sub-metre improvement isn't discarded.
  const maxIterations = task.turnpoints.length * 10;
  for (let iter = 0; iter < maxIterations; iter++) {
    const newPath = optimizePass(task, path, goalLine, pinnedIdx);
    const newDistance = pathDistance(newPath);

    if (newDistance < prevDistance) path = newPath;
    if (prevDistance - newDistance < 1.0) break;
    prevDistance = newDistance;
  }

  return path;
}

/**
 * Calculate the optimized task distance (sum of all line segments).
 *
 * This is the shortest achievable distance through the task by optimally
 * tagging each turnpoint cylinder. The distance is computed as the sum
 * of great circle distances between consecutive optimized points.
 *
 * @param task The competition task with turnpoint cylinders
 * @returns Total optimized distance in meters
 *
 * @example
 * const task = await fetchTaskByCode('BUJE');
 * const distance = calculateOptimizedTaskDistance(task);
 * console.log(`Task distance: ${(distance / 1000).toFixed(2)} km`);
 * // Output: "Task distance: 133.08 km"
 */
export function calculateOptimizedTaskDistance(task: XCTask): number {
  const path = calculateOptimizedTaskLine(task);
  if (path.length < 2) return 0;

  let totalDistance = 0;
  for (let i = 1; i < path.length; i++) {
    totalDistance += andoyerDistance(
      path[i - 1].lat,
      path[i - 1].lon,
      path[i].lat,
      path[i].lon
    );
  }

  return totalDistance;
}

/**
 * Get individual segment distances for the optimized path.
 *
 * Returns an array of distances (in meters) for each segment between
 * consecutive optimized points. Used for displaying distance labels
 * on each leg of the task line.
 *
 * @param task The competition task with turnpoint cylinders
 * @returns Array of distances in meters, one per segment
 *
 * @example
 * const task = await fetchTaskByCode('BUJE');
 * const segments = getOptimizedSegmentDistances(task);
 * segments.forEach((dist, i) => {
 *   console.log(`Leg ${i+1}: ${(dist / 1000).toFixed(1)} km`);
 * });
 * // Output:
 * // Leg 1: 7.2 km
 * // Leg 2: 23.6 km
 * // ...
 */
export function getOptimizedSegmentDistances(task: XCTask): number[] {
  const path = calculateOptimizedTaskLine(task);
  if (path.length < 2) return [];

  const distances: number[] = [];
  for (let i = 1; i < path.length; i++) {
    distances.push(
      andoyerDistance(
        path[i - 1].lat,
        path[i - 1].lon,
        path[i].lat,
        path[i].lon
      )
    );
  }

  return distances;
}

/** Which way a pilot must cross a turnpoint cylinder's boundary. */
export type TurnpointDirection = 'enter' | 'exit';

/**
 * Infer each turnpoint's crossing direction from the task geometry.
 *
 * A cylinder's direction is not a free choice — it is forced by which side
 * of the boundary the route arrives on. A turnpoint whose cylinder contains
 * the previous turnpoint's optimized tag point is an EXIT cylinder: the
 * route reaches its boundary from inside, so the pilot must fly out of it
 * (the concentric out-and-return task is the common case). Every other
 * turnpoint is an ENTER cylinder.
 *
 * The previous *tag point* is the right reference, not the previous centre:
 * with concentric shrinking cylinders (a 3 km ESS ring around a 400 m goal)
 * the previous centre lies inside the goal cylinder but the tag point sits
 * on the ESS ring, outside it — and the goal is indeed entered. The tag
 * point's distance from the centre is also stable when the optimizer's
 * bearing choice is arbitrary (perfectly concentric tasks), so the
 * inference doesn't wobble with tie-breaking.
 *
 * Two positions use conventions instead of inference:
 * - The SSS keeps its declared direction (`task.sss.direction`) — pilots
 *   cross the start cylinder both ways while waiting for the gate, and the
 *   declaration says which crossings arm the start.
 * - The goal (last turnpoint) is always ENTER: it is a destination, not a
 *   gate — presence inside finishes the task even when the previous
 *   turnpoint is nested inside the goal ring.
 *
 * A tag point exactly on the boundary (co-located identical cylinders)
 * counts as ENTER, which preserves the shared-crossing crediting for a
 * co-located ESS/goal pair.
 *
 * @param task - The competition task
 * @param optimizedLine - Optional precomputed result of
 *   {@link calculateOptimizedTaskLine} for the same task, to avoid
 *   recomputing it
 */
export function computeTurnpointDirections(
  task: XCTask,
  optimizedLine?: { lat: number; lon: number }[],
): TurnpointDirection[] {
  const n = task.turnpoints.length;
  if (n === 0) return [];
  const line = optimizedLine ?? calculateOptimizedTaskLine(task);
  const sssIdx = getSSSIndex(task);

  return task.turnpoints.map((tp, i) => {
    if (i === sssIdx) {
      return task.sss?.direction === 'EXIT' ? 'exit' : 'enter';
    }
    if (i === 0 || i === n - 1) return 'enter';
    const prevTag = line[i - 1];
    if (!prevTag) return 'enter';
    const prevTagToCenter = andoyerDistance(
      prevTag.lat, prevTag.lon,
      tp.waypoint.lat, tp.waypoint.lon,
    );
    return prevTagToCenter < tp.radius ? 'exit' : 'enter';
  });
}
