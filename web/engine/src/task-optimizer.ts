/**
 * Task Optimization
 *
 * Calculates the optimized (shortest) path through a competition task by
 * finding the optimal point to tag each turnpoint cylinder, with the
 * S7F 2026 §7.1 algorithm set: the task's route is projected into a
 * localised Transverse Mercator plane about the §7.1.6 task-area centre,
 * solved by the §7.1.3 PathFinder algorithm (Ding et al. 2018, Annex B for
 * the goal line), corrected back onto the control-zone boundaries (§7.1.7)
 * and measured on the ellipsoid (§7.1.5) — see route-optimizer.ts.
 *
 * This module owns what the route MEANS: which turnpoint is the launch,
 * where the ESS pins, how a goal cylinder or LINE terminates the route.
 * route-optimizer.ts owns how a route, once defined, is solved.
 *
 * @see /docs/optimized-task-line-spec.md - Full algorithm documentation
 * @see /docs/research/task-optimization-comparison.md - Comparison with AirScore/CIVL
 */

import { ellipsoidDistance } from './geo';
import {
  createLtmProjection,
  findTaskAreaCentre,
  routeOptimizer,
  type GeoPoint,
  type GeodesicRouteDefinition,
  type GeodesicRouteElement,
  type LtmProjection,
} from './route-optimizer';

import type { XCTask, Turnpoint } from './xctsk-parser';
import { getSSSIndex, getESSIndex } from './xctsk-parser';
import { computeGoalLine, type GoalLine } from './goal-line';

/** A geographic point in this module's (lat, lon) convention. */
type LatLon = { lat: number; lon: number };

/**
 * The ESS index the optimizer must pin (FAI S7F §7.2): "The end
 * of speed section is taken from its center position, so that its fix is
 * pinned to the preceding points, rather than any subsequent points at a
 * different position." Only an explicit mid-route ESS pins — an ESS at the
 * last turnpoint is already the route's destination and gets the same
 * nearest-point treatment there. -1 when nothing pins.
 *
 * The pin makes the task path's launch→ESS prefix equal the §7.2
 * launchToESSPath (its own shortest-path optimisation) by construction, so
 * slicing the task path at the ESS yields the spec's launch-to-ESS and
 * speed-section distances, and the task distance deliberately kinks at ESS.
 */
function pinnedESSIndex(task: XCTask): number {
  const essIdx = getESSIndex(task);
  return essIdx > 0 && essIdx < task.turnpoints.length - 1 ? essIdx : -1;
}

const centre = (tp: Turnpoint): GeoPoint => ({ lat: tp.waypoint.lat, lon: tp.waypoint.lon });

/**
 * The §7.1.1 geodesicRouteDefinition for a task (or a tail of one — see
 * {@link optimizeRemainingRoute}), encoding the FAI placement rules:
 *
 * - The route STARTS at `startPoint` — the launch centre (§7.2: "measured
 *   from the center of the launch waypoint, regardless of whether it has
 *   been given a radius"), or a pilot's position for a remaining route.
 *   When `startCylinder` is set (the explicit
 *   `XCTask.firstTurnpointAtBoundary` directive), that first cylinder is
 *   added as a control zone so the path begins on its boundary; the centre
 *   start point is dropped from the result by the caller.
 * - A mid-route ESS is `pinned`: its path point is the nearest boundary
 *   point to the incoming leg, ignoring everything beyond (§7.2).
 * - A CYLINDER goal terminates the route via `endPoint` at the goal
 *   CENTRE with the goal cylinder as the last control zone: the cylinder's
 *   path point then falls on the boundary nearest the incoming leg (the
 *   crossing case of the centre-bound final segment), and the caller drops
 *   the endPoint. A LINE goal is a terminal `line` element (Annex B.1.2:
 *   the closest point on the line) with no endPoint.
 */
function buildRoute(
  startPoint: GeoPoint,
  startCylinder: Turnpoint | null,
  turnpoints: Turnpoint[],
  pinnedIdx: number,
  goalLine: GoalLine | null
): GeodesicRouteDefinition {
  const elements: GeodesicRouteElement[] = [];
  if (startCylinder) {
    elements.push({ kind: 'cylinder', center: centre(startCylinder), radius: startCylinder.radius });
  }
  const n = turnpoints.length;
  for (let i = 0; i < n - 1; i++) {
    elements.push({
      kind: 'cylinder',
      center: centre(turnpoints[i]),
      radius: turnpoints[i].radius,
      pinned: i === pinnedIdx,
    });
  }
  const goal = turnpoints[n - 1];
  if (goalLine) {
    elements.push({ kind: 'line', point1: goalLine.end1, point2: goalLine.end2 });
    return { startPoint, elements };
  }
  elements.push({ kind: 'cylinder', center: centre(goal), radius: goal.radius });
  return { startPoint, elements, endPoint: centre(goal) };
}

/**
 * The task's §7.1.6 task-area centre and its LTM projection, cached per
 * task object (with the same content key as the task-line cache): the spec
 * computes the centre ONCE per task and reuses it for every route
 * optimisation of that task — including the §9.3 per-fix remaining routes,
 * where recomputing it would dominate the cost. The centre derives from the
 * cylinder-form route (a goal LINE spans at most a few km of the box, and
 * resolving it needs an optimised route — a circularity the spec avoids the
 * same way, by defining the centre over the route definition's points).
 */
const projectionCache = new WeakMap<XCTask, { key: string; projection: LtmProjection }>();

function taskAreaProjection(task: XCTask): LtmProjection {
  const key = taskGeometryKey(task);
  const cached = projectionCache.get(task);
  if (cached && cached.key === key) return cached.projection;
  const tps = task.turnpoints;
  const route = buildRoute(centre(tps[0]), null, tps.slice(1), pinnedESSIndex(task) - 1, null);
  const areaCentre = findTaskAreaCentre(route);
  const projection = createLtmProjection(areaCentre.lat, areaCentre.lon);
  projectionCache.set(task, { key, projection });
  return projection;
}

/** Sum path distance for a sequence of points */
function pathDistance(path: { lat: number; lon: number }[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    total += ellipsoidDistance(path[i - 1].lat, path[i - 1].lon, path[i].lat, path[i].lon);
  }
  return total;
}

/**
 * The §9.3 remaining route from an arbitrary position: the shortest path
 * of the route {point(position), un-reached control zones…, goal},
 * optimised with the §7.1.8 RouteOptimizer exactly as the task line is —
 * the position is the route's start point, the un-reached turnpoints keep
 * their types (so a mid-route ESS still pins) and the goal keeps its
 * cylinder/LINE handling. The projection is the TASK's cached one: §7.1.6
 * fixes the task-area centre once per task, for all of its routes.
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
  const remaining = task.turnpoints.slice(lastReachedIndex + 1);
  // The ESS pins in the remaining route under the same rule as in the task:
  // it must not be the route's terminal element (the position anchors the
  // start, so an ESS anywhere in `remaining` but last pins).
  const essIdx = remaining.findIndex((tp) => tp.type === 'ESS');
  const pinnedIdx = essIdx >= 0 && essIdx < remaining.length - 1 ? essIdx : -1;
  // The goal line (when the task has one) is resolved from the TASK's own
  // final leg, never from the position-anchored route — re-deriving it here
  // would tilt the line toward the pilot.
  const goalLine = computeGoalLine(task);
  const route = buildRoute(position, null, remaining, pinnedIdx, goalLine);
  const { path } = routeOptimizer(route, taskAreaProjection(task));
  // Drop the synthetic endPoint (the goal centre) for a cylinder goal: the
  // line ends at the goal's boundary tag, as consumers expect.
  const line = route.endPoint ? path.slice(0, -1) : path;
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
 * Calculate the optimized task line with the §7.1.8 RouteOptimizer.
 *
 * Returns one point per turnpoint: the launch CENTRE first (§7.2), then
 * each cylinder's optimal tag point, with an explicit mid-route ESS pinned
 * to the incoming leg (§7.2) — see {@link pinnedESSIndex} — and the goal's
 * boundary tag (or goal-line tag) last.
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
 *   Passed in (not derived here) because deriving it needs an optimised
 *   route of the CYLINDER-goal form of this task — computeGoalLine owns
 *   that recursion and memoises the result.
 */
function computeOptimizedTaskLine(task: XCTask, goalLine: GoalLine | null): LatLon[] {
  const tps = task.turnpoints;
  const first = tps[0];
  const boundaryStart = Boolean(task.firstTurnpointAtBoundary && first.radius > 0);
  const route = buildRoute(
    centre(first),
    boundaryStart ? first : null,
    tps.slice(1),
    pinnedESSIndex(task) - 1,
    goalLine,
  );
  const { path } = routeOptimizer(route, taskAreaProjection(task));
  // path = [startPoint, one tag per element, endPoint?]. Reduce to one point
  // per turnpoint: the start centre (or, under the boundary directive, the
  // first cylinder's tag), each mid-route tag, and the goal tag — dropping
  // the synthetic goal-centre endPoint of a cylinder goal.
  const tags = route.endPoint ? path.slice(1, -1) : path.slice(1);
  return boundaryStart ? tags : [path[0], ...tags];
}

/**
 * Calculate the optimized task distance (sum of all line segments).
 *
 * This is the shortest achievable distance through the task by optimally
 * tagging each turnpoint cylinder. The distance is computed as the sum
 * of the §7.1.5 EllipsoidDistance over consecutive optimized points.
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
  return pathDistance(path);
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
      ellipsoidDistance(
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
    const prevTagToCenter = ellipsoidDistance(
      prevTag.lat, prevTag.lon,
      tp.waypoint.lat, tp.waypoint.lon,
    );
    return prevTagToCenter < tp.radius ? 'exit' : 'enter';
  });
}
