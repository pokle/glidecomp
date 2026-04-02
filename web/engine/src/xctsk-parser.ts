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
  finishAltitude?: number;
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
/**
 * Decode a single polyline-encoded integer from the string at the given index.
 * Returns [decoded_value, new_index].
 */
function decodePolylineValue(encoded: string, index: number): [number, number] {
  let shift = 0;
  let value = 0;
  let byte: number;

  do {
    byte = encoded.charCodeAt(index++) - 63;
    value |= (byte & 0x1f) << shift;
    shift += 5;
  } while (byte >= 0x20 && index < encoded.length);

  return [(value & 1) ? ~(value >> 1) : (value >> 1), index];
}

/**
 * Decode polyline-encoded turnpoint data.
 * The xctsk v2 spec encodes 4 values per turnpoint: lat, lon, altitude, radius.
 * Returns [lat, lon, altitude, radius] (coordinates at 1e5 precision).
 */
function decodePolyline(encoded: string): number[] {
  const result: number[] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  let alt = 0;
  let radius = 0;

  while (index < encoded.length) {
    let delta: number;

    [delta, index] = decodePolylineValue(encoded, index);
    lat += delta;

    if (index >= encoded.length) {
      result.push(lat / 1e5, lon / 1e5, alt, radius);
      break;
    }
    [delta, index] = decodePolylineValue(encoded, index);
    lon += delta;

    // Decode altitude (if present)
    if (index < encoded.length) {
      [delta, index] = decodePolylineValue(encoded, index);
      alt += delta;
    }

    // Decode radius (if present — xctsk v2 spec encodes 4 values)
    if (index < encoded.length) {
      [delta, index] = decodePolylineValue(encoded, index);
      radius += delta;
    }

    result.push(lat / 1e5, lon / 1e5, alt, radius);
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
      finishAltitude: typeof goal.finishAltitude === 'number' ? goal.finishAltitude : undefined,
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
          // Polyline encoded: lat, lon, altitude, radius (4 values per spec)
          const decoded = decodePolyline(tpObj.z);
          if (decoded.length >= 2) {
            lat = decoded[0];
            lon = decoded[1];
          }
          if (decoded.length >= 3) alt = decoded[2];
          if (decoded.length >= 4 && decoded[3] > 0) radius = decoded[3];
        }

        // Handle explicit lat/lon/radius if present (override polyline values)
        if (typeof tpObj.lat === 'number') lat = tpObj.lat;
        if (typeof tpObj.lon === 'number') lon = tpObj.lon;
        if (typeof tpObj.r === 'number') radius = tpObj.r;

        // Determine type: spec uses numeric 't' field (2=SSS, 3=ESS),
        // also support string 'y' field for compatibility
        let type: TurnpointType = 'TURNPOINT';
        if (tpObj.t === 2 || tpObj.y === 'S') type = 'SSS';
        else if (tpObj.t === 3 || tpObj.y === 'E') type = 'ESS';
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
      finishAltitude: typeof g.fa === 'number' ? g.fa : undefined,
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
 * Parse xctsk JSON content.
 * Supports XCTSK: prefix (uncompressed QR code format).
 * For XCTSKZ: compressed format, use parseXCTaskAsync().
 */
export function parseXCTask(content: string): XCTask {
  let jsonContent = content.trim();
  if (jsonContent.startsWith('XCTSKZ:')) {
    throw new Error('XCTSKZ compressed format requires async parsing — use parseXCTaskAsync()');
  }

  // Remove XCTSK: prefix if present (QR code format)
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
 * Parse xctsk content asynchronously — supports XCTSKZ: compressed format.
 * Falls back to synchronous parsing for uncompressed content.
 *
 * @param content Raw xctsk string (may be XCTSK: or XCTSKZ: prefixed)
 * @param decompress Optional decompression function for XCTSKZ format.
 *   Receives the base64-encoded compressed data (without prefix), returns the JSON string.
 *   If not provided, uses the Web DecompressionStream API (available in browsers and Bun).
 */
export async function parseXCTaskAsync(
  content: string,
  decompress?: (base64Data: string) => Promise<string>,
): Promise<XCTask> {
  const trimmed = content.trim();
  if (trimmed.startsWith('XCTSKZ:')) {
    const base64Data = trimmed.substring(7);
    let jsonContent: string;
    if (decompress) {
      jsonContent = await decompress(base64Data);
    } else {
      // Use Web Compression API (globalThis.DecompressionStream)
      const binary = (globalThis as unknown as { atob: (s: string) => string }).atob(base64Data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const g = globalThis as any;
      const ds = new g.DecompressionStream('deflate');
      const writer = ds.writable.getWriter();
      writer.write(bytes);
      writer.close();
      jsonContent = await new g.Response(ds.readable).text();
    }
    return parseXCTask(jsonContent);
  }
  return parseXCTask(trimmed);
}

/** Spec-valid turnpoint types (only these should appear in exported files) */
const SPEC_TURNPOINT_TYPES = new Set<string>(['TAKEOFF', 'SSS', 'ESS']);

/**
 * Serialize an XCTask to a spec-compliant v1 JSON object.
 * Strips internal-only types (TURNPOINT, GOAL) and ensures required fields.
 */
export function toXctskJSON(task: XCTask): Record<string, unknown> {
  const turnpoints = task.turnpoints.map(tp => {
    const wpObj: Record<string, unknown> = {
      name: tp.waypoint.name,
      lat: tp.waypoint.lat,
      lon: tp.waypoint.lon,
      altSmoothed: tp.waypoint.altSmoothed ?? 0,
    };
    if (tp.waypoint.description !== undefined) {
      wpObj.description = tp.waypoint.description;
    }

    const tpObj: Record<string, unknown> = {
      radius: tp.radius,
      waypoint: wpObj,
    };
    // Only write type if it's a spec-valid value (TAKEOFF, SSS, ESS)
    if (tp.type && SPEC_TURNPOINT_TYPES.has(tp.type)) {
      tpObj.type = tp.type;
    }
    return tpObj;
  });

  const result: Record<string, unknown> = {
    taskType: task.taskType,
    version: 1,
  };

  if (task.earthModel) {
    result.earthModel = task.earthModel;
  }

  result.turnpoints = turnpoints;

  if (task.takeoff) {
    result.takeoff = { ...task.takeoff };
  }

  if (task.sss) {
    // timeGates must be non-empty per spec (xcontest rejects empty arrays)
    const timeGates = task.sss.timeGates && task.sss.timeGates.length > 0
      ? task.sss.timeGates
      : ['00:00:00Z'];
    const sss: Record<string, unknown> = {
      type: task.sss.type,
      direction: task.sss.direction,
      timeGates,
    };
    result.sss = sss;
  }

  if (task.goal) {
    const goal: Record<string, unknown> = {
      type: task.goal.type,
    };
    if (task.goal.deadline !== undefined) goal.deadline = task.goal.deadline;
    if (task.goal.finishAltitude !== undefined) goal.finishAltitude = task.goal.finishAltitude;
    result.goal = goal;
  }

  return result;
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

