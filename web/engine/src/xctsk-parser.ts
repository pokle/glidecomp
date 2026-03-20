/**
 * XCTrack Task (.xctsk) Parser
 *
 * Parses XCTrack task files and fetches tasks from xcontest.org by code.
 * Reference: http://xctrack.org/Competition_Interfaces.html
 */

import { andoyerDistance } from './geo';
import { sanitizeText } from './sanitize';
import type { IGCTask, IGCTaskPoint } from './igc-parser';
import { findWaypoint, type WaypointRecord } from './waypoints';

export interface Waypoint {
  name: string;
  description?: string;
  lat: number;
  lon: number;
  altSmoothed?: number;
}

export type TurnpointType = 'TAKEOFF' | 'SSS' | 'TURNPOINT' | 'ESS' | 'GOAL';

export interface Turnpoint {
  type: TurnpointType;
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

  /**
   * Cylinder tolerance as a fraction (e.g. 0.005 = 0.5%).
   * Applied to turnpoint radii when checking cylinder crossings.
   * CIVL GAP: 0.001 (0.1%) for Cat 1, up to 0.005 (0.5%) for Cat 2.
   * Default: 0.005 (0.5%) — the Cat 2 maximum.
   */
  cylinderTolerance?: number;
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
            type: (tpObj.type as Turnpoint['type']) || 'TURNPOINT',
            radius: (tpObj.radius as number) || 400,
            waypoint: {
              name: sanitizeText((wp.name as string) || 'Unnamed'),
              description: wp.description ? sanitizeText(wp.description as string) : undefined,
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
        let type: TurnpointType = 'TURNPOINT';
        if (tpObj.y === 'S') type = 'SSS';
        else if (tpObj.y === 'E') type = 'ESS';
        else if (tpObj.y === 'T') type = 'TAKEOFF';
        else if (tpObj.y === 'G') type = 'GOAL';

        turnpoints.push({
          type,
          radius,
          waypoint: {
            name: sanitizeText((tpObj.n as string) || 'Unnamed'),
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
  return task.turnpoints.filter(tp => tp.type === 'TURNPOINT');
}

/**
 * Get the goal turnpoint index
 */
export function getGoalIndex(task: XCTask): number {
  const idx = task.turnpoints.findIndex(tp => tp.type === 'GOAL');
  return idx >= 0 ? idx : task.turnpoints.length - 1;
}

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
    type: TurnpointType,
    fallbackName: string
  ): Turnpoint {
    const name = point.name || fallbackName;

    // Look up waypoint by name or coordinates
    const wp = findWaypoint(waypoints, name, point.latitude, point.longitude, tolerance);

    // For start areas, the meaningful radius is innerRadius (the cylinder to cross);
    // for turn/finish areas, it's outerRadius (the cylinder to enter).
    // Falls back to waypoint DB radius, then default.
    let radius: number | undefined;
    if (point.areaOZ) {
      const oz = point.areaOZ;
      if (oz.areaType === 'STARTAREA' && oz.innerRadius > 0) {
        radius = oz.innerRadius;
      } else if (isFinite(oz.outerRadius) && oz.outerRadius > 0) {
        radius = oz.outerRadius;
      }
    }
    radius = radius ?? wp?.radius ?? defaultRadius;

    // Area type can confirm SSS/ESS assignment
    if (point.areaOZ) {
      if (point.areaOZ.areaType === 'STARTAREA') type = 'SSS';
      else if (point.areaOZ.areaType === 'FINISHAREA') type = 'GOAL';
    }

    return {
      type,
      radius,
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

  // Add intermediate turnpoints
  for (const tp of igcTask.turnpoints) {
    turnpoints.push(createTurnpoint(tp, 'TURNPOINT', 'Turnpoint'));
  }

  // Add finish point as GOAL (in IGC tasks, finish IS goal)
  if (igcTask.finish) {
    turnpoints.push(createTurnpoint(igcTask.finish, 'GOAL', 'Finish'));
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
 * Calculate nominal task distance (center-to-center, ignoring cylinder radii).
 * For the optimized distance that accounts for cylinder edges, use
 * calculateOptimizedTaskDistance() from task-optimizer.ts.
 */
export function calculateNominalTaskDistance(task: XCTask): number {
  let distance = 0;
  const tps = task.turnpoints;

  for (let i = 1; i < tps.length; i++) {
    const p1 = tps[i - 1].waypoint;
    const p2 = tps[i].waypoint;
    distance += andoyerDistance(p1.lat, p1.lon, p2.lat, p2.lon);
  }

  return distance;
}

