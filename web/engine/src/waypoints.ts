/**
 * Waypoint Database
 *
 * Parses and provides lookup for competition waypoints from CSV files.
 * Used to enrich IGC task declarations with radius and altitude data.
 */

import { andoyerDistance } from './geo';

/**
 * A waypoint record from a competition waypoint database.
 * Named WaypointRecord to avoid conflict with Waypoint in xctsk-parser.ts.
 */
export interface WaypointRecord {
  name: string;
  latitude: number;
  longitude: number;
  description: string;
  radius: number;
  altitude: number;
}

/**
 * Parse a CSV file containing waypoints.
 *
 * Expected format:
 * Name,Latitude,Longitude,Description,Proximity Distance,Altitude
 *
 * @param csvContent The raw CSV content
 * @returns Array of parsed waypoints
 */
export function parseWaypointsCSV(csvContent: string): WaypointRecord[] {
  const lines = csvContent.trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  // Skip header row
  const waypoints: WaypointRecord[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const parts = line.split(',');
    if (parts.length < 6) continue;

    const name = parts[0].trim();
    const latitude = parseFloat(parts[1]);
    const longitude = parseFloat(parts[2]);
    const description = parts[3].trim();
    const radius = parseInt(parts[4], 10);
    const altitude = parseInt(parts[5], 10);

    if (isNaN(latitude) || isNaN(longitude)) continue;

    waypoints.push({
      name,
      latitude,
      longitude,
      description,
      radius: isNaN(radius) ? 400 : radius,
      altitude: isNaN(altitude) ? 0 : altitude,
    });
  }

  return waypoints;
}

// ---------------------------------------------------------------------------
// Multi-format waypoint file parsing
//
// Competitions publish their turnpoint database in whatever the local
// toolchain exports. We read the three formats organisers actually hand out:
// OziExplorer .wpt, SeeYou .cup, and plain CSV. All normalise to the same
// WaypointRecord so the route editor can drop them onto the map as pickable
// points. Coordinates come in two flavours — decimal degrees, or the
// DDMM.mmm + hemisphere form CUP/Ozi use — and parseCoordinateValue reads
// both. Never hand-roll geo elsewhere; this is only string→number parsing.
// ---------------------------------------------------------------------------

/** The waypoint file formats we can read. */
export type WaypointFileFormat = 'ozi-wpt' | 'seeyou-cup' | 'csv';

export interface ParsedWaypointFile {
  format: WaypointFileFormat;
  waypoints: WaypointRecord[];
}

/**
 * Split one CSV/CUP line into fields, honouring double-quoted values (which
 * may themselves contain commas) and `""` escapes. The stock split(',') in
 * parseWaypointsCSV can't do this; CUP names are quoted, so it needs to.
 */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/**
 * Parse a single coordinate value, accepting either decimal degrees
 * (`-36.185000`) or the CUP/Ozi packed form `DDMM.mmm` / `DDDMM.mmm` with a
 * trailing hemisphere letter (`3611.100S`, `14753.484E`). In the packed form
 * the two integer digits before the decimal point are minutes and everything
 * before them is whole degrees, so the same rule reads both latitude (2°
 * digits) and longitude (3° digits). Returns null when it isn't a number.
 */
export function parseCoordinateValue(raw: string): number | null {
  const t = raw.trim();
  if (t === '') return null;
  const hemi = t.slice(-1).toUpperCase();
  if (hemi === 'N' || hemi === 'S' || hemi === 'E' || hemi === 'W') {
    const num = t.slice(0, -1).trim();
    const dot = num.indexOf('.');
    const minStart = (dot >= 0 ? dot : num.length) - 2;
    if (minStart < 1) return null;
    const deg = parseInt(num.slice(0, minStart), 10);
    const min = parseFloat(num.slice(minStart));
    if (!Number.isFinite(deg) || !Number.isFinite(min)) return null;
    let v = deg + min / 60;
    if (hemi === 'S' || hemi === 'W') v = -v;
    return v;
  }
  const v = parseFloat(t);
  return Number.isFinite(v) ? v : null;
}

/** Parse an elevation field like `328.863m`, `310`, or `1000ft` to metres. */
function parseElevationValue(raw: string): number {
  const t = raw.trim();
  const v = parseFloat(t);
  if (!Number.isFinite(v)) return 0;
  return /ft\s*$/i.test(t) ? Math.round(v * 0.3048) : Math.round(v);
}

/**
 * Parse an OziExplorer waypoint file (.wpt). Four header lines, then one
 * comma-separated record per waypoint: field 2 = latitude, 3 = longitude,
 * 10 = description/long name, 13 = proximity radius (m), 14 = elevation (m).
 * The short code in field 1 is the fallback name when field 10 is blank.
 */
export function parseWaypointsWPT(content: string): WaypointRecord[] {
  const lines = content.split(/\r?\n/);
  const waypoints: WaypointRecord[] = [];
  // Header is 4 fixed lines (magic, datum, Reserved 2, Reserved 3).
  for (let i = 4; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const f = splitCsvLine(line);
    if (f.length < 4) continue;
    const latitude = parseFloat(f[2]);
    const longitude = parseFloat(f[3]);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    const description = (f[10] ?? '').trim();
    const code = (f[1] ?? '').trim();
    const radius = f.length > 13 ? parseInt(f[13], 10) : NaN;
    const altitude = f.length > 14 ? parseInt(f[14], 10) : NaN;
    waypoints.push({
      name: description || code || `WP${f[0]}`,
      latitude,
      longitude,
      description,
      radius: Number.isFinite(radius) && radius > 0 ? radius : 400,
      altitude: Number.isFinite(altitude) ? altitude : 0,
    });
  }
  return waypoints;
}

/**
 * Parse a header-based waypoint table — SeeYou .cup or a generic CSV. Both
 * are comma tables with a named header; we locate the name/lat/lon/desc/elev
 * columns by header text and read coordinates in either decimal or DDMM.mmm
 * form. CUP files end their waypoint block with a `-----Related Tasks-----`
 * marker, so parsing stops at the first all-dashes line.
 */
function parseWaypointTable(content: string): WaypointRecord[] {
  const lines = content.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) return [];
  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase().replace(/"/g, '').trim());
  const findCol = (...names: string[]) => header.findIndex((h) => names.includes(h));
  const iName = findCol('name', 'title');
  const iLat = findCol('lat', 'latitude');
  const iLon = findCol('lon', 'longitude', 'long');
  const iDesc = findCol('desc', 'description');
  const iElev = findCol('elev', 'elevation', 'altitude');
  const iRadius = findCol('radius', 'proximity distance', 'proximity');
  if (iLat < 0 || iLon < 0) return [];

  const waypoints: WaypointRecord[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('-----')) break; // CUP related-tasks section
    const f = splitCsvLine(line);
    if (f.length <= Math.max(iLat, iLon)) continue;
    const latitude = parseCoordinateValue(f[iLat] ?? '');
    const longitude = parseCoordinateValue(f[iLon] ?? '');
    if (latitude === null || longitude === null) continue;
    const name = (iName >= 0 ? f[iName] : '').replace(/"/g, '').trim();
    const description = iDesc >= 0 ? (f[iDesc] ?? '').replace(/"/g, '').trim() : '';
    const radius = iRadius >= 0 ? parseInt(f[iRadius], 10) : NaN;
    const altitude = iElev >= 0 ? parseElevationValue(f[iElev] ?? '') : 0;
    waypoints.push({
      name: name || `WP${i}`,
      latitude,
      longitude,
      description,
      radius: Number.isFinite(radius) && radius > 0 ? radius : 400,
      altitude,
    });
  }
  return waypoints;
}

/** Parse a SeeYou .cup waypoint file (comma table with DDMM.mmm coords). */
export function parseWaypointsCUP(content: string): WaypointRecord[] {
  return parseWaypointTable(content);
}

/**
 * Detect a waypoint file's format from its contents (and optional filename)
 * and parse it. Recognises OziExplorer .wpt, SeeYou .cup, and generic CSV —
 * the three formats competition organisers hand out — normalising all to
 * WaypointRecord. Throws nothing; an unrecognised file yields no waypoints.
 */
export function parseWaypointFile(content: string, filename?: string): ParsedWaypointFile {
  const firstLine = (content.split(/\r?\n/, 1)[0] ?? '').toLowerCase();
  const ext = (filename?.split('.').pop() ?? '').toLowerCase();

  if (firstLine.includes('oziexplorer') || ext === 'wpt') {
    return { format: 'ozi-wpt', waypoints: parseWaypointsWPT(content) };
  }

  const header = splitCsvLine(firstLine).map((h) => h.replace(/"/g, '').trim());
  const looksLikeCup =
    ext === 'cup' ||
    (header.includes('code') && (header.includes('lat') || header.includes('latitude')));
  if (looksLikeCup) {
    return { format: 'seeyou-cup', waypoints: parseWaypointTable(content) };
  }

  // Generic CSV. Prefer the header-driven table parser (handles quoted
  // fields and decimal-or-DDMM coords); fall back to the legacy fixed-column
  // parser for the exact 6-column shape it was written for.
  const table = parseWaypointTable(content);
  if (table.length > 0) return { format: 'csv', waypoints: table };
  return { format: 'csv', waypoints: parseWaypointsCSV(content) };
}

/**
 * Normalize a waypoint name for matching.
 * Removes common prefixes like "START", "TURN", "FINISH", etc.
 * and converts to uppercase.
 *
 * Examples:
 * - "START ELLIOT" → "ELLIOT"
 * - "TURN CUDGWE" → "CUDGWE"
 * - "FINISH NCORGL" → "NCORGL"
 * - "HALFWY" → "HALFWY"
 */
function normalizeWaypointName(name: string): string {
  return name
    .toUpperCase()
    .replace(/^(START|TURN|FINISH|TAKEOFF|LANDING|GOAL|SSS|ESS)\s+/, '')
    .trim();
}

/**
 * Find a waypoint by name, with fuzzy matching.
 *
 * Tries exact match first, then normalized match (removing prefixes).
 *
 * @param waypoints The waypoint database
 * @param name The name to search for
 * @returns The matching waypoint, or undefined
 */
export function findWaypointByName(waypoints: WaypointRecord[], name: string): WaypointRecord | undefined {
  const upperName = name.toUpperCase();
  const normalizedName = normalizeWaypointName(name);

  // Try exact match first
  const exact = waypoints.find(wp => wp.name.toUpperCase() === upperName);
  if (exact) return exact;

  // Try normalized match (e.g., "START ELLIOT" matches "ELLIOT")
  const normalized = waypoints.find(wp => wp.name.toUpperCase() === normalizedName);
  if (normalized) return normalized;

  // Try if waypoint name is contained in the search name
  // e.g., "TURN HALFWY" contains "HALFWY"
  const contained = waypoints.find(wp =>
    upperName.includes(wp.name.toUpperCase()) ||
    normalizedName.includes(wp.name.toUpperCase())
  );
  if (contained) return contained;

  return undefined;
}

/**
 * Find a waypoint by coordinates within a tolerance.
 *
 * @param waypoints The waypoint database
 * @param latitude The latitude to search for
 * @param longitude The longitude to search for
 * @param toleranceMeters Maximum distance in meters (default: 50m)
 * @returns The closest matching waypoint within tolerance, or undefined
 */
export function findWaypointByCoordinates(
  waypoints: WaypointRecord[],
  latitude: number,
  longitude: number,
  toleranceMeters: number = 50
): WaypointRecord | undefined {
  let closest: WaypointRecord | undefined;
  let closestDistance = Infinity;

  for (const wp of waypoints) {
    const distance = andoyerDistance(latitude, longitude, wp.latitude, wp.longitude);
    if (distance <= toleranceMeters && distance < closestDistance) {
      closest = wp;
      closestDistance = distance;
    }
  }

  return closest;
}

/**
 * Find a waypoint by name first, then by coordinates as fallback.
 *
 * @param waypoints The waypoint database
 * @param name The name to search for
 * @param latitude The latitude to search for
 * @param longitude The longitude to search for
 * @param toleranceMeters Maximum distance in meters for coordinate matching
 * @returns The matching waypoint, or undefined
 */
export function findWaypoint(
  waypoints: WaypointRecord[],
  name: string,
  latitude: number,
  longitude: number,
  toleranceMeters: number = 50
): WaypointRecord | undefined {
  // Try name match first
  const byName = findWaypointByName(waypoints, name);
  if (byName) return byName;

  // Fall back to coordinate match
  return findWaypointByCoordinates(waypoints, latitude, longitude, toleranceMeters);
}

