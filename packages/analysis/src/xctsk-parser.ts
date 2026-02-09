/**
 * XCTrack Task (.xctsk) Parser
 *
 * Parses XCTrack task files and fetches tasks from xcontest.org by code.
 * Reference: http://xctrack.org/Competition_Interfaces.html
 */

export interface Waypoint {
  name: string;
  description?: string;
  lat: number;
  lon: number;
  altSmoothed?: number;
}

export interface Turnpoint {
  type?: 'TAKEOFF' | 'SSS' | 'ESS';
  radius: number;
  waypoint: Waypoint;
}

export interface SSSConfig {
  type: 'RACE' | 'ELAPSED-TIME';
  direction: 'ENTER' | 'EXIT';
  timeGates?: string[];
}

export interface GoalConfig {
  type: 'CYLINDER' | 'LINE';
  deadline?: string;
}

export interface XCTask {
  taskType: string;
  version: number;
  earthModel?: 'WGS84' | 'FAI_SPHERE';
  turnpoints: Turnpoint[];
  takeoff?: {
    timeOpen?: string;
    timeClose?: string;
  };
  sss?: SSSConfig;
  goal?: GoalConfig;
}

/**
 * Decode polyline-encoded coordinates (Google Polyline Algorithm)
 * Used in xctsk v2 format for compact representation
 */
function decodePolyline(encoded: string): number[] {
  const result: number[] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  let alt = 0;

  while (index < encoded.length) {
    // Decode latitude
    let shift = 0;
    let value = 0;
    let byte: number;

    do {
      byte = encoded.charCodeAt(index++) - 63;
      value |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);

    lat += (value & 1) ? ~(value >> 1) : (value >> 1);

    // Decode longitude
    shift = 0;
    value = 0;

    do {
      byte = encoded.charCodeAt(index++) - 63;
      value |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);

    lon += (value & 1) ? ~(value >> 1) : (value >> 1);

    // Decode altitude (if present)
    if (index < encoded.length) {
      shift = 0;
      value = 0;

      do {
        byte = encoded.charCodeAt(index++) - 63;
        value |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20 && index < encoded.length);

      alt += (value & 1) ? ~(value >> 1) : (value >> 1);
    }

    // Coordinates are stored with 5 decimal precision
    result.push(lat / 1e5, lon / 1e5, alt);
  }

  return result;
}

/**
 * Parse xctsk v1 format (full JSON)
 */
function parseV1(data: Record<string, unknown>): XCTask {
  const turnpoints: Turnpoint[] = [];

  if (Array.isArray(data.turnpoints)) {
    for (const tp of data.turnpoints) {
      if (typeof tp === 'object' && tp !== null) {
        const tpObj = tp as Record<string, unknown>;
        const wp = tpObj.waypoint as Record<string, unknown> | undefined;

        if (wp) {
          turnpoints.push({
            type: tpObj.type as Turnpoint['type'],
            radius: (tpObj.radius as number) || 400,
            waypoint: {
              name: (wp.name as string) || 'Unnamed',
              description: wp.description as string | undefined,
              lat: wp.lat as number,
              lon: wp.lon as number,
              altSmoothed: wp.altSmoothed as number | undefined,
            },
          });
        }
      }
    }
  }

  const task: XCTask = {
    taskType: (data.taskType as string) || 'CLASSIC',
    version: (data.version as number) || 1,
    earthModel: (data.earthModel as XCTask['earthModel']) || 'WGS84',
    turnpoints,
  };

  // Parse takeoff times
  if (typeof data.takeoff === 'object' && data.takeoff !== null) {
    const takeoff = data.takeoff as Record<string, unknown>;
    task.takeoff = {
      timeOpen: takeoff.timeOpen as string | undefined,
      timeClose: takeoff.timeClose as string | undefined,
    };
  }

  // Parse SSS config
  if (typeof data.sss === 'object' && data.sss !== null) {
    const sss = data.sss as Record<string, unknown>;
    task.sss = {
      type: (sss.type as SSSConfig['type']) || 'RACE',
      direction: (sss.direction as SSSConfig['direction']) || 'ENTER',
      timeGates: sss.timeGates as string[] | undefined,
    };
  }

  // Parse goal config
  if (typeof data.goal === 'object' && data.goal !== null) {
    const goal = data.goal as Record<string, unknown>;
    task.goal = {
      type: (goal.type as GoalConfig['type']) || 'CYLINDER',
      deadline: goal.deadline as string | undefined,
    };
  }

  return task;
}

/**
 * Parse xctsk v2 format (compact QR code format)
 */
function parseV2(data: Record<string, unknown>): XCTask {
  const turnpoints: Turnpoint[] = [];

  // Parse turnpoints from compact format
  if (Array.isArray(data.t)) {
    for (const tp of data.t) {
      if (typeof tp === 'object' && tp !== null) {
        const tpObj = tp as Record<string, unknown>;

        // Decode encoded coordinates
        let lat = 0;
        let lon = 0;
        let radius = 400;
        let alt = 0;

        if (typeof tpObj.z === 'string') {
          // Polyline encoded: lat, lon, radius (or lat, lon, alt, radius)
          const decoded = decodePolyline(tpObj.z);
          if (decoded.length >= 2) {
            lat = decoded[0];
            lon = decoded[1];
            if (decoded.length >= 3) {
              // Third value could be altitude or radius depending on format
              alt = decoded[2];
            }
          }
        }

        // Handle explicit lat/lon if present
        if (typeof tpObj.lat === 'number') lat = tpObj.lat;
        if (typeof tpObj.lon === 'number') lon = tpObj.lon;
        if (typeof tpObj.r === 'number') radius = tpObj.r;

        // Determine type from short code
        let type: Turnpoint['type'] | undefined;
        if (tpObj.y === 'S') type = 'SSS';
        else if (tpObj.y === 'E') type = 'ESS';
        else if (tpObj.y === 'T') type = 'TAKEOFF';

        turnpoints.push({
          type,
          radius,
          waypoint: {
            name: (tpObj.n as string) || 'Unnamed',
            lat,
            lon,
            altSmoothed: alt || undefined,
          },
        });
      }
    }
  }

  const task: XCTask = {
    taskType: (data.taskType as string) || 'CLASSIC',
    version: 2,
    earthModel: data.e === 1 ? 'FAI_SPHERE' : 'WGS84',
    turnpoints,
  };

  // Parse takeoff times
  if (data.to || data.tc) {
    task.takeoff = {
      timeOpen: data.to as string | undefined,
      timeClose: data.tc as string | undefined,
    };
  }

  // Parse SSS config from compact format
  if (typeof data.s === 'object' && data.s !== null) {
    const s = data.s as Record<string, unknown>;
    task.sss = {
      type: s.t === 1 ? 'RACE' : 'ELAPSED-TIME',
      direction: s.d === 1 ? 'ENTER' : 'EXIT',
      timeGates: Array.isArray(s.g) ? s.g as string[] : undefined,
    };
  }

  // Parse goal config from compact format
  if (typeof data.g === 'object' && data.g !== null) {
    const g = data.g as Record<string, unknown>;
    task.goal = {
      type: g.t === 1 ? 'LINE' : 'CYLINDER',
      deadline: g.d as string | undefined,
    };
  }

  return task;
}

/**
 * Validate that a task has valid turnpoints with coordinates
 */
export function isValidTask(task: XCTask): boolean {
  if (task.turnpoints.length === 0) {
    return false;
  }

  for (const tp of task.turnpoints) {
    const { lat, lon } = tp.waypoint;

    // Check for valid coordinate ranges
    if (typeof lat !== 'number' || typeof lon !== 'number') {
      return false;
    }
    if (isNaN(lat) || isNaN(lon)) {
      return false;
    }
    if (lat < -90 || lat > 90) {
      return false;
    }
    if (lon < -180 || lon > 180) {
      return false;
    }
  }

  return true;
}

/**
 * Parse xctsk JSON content
 */
export function parseXCTask(content: string): XCTask {
  // Remove XCTSK: prefix if present (QR code format)
  let jsonContent = content.trim();
  if (jsonContent.startsWith('XCTSK:')) {
    jsonContent = jsonContent.substring(6);
  }

  const data = JSON.parse(jsonContent) as Record<string, unknown>;

  // Determine format based on structure, not just version number
  // v1 format uses 'turnpoints' array, v2 uses 't' array
  if ('turnpoints' in data && Array.isArray(data.turnpoints)) {
    return parseV1(data);
  } else if ('t' in data && Array.isArray(data.t)) {
    return parseV2(data);
  } else {
    // Fallback: try v1 first, then v2
    const v1Task = parseV1(data);
    if (isValidTask(v1Task)) {
      return v1Task;
    }
    return parseV2(data);
  }
}

/**
 * Get the SSS (start) turnpoint index
 */
export function getSSSIndex(task: XCTask): number {
  return task.turnpoints.findIndex(tp => tp.type === 'SSS');
}

/**
 * Get the ESS (end of speed section) turnpoint index
 */
export function getESSIndex(task: XCTask): number {
  return task.turnpoints.findIndex(tp => tp.type === 'ESS');
}

/**
 * Get all turnpoints that are actual turnpoints (not SSS/ESS/TAKEOFF)
 */
export function getIntermediateTurnpoints(task: XCTask): Turnpoint[] {
  return task.turnpoints.filter(tp => !tp.type);
}

import {
  haversineDistance,
  calculateBearingRadians as calculateBearing,
  destinationPoint
} from './geo';

import type { IGCTask, IGCTaskPoint } from './igc-parser';
import { findWaypoint, type WaypointRecord } from './waypoints';

/**
 * Default turnpoint radius in meters.
 * IGC files don't specify radius, so we use 400m (standard for paragliding).
 */
const DEFAULT_TURNPOINT_RADIUS = 400;

/**
 * Options for converting IGC task to XCTask.
 */
export interface IGCTaskConversionOptions {
  /** Default radius in meters if waypoint not found (default: 400m) */
  defaultRadius?: number;
  /** Waypoint database for looking up radius and altitude */
  waypoints?: WaypointRecord[];
  /** Tolerance in meters for coordinate matching (default: 50m) */
  coordinateTolerance?: number;
}

/**
 * Convert an IGCTask (from IGC file C records) to an XCTask.
 *
 * IGC task declarations include:
 * - takeoff: informational, not part of competition task
 * - start: first competition point (becomes SSS)
 * - turnpoints[]: intermediate turnpoints
 * - finish: last competition point (becomes ESS)
 * - landing: informational, not part of competition task
 *
 * If a waypoint database is provided, the function will look up each task point
 * by name (with fuzzy matching) or coordinates (within tolerance) to get the
 * correct radius and altitude.
 *
 * @param igcTask The task declaration from an IGC file
 * @param options Conversion options including waypoint database
 * @returns An XCTask suitable for map rendering and distance calculation
 */
export function igcTaskToXCTask(igcTask: IGCTask, options: IGCTaskConversionOptions | number = {}): XCTask {
  // Support legacy signature: igcTaskToXCTask(task, radius)
  const opts: IGCTaskConversionOptions = typeof options === 'number'
    ? { defaultRadius: options }
    : options;

  const defaultRadius = opts.defaultRadius ?? DEFAULT_TURNPOINT_RADIUS;
  const waypoints = opts.waypoints ?? [];
  const tolerance = opts.coordinateTolerance ?? 50;

  /**
   * Create a turnpoint from an IGC task point, enriching with waypoint data if available.
   */
  function createTurnpoint(
    point: IGCTaskPoint,
    type: Turnpoint['type'],
    fallbackName: string
  ): Turnpoint {
    const name = point.name || fallbackName;

    // Look up waypoint by name or coordinates
    const wp = findWaypoint(waypoints, name, point.latitude, point.longitude, tolerance);

    return {
      type,
      radius: wp?.radius ?? defaultRadius,
      waypoint: {
        name: wp?.description || name,
        lat: point.latitude,
        lon: point.longitude,
        altSmoothed: wp?.altitude,
      },
    };
  }

  const turnpoints: Turnpoint[] = [];

  // Add start point as SSS
  if (igcTask.start) {
    turnpoints.push(createTurnpoint(igcTask.start, 'SSS', 'Start'));
  }

  // Add intermediate turnpoints (no type)
  for (const tp of igcTask.turnpoints) {
    turnpoints.push(createTurnpoint(tp, undefined, 'Turnpoint'));
  }

  // Add finish point as ESS
  if (igcTask.finish) {
    turnpoints.push(createTurnpoint(igcTask.finish, 'ESS', 'Finish'));
  }

  return {
    taskType: 'CLASSIC',
    version: 1,
    earthModel: 'WGS84',
    turnpoints,
    sss: {
      type: 'RACE',
      direction: 'EXIT',
    },
    goal: {
      type: 'CYLINDER',
    },
  };
}

/**
 * Calculate total task distance (optimized route)
 */
export function calculateTaskDistance(task: XCTask): number {
  let distance = 0;
  const tps = task.turnpoints;

  for (let i = 1; i < tps.length; i++) {
    const p1 = tps[i - 1].waypoint;
    const p2 = tps[i].waypoint;
    distance += haversineDistance(p1.lat, p1.lon, p2.lat, p2.lon);
  }

  return distance;
}

/**
 * Find the optimal point on a circle that minimizes total path distance.
 *
 * For a circle at position (centerLat, centerLon) with radius r, find the point
 * on its perimeter that minimizes: distance(prevPoint, circlePoint) + distance(circlePoint, nextPoint)
 *
 * This is a constrained optimization problem where we search for the angle θ ∈ [0, 2π]
 * that minimizes the cost function. The cost function is unimodal (has a single minimum),
 * making golden section search an efficient choice.
 *
 * Golden section search has linear convergence and requires O(log(1/ε)) iterations
 * where ε is the tolerance (1e-5). For typical cases, this means ~30 iterations.
 *
 * @param prevLat Latitude of the previous optimized point
 * @param prevLon Longitude of the previous optimized point
 * @param centerLat Latitude of the current turnpoint center
 * @param centerLon Longitude of the current turnpoint center
 * @param radius Radius of the current turnpoint cylinder (in meters)
 * @param nextLat Latitude of the next turnpoint center
 * @param nextLon Longitude of the next turnpoint center
 * @returns The optimal point on the cylinder's perimeter
 *
 * @see https://en.wikipedia.org/wiki/Golden-section_search
 */
function findOptimalCirclePoint(
  prevLat: number,
  prevLon: number,
  centerLat: number,
  centerLon: number,
  radius: number,
  nextLat: number,
  nextLon: number
): { lat: number; lon: number } {
  // Cost function: total distance through a point on the circle
  const cost = (angle: number): number => {
    const point = destinationPoint(centerLat, centerLon, radius, angle);
    const d1 = haversineDistance(prevLat, prevLon, point.lat, point.lon);
    const d2 = haversineDistance(point.lat, point.lon, nextLat, nextLon);
    return d1 + d2;
  };

  // Golden section search for minimum
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
  return destinationPoint(centerLat, centerLon, radius, optimalAngle);
}

/**
 * Calculate the optimized task line that tags the edges of turnpoint cylinders
 * rather than going through their centers.
 *
 * This algorithm finds the shortest achievable distance through a competition task
 * by determining the optimal point to tag each turnpoint cylinder. Each cylinder
 * contributes exactly ONE point to the path.
 *
 * Algorithm:
 * - First turnpoint: Point on circle along bearing toward next turnpoint
 * - Intermediate turnpoints: Use golden section search to minimize total distance
 * - Last turnpoint: Point on circle along bearing from previous turnpoint
 *
 * The optimization for intermediate turnpoints is greedy (considers only adjacent
 * points) but is computationally efficient and matches the behavior of professional
 * scoring systems like XContest, XCTrack, AirScore, and LK8000.
 *
 * Mathematical formulation:
 * For each turnpoint i, find point pᵢ on circle i such that:
 *   min Σ distance(pᵢ₋₁, pᵢ) + distance(pᵢ, pᵢ₊₁)
 *
 * @param task The competition task with turnpoint cylinders
 * @returns Array of lat/lon coordinates representing the optimized path
 *
 * @example
 * const task = await fetchTaskByCode('BUJE');
 * const optimizedPath = calculateOptimizedTaskLine(task);
 * // Returns: [{lat: 45.123, lon: 13.456}, {lat: 45.234, lon: 13.567}, ...]
 *
 * @see https://github.com/LK8000/LK8000/pull/286 - LK8000 task optimization
 * @see https://github.com/teobouvard/igclib - Python task optimization library
 * @see /docs/optimized-task-line-spec.md - Full algorithm documentation
 */
export function calculateOptimizedTaskLine(task: XCTask): { lat: number; lon: number }[] {
  if (task.turnpoints.length === 0) return [];
  if (task.turnpoints.length === 1) {
    // Single turnpoint - just return its center
    return [{ lat: task.turnpoints[0].waypoint.lat, lon: task.turnpoints[0].waypoint.lon }];
  }

  if (task.turnpoints.length === 2) {
    // Two turnpoints - simple case: find points along line between centers
    const tp1 = task.turnpoints[0];
    const tp2 = task.turnpoints[1];

    const bearing = calculateBearing(
      tp1.waypoint.lat,
      tp1.waypoint.lon,
      tp2.waypoint.lat,
      tp2.waypoint.lon
    );

    return [
      destinationPoint(tp1.waypoint.lat, tp1.waypoint.lon, tp1.radius, bearing),
      destinationPoint(tp2.waypoint.lat, tp2.waypoint.lon, tp2.radius, bearing + Math.PI)
    ];
  }

  // Three or more turnpoints - optimize each point
  const path: { lat: number; lon: number }[] = [];

  for (let i = 0; i < task.turnpoints.length; i++) {
    const tp = task.turnpoints[i];

    if (i === 0) {
      // First turnpoint: point along line towards next
      const next = task.turnpoints[i + 1];
      const bearing = calculateBearing(
        tp.waypoint.lat,
        tp.waypoint.lon,
        next.waypoint.lat,
        next.waypoint.lon
      );
      path.push(destinationPoint(tp.waypoint.lat, tp.waypoint.lon, tp.radius, bearing));
    } else if (i === task.turnpoints.length - 1) {
      // Last turnpoint: point along line from previous
      const prev = task.turnpoints[i - 1];
      const bearing = calculateBearing(
        prev.waypoint.lat,
        prev.waypoint.lon,
        tp.waypoint.lat,
        tp.waypoint.lon
      );
      path.push(destinationPoint(tp.waypoint.lat, tp.waypoint.lon, tp.radius, bearing));
    } else {
      // Intermediate turnpoint: find optimal point minimizing total distance
      const prevPoint = path[path.length - 1]; // Use the already optimized previous point
      const next = task.turnpoints[i + 1];

      const optimal = findOptimalCirclePoint(
        prevPoint.lat,
        prevPoint.lon,
        tp.waypoint.lat,
        tp.waypoint.lon,
        tp.radius,
        next.waypoint.lat,
        next.waypoint.lon
      );

      path.push(optimal);
    }
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
    totalDistance += haversineDistance(
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
      haversineDistance(
        path[i - 1].lat,
        path[i - 1].lon,
        path[i].lat,
        path[i].lon
      )
    );
  }

  return distances;
}
