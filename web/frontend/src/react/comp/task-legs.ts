/**
 * The task read as a course: each leg's length and true bearing, and the turn
 * made at each turnpoint between them.
 *
 * Heading is kept as an explicit NUMBER rather than as geometry, the way a
 * rally roadbook or a sailing route card does it — nothing here is measured
 * off a picture. That is what lets the turnpoint listing resolve the day's
 * wind against a leg (`TurnpointsTable`), and it is why this module outlived
 * the task strip it was first written for.
 *
 * Everything derives from the OPTIMISED line — the same computation the scorer
 * and the turnpoint table use — so bearings and distances can never disagree
 * with the published numbers.
 *
 * Pure math, no DOM, all metres and degrees: the caller formats them into the
 * viewer's units.
 */
import {
  calculateBearing,
  calculateOptimizedTaskLine,
  computeTurnpointDirections,
  getOptimizedSegmentDistances,
  type TurnpointDirection,
  type XCTask,
} from "@glidecomp/engine";
import { turnpointRole, type TaskDiagramRole } from "./task-diagram-layout";

/** Below this the course change is not worth calling a turn. */
const STRAIGHT_ON_DEG = 8;
/** At or above this the course reverses — the out-and-return signature. */
export const REVERSAL_DEG = 165;

export interface TaskStation {
  index: number;
  name: string;
  role: TaskDiagramRole;
  /** Crossing direction inferred by the engine — 'exit' is the unusual case. */
  direction: TurnpointDirection;
  radiusM: number;
  /** Waypoint elevation in metres, when the task file carries one. */
  elevationM: number | null;
  /**
   * Course change here, 0–180°. Null at the first and last turnpoints, which
   * have nothing to turn between.
   */
  turnDeg: number | null;
  /** Which way the course bends; null when it runs straight on. */
  turnSide: "left" | "right" | null;
  /** turnDeg >= REVERSAL_DEG — the route doubles back on itself. */
  isReversal: boolean;
}

export interface TaskLeg {
  fromIndex: number;
  toIndex: number;
  meters: number;
  /** True bearing, 0–360°, from the optimised tag points. */
  bearingDeg: number;
  /** 16-point compass name for that bearing ("NNE"). */
  compass: string;
}

export interface TaskCourse {
  stations: TaskStation[];
  /** legs[i] runs from stations[i] to stations[i + 1]. */
  legs: TaskLeg[];
  totalMeters: number;
}

const COMPASS_16 = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
];

/** 16-point compass name for a true bearing in degrees. */
export function compassPoint(bearingDeg: number): string {
  const normalized = ((bearingDeg % 360) + 360) % 360;
  return COMPASS_16[Math.round(normalized / 22.5) % 16];
}

/**
 * Signed course change from one bearing to the next, normalised to (-180, 180].
 * Positive turns right (clockwise), negative left.
 */
export function courseChange(fromDeg: number, toDeg: number): number {
  let delta = ((toDeg - fromDeg) % 360 + 540) % 360 - 180;
  // The normalisation above maps an exact reversal to -180; call it +180 so a
  // there-and-back task reads as a right-hand turn rather than a left-hand one
  // purely by floating-point luck. Either is arbitrary — being STABLE is not.
  if (delta === -180) delta = 180;
  return delta;
}

/**
 * Read the course off a task. Returns null when there is no course to
 * describe — a task with fewer than two turnpoints (an open-distance launch
 * cylinder) has an order of one and no direction at all.
 */
export function buildTaskLegs(task: XCTask): TaskCourse | null {
  const tps = task.turnpoints ?? [];
  if (tps.length < 2) return null;
  if (
    tps.some(
      (tp) =>
        !Number.isFinite(tp.waypoint?.lat) || !Number.isFinite(tp.waypoint?.lon)
    )
  ) {
    return null;
  }

  let line: Array<{ lat: number; lon: number }>;
  let distances: number[];
  try {
    line = calculateOptimizedTaskLine(task);
    distances = getOptimizedSegmentDistances(task);
  } catch {
    return null;
  }
  if (line.length !== tps.length || distances.length !== tps.length - 1) {
    return null;
  }

  let directions: TurnpointDirection[];
  try {
    directions = computeTurnpointDirections(task, line);
  } catch {
    directions = tps.map(() => "enter" as const);
  }

  const legs: TaskLeg[] = distances.map((meters, i) => {
    // Turf (via calculateBearing) returns -180..180; a heading is 0..360, and
    // "fly -118°" is not a thing anyone has ever said on a hill.
    const raw = calculateBearing(
      line[i].lat,
      line[i].lon,
      line[i + 1].lat,
      line[i + 1].lon
    );
    const bearingDeg = ((raw % 360) + 360) % 360;
    return {
      fromIndex: i,
      toIndex: i + 1,
      meters,
      bearingDeg,
      compass: compassPoint(bearingDeg),
    };
  });

  const stations: TaskStation[] = tps.map((tp, i) => {
    const incoming = legs[i - 1];
    const outgoing = legs[i];
    let turnDeg: number | null = null;
    let turnSide: "left" | "right" | null = null;
    let isReversal = false;
    if (incoming && outgoing) {
      const delta = courseChange(incoming.bearingDeg, outgoing.bearingDeg);
      turnDeg = Math.abs(delta);
      if (turnDeg >= STRAIGHT_ON_DEG) {
        turnSide = delta > 0 ? "right" : "left";
        isReversal = turnDeg >= REVERSAL_DEG;
      }
    }
    const elevation = tp.waypoint.altSmoothed;
    return {
      index: i,
      name: tp.waypoint.name,
      role: turnpointRole(task, i),
      direction: directions[i] ?? "enter",
      radiusM: tp.radius,
      elevationM: Number.isFinite(elevation) ? (elevation as number) : null,
      turnDeg,
      turnSide,
      isReversal,
    };
  });

  return {
    stations,
    legs,
    totalMeters: distances.reduce((sum, d) => sum + d, 0),
  };
}
