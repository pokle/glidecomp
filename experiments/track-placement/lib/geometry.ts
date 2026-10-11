// Copyright (c) 2026, Tushar Pokle.  All rights reserved.
/**
 * Task geometry the feature extractor reuses across every track of a task.
 *
 * The optimised line, its leg lengths and bearings, and the course bearing
 * are the same for all ~27 pilots of a task-class, so they are computed once
 * and threaded in. Everything here is derived from the `.xctsk` alone — no
 * track, no field.
 */

import {
  calculateBearing,
  calculateOptimizedTaskLine,
  ellipsoidDistance,
  getESSIndex,
  getGoalIndex,
  getSSSIndex,
  localEastNorth,
  type XCTask,
} from '@glidecomp/engine';

export interface TaskGeometry {
  task: XCTask;
  /** One vertex per turnpoint: the optimal tag point on each cylinder. */
  line: { lat: number; lon: number }[];
  legMeters: number[];
  totalMeters: number;
  /** True bearing of each leg, degrees. */
  legBearings: number[];
  /** Length-weighted vector mean of the leg bearings, degrees. */
  courseBearing: number;
  sssIndex: number;
  essIndex: number;
  goalIndex: number;
}

export function buildTaskGeometry(task: XCTask): TaskGeometry {
  const line = calculateOptimizedTaskLine(task);
  const legMeters: number[] = [];
  const legBearings: number[] = [];
  for (let i = 1; i < line.length; i++) {
    legMeters.push(ellipsoidDistance(line[i - 1].lat, line[i - 1].lon, line[i].lat, line[i].lon));
    legBearings.push(calculateBearing(line[i - 1].lat, line[i - 1].lon, line[i].lat, line[i].lon));
  }
  let east = 0;
  let north = 0;
  for (let i = 0; i < legBearings.length; i++) {
    const rad = (legBearings[i] * Math.PI) / 180;
    east += Math.sin(rad) * legMeters[i];
    north += Math.cos(rad) * legMeters[i];
  }
  const courseBearing = ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360;
  return {
    task,
    line,
    legMeters,
    totalMeters: legMeters.reduce((s, d) => s + d, 0),
    legBearings,
    courseBearing,
    sssIndex: getSSSIndex(task),
    essIndex: getESSIndex(task),
    goalIndex: getGoalIndex(task),
  };
}

/**
 * Shortest distance in metres from a point to the optimised course line.
 *
 * Projected into a local east/north frame centred on the point itself, so the
 * equirectangular approximation is evaluated where it is most accurate; a leg
 * is only ever tens of kilometres long, well inside its useful range.
 */
export function distanceToCourseLine(
  line: { lat: number; lon: number }[],
  lat: number,
  lon: number,
): number {
  if (line.length === 0) return NaN;
  if (line.length === 1) return ellipsoidDistance(lat, lon, line[0].lat, line[0].lon);
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const a = localEastNorth(lat, lon, line[i - 1].lat, line[i - 1].lon);
    const b = localEastNorth(lat, lon, line[i].lat, line[i].lon);
    best = Math.min(best, distanceToSegment(a, b));
  }
  return best;
}

/** Distance from the origin to the segment a→b, both already in metres. */
function distanceToSegment(
  a: { east: number; north: number },
  b: { east: number; north: number },
): number {
  const dx = b.east - a.east;
  const dy = b.north - a.north;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(a.east, a.north);
  // Projection of the origin onto the infinite line, clamped to the segment.
  let t = -(a.east * dx + a.north * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(a.east + t * dx, a.north + t * dy);
}

/** Signed turn at each interior vertex of the optimised line, in degrees. */
export function turnAnglesDeg(legBearings: number[]): number[] {
  const angles: number[] = [];
  for (let i = 1; i < legBearings.length; i++) {
    let delta = legBearings[i] - legBearings[i - 1];
    while (delta > 180) delta -= 360;
    while (delta < -180) delta += 360;
    angles.push(delta);
  }
  return angles;
}

/**
 * Component of a wind blowing FROM `fromDeg` at `speed` along a course of
 * `courseDeg`. Positive is a tailwind. The second value is the crosswind
 * magnitude, which has no sign that means anything to a pilot.
 */
export function windComponents(
  speed: number,
  fromDeg: number,
  courseDeg: number,
): { along: number; cross: number } {
  const towards = ((fromDeg + 180) * Math.PI) / 180;
  const course = (courseDeg * Math.PI) / 180;
  const delta = towards - course;
  return { along: speed * Math.cos(delta), cross: Math.abs(speed * Math.sin(delta)) };
}
