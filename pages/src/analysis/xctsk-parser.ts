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
function isValidTask(task: XCTask): boolean {
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
 * Fetch task from XContest by task code
 *
 * Task codes can be alphanumeric (e.g., "face", "12345").
 * The v1 API (/api/xctsk/load/) returns the original JSON format.
 * The v2 API (/api/xctsk/loadV2/) returns compact QR code format.
 * See: https://tools.xcontest.org/xctsk
 */
export async function fetchTaskByCode(code: string): Promise<XCTask> {
  // Clean up code - trim whitespace only
  const cleanCode = code.trim();

  if (!cleanCode) {
    throw new Error('Task code cannot be empty');
  }

  // Use only the v1 API which returns the original format
  // The v2 API returns a compact format that requires different parsing
  const url = `https://tools.xcontest.org/api/xctsk/load/${encodeURIComponent(cleanCode)}`;

  const response = await fetch(url);

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`Task code "${cleanCode}" not found`);
    }
    throw new Error(`Failed to fetch task: HTTP ${response.status}`);
  }

  const text = await response.text();

  // Validate that we got JSON back
  if (!text.trim().startsWith('{')) {
    throw new Error(`Invalid response from server: expected JSON`);
  }

  const task = parseXCTask(text);

  // Validate the parsed task has valid coordinates
  if (!isValidTask(task)) {
    throw new Error('Task has invalid or missing coordinates');
  }

  return task;
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

/**
 * Calculate total task distance (optimized route)
 */
export function calculateTaskDistance(task: XCTask): number {
  let distance = 0;
  const tps = task.turnpoints;

  for (let i = 1; i < tps.length; i++) {
    const p1 = tps[i - 1].waypoint;
    const p2 = tps[i].waypoint;

    // Haversine distance
    const R = 6371000; // Earth's radius in meters
    const dLat = (p2.lat - p1.lat) * Math.PI / 180;
    const dLon = (p2.lon - p1.lon) * Math.PI / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(p1.lat * Math.PI / 180) *
      Math.cos(p2.lat * Math.PI / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    distance += R * c;
  }

  return distance;
}
