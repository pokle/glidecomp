/**
 * IGC File Parser
 *
 * Parses IGC (International Gliding Commission) flight recorder files.
 * Reference: https://xp-soaring.github.io/igc_file_format/igc_format_2008.html
 */

import { sanitizeText } from './sanitize';
import { cleanAltitudes, type AltitudeCleaningReport } from './altitude-cleaning';

export interface IGCFix {
  time: Date;
  latitude: number;
  longitude: number;
  pressureAltitude: number;
  gnssAltitude: number;
  valid: boolean;
  /** Repaired altitude where cleaning flagged this fix as implausible (see
   * altitude-cleaning.ts). Raw channels above stay exactly as logged. */
  cleanedAltitude?: number;
}

/**
 * A fix's altitude for analysis: the cleaned value where the plausibility
 * pass repaired this fix (see altitude-cleaning.ts), otherwise GNSS, falling
 * back to pressure when the logger wrote the GNSS field as 0 (the IGC "no
 * GPS altitude" sentinel — dropout fixes, pressure-only instruments). THE
 * canonical altitude read; every consumer must use it rather than raw
 * gnssAltitude, or one dropout fix reads as sea level.
 */
export function fixAltitude(fix: IGCFix): number {
  if (fix.cleanedAltitude !== undefined) return fix.cleanedAltitude;
  return fix.gnssAltitude !== 0 ? fix.gnssAltitude : fix.pressureAltitude;
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

export interface IGCAreaOZ {
  innerRadius: number;  // meters
  outerRadius: number;  // meters
  bearing1: number;     // degrees
  bearing2: number;     // degrees
  areaType: 'STARTAREA' | 'TURNAREA' | 'FINISHAREA';
}

export interface IGCTaskPoint {
  latitude: number;
  longitude: number;
  name: string;
  areaOZ?: IGCAreaOZ; // OZ = Observation Zone (FAI/IGC term)
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

/**
 * What the parse-time timestamp pass found and did — the transparency record
 * for the time axis, parallel to {@link AltitudeCleaningReport} for altitude.
 *
 * Every field is a count or a magnitude, so a caller can say exactly how much
 * of a file was discarded without re-reading it. On a well-formed track every
 * field is 0 except `totalRecordCount` and, above 1 Hz, `duplicateTimeFixCount`.
 */
export interface TimeOrderReport {
  /** B records that passed field validation. */
  totalRecordCount: number;
  /** B records rejected by field validation — truncated, non-digit, binary. */
  malformedRecordCount: number;
  /** Fixes dropped to keep `fixes` non-decreasing in time (see parseIGC). */
  droppedFixCount: number;
  /** Kept fixes sharing the previous fix's second. Legitimate above 1 Hz — the
   * B record's resolution is one second, so a 5 Hz logger writes five. */
  duplicateTimeFixCount: number;
  /** Largest backwards step seen before dropping, milliseconds. */
  maxBackwardsJumpMs: number;
  /** Midnight crossings the day-offset heuristic applied: 0 or 1. */
  dayRollovers: number;
  /** Later ≥18h→≤6h transitions refused because one crossing is the cap. */
  suppressedDayRollovers: number;
}

export interface IGCFile {
  header: IGCHeader;
  /** Non-decreasing in time — guaranteed by parseIGC, relied on by every
   * time-window loop in the engine. */
  fixes: IGCFix[];
  events: IGCEvent[];
  task?: IGCTask;
  /** What the altitude plausibility pass repaired (transparency record —
   * surfaced on the score explainer). */
  altitudeCleaning: AltitudeCleaningReport;
  /** What the timestamp pass discarded to make `fixes` non-decreasing. */
  timeOrder: TimeOrderReport;
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

const MS_PER_DAY = 86_400_000;

/**
 * Parse time from IGC format: HHMMSS
 * dayOffset handles midnight rollover — flights crossing midnight UTC get
 * subsequent fixes on the next calendar day.
 *
 * `baseMidnightMs` is the epoch-millisecond value of 00:00:00 UTC on the
 * flight's base date. Building the Date arithmetically (rather than cloning a
 * base Date and calling setUTCHours) is materially cheaper when a track has
 * tens of thousands of fixes — the hot path in competition scoring.
 */
function parseTime(time: string, baseMidnightMs: number, dayOffset: number = 0): Date {
  const hours = parseInt(time.substring(0, 2), 10);
  const minutes = parseInt(time.substring(2, 4), 10);
  const seconds = parseInt(time.substring(4, 6), 10);

  return new Date(
    baseMidnightMs +
      dayOffset * MS_PER_DAY +
      (hours * 3600 + minutes * 60 + seconds) * 1000
  );
}

/** Epoch ms of 00:00:00 UTC on the same UTC calendar day as `d`. */
function midnightUTCms(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
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
 *         PPPPP - Pressure altitude (meters, may be negative: "-0012")
 *         GGGGG - GNSS altitude (meters, may be negative)
 *
 * Every field is validated before parsing — a single corrupted B record
 * (truncated line, binary garbage, non-digit fields) would otherwise feed
 * NaN coordinates or an Invalid Date into every downstream distance/climb
 * computation.
 */
const B_RECORD_RE =
  /^B(\d{6})(\d{7}[NS])(\d{8}[EW])([AV])(-\d{4}|\d{5})(-\d{4}|\d{5})/;

/**
 * Build a fix from an already-matched B record. Taking the match rather than
 * the line is deliberate: the caller must validate BEFORE it advances the
 * midnight-rollover state, or a corrupt line's garbage hour field steers the
 * day offset for every fix after it (see parseIGC).
 */
function fixFromBRecord(m: RegExpExecArray, baseMidnightMs: number, dayOffset: number): IGCFix {
  return {
    time: parseTime(m[1], baseMidnightMs, dayOffset),
    latitude: parseLatitude(m[2]),
    longitude: parseLongitude(m[3]),
    valid: m[4] === 'A',
    pressureAltitude: parseInt(m[5], 10),
    gnssAltitude: parseInt(m[6], 10),
  };
}

/**
 * Parse area task observation zone parameters from a C-record name field.
 * IGC spec format: DDDDdddDDDDdddBBBbbbBBBbbbTYPEAREA WaypointName
 *   - 7 digits: min distance from WP in km (DDDDddd = DDDD.ddd km, integer value = meters)
 *   - 7 digits: max distance from WP in km (same encoding; 9999999 = no limit sentinel)
 *   - 6 digits: bearing1 in degrees (BBBbbb = BBB.bbb°)
 *   - 6 digits: bearing2 in degrees (same encoding, area extends clockwise from b1 to b2)
 *   - Type: STARTAREA, TURNAREA, or FINISHAREA
 *   - Remaining text: waypoint name (underscores replaced with spaces)
 */
const AREA_TASK_RE = /^(\d{7})(\d{7})(\d{6})(\d{6})(STARTAREA|TURNAREA|FINISHAREA)\s*(.*)$/;

function parseAreaTaskName(rawName: string): { name: string; areaOZ: IGCAreaOZ } | null {
  const m = AREA_TASK_RE.exec(rawName);
  if (!m) return null;

  const innerRadius = parseInt(m[1], 10);
  const outerRadius = parseInt(m[2], 10);

  return {
    name: m[6].replace(/_/g, ' ').trim(),
    areaOZ: {
      innerRadius,
      // Flyskyhy uses 9999999 as a sentinel for "no outer limit" (e.g. start cylinders)
      outerRadius: outerRadius >= 9999999 ? Infinity : outerRadius,
      bearing1: parseInt(m[3], 10) / 1000,
      bearing2: parseInt(m[4], 10) / 1000,
      areaType: m[5] as IGCAreaOZ['areaType'],
    },
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
  const rawName = line.substring(18).trim();

  // Try to parse area task OZ parameters from the name field
  const area = parseAreaTaskName(rawName);
  if (area) {
    return { latitude, longitude, name: sanitizeText(area.name), areaOZ: area.areaOZ };
  }

  return { latitude, longitude, name: sanitizeText(rawName) };
}

/**
 * Parse an E record (event)
 * Format: EHHMMSSTTT[text]
 *         HHMMSS - UTC time
 *         TTT - Event code (e.g., PEV for pilot event)
 *
 * The time field is digit-validated for the same reason B records are: an
 * unvalidated HHMMSS yields an Invalid Date, and — before the record is
 * dropped for it — steers the shared midnight-rollover state.
 */
const E_RECORD_RE = /^E(\d{6})(.{3})(.*)$/;

function eventFromERecord(m: RegExpExecArray, baseMidnightMs: number, dayOffset: number): IGCEvent {
  return {
    time: parseTime(m[1], baseMidnightMs, dayOffset),
    code: m[2],
    description: sanitizeText(m[3].trim()),
  };
}

/**
 * The H-record date field (HFDTE / HDTE, with the IGC source char F, O or P
 * optional), matched against the content AFTER the leading 'H'. Also accepts
 * the post-2015 long form HFDTEDATE:150124,01. Captures the DDMMYY digits.
 * Shared by parseIGC's first-pass date scan and parseHRecord.
 */
const H_DATE_RE = /^[FOP]?DTE(?:DATE)?[:\s]*(\d{6})/;

/**
 * H record field definitions. Each field matches the source-prefixed
 * (FPLT/OPLT/PPLT — the IGC spec allows source char F, O, or P) and bare
 * (PLT) forms. The RegExps are compiled once here rather than per line —
 * parseHRecord runs for every H record of every track.
 */
const H_RECORD_FIELDS = ([
  ['PLT', 'pilot'],
  ['GTY', 'gliderType'],
  ['GID', 'gliderId'],
  ['CID', 'competitionId'],
  ['CCL', 'competitionClass'],
] as const).map(([code, field]) => ({
  field: field as keyof Omit<IGCHeader, 'date'>,
  prefix: new RegExp(`^[FOP]?${code}`),
  value: new RegExp(`^[FOP]?${code}[^:]*:(.+)`),
}));

/**
 * Parse an H record (header)
 */
function parseHRecord(line: string, header: IGCHeader): void {
  const content = line.substring(1);

  // H[FOP]DTE / HDTE - Date (special case: value is not colon-delimited).
  if (/^[FOP]?DTE/.test(content)) {
    const dateMatch = H_DATE_RE.exec(content);
    if (dateMatch) {
      header.date = parseDate(dateMatch[1]);
    }
    return;
  }

  // All other header fields follow the same pattern: [source]CODE[...]:value
  for (const { field, prefix, value } of H_RECORD_FIELDS) {
    if (prefix.test(content)) {
      const match = value.exec(content);
      if (match) {
        header[field] = sanitizeText(match[1].trim());
      }
      return;
    }
  }
}

/**
 * How many midnight crossings one file may contain.
 *
 * An IGC file is ONE flight, and no flight lasts 24 hours — so a second
 * ≥18h→≤6h transition is not a second crossing, it is a corrupt clock. Left
 * uncapped, an oscillating time field (23:xx, 05:xx, 23:xx, …) marches the day
 * offset forward without bound, and the file ends up "spanning" days: the
 * timestamps stay monotone, so nothing downstream objects, while track
 * quality's wrong-day check sees a flight days from its task. Capping the
 * offset instead makes the rewound fixes go backwards, where the ordering rule
 * below drops them.
 */
const MAX_DAY_ROLLOVERS = 1;

/**
 * Parse an IGC file content
 *
 * ## Timestamps
 *
 * The returned `fixes` are guaranteed **non-decreasing in time**. Every
 * time-window loop in the engine — altitude cleaning, track quality, event
 * detection, every dt-based rate — assumes that, and B records carry no date,
 * so nothing but this function can establish it.
 *
 * Two kinds of non-monotonicity, treated differently:
 *
 * - **Duplicate timestamps are kept.** The B record's resolution is one
 *   second, so a logger sampling above 1 Hz legitimately writes several fixes
 *   per second. 24 of the 5,590 archived tracks do. Dropping them would throw
 *   away real position data.
 * - **Strictly backwards fixes are dropped**, never clamped or coalesced.
 *   Clamping invents a timestamp the logger never wrote and turns a corrupt
 *   jump into a dense cluster of zero-dt fixes; dropping keeps every retained
 *   fix exactly as logged and records what went in `timeOrder`.
 *
 * Dropping naively would let ONE fix stamped far in the future truncate the
 * whole rest of a flight, so an isolated forward spike is popped instead: when
 * the fix that broke the order is itself back in order against the fix before
 * the last kept one, the last kept one was the outlier and goes. A *sustained*
 * rewind is not a spike, and there the first ordering wins — the rewound run
 * is dropped.
 *
 * No file in the corpus needs any of this: across 5,590 real tracks there are
 * zero backwards steps and zero malformed B records. It is a guarantee for
 * corrupt and adversarial input, not a repair of anything observed.
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
      const dateMatch = H_DATE_RE.exec(line.substring(1));
      if (dateMatch) {
        baseDate = parseDate(dateMatch[1]);
        header.date = baseDate;
        break;
      }
    }
  }

  // Epoch ms of midnight UTC on the base date, computed once and reused for
  // every B/E record (see parseTime).
  const baseMidnightMs = midnightUTCms(baseDate);

  const timeOrder: TimeOrderReport = {
    totalRecordCount: 0,
    malformedRecordCount: 0,
    droppedFixCount: 0,
    duplicateTimeFixCount: 0,
    maxBackwardsJumpMs: 0,
    dayRollovers: 0,
    suppressedDayRollovers: 0,
  };

  // Midnight rollover tracking: IGC B/E records only have HHMMSS with no date,
  // so flights crossing midnight UTC (common in Australia/Pacific) need day
  // adjustment. A time jumping from late evening to early morning between
  // consecutive timed records means the flight crossed midnight.
  //
  // Driven by VALIDATED time fields only. Reading the hour straight off the
  // line advanced this state from records that were then thrown away: a
  // corrupt line whose hour field reads 99 armed the heuristic, so the next
  // honest morning fix shifted the entire rest of the track a day forward,
  // and a line whose hour field is not numeric at all set `prevHours` to NaN,
  // which compares false against everything and disarms a genuine crossing.
  let prevHours = -1;
  let dayOffset = 0;
  const dayOffsetFor = (hhmmss: string): number => {
    const hours = parseInt(hhmmss.substring(0, 2), 10);
    if (prevHours >= 18 && hours <= 6) {
      if (dayOffset < MAX_DAY_ROLLOVERS) {
        dayOffset++;
        timeOrder.dayRollovers++;
      } else {
        timeOrder.suppressedDayRollovers++;
      }
    }
    prevHours = hours;
    return dayOffset;
  };

  // Append a fix, keeping `fixes` non-decreasing in time. See the policy in
  // this function's doc comment.
  let lastKeptMs = -Infinity;
  const appendFix = (fix: IGCFix): void => {
    const t = fix.time.getTime();
    if (t >= lastKeptMs) {
      if (t === lastKeptMs) timeOrder.duplicateTimeFixCount++;
      fixes.push(fix);
      lastKeptMs = t;
      return;
    }

    timeOrder.maxBackwardsJumpMs = Math.max(timeOrder.maxBackwardsJumpMs, lastKeptMs - t);

    // Was the last fix kept an isolated forward spike? If dropping IT restores
    // order, it is the one fix that disagrees with its neighbours on both
    // sides, and costs one bogus fix rather than the rest of the flight.
    const priorMs =
      fixes.length >= 2 ? fixes[fixes.length - 2].time.getTime() : -Infinity;
    if (t >= priorMs) {
      fixes.pop();
      timeOrder.droppedFixCount++;
      if (t === priorMs) timeOrder.duplicateTimeFixCount++;
      fixes.push(fix);
      lastKeptMs = t;
      return;
    }

    timeOrder.droppedFixCount++;
  };

  // Second pass: parse all records
  for (const line of lines) {
    if (!line.length) continue;

    const recordType = line.charAt(0);

    switch (recordType) {
      case 'H':
        parseHRecord(line, header);
        break;

      case 'B': {
        const m = B_RECORD_RE.exec(line);
        if (!m) {
          timeOrder.malformedRecordCount++;
          break;
        }
        timeOrder.totalRecordCount++;
        appendFix(fixFromBRecord(m, baseMidnightMs, dayOffsetFor(m[1])));
        break;
      }

      case 'E': {
        const m = E_RECORD_RE.exec(line);
        if (!m) break;
        events.push(eventFromERecord(m, baseMidnightMs, dayOffsetFor(m[1])));
        break;
      }

      case 'C': {
        const point = parseCRecord(line);
        if (point) taskPoints.push(point);
        break;
      }
    }
  }

  // Build task from C records if present.
  // First point is takeoff, second is start, last is landing, second-to-last
  // is finish; everything in between (excluding those four) are turnpoints.
  let task: IGCTask | undefined;
  if (taskPoints.length >= 2) {
    const turnpoints = taskPoints.length > 4
      ? taskPoints.slice(2, taskPoints.length - 2)
      : [];
    task = {
      numTurnpoints: turnpoints.length,
      turnpoints,
      takeoff: taskPoints[0],
      start: taskPoints[1],
    };
    if (taskPoints.length >= 3) task.landing = taskPoints[taskPoints.length - 1];
    if (taskPoints.length >= 4) task.finish = taskPoints[taskPoints.length - 2];
  }

  // Altitude plausibility pass: repairs land in fix.cleanedAltitude (raw
  // channels untouched) so every consumer downstream of fixAltitude() reads
  // the cleaned series; the report is the transparency record.
  const altitudeCleaning = cleanAltitudes(fixes);

  return { header, fixes, events, task, altitudeCleaning, timeOrder };
}

