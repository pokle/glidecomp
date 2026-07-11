/**
 * Multi-format waypoint file serialization + XCTrack QR encoding (issue #312,
 * stage 2).
 *
 * The mirror image of ./waypoint-files: those parsers read whatever organisers
 * hand out, these writers hand the competition's shared waypoint set back to
 * pilots in the format their device wants — SeeYou .cup, GPX, KML, CompeGPS/
 * Garmin and OziExplorer .wpt, FS $FormatGEO/$FormatUTM and plain CSV — plus a
 * scannable XCTrack `XCTSK:` QR that most flight apps (Flyskyhy, XCTrack, …)
 * import directly.
 *
 * Like ./waypoint-files this module is deliberately OUTSIDE the scoring import
 * closure (see scoring-version.test.ts): it's pure number→string formatting, so
 * adding export formats never forces a scoring-engine version bump. The only
 * geo maths it needs (lat/lon → UTM) lives in ./utm; never hand-roll it here.
 */
import type { WaypointFileRecord } from './waypoint-files';
import { latLonToUtm } from './utm';

/** A downloadable waypoint file format. */
export interface WaypointExportFormat {
  /** Stable id used by the UI. */
  id: string;
  /** Human label, e.g. "SeeYou (.cup)". */
  label: string;
  /** File extension without the dot. */
  extension: string;
  /** MIME type for the download blob. */
  mimeType: string;
  /** Serialize a waypoint set to this format's text. */
  serialize: (waypoints: WaypointFileRecord[]) => string;
}

// ---------------------------------------------------------------------------
// Coordinate formatting helpers (all inverses of waypoint-files.ts parsers).
// ---------------------------------------------------------------------------

/** Signed decimal degrees, fixed to 6 dp (~0.1 m). */
function dec(value: number): string {
  return value.toFixed(6);
}

/** Absolute value + hemisphere letter, e.g. `latHemi(-36.18) === "S"`. */
function latHemi(lat: number): string {
  return lat < 0 ? 'S' : 'N';
}
function lonHemi(lon: number): string {
  return lon < 0 ? 'W' : 'E';
}

/**
 * Pack a coordinate as SeeYou/CUP `DDMM.mmm` (+ hemisphere): whole degrees
 * then decimal minutes, latitude padded to 2 degree digits and longitude to 3.
 */
function packDDM(value: number, degDigits: number, hemi: string): string {
  const abs = Math.abs(value);
  const deg = Math.floor(abs);
  const min = (abs - deg) * 60;
  const degStr = String(deg).padStart(degDigits, '0');
  const minStr = min.toFixed(3).padStart(6, '0'); // MM.mmm
  return `${degStr}${minStr}${hemi}`;
}

/** Degrees-minutes-seconds pieces for the FS $FormatGEO writer. */
function toDMS(value: number, degDigits: number): { d: string; m: string; s: string } {
  const abs = Math.abs(value);
  let deg = Math.floor(abs);
  let min = Math.floor((abs - deg) * 60);
  let sec = (abs - deg - min / 60) * 3600;
  // Guard against 60.00 rounding to the next unit.
  if (Number(sec.toFixed(2)) >= 60) {
    sec = 0;
    min += 1;
  }
  if (min >= 60) {
    min = 0;
    deg += 1;
  }
  return {
    d: String(deg).padStart(degDigits, '0'),
    m: String(min).padStart(2, '0'),
    s: sec.toFixed(2).padStart(5, '0'),
  };
}

/** Escape the five XML entities for GPX/KML text nodes. */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Quote a CSV field if it contains a comma, quote or newline. */
function csvField(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ---------------------------------------------------------------------------
// Serializers
// ---------------------------------------------------------------------------

/** SeeYou `.cup` (the de-facto standard for XCSoar/LK8000/Flymaster/XCTrack). */
export function toSeeYouCup(waypoints: WaypointFileRecord[]): string {
  const lines = ['name,code,country,lat,lon,elev,style,rwdir,rwlen,freq,desc'];
  for (const w of waypoints) {
    const lat = packDDM(w.latitude, 2, latHemi(w.latitude));
    const lon = packDDM(w.longitude, 3, lonHemi(w.longitude));
    lines.push(
      [
        `"${(w.name || w.code).replace(/"/g, '""')}"`,
        csvField(w.code),
        '',
        lat,
        lon,
        `${w.altitude || 0}.0m`,
        '1',
        '',
        '',
        '',
        '',
      ].join(',')
    );
  }
  return lines.join('\r\n') + '\r\n';
}

/** GPX 1.1 waypoint file (universal; phones, GpsDump, most desktop tools). */
export function toGPX(waypoints: WaypointFileRecord[]): string {
  const pts = waypoints
    .map((w) => {
      const parts = [
        `  <wpt lat="${dec(w.latitude)}" lon="${dec(w.longitude)}">`,
        `    <ele>${w.altitude || 0}</ele>`,
        `    <name>${xmlEscape(w.code)}</name>`,
        `    <cmt>${xmlEscape(w.name || w.code)}</cmt>`,
        `    <desc>${xmlEscape(w.name || w.code)}</desc>`,
        `    <sym>Waypoint</sym>`,
        `  </wpt>`,
      ];
      return parts.join('\n');
    })
    .join('\n');
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<gpx xmlns="http://www.topografix.com/GPX/1/1" creator="GlideComp" version="1.1" ' +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
    'xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">\n' +
    pts +
    '\n</gpx>\n'
  );
}

/** Google Earth KML (each waypoint a Point placemark, `lon,lat,alt`). */
export function toKML(waypoints: WaypointFileRecord[]): string {
  const marks = waypoints
    .map((w) =>
      [
        '      <Placemark>',
        `        <name>${xmlEscape(w.code)}</name>`,
        `        <description>${xmlEscape(w.name || w.code)}</description>`,
        '        <Point>',
        `          <coordinates>${dec(w.longitude)},${dec(w.latitude)},${w.altitude || 0}</coordinates>`,
        '        </Point>',
        '      </Placemark>',
      ].join('\n')
    )
    .join('\n');
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<kml xmlns="http://www.opengis.net/kml/2.2">\n' +
    '  <Document>\n' +
    marks +
    '\n  </Document>\n</kml>\n'
  );
}

/** CompeGPS / Garmin PCX5 `.wpt` (whitespace `W` records under a `G`/`U` header). */
export function toCompeGPS(waypoints: WaypointFileRecord[]): string {
  const lines = ['G  WGS 84', 'U  1'];
  for (const w of waypoints) {
    const lat = `${Math.abs(w.latitude).toFixed(7)}${latHemi(w.latitude)}`;
    const lon = `${Math.abs(w.longitude).toFixed(7)}${lonHemi(w.longitude)}`;
    const alt = (w.altitude || 0).toFixed(6);
    // W  <code> A <lat> <lon> <date> <time> <alt> <long name>
    lines.push(`W  ${w.code} A ${lat} ${lon} 01-JAN-00 00:00:00 ${alt} ${w.name || w.code}`);
  }
  return lines.join('\r\n') + '\r\n';
}

/** OziExplorer `.wpt` (four header lines then a CSV record per waypoint). */
export function toOziExplorer(waypoints: WaypointFileRecord[]): string {
  const lines = ['OziExplorer Waypoint File Version 1.1', 'WGS 84', 'Reserved 2', 'Reserved 3'];
  waypoints.forEach((w, i) => {
    // field: num,code,lat,lon,date,sym,...,longName(10),...,radius(13),elev(14)...
    lines.push(
      [
        i + 1,
        w.code,
        w.latitude.toFixed(6),
        w.longitude.toFixed(6),
        '',
        '0',
        '1',
        '3',
        '0',
        '65535',
        w.name || w.code,
        '0',
        '0',
        String(w.radius || 0),
        String(w.altitude || 0),
        '6',
        '0',
        '17',
      ].join(',')
    );
  });
  return lines.join('\r\n') + '\r\n';
}

/** FS `$FormatGEO` (`NAME  N dd mm ss.ss  E ddd mm ss.ss  alt  long name`). */
export function toFsGeo(waypoints: WaypointFileRecord[]): string {
  const lines = ['$FormatGEO'];
  for (const w of waypoints) {
    const la = toDMS(w.latitude, 2);
    const lo = toDMS(w.longitude, 3);
    const code = w.code.padEnd(9);
    lines.push(
      `${code} ${latHemi(w.latitude)} ${la.d} ${la.m} ${la.s}    ` +
        `${lonHemi(w.longitude)} ${lo.d} ${lo.m} ${lo.s}   ` +
        `${String(w.altitude || 0).padStart(4)}  ${w.name || w.code}`
    );
  }
  return lines.join('\r\n') + '\r\n';
}

/** FS `$FormatUTM` (`NAME  <zone><band>  easting  northing  alt  long name`). */
export function toFsUtm(waypoints: WaypointFileRecord[]): string {
  const lines = ['$FormatUTM'];
  for (const w of waypoints) {
    const utm = latLonToUtm(w.latitude, w.longitude);
    const code = w.code.padEnd(9);
    const east = String(Math.round(utm.easting)).padStart(7, '0');
    const north = String(Math.round(utm.northing)).padStart(7, '0');
    lines.push(
      `${code} ${utm.zone}${utm.band}   ${east}   ${north}   ` +
        `${String(w.altitude || 0).padStart(3)}  ${w.name || w.code}`
    );
  }
  return lines.join('\r\n') + '\r\n';
}

/** Plain CSV with an explicit `code` and long `name` column. */
export function toCSV(waypoints: WaypointFileRecord[]): string {
  const lines = ['code,name,latitude,longitude,altitude,radius'];
  for (const w of waypoints) {
    lines.push(
      [
        csvField(w.code),
        csvField(w.name || w.code),
        w.latitude.toFixed(6),
        w.longitude.toFixed(6),
        String(w.altitude || 0),
        String(w.radius || 400),
      ].join(',')
    );
  }
  return lines.join('\r\n') + '\r\n';
}

/**
 * Swap each record's short `code` and long `name`. Devices disagree on which
 * identifier they show as the waypoint's label — some key off the short code,
 * others the descriptive name — so the UI offers this as a toggle that applies
 * uniformly to every download format and the QR (it flips the CUP/CSV code/name
 * columns and the XCTSK `n`/`d` fields alike).
 */
export function swapCodeName(waypoints: WaypointFileRecord[]): WaypointFileRecord[] {
  return waypoints.map((w) => ({ ...w, code: w.name || w.code, name: w.code }));
}

/** All downloadable file formats, in the order the UI offers them. */
export const WAYPOINT_EXPORT_FORMATS: WaypointExportFormat[] = [
  { id: 'seeyou-cup', label: 'SeeYou (.cup)', extension: 'cup', mimeType: 'text/plain;charset=utf-8', serialize: toSeeYouCup },
  { id: 'gpx', label: 'GPX (.gpx)', extension: 'gpx', mimeType: 'application/gpx+xml', serialize: toGPX },
  { id: 'compegps', label: 'CompeGPS / Garmin (.wpt)', extension: 'wpt', mimeType: 'text/plain;charset=utf-8', serialize: toCompeGPS },
  { id: 'ozi', label: 'OziExplorer (.wpt)', extension: 'wpt', mimeType: 'text/plain;charset=utf-8', serialize: toOziExplorer },
  { id: 'fs-geo', label: 'FS GEO (.wpt)', extension: 'wpt', mimeType: 'text/plain;charset=utf-8', serialize: toFsGeo },
  { id: 'fs-utm', label: 'FS UTM (.wpt)', extension: 'wpt', mimeType: 'text/plain;charset=utf-8', serialize: toFsUtm },
  { id: 'kml', label: 'Google Earth (.kml)', extension: 'kml', mimeType: 'application/vnd.google-earth.kml+xml', serialize: toKML },
  { id: 'csv', label: 'CSV (.csv)', extension: 'csv', mimeType: 'text/csv;charset=utf-8', serialize: toCSV },
];

// ---------------------------------------------------------------------------
// XCTrack QR encoding
// ---------------------------------------------------------------------------

/**
 * Encode one signed integer with the Google polyline algorithm (no delta —
 * each value stands alone). This is the per-value encoding XCTrack's compact
 * `z` field uses.
 */
function encodePolylineValue(num: number): string {
  let sgn = num << 1;
  if (num < 0) sgn = ~sgn;
  let out = '';
  while (sgn >= 0x20) {
    out += String.fromCharCode((0x20 | (sgn & 0x1f)) + 63);
    sgn >>= 5;
  }
  out += String.fromCharCode(sgn + 63);
  return out;
}

/**
 * Encode a turnpoint's compact `z` string: longitude, latitude (each ×1e5),
 * altitude (m) and radius (m), in that order. Matches the real XCTrack /
 * Flyskyhy QR byte-for-byte (verified against sampled competition QRs).
 */
export function encodeTurnpointZ(w: WaypointFileRecord): string {
  // Preserve an explicit radius of 0 (real waypoint QRs use it for points with
  // no cylinder); only fall back to 400 when the value is missing/non-finite.
  const radius = Number.isFinite(w.radius) ? w.radius : 400;
  const altitude = Number.isFinite(w.altitude) ? w.altitude : 0;
  return (
    encodePolylineValue(Math.round(w.longitude * 1e5)) +
    encodePolylineValue(Math.round(w.latitude * 1e5)) +
    encodePolylineValue(Math.round(altitude)) +
    encodePolylineValue(Math.round(radius))
  );
}

/**
 * Build the XCTrack `XCTSK:` string for a waypoint set — the payload encoded
 * into the QR that pilots scan to load the competition's waypoints into their
 * flight app. Uses the v2 compact schema: `n` is the short code (the device's
 * waypoint id), `d` the long name, `z` the packed position/altitude/radius.
 * Field roles match a real Flyskyhy waypoint QR (`{"n":"BRADGP","d":"Bradneys"}`).
 */
export function encodeXctskQR(waypoints: WaypointFileRecord[]): string {
  const task = {
    version: 2,
    t: waypoints.map((w) => ({
      n: w.code,
      d: w.name || w.code,
      z: encodeTurnpointZ(w),
    })),
    taskType: 'CLASSIC',
  };
  return `XCTSK:${JSON.stringify(task)}`;
}

/**
 * Practical byte ceiling for a single scannable QR (version 40, byte mode, EC
 * level L holds 2953 bytes; leave headroom). Beyond this the UI should offer a
 * file download instead of a QR.
 */
export const XCTSK_QR_MAX_BYTES = 2900;
