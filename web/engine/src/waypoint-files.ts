/**
 * Multi-format waypoint file parsing.
 *
 * Competitions publish their turnpoint database in whatever the local
 * toolchain exports. We read the formats organisers hand out — OziExplorer
 * and Garmin/PCX5/CompeGPS .wpt, SeeYou .cup, FS $FormatGEO/$FormatUTM, GPX,
 * KML and plain CSV — normalising each to a WaypointFileRecord for the route
 * editor to drop onto the map as pickable points.
 *
 * Every format carries two identifiers: a short **code** (e.g. "A01", "CURY")
 * and a longer **name** (e.g. "BORDANO LANDING"). We keep them separate —
 * they're shown separately and must survive a round-trip back to a file — so
 * `code` and `name` are distinct fields (`name` falls back to `code` when a
 * format has only one). Coordinates arrive as decimal degrees, DDMM.mmm +
 * hemisphere, DMS, or UTM; each parser normalises to signed decimal degrees.
 *
 * This module is deliberately separate from ./waypoints: it is NOT part of
 * the scoring import closure (see scoring-version.test.ts), so adding file
 * formats here never forces a scoring-engine version bump. It's pure
 * string→number parsing; never hand-roll geo maths here (UTM lives in ./utm).
 */
import { parseWaypointsCSV, type WaypointRecord } from './waypoints';
import { utmToLatLon } from './utm';

/**
 * A waypoint parsed from a file. `code` is the short identifier and `name`
 * the long descriptive name; they are kept separate so both can be shown and
 * re-exported. (Distinct from waypoints.ts's WaypointRecord, the CSV DB record
 * used to enrich IGC tasks.)
 */
export interface WaypointFileRecord {
  code: string;
  name: string;
  latitude: number;
  longitude: number;
  altitude: number;
  radius: number;
}

/** The waypoint file formats we can read. */
export type WaypointFileFormat =
  | 'ozi-wpt'
  | 'garmin-wpt'
  | 'fs-geo'
  | 'utm'
  | 'seeyou-cup'
  | 'gpx'
  | 'kml'
  | 'csv';

export interface ParsedWaypointFile {
  format: WaypointFileFormat;
  waypoints: WaypointFileRecord[];
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
export function parseWaypointsWPT(content: string): WaypointFileRecord[] {
  const lines = content.split(/\r?\n/);
  const waypoints: WaypointFileRecord[] = [];
  // Header is 4 fixed lines (magic, datum, Reserved 2, Reserved 3).
  for (let i = 4; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const f = splitCsvLine(line);
    if (f.length < 4) continue;
    const latitude = parseFloat(f[2]);
    const longitude = parseFloat(f[3]);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    const longName = (f[10] ?? '').trim(); // field 10 is the descriptive name
    const code = (f[1] ?? '').trim() || `WP${f[0]}`;
    const radius = f.length > 13 ? parseInt(f[13], 10) : NaN;
    const altitude = f.length > 14 ? parseInt(f[14], 10) : NaN;
    waypoints.push({
      code,
      name: longName || code,
      latitude,
      longitude,
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
function parseWaypointTable(content: string): WaypointFileRecord[] {
  const lines = content.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) return [];
  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase().replace(/"/g, '').trim());
  const findCol = (...names: string[]) => header.findIndex((h) => names.includes(h));
  const iName = findCol('name', 'title');
  const iCode = findCol('code');
  const iLat = findCol('lat', 'latitude');
  const iLon = findCol('lon', 'longitude', 'long');
  const iDesc = findCol('desc', 'description');
  const iElev = findCol('elev', 'elevation', 'altitude');
  const iRadius = findCol('radius', 'proximity distance', 'proximity');
  if (iLat < 0 || iLon < 0) return [];

  const waypoints: WaypointFileRecord[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('-----')) break; // CUP related-tasks section
    const f = splitCsvLine(line);
    if (f.length <= Math.max(iLat, iLon)) continue;
    const latitude = parseCoordinateValue(f[iLat] ?? '');
    const longitude = parseCoordinateValue(f[iLon] ?? '');
    if (latitude === null || longitude === null) continue;
    const cell = (idx: number) => (idx >= 0 ? (f[idx] ?? '').replace(/"/g, '').trim() : '');
    const nameCell = cell(iName);
    // SeeYou .cup has a dedicated `code` column (short id) with the long name
    // in `name`; a generic CSV has no code column, so its "Name" column is the
    // short code and "Description" the long name.
    let code: string;
    let longName: string;
    if (iCode >= 0) {
      code = cell(iCode) || nameCell;
      longName = nameCell || code;
    } else {
      code = nameCell;
      longName = cell(iDesc) || nameCell;
    }
    if (!code) code = `WP${i}`;
    const radius = iRadius >= 0 ? parseInt(f[iRadius], 10) : NaN;
    const altitude = iElev >= 0 ? parseElevationValue(f[iElev] ?? '') : 0;
    waypoints.push({
      code,
      name: longName || code,
      latitude,
      longitude,
      radius: Number.isFinite(radius) && radius > 0 ? radius : 400,
      altitude,
    });
  }
  return waypoints;
}

/** Parse a SeeYou .cup waypoint file (comma table with DDMM.mmm coords). */
export function parseWaypointsCUP(content: string): WaypointFileRecord[] {
  return parseWaypointTable(content);
}

/**
 * Parse one decimal-degrees-plus-hemisphere token, e.g. `35.8525118956°S` or
 * `142.7814859414°E`. The degree symbol is often mojibake (a file saved as
 * Latin-1 then read as UTF-8 turns `°` into U+FFFD), so we key off the
 * trailing hemisphere letter and strip everything non-numeric from the rest.
 */
function parseDecimalHemiCoord(token: string): number | null {
  const hemi = token.trim().match(/([NSEWnsew])\s*$/)?.[1]?.toUpperCase();
  const num = parseFloat(token.replace(/[^0-9.+-]/g, ''));
  if (!Number.isFinite(num)) return null;
  return hemi === 'S' || hemi === 'W' ? -Math.abs(num) : num;
}

/**
 * Parse a Garmin / PCX5-style `.wpt` file (a different, older `.wpt` than
 * OziExplorer's). Header lines like `G  WGS 84` and `U  1`, then one
 * whitespace-delimited `W` record per waypoint:
 *   `W  CURY A 35.8525S 142.7815E 27-MAR-62 00:00:00 0.000000 CURY`
 * The two coordinate tokens are the ones carrying a hemisphere letter; the
 * rest (symbol class, date, time, altitude, description) sit around them.
 */
export function parseWaypointsPCX5(content: string): WaypointFileRecord[] {
  const out: WaypointFileRecord[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (!/^W\s/.test(line)) continue;
    const t = line.trim().split(/\s+/);
    if (t.length < 5) continue;
    // Coordinate tokens = those with a digit AND a trailing hemisphere letter
    // (names like "SLKE" end in E but have no digit; "400" has no hemisphere).
    const coordIdx: number[] = [];
    for (let i = 2; i < t.length; i++) {
      if (/\d/.test(t[i]) && /[NSEWnsew]$/.test(t[i])) coordIdx.push(i);
    }
    if (coordIdx.length < 2) continue;
    const lat = parseDecimalHemiCoord(t[coordIdx[0]]);
    const lon = parseDecimalHemiCoord(t[coordIdx[1]]);
    if (lat === null || lon === null) continue;
    // Altitude is the first plain number after the coordinates; anything after
    // that is the long name (CompeGPS carries "BORDANO LANDING" etc.).
    let altitude = 0;
    let altIdx = -1;
    for (let i = coordIdx[1] + 1; i < t.length; i++) {
      if (/^[+-]?\d+(\.\d+)?$/.test(t[i])) {
        altitude = Math.round(parseFloat(t[i]));
        altIdx = i;
        break;
      }
    }
    const code = t[1] || `WP${out.length + 1}`;
    const longName = altIdx >= 0 && altIdx + 1 < t.length ? t.slice(altIdx + 1).join(' ') : '';
    out.push({
      code,
      name: longName || code,
      latitude: lat,
      longitude: lon,
      radius: 400,
      altitude,
    });
  }
  return out;
}

/** Minimal XML entity decode for names/descriptions in GPX/KML. */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

const firstTag = (body: string, tag: string): string | undefined => {
  const m = body.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? decodeXmlEntities(m[1].trim()) : undefined;
};

/**
 * Parse a GPX 1.1 waypoint file: one `<wpt lat="…" lon="…">` per point with
 * `<name>` (the short code), optional `<ele>` (metres) and `<desc>`/`<cmt>`
 * (the long name). Regex-based (no DOM) so it stays dependency-free and
 * SSR-safe. Attribute order is not assumed.
 */
export function parseWaypointsGPX(content: string): WaypointFileRecord[] {
  const out: WaypointFileRecord[] = [];
  for (const m of content.matchAll(/<wpt\b([^>]*)>([\s\S]*?)<\/wpt>/gi)) {
    const attrs = m[1];
    const lat = parseFloat(attrs.match(/\blat\s*=\s*"([^"]+)"/i)?.[1] ?? '');
    const lon = parseFloat(attrs.match(/\blon\s*=\s*"([^"]+)"/i)?.[1] ?? '');
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const code = firstTag(m[2], 'name') || `WP${out.length + 1}`;
    const longName = firstTag(m[2], 'desc') || firstTag(m[2], 'cmt') || code;
    const ele = parseFloat(firstTag(m[2], 'ele') ?? '');
    out.push({
      code,
      name: longName,
      latitude: lat,
      longitude: lon,
      radius: 400,
      altitude: Number.isFinite(ele) ? Math.round(ele) : 0,
    });
  }
  return out;
}

/**
 * Parse a KML waypoint file: each `<Placemark>` with a `<Point>` becomes a
 * waypoint — `<name>` is the short code, `<description>` the long name. KML
 * coordinates are `lon,lat,alt`. We read only the Point's coordinates
 * (ignoring any LookAt/Camera view the placemark also carries).
 */
export function parseWaypointsKML(content: string): WaypointFileRecord[] {
  const out: WaypointFileRecord[] = [];
  for (const m of content.matchAll(/<Placemark\b[^>]*>([\s\S]*?)<\/Placemark>/gi)) {
    const body = m[1];
    const point = body.match(/<Point\b[^>]*>([\s\S]*?)<\/Point>/i);
    if (!point) continue;
    const coords = point[1].match(/<coordinates>([\s\S]*?)<\/coordinates>/i);
    if (!coords) continue;
    const parts = coords[1].trim().split(/\s*,\s*/);
    const lon = parseFloat(parts[0]);
    const lat = parseFloat(parts[1]);
    const alt = parseFloat(parts[2] ?? '');
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const code = firstTag(body, 'name') || `WP${out.length + 1}`;
    out.push({
      code,
      name: firstTag(body, 'description') || code,
      latitude: lat,
      longitude: lon,
      radius: 400,
      altitude: Number.isFinite(alt) ? Math.round(alt) : 0,
    });
  }
  return out;
}

/** Degrees/minutes/seconds → signed decimal degrees. */
function dmsToDegrees(hemi: string, d: string, m: string, s: string): number | null {
  const deg = parseFloat(d);
  const min = parseFloat(m);
  const sec = parseFloat(s);
  if (!Number.isFinite(deg) || !Number.isFinite(min) || !Number.isFinite(sec)) return null;
  const v = deg + min / 60 + sec / 3600;
  return /^[SW]$/i.test(hemi) ? -v : v;
}

/**
 * Parse an FS `$FormatGEO` waypoint file: fixed columns of
 *   `NAME   N dd mm ss.ss   E ddd mm ss.ss   alt   description`
 * (degrees-minutes-seconds with hemisphere letters). Everything after the
 * altitude is the long name.
 */
export function parseWaypointsFsGeo(content: string): WaypointFileRecord[] {
  const out: WaypointFileRecord[] = [];
  for (const line of content.split(/\r?\n/)) {
    const l = line.trim();
    if (!l || l.startsWith('$') || l.startsWith('#') || l.startsWith('*')) continue;
    const t = l.split(/\s+/);
    const iLat = t.findIndex((x) => /^[NS]$/i.test(x));
    const iLon = t.findIndex((x, k) => k > iLat && /^[EW]$/i.test(x));
    if (iLat < 1 || iLon < 0 || iLon + 3 >= t.length) continue;
    const lat = dmsToDegrees(t[iLat], t[iLat + 1], t[iLat + 2], t[iLat + 3]);
    const lon = dmsToDegrees(t[iLon], t[iLon + 1], t[iLon + 2], t[iLon + 3]);
    if (lat === null || lon === null) continue;
    let altitude = 0;
    let descStart = iLon + 4;
    if (/^[+-]?\d+(\.\d+)?$/.test(t[iLon + 4] ?? '')) {
      altitude = Math.round(parseFloat(t[iLon + 4]));
      descStart = iLon + 5;
    }
    const code = t.slice(0, iLat).join(' ') || `WP${out.length + 1}`;
    const longName = t.slice(descStart).join(' ');
    out.push({
      code,
      name: longName || code,
      latitude: lat,
      longitude: lon,
      radius: 400,
      altitude,
    });
  }
  return out;
}

/**
 * Parse an FS `$FormatUTM` waypoint file: fixed columns of
 *   `NAME   <zone><band>   easting   northing   alt   description`
 * e.g. `A01   33T   0354663   5130093   225   BORDANO LANDING`. The grid
 * reference is converted to WGS84 lat/lon via geo.ts's utmToLatLon.
 */
export function parseWaypointsUTM(content: string): WaypointFileRecord[] {
  const out: WaypointFileRecord[] = [];
  for (const line of content.split(/\r?\n/)) {
    const l = line.trim();
    if (!l || l.startsWith('$') || l.startsWith('#') || l.startsWith('*')) continue;
    const t = l.split(/\s+/);
    const iZone = t.findIndex((x) => /^\d{1,2}[C-HJ-NP-Xc-hj-np-x]$/.test(x));
    if (iZone < 1 || iZone + 2 >= t.length) continue;
    const zone = parseInt(t[iZone], 10);
    const band = t[iZone].slice(-1).toUpperCase();
    const easting = parseFloat(t[iZone + 1]);
    const northing = parseFloat(t[iZone + 2]);
    if (!Number.isFinite(zone) || !Number.isFinite(easting) || !Number.isFinite(northing)) continue;
    // Band letters N–X are the northern hemisphere, C–M the southern.
    const { lat, lon } = utmToLatLon(zone, band >= 'N', easting, northing);
    let altitude = 0;
    let descStart = iZone + 3;
    if (/^[+-]?\d+(\.\d+)?$/.test(t[iZone + 3] ?? '')) {
      altitude = Math.round(parseFloat(t[iZone + 3]));
      descStart = iZone + 4;
    }
    const code = t.slice(0, iZone).join(' ') || `WP${out.length + 1}`;
    const longName = t.slice(descStart).join(' ');
    out.push({
      code,
      name: longName || code,
      latitude: lat,
      longitude: lon,
      radius: 400,
      altitude,
    });
  }
  return out;
}

/**
 * Detect a waypoint file's format from its **contents** (with the filename as
 * a hint) and parse it. Content wins over extension because the same `.wpt`
 * extension covers two unrelated formats (OziExplorer and Garmin/PCX5) and
 * files are routinely renamed. Recognises OziExplorer `.wpt`, Garmin/PCX5
 * `.wpt`, SeeYou `.cup`, GPX, KML and generic CSV, normalising all to
 * WaypointRecord. Throws nothing; an unrecognised file yields no waypoints.
 */
export function parseWaypointFile(content: string, filename?: string): ParsedWaypointFile {
  const firstLine = (content.split(/\r?\n/, 1)[0] ?? '').toLowerCase();
  const ext = (filename?.split('.').pop() ?? '').toLowerCase();

  // XML formats — detect by root/element regardless of extension.
  if (/^\s*</.test(content)) {
    if (/<gpx\b|<wpt\b/i.test(content)) {
      return { format: 'gpx', waypoints: parseWaypointsGPX(content) };
    }
    if (/<kml\b|<Placemark\b/i.test(content)) {
      return { format: 'kml', waypoints: parseWaypointsKML(content) };
    }
  }

  if (firstLine.includes('oziexplorer')) {
    return { format: 'ozi-wpt', waypoints: parseWaypointsWPT(content) };
  }
  // FS exports declare their coordinate format on the first line.
  if (/^\$FormatGEO\b/im.test(content)) {
    return { format: 'fs-geo', waypoints: parseWaypointsFsGeo(content) };
  }
  if (/^\$FormatUTM\b/im.test(content)) {
    return { format: 'utm', waypoints: parseWaypointsUTM(content) };
  }
  // Garmin/PCX5/CompeGPS: a `G  <datum>` header line plus whitespace `W`
  // records (CompeGPS adds lowercase `w` comment lines, which we skip).
  if (/^G\s/m.test(content) && /^W\s/m.test(content)) {
    return { format: 'garmin-wpt', waypoints: parseWaypointsPCX5(content) };
  }
  // An unlabelled .wpt that reached here is the OziExplorer CSV variant.
  if (ext === 'wpt') {
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
  // Legacy WaypointRecord → WaypointFileRecord: its Name is the short code,
  // its Description the long name.
  const legacy = parseWaypointsCSV(content).map((w): WaypointFileRecord => ({
    code: w.name,
    name: w.description || w.name,
    latitude: w.latitude,
    longitude: w.longitude,
    altitude: w.altitude,
    radius: w.radius,
  }));
  return { format: 'csv', waypoints: legacy };
}
