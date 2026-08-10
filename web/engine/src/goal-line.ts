/**
 * GAP goal line geometry (FAI Sporting Code Section 7F §6.2.3.1 for the
 * geometry, §9.2.3 for reaching it, §9.1.2 for its tolerance).
 *
 * A task whose goal is configured as `goal.type === 'LINE'` ends at a goal
 * LINE instead of a cylinder: a line segment centred on the goal waypoint,
 * perpendicular to the final task leg, extending the goal turnpoint's
 * "radius" to each side (total length = 2 × radius).
 *
 * Behind the line — on the far side from the course — lies a semicircular
 * control zone of the same radius (§6.2.3.1). Goal is achieved when the
 * tracklog crosses the line in the direction of the last leg (§9.2.3), or
 * when a fix falls inside that semicircle — which rescues a fast crossing
 * that falls between two fixes, or a tracklog gap right at the line.
 *
 * The semicircle rule is **paragliding-only** in the specification; for hang
 * gliding §9.2.3 requires the line itself be crossed before a landing is
 * made. GlideComp applies it to both sports — a deliberate, documented
 * deviation (see /scoring/gap, "Smaller details"), because getting behind
 * the line without entering the semicircle is very nearly impossible. The
 * *direction* requirement is enforced for both sports: a segment crossing
 * the line the wrong way validates nothing.
 *
 * Both control-zone shapes carry a tolerance band, exactly as a cylinder
 * does (§9.1.1): the line gets the §9.1.3 line tolerance ({@link goalLineToleranceM})
 * and the semicircle gets the cylinder calculation §9.2.3 sends it to
 * ({@link goalZoneRadius}). The band is measurement slack, not geometry — it
 * is at most a few metres and, like the cylinder bands, is not drawn on the
 * map; the drawn line and semicircle are the nominal ones.
 *
 * The final leg direction follows the OPTIMISED route (S7F 2026 §6.2.3.1,
 * changed by the 2025 edition): the previous point p is the optimised route
 * point on the last control zone before goal, and the line runs
 * perpendicular to p→centre. The route is computed with the goal treated as
 * its centre point, so the geometry has no circular dependency on the line
 * being constructed. When the route gives no usable direction the leg falls
 * back to turnpoint centres (skipping turnpoints concentric with the goal —
 * an ESS ring is often concentric); when no direction can be established at
 * all — fewer than two distinct centres, or a zero radius — the goal falls
 * back to cylinder behaviour and every function here reports "no goal
 * line".
 *
 * All decisions made from this geometry are explainable: the line endpoints
 * and semicircle are exported for rendering, so what the pilot sees on the
 * map is (to within the tolerance band) exactly what the scorer measured
 * against.
 */

import type { XCTask } from './xctsk-parser';
import { getGoalIndex } from './xctsk-parser';
// Runtime-only cycle with task-optimizer (it imports this module's geometry;
// we call its route optimiser inside a function body) — safe under ESM
// hoisting, and the derived task passed back always has a CYLINDER goal so
// the call can never recurse into goal-line construction.
import { calculateOptimizedTaskLine } from './task-optimizer';
import {
  ellipsoidDistance,
  inverseGeodesic,
  calculateBearingRadians,
  destinationPoint,
  localEastNorth,
} from './geo';
import {
  MIN_CYLINDER_TOLERANCE_M,
  outerDetectionRadius,
} from './turnpoint-sequence-types';

/** A resolved goal line in world coordinates. */
export interface GoalLine {
  /** Goal waypoint centre — the middle of the line. */
  center: { lat: number; lon: number };
  /** Line endpoint to the left of the course direction. */
  end1: { lat: number; lon: number };
  /** Line endpoint to the right of the course direction. */
  end2: { lat: number; lon: number };
  /**
   * Direction of the final leg at the goal (radians clockwise from north,
   * pointing from the last distinct turnpoint centre through the goal).
   * The line runs perpendicular to this; the control semicircle lies on
   * this side of the line.
   */
  legBearing: number;
  /** Half the line length in metres (= the goal turnpoint's radius). */
  halfWidth: number;
}

/**
 * Resolve the goal line for a task, or null when the task's goal is not a
 * line (or a line can't be constructed — see the module doc for fallback
 * conditions). Null means: treat the goal as a cylinder, exactly as before.
 */
// Memoised goal lines and the CYLINDER-goal variant used to compute the
// orientation route: keyed by task object identity so repeated calls in the
// crossing detector and renderer don't re-run the route optimiser (which
// itself caches by task object, hence the persistent derived task).
const goalLineCache = new WeakMap<XCTask, GoalLine | null>();
const orientationTaskCache = new WeakMap<XCTask, XCTask>();

/**
 * S7F 2026 §6.2.3.1: the previous point p — the optimised route point on
 * the last control zone before goal, from a route computed with the goal
 * treated as its centre point. Null when the route yields no usable point.
 */
function optimizedPreviousPoint(
  task: XCTask,
  goalIdx: number,
  goalCenter: { lat: number; lon: number },
): { lat: number; lon: number } | null {
  let derived = orientationTaskCache.get(task);
  if (!derived) {
    derived = { ...task, goal: { ...task.goal, type: 'CYLINDER' } };
    orientationTaskCache.set(task, derived);
  }
  const line = calculateOptimizedTaskLine(derived);
  // The optimised line carries one point per turnpoint. Walk back from the
  // zone before goal to the nearest route point distinct from the goal
  // centre (a concentric ESS ring's point can coincide with it when the
  // route enters from the far side of a zero-progress leg).
  for (let i = Math.min(goalIdx, line.length) - 1; i >= 0; i--) {
    const p = line[i];
    if (!p) continue;
    if (ellipsoidDistance(p.lat, p.lon, goalCenter.lat, goalCenter.lon) > 1) {
      return p;
    }
  }
  return null;
}

export function computeGoalLine(task: XCTask): GoalLine | null {
  if (goalLineCache.has(task)) return goalLineCache.get(task)!;
  const line = computeGoalLineUncached(task);
  goalLineCache.set(task, line);
  return line;
}

function computeGoalLineUncached(task: XCTask): GoalLine | null {
  if (task.goal?.type !== 'LINE') return null;
  const goalIdx = getGoalIndex(task);
  if (goalIdx < 1) return null;
  const goal = task.turnpoints[goalIdx];
  const halfWidth = goal.radius;
  if (!(halfWidth > 0)) return null;

  const center = { lat: goal.waypoint.lat, lon: goal.waypoint.lon };

  // §6.2.3.1 (2026): orient on the optimised route's previous point.
  let prev = optimizedPreviousPoint(task, goalIdx, center);

  // Fallback: turnpoint centres, skipping any turnpoint concentric with the
  // goal (commonly the ESS ring around the goal line).
  if (!prev) {
    for (let i = goalIdx - 1; i >= 0; i--) {
      const wp = task.turnpoints[i].waypoint;
      if (wp.lat !== center.lat || wp.lon !== center.lon) {
        prev = { lat: wp.lat, lon: wp.lon };
        break;
      }
    }
  }
  if (!prev) return null;

  const legBearing = calculateBearingRadians(prev.lat, prev.lon, center.lat, center.lon);
  return {
    center,
    end1: destinationPoint(center.lat, center.lon, halfWidth, legBearing - Math.PI / 2),
    end2: destinationPoint(center.lat, center.lon, halfWidth, legBearing + Math.PI / 2),
    legBearing,
    halfWidth,
  };
}

/**
 * A point in the goal line's local frame:
 * `along` = metres past the line in the course direction (negative = before
 * the line, on the approach side), `across` = signed lateral offset from the
 * centre along the line.
 */
function toLineFrame(
  line: GoalLine,
  lat: number,
  lon: number
): { along: number; across: number } {
  const p = localEastNorth(line.center.lat, line.center.lon, lat, lon);
  const ux = Math.sin(line.legBearing); // course direction, east component
  const uy = Math.cos(line.legBearing); // course direction, north component
  return {
    along: p.east * ux + p.north * uy,
    across: p.east * uy - p.north * ux,
  };
}

/**
 * The §9.1.2 line tolerance in metres: the same percentage a cylinder gets
 * (§9.1.1), applied to the line's size, with the same 5 m absolute minimum.
 *
 * The specification says the absolute tolerance "is calculated from the
 * Distance and the Length (whichever is greater)" — the two ways a line's
 * size is written down: the centre-to-endpoint distance (which a task file
 * stores as the goal turnpoint's radius, i.e. `halfWidth`) and the line's
 * full length. Taking the greater of the two, as the sentence directs, makes
 * it the full length. On the goal lines competitions actually set — a few
 * hundred metres to a couple of kilometres — the 5 m floor is what binds
 * either way, so the reading only matters for a very long line, and then it
 * is the pilot-favourable one.
 *
 * What the band buys at a GOAL line is length: a crossing that lands up to
 * this far past an endpoint still counts (see {@link goalLineCrossing}).
 * §9.2.2's other half — a tracklog point closer to the line than the tolerance
 * reaches it without crossing — is a rule for line control zones a pilot flies
 * THROUGH; at goal §9.2.3 requires the line be crossed in flight, and the
 * band is not a substitute for that. It would also be the one part of the
 * band that could move a goal TIME (by tolerance ÷ ground speed, a few tenths
 * of a second) rather than only decide credit, for pilots who did cross.
 */
export function goalLineToleranceM(line: GoalLine, tolerance: number): number {
  return Math.max(tolerance * 2 * line.halfWidth, MIN_CYLINDER_TOLERANCE_M);
}

/**
 * Radius of the goal control semicircle as reaching sees it. §9.2.3 sends the
 * control zone to the CYLINDER calculation — "the same tolerance calculations
 * apply as for full cylinders (see 8.1)" — so this is the §9.1.1 outer
 * detection radius of the line's half-width, NOT the §9.1.2 line band.
 */
export function goalZoneRadius(line: GoalLine, tolerance: number): number {
  return outerDetectionRadius(line.halfWidth, tolerance);
}

/**
 * Is the point inside the goal control semicircle — behind the line (past it
 * in the course direction) and within `radius` of the centre? A fix here
 * counts as goal (S7F §9.2.3) even without a detected line crossing.
 *
 * `radius` defaults to the nominal half-width: that is the drawn semicircle,
 * which is what rendering and route measurement want. Reaching passes the
 * §9.2.3/§9.1.1 band edge ({@link goalZoneRadius}).
 */
export function isInGoalSemicircle(
  line: GoalLine,
  lat: number,
  lon: number,
  radius: number = line.halfWidth
): boolean {
  const { along, across } = toLineFrame(line, lat, lon);
  return along > 0 && along * along + across * across <= radius * radius;
}

/**
 * Where a straight track segment crosses the goal line, and whether it took
 * the §9.1.2 tolerance band to get there — or null when the segment doesn't
 * cross the line.
 *
 * `t` is the fraction of the way from the segment's first point to its second
 * (0..1). `toleranceCredited` is true when the crossing landed PAST an
 * endpoint of the nominal line but within `toleranceM` of it: the pilot
 * clipped the very end of the line, and only the band credits them. Both
 * crossing directions cross; use {@link isForwardGoalCrossing} to tell them
 * apart.
 */
export function goalLineCrossing(
  line: GoalLine,
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
  toleranceM = 0
): { t: number; toleranceCredited: boolean } | null {
  const a = toLineFrame(line, from.lat, from.lon);
  const b = toLineFrame(line, to.lat, to.lon);
  // The line is {along = 0, |across| ≤ halfWidth}. The segment crosses the
  // infinite line iff `along` changes sign (a collinear glide exactly on the
  // line is left to the semicircle presence test).
  if (a.along === b.along) return null;
  if (a.along > 0 === b.along > 0 && a.along !== 0) return null;
  const t = a.along / (a.along - b.along);
  if (t < 0 || t > 1) return null;
  const acrossAtT = Math.abs(a.across + t * (b.across - a.across));
  if (acrossAtT > line.halfWidth + toleranceM) return null;
  return { t, toleranceCredited: acrossAtT > line.halfWidth };
}

/**
 * {@link goalLineCrossing} reduced to the crossing fraction, for callers that
 * only need to know where (and whether) the segment met the line.
 */
export function goalLineCrossingFraction(
  line: GoalLine,
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
  toleranceM = 0
): number | null {
  return goalLineCrossing(line, from, to, toleranceM)?.t ?? null;
}

/** Did the segment cross in the course direction (approach side → beyond)? */
export function isForwardGoalCrossing(
  line: GoalLine,
  from: { lat: number; lon: number },
  to: { lat: number; lon: number }
): boolean {
  return toLineFrame(line, to.lat, to.lon).along > toLineFrame(line, from.lat, from.lon).along;
}

/**
 * Where a straight track segment crosses the semicircle boundary, as a
 * fraction 0..1 from `from` to `to`. The two points must be on opposite
 * sides of the {@link isInGoalSemicircle} predicate; the semicircle is
 * convex, so the boundary crossing along the segment is unique and bisection
 * converges to it (~1 cm after 25 iterations for any competition-scale leg).
 */
export function goalSemicircleBoundaryFraction(
  line: GoalLine,
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
  radius: number = line.halfWidth
): number {
  const fromInside = isInGoalSemicircle(line, from.lat, from.lon, radius);
  let lo = 0; // same side as `from`
  let hi = 1; // same side as `to`
  for (let i = 0; i < 25; i++) {
    const mid = (lo + hi) / 2;
    const lat = from.lat + mid * (to.lat - from.lat);
    const lon = from.lon + mid * (to.lon - from.lon);
    if (isInGoalSemicircle(line, lat, lon, radius) === fromInside) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return (lo + hi) / 2;
}

/**
 * Point on the goal line at fraction t (0 = end1, 1 = end2).
 * Follows the geodesic between the endpoints, walked along the GEODESIC
 * azimuth (S7F 2026 §7.1.4 InverseGeodesic): a spherical bearing is off by
 * ~0.08° here, which would sag the drawn line metres away from the goal
 * centre at its middle — the §7.1.7-corrected route tag sits on the
 * geodesic, and this function must agree with it.
 */
export function goalLinePointAt(line: GoalLine, t: number): { lat: number; lon: number } {
  const { azimuth } = inverseGeodesic(
    line.end1.lat, line.end1.lon,
    line.end2.lat, line.end2.lon
  );
  return destinationPoint(line.end1.lat, line.end1.lon, t * 2 * line.halfWidth, azimuth);
}

/**
 * Shortest distance from a point to the goal line segment, in metres.
 *
 * Golden-section search over the position along the line, measuring each
 * candidate with the ellipsoidal {@link ellipsoidDistance} — accurate at any
 * range (the pilot may be 100 km out), unlike a local planar projection.
 * The distance to a geodesic segment is unimodal in the line parameter, so
 * the search converges to the true minimum.
 */
export function distanceToGoalLine(line: GoalLine, lat: number, lon: number): number {
  const cost = (t: number): number => {
    const p = goalLinePointAt(line, t);
    return ellipsoidDistance(lat, lon, p.lat, p.lon);
  };

  const phi = (1 + Math.sqrt(5)) / 2;
  const resphi = 2 - phi;

  let a = 0;
  let b = 1;
  let x1 = a + resphi * (b - a);
  let x2 = b - resphi * (b - a);
  let f1 = cost(x1);
  let f2 = cost(x2);

  // 40 iterations shrink the bracket below 1e-8 of the line length.
  for (let i = 0; i < 40 && b - a > 1e-8; i++) {
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

  return cost((a + b) / 2);
}

/**
 * Closed polygon outlining the goal control semicircle (the half-disc behind
 * the line), for rendering: arc from end1 around the far side to end2, then
 * straight back along the line. First point repeated at the end.
 */
export function goalSemicirclePoints(
  line: GoalLine,
  numPoints = 32
): Array<{ lat: number; lon: number }> {
  const points: Array<{ lat: number; lon: number }> = [];
  for (let i = 0; i <= numPoints; i++) {
    const angle = line.legBearing - Math.PI / 2 + (i / numPoints) * Math.PI;
    points.push(destinationPoint(line.center.lat, line.center.lon, line.halfWidth, angle));
  }
  points.push(points[0]);
  return points;
}
