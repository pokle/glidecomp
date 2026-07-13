/**
 * GAP goal line geometry (FAI Sporting Code Section 7F §6.3.1).
 *
 * A task whose goal is configured as `goal.type === 'LINE'` ends at a goal
 * LINE instead of a cylinder: a line segment centred on the goal waypoint,
 * perpendicular to the final task leg, extending the goal turnpoint's
 * "radius" to each side (total length = 2 × radius).
 *
 * Behind the line — on the far side from the course — lies a semicircular
 * control zone of the same radius. Per the GAP definition, goal is achieved
 * when the tracklog crosses the line itself OR contains a fix inside that
 * semicircle (which rescues a fast crossing that falls between two fixes,
 * or a tracklog gap right at the line).
 *
 * The final leg direction is taken from turnpoint centres: from the last
 * turnpoint whose centre differs from the goal centre, to the goal centre.
 * (An ESS ring is often concentric with the goal, so concentric turnpoints
 * are skipped when finding the leg.) When no direction can be established —
 * fewer than two distinct centres, or a zero radius — the goal falls back
 * to cylinder behaviour and every function here reports "no goal line".
 *
 * All decisions made from this geometry are explainable: the line endpoints
 * and semicircle are exported for rendering, so what the pilot sees on the
 * map is exactly what the scorer measured against.
 */

import type { XCTask } from './xctsk-parser';
import { getGoalIndex } from './xctsk-parser';
import {
  andoyerDistance,
  calculateBearingRadians,
  destinationPoint,
  localEastNorth,
} from './geo';

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
export function computeGoalLine(task: XCTask): GoalLine | null {
  if (task.goal?.type !== 'LINE') return null;
  const goalIdx = getGoalIndex(task);
  if (goalIdx < 1) return null;
  const goal = task.turnpoints[goalIdx];
  const halfWidth = goal.radius;
  if (!(halfWidth > 0)) return null;

  // Final leg direction from turnpoint centres, skipping any turnpoint
  // concentric with the goal (commonly the ESS ring around the goal line).
  let prev: { lat: number; lon: number } | null = null;
  for (let i = goalIdx - 1; i >= 0; i--) {
    const wp = task.turnpoints[i].waypoint;
    if (wp.lat !== goal.waypoint.lat || wp.lon !== goal.waypoint.lon) {
      prev = { lat: wp.lat, lon: wp.lon };
      break;
    }
  }
  if (!prev) return null;

  const center = { lat: goal.waypoint.lat, lon: goal.waypoint.lon };
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
 * Is the point inside the goal control semicircle — behind the line (past it
 * in the course direction) and within `halfWidth` of the centre? A fix here
 * counts as goal (S7F §6.3.1) even without a detected line crossing.
 */
export function isInGoalSemicircle(line: GoalLine, lat: number, lon: number): boolean {
  const { along, across } = toLineFrame(line, lat, lon);
  return along > 0 && along * along + across * across <= line.halfWidth * line.halfWidth;
}

/**
 * Where a straight track segment crosses the goal line, as a fraction of the
 * way from the segment's first point to its second (0..1) — or null when the
 * segment doesn't intersect the line. Both crossing directions intersect;
 * use {@link isForwardGoalCrossing} to tell them apart.
 */
export function goalLineCrossingFraction(
  line: GoalLine,
  from: { lat: number; lon: number },
  to: { lat: number; lon: number }
): number | null {
  const a = toLineFrame(line, from.lat, from.lon);
  const b = toLineFrame(line, to.lat, to.lon);
  // The line is {along = 0, |across| ≤ halfWidth}. The segment crosses the
  // infinite line iff `along` changes sign (a collinear glide exactly on the
  // line is left to the semicircle presence test).
  if (a.along === b.along) return null;
  if (a.along > 0 === b.along > 0 && a.along !== 0) return null;
  const t = a.along / (a.along - b.along);
  if (t < 0 || t > 1) return null;
  const acrossAtT = a.across + t * (b.across - a.across);
  return Math.abs(acrossAtT) <= line.halfWidth ? t : null;
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
  to: { lat: number; lon: number }
): number {
  const fromInside = isInGoalSemicircle(line, from.lat, from.lon);
  let lo = 0; // same side as `from`
  let hi = 1; // same side as `to`
  for (let i = 0; i < 25; i++) {
    const mid = (lo + hi) / 2;
    const lat = from.lat + mid * (to.lat - from.lat);
    const lon = from.lon + mid * (to.lon - from.lon);
    if (isInGoalSemicircle(line, lat, lon) === fromInside) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return (lo + hi) / 2;
}

/**
 * Point on the goal line at fraction t (0 = end1, 1 = end2).
 * Follows the geodesic between the endpoints — indistinguishable from the
 * constructed line over goal-line lengths (≤ a few km).
 */
export function goalLinePointAt(line: GoalLine, t: number): { lat: number; lon: number } {
  const bearing = calculateBearingRadians(
    line.end1.lat, line.end1.lon,
    line.end2.lat, line.end2.lon
  );
  return destinationPoint(line.end1.lat, line.end1.lon, t * 2 * line.halfWidth, bearing);
}

/**
 * Shortest distance from a point to the goal line segment, in metres.
 *
 * Golden-section search over the position along the line, measuring each
 * candidate with the ellipsoidal {@link andoyerDistance} — accurate at any
 * range (the pilot may be 100 km out), unlike a local planar projection.
 * The distance to a geodesic segment is unimodal in the line parameter, so
 * the search converges to the true minimum.
 */
export function distanceToGoalLine(line: GoalLine, lat: number, lon: number): number {
  const cost = (t: number): number => {
    const p = goalLinePointAt(line, t);
    return andoyerDistance(lat, lon, p.lat, p.lon);
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
