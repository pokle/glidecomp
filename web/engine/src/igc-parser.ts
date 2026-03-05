/**
 * IGC File Parser
 *
 * Parses IGC (International Gliding Commission) flight recorder files.
 * Reference: https://xp-soaring.github.io/igc_file_format/igc_format_2008.html
 */

import { sanitizeText } from './sanitize';

export interface IGCFix {
  time: Date;
  latitude: number;
  longitude: number;
  pressureAltitude: number;
  gnssAltitude: number;
  valid: boolean;
}

export interface IGCHeader {
  date?: Date;
  pilot?: string;
  gliderType?: string;
  gliderId?: string;
  competitionId?: string;
  competitionClass?: string;
}

export interface IGCEvent {
  time: Date;
  code: string;
  description: string;
}

export interface IGCTaskPoint {
  latitude: number;
  longitude: number;
  name: string;
}

export interface IGCTask {
  declarationTime?: Date;
  flightDate?: Date;
  taskId?: string;
  numTurnpoints: number;
  description?: string;
  takeoff?: IGCTaskPoint;
  start?: IGCTaskPoint;
  turnpoints: IGCTaskPoint[];
  finish?: IGCTaskPoint;
  landing?: IGCTaskPoint;
}

export interface IGCFile {
  header: IGCHeader;
  fixes: IGCFix[];
  events: IGCEvent[];
  task?: IGCTask;
}

/**
 * Parse latitude from IGC format: DDMMmmmN/S
 * Example: 4728234N = 47 degrees, 28.234 minutes North
 */
function parseLatitude(lat: string): number {
  const degrees = parseInt(lat.substring(0, 2), 10);
  const minutes = parseInt(lat.substring(2, 4), 10);
  const decimal = parseInt(lat.substring(4, 7), 10) / 1000;
  const direction = lat.charAt(7);

  let value = degrees + (minutes + decimal) / 60;
  if (direction === 'S') value = -value;

  return value;
}

/**
 * Parse longitude from IGC format: DDDMMmmmE/W
 * Example: 01152432E = 011 degrees, 52.432 minutes East
 */
function parseLongitude(lon: string): number {
  const degrees = parseInt(lon.substring(0, 3), 10);
  const minutes = parseInt(lon.substring(3, 5), 10);
  const decimal = parseInt(lon.substring(5, 8), 10) / 1000;
  const direction = lon.charAt(8);

  let value = degrees + (minutes + decimal) / 60;
  if (direction === 'W') value = -value;

  return value;
}

/**
 * Parse time from IGC format: HHMMSS
 * dayOffset handles midnight rollover — flights crossing midnight UTC get
 * subsequent fixes on the next calendar day.
 */
function parseTime(time: string, baseDate: Date, dayOffset: number = 0): Date {
  const hours = parseInt(time.substring(0, 2), 10);
  const minutes = parseInt(time.substring(2, 4), 10);
  const seconds = parseInt(time.substring(4, 6), 10);

  const result = new Date(baseDate);
  if (dayOffset > 0) {
    result.setUTCDate(result.getUTCDate() + dayOffset);
  }
  result.setUTCHours(hours, minutes, seconds, 0);
  return result;
}

/**
 * Parse date from IGC format: DDMMYY
 */
function parseDate(dateStr: string): Date {
  const day = parseInt(dateStr.substring(0, 2), 10);
  const month = parseInt(dateStr.substring(2, 4), 10) - 1; // 0-indexed
  let year = parseInt(dateStr.substring(4, 6), 10);

  // Handle 2-digit year: assume 20xx for years < 80, 19xx otherwise
  year += year < 80 ? 2000 : 1900;

  return new Date(Date.UTC(year, month, day));
}

/**
 * Parse a B record (GPS fix)
 * Format: BHHMMSSDDMMMMMN/SDDDMMMMMWE/WVPPPPPGGGGG
 *         B      - Record type
 *         HHMMSS - UTC time
 *         DDMMmmmN/S - Latitude (degrees, minutes, decimal minutes, N/S)
 *         DDDMMmmmE/W - Longitude (degrees, minutes, decimal minutes, E/W)
 *         V - Fix validity (A=3D, V=2D/invalid)
 *         PPPPP - Pressure altitude (meters)
 *         GGGGG - GNSS altitude (meters)
 */
function parseBRecord(line: string, baseDate: Date, dayOffset: number = 0): IGCFix | null {
  if (line.length < 35) return null;

  const time = parseTime(line.substring(1, 7), baseDate, dayOffset);
  const latitude = parseLatitude(line.substring(7, 15));
  const longitude = parseLongitude(line.substring(15, 24));
  const valid = line.charAt(24) === 'A';
  const pressureAltitude = parseInt(line.substring(25, 30), 10);
  const gnssAltitude = parseInt(line.substring(30, 35), 10);

  return {
    time,
    latitude,
    longitude,
    pressureAltitude,
    gnssAltitude,
    valid,
  };
}

/**
 * Parse a C record (task declaration point)
 * Format: CDDMMmmmN/SDDDMMmmmE/W[Description]
 *         or for first C record: C[DateTime info]
 */
function parseCRecord(line: string): IGCTaskPoint | null {
  // Skip declaration header lines
  if (line.length < 18) return null;

  // Check if this looks like a waypoint (has lat/lon pattern)
  const latPart = line.substring(1, 9);
  const lonPart = line.substring(9, 18);

  if (!/^\d{7}[NS]$/.test(latPart) || !/^\d{8}[EW]$/.test(lonPart)) {
    return null;
  }

  const latitude = parseLatitude(latPart);
  const longitude = parseLongitude(lonPart);
  const name = sanitizeText(line.substring(18).trim());

  return { latitude, longitude, name };
}

/**
 * Parse an E record (event)
 * Format: EHHMMSSTTT[text]
 *         HHMMSS - UTC time
 *         TTT - Event code (e.g., PEV for pilot event)
 */
function parseERecord(line: string, baseDate: Date, dayOffset: number = 0): IGCEvent | null {
  if (line.length < 10) return null;

  const time = parseTime(line.substring(1, 7), baseDate, dayOffset);
  const code = line.substring(7, 10);
  const description = sanitizeText(line.substring(10).trim());

  return { time, code, description };
}

/**
 * H record field definitions: [3-letter code, header property name].
 * Each field matches both the "F"-prefixed (e.g. FPLT) and bare (e.g. PLT) forms.
 */
const H_RECORD_FIELDS: [string, keyof Omit<IGCHeader, 'date'>][] = [
  ['PLT', 'pilot'],
  ['GTY', 'gliderType'],
  ['GID', 'gliderId'],
  ['CID', 'competitionId'],
  ['CCL', 'competitionClass'],
];

/**
 * Parse an H record (header)
 */
function parseHRecord(line: string, header: IGCHeader): void {
  const content = line.substring(1);

  // HFDTE / HDTE - Date (special case: value is not colon-delimited)
  if (content.startsWith('FDTE') || content.startsWith('DTE')) {
    const dateMatch = content.match(/(?:FDTE|DTE)[:\s]*(\d{6})/);
    if (dateMatch) {
      header.date = parseDate(dateMatch[1]);
    }
    return;
  }

  // All other header fields follow the same pattern: CODE[...]:value
  for (const [code, field] of H_RECORD_FIELDS) {
    if (content.startsWith(`F${code}`) || content.startsWith(code)) {
      const match = content.match(new RegExp(`(?:F${code}|${code})[^:]*:(.+)`));
      if (match) {
        header[field] = sanitizeText(match[1].trim());
      }
      return;
    }
  }
}

/**
 * Parse an IGC file content
 */
export function parseIGC(content: string): IGCFile {
  const lines = content.split(/\r?\n/);
  const header: IGCHeader = {};
  const fixes: IGCFix[] = [];
  const events: IGCEvent[] = [];
  const taskPoints: IGCTaskPoint[] = [];

  let baseDate = new Date();

  // First pass: get the date from header
  for (const line of lines) {
    if (line.startsWith('H')) {
      const dateMatch = line.match(/(?:HFDTE|HDTE)[:\s]*(\d{6})/);
      if (dateMatch) {
        baseDate = parseDate(dateMatch[1]);
        header.date = baseDate;
        break;
      }
    }
  }

  // Midnight rollover tracking: IGC B/E records only have HHMMSS with no date,
  // so flights crossing midnight UTC (common in Australia/Pacific) need day adjustment.
  let prevHours = -1;
  let dayOffset = 0;

  // Second pass: parse all records
  for (const line of lines) {
    if (!line.length) continue;

    const recordType = line.charAt(0);

    switch (recordType) {
      case 'H':
        parseHRecord(line, header);
        break;

      case 'B': {
        const hours = parseInt(line.substring(1, 3), 10);
        if (prevHours >= 18 && hours <= 6) {
          dayOffset++;
        }
        prevHours = hours;
        const fix = parseBRecord(line, baseDate, dayOffset);
        if (fix) fixes.push(fix);
        break;
      }

      case 'E': {
        const hours = parseInt(line.substring(1, 3), 10);
        if (prevHours >= 18 && hours <= 6) {
          dayOffset++;
        }
        prevHours = hours;
        const event = parseERecord(line, baseDate, dayOffset);
        if (event) events.push(event);
        break;
      }

      case 'C': {
        const point = parseCRecord(line);
        if (point) taskPoints.push(point);
        break;
      }
    }
  }

  // Build task from C records if present
  let task: IGCTask | undefined;
  if (taskPoints.length >= 2) {
    task = {
      numTurnpoints: Math.max(0, taskPoints.length - 4), // Exclude takeoff, start, finish, landing
      turnpoints: [],
    };

    // First point is takeoff, second is start, last is landing, second-to-last is finish
    // Everything in between are turnpoints
    if (taskPoints.length >= 1) task.takeoff = taskPoints[0];
    if (taskPoints.length >= 2) task.start = taskPoints[1];
    if (taskPoints.length >= 3) task.landing = taskPoints[taskPoints.length - 1];
    if (taskPoints.length >= 4) task.finish = taskPoints[taskPoints.length - 2];

    // Middle points are turnpoints
    if (taskPoints.length > 4) {
      task.turnpoints = taskPoints.slice(2, taskPoints.length - 2);
    }
  }

  return { header, fixes, events, task };
}

