// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Where a thermal was, in the task's own words.
 *
 * A reader of "The day's thermals" knows the course by its turnpoints, not by
 * coordinates, so each thermal is named against them, most specific first:
 *
 *   1. inside a turnpoint's cylinder        → "B12"
 *   2. within 1 km outside a cylinder       → "Near B12"
 *   3. beside a leg of the optimised route  → "Between B03 and B04"
 *   4. anywhere else                        → "4.2 km NE of B12"
 *
 * The last is the fallback that keeps every row answerable: a thermal off to
 * the side of the course, or behind launch, still says where it was.
 */

import type { XCTask } from '../xctsk-parser';
import { calculateBearing, ellipsoidDistance, projectOntoSegment } from '../geo';
import { calculateOptimizedTaskLine } from '../task-optimizer';
import { formatDistance, type UnitPreferences } from '../units';

export type ThermalPlace =
  /** Inside the turnpoint's cylinder. */
  | { kind: 'at'; turnpoint: string }
  /** Outside every cylinder, but within NEAR_MARGIN_METERS of this one's edge. */
  | { kind: 'near'; turnpoint: string }
  /** Beside the leg from → to of the optimised route. */
  | { kind: 'between'; from: string; to: string }
  /** None of the above: distance and bearing from the turnpoint (its centre)
   * whose cylinder edge is nearest. */
  | { kind: 'off'; turnpoint: string; distanceMeters: number; bearing: number };

/** How far outside a cylinder's edge still reads as "near" it. */
export const NEAR_MARGIN_METERS = 1000;

/**
 * The most a thermal may sit off a leg and still be "between" its ends. Also
 * capped at half the leg's length, so a short leg cannot claim a thermal that
 * is further off it than the leg is long.
 */
export const BETWEEN_MAX_OFFSET_METERS = 5000;

/** A turnpoint's name as a reader sees it. */
function turnpointName(task: XCTask, index: number): string {
  const wp = task.turnpoints[index].waypoint;
  return wp.name?.trim() || wp.description?.trim() || `TP${index + 1}`;
}

/**
 * Name where a thermal at (lat, lon) was against the task's turnpoints.
 * Null only for a task with no turnpoints.
 */
export function describeThermalPlace(task: XCTask, lat: number, lon: number): ThermalPlace | null {
  const tps = task.turnpoints;
  if (tps.length === 0) return null;

  // Distance from each cylinder's edge (negative inside).
  const centreDist = tps.map((tp) => ellipsoidDistance(lat, lon, tp.waypoint.lat, tp.waypoint.lon));
  const edgeDist = centreDist.map((d, i) => d - tps[i].radius);

  // 1. Inside a cylinder. Launch and SSS often share a waypoint, and a route
  //    may reuse one, so name the SMALLEST cylinder that holds it — the most
  //    specific place.
  let inside = -1;
  for (let i = 0; i < tps.length; i++) {
    if (edgeDist[i] <= 0 && (inside < 0 || tps[i].radius < tps[inside].radius)) inside = i;
  }
  if (inside >= 0) return { kind: 'at', turnpoint: turnpointName(task, inside) };

  // Nearest by EDGE, not centre: a 400 m cylinder close by must not lose to a
  // 10 km one whose centre happens to be nearer.
  let nearest = 0;
  for (let i = 1; i < tps.length; i++) {
    if (edgeDist[i] < edgeDist[nearest]) nearest = i;
  }

  // 2. Just outside one.
  if (edgeDist[nearest] <= NEAR_MARGIN_METERS) {
    return { kind: 'near', turnpoint: turnpointName(task, nearest) };
  }

  // 3. Beside a leg. The optimised route is the line the field actually
  //    raced; it has one point per turnpoint. Fall back to the centres if
  //    that ever stops being true.
  let line = calculateOptimizedTaskLine(task);
  if (line.length !== tps.length) line = tps.map((tp) => ({ lat: tp.waypoint.lat, lon: tp.waypoint.lon }));

  let best: { from: string; to: string; offset: number } | null = null;
  for (let i = 0; i + 1 < tps.length; i++) {
    const from = turnpointName(task, i);
    const to = turnpointName(task, i + 1);
    // Launch → an exit start around launch, or a waypoint repeated back to
    // back: "between B01 and B01" names nothing.
    if (from === to) continue;
    const a = line[i];
    const b = line[i + 1];
    const { fraction, offsetMeters, lengthMeters } = projectOntoSegment(lat, lon, a.lat, a.lon, b.lat, b.lon);
    if (lengthMeters === 0 || fraction < 0 || fraction > 1) continue;
    if (offsetMeters > Math.min(BETWEEN_MAX_OFFSET_METERS, lengthMeters / 2)) continue;
    if (!best || offsetMeters < best.offset) best = { from, to, offset: offsetMeters };
  }
  if (best) return { kind: 'between', from: best.from, to: best.to };

  // 4. Off the course: from the waypoint itself, which is what a reader with
  //    a map measures from.
  const wp = tps[nearest].waypoint;
  const bearing = (calculateBearing(wp.lat, wp.lon, lat, lon) + 360) % 360;
  return {
    kind: 'off',
    turnpoint: turnpointName(task, nearest),
    distanceMeters: centreDist[nearest],
    bearing,
  };
}

const COMPASS_8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/** Eight-point compass name for a bearing in degrees. */
function compass8(deg: number): string {
  return COMPASS_8[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

/** The place as a reader reads it, in their distance unit. */
export function formatThermalPlace(place: ThermalPlace, opts?: { prefs?: UnitPreferences }): string {
  switch (place.kind) {
    case 'at':
      return place.turnpoint;
    case 'near':
      return `Near ${place.turnpoint}`;
    case 'between':
      return `Between ${place.from} and ${place.to}`;
    case 'off': {
      const d = formatDistance(place.distanceMeters, { decimals: 1, prefs: opts?.prefs }).withUnit;
      return `${d} ${compass8(place.bearing)} of ${place.turnpoint}`;
    }
  }
}
