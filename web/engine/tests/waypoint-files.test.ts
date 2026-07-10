import { describe, it, expect } from 'bun:test';
import {
  parseWaypointsWPT,
  parseWaypointsCUP,
  parseWaypointFile,
  parseCoordinateValue,
} from '../src/waypoint-files';
import { type WaypointRecord } from '../src/waypoints';

// Real Corryong turnpoints, one per format. CORRY and ELLIOT are the anchors
// checked across formats: every format must decode to the same decimal
// degrees so a route is identical whichever file the organiser uploads.
const CORRY = { lat: -36.185, lon: 147.8914 };
const ELLIOT = { lat: -36.185833, lon: 147.976667 };

const OZI_WPT = `OziExplorer Waypoint File Version 1.1
WGS 84
Reserved 2
Reserved 3
1,BIGARA,-36.263625,148.020957,25569.00000,0,1,3,0,65535,BIGARA,0,0,0,1017,6,0,17
5,CORRY,-36.185,147.8914,25569.00000,0,1,3,0,65535,CORRY,0,0,0,955,6,0,17
10,ELLIOT,-36.185833,147.976667,25569.00000,0,1,3,0,65535,ELLIOT,0,0,0,3068,6,0,17
`;

// The 2021 Ozi variant carries a real proximity radius in field 13.
const OZI_WPT_RADIUS = `OziExplorer Waypoint File Version 1.1
WGS 84
Reserved 2
Reserved 3
4,CORRY Airport,-36.185000,147.891400,,0,1,3,0,65535,CORRY,0,0,1000,954,6,0,17
9,ELLIOT,-36.185833,147.976667,,0,1,3,0,65535,ELLIOT,0,0,5000,3067,6,0,17
`;

const SEEYOU_CUP = `name,code,country,lat,lon,elev,style,rwdir,rwlen,freq,desc
"CORRY",CORRY,,3611.100S,14753.484E,291.0m,1,,,,"CORRY"
"ELLIOT",ELLIOT,,3611.150S,14758.600E,935.0m,1,,,,"ELLIOT"
-----Related Tasks-----
"Task",TASK,,3611.100S,14753.484E,0.0m,1,,,,"should be ignored"
`;

// SeeYou export with Title/Latitude/Longitude header casing and unit-suffixed elevation.
const SEEYOU_CUP_TITLE = `Title,Code,Country,Latitude,Longitude,Elevation,Style,Direction,Length,Frequency,Description
"CORRY","CORRY",AU,3611.100S,14753.484E,291.06979579397m,1,,,,
"ELLIOT","ELLIOT",AU,3611.150S,14758.600E,935.08076805852m,1,,,,
`;

const GLIDECOMP_CSV = `Name,Latitude,Longitude,Description,Proximity Distance,Altitude
CORRY,-36.185000,147.891400,Corryong Airport,1000,954
ELLIOT,-36.185833,147.976667,,5000,3067
`;

function byName(list: { name: string }[], name: string): WaypointRecord {
  const wp = list.find((w) => w.name === name);
  if (!wp) throw new Error(`waypoint ${name} not found`);
  return wp as WaypointRecord;
}

describe('parseCoordinateValue', () => {
  it('reads decimal degrees', () => {
    expect(parseCoordinateValue('-36.185')).toBeCloseTo(-36.185, 6);
    expect(parseCoordinateValue('147.8914')).toBeCloseTo(147.8914, 6);
  });
  it('reads DDMM.mmm latitude with hemisphere', () => {
    expect(parseCoordinateValue('3611.100S')).toBeCloseTo(-36.185, 5);
    expect(parseCoordinateValue('3556.017S')).toBeCloseTo(-35.933617, 4);
  });
  it('reads DDDMM.mmm longitude with hemisphere', () => {
    expect(parseCoordinateValue('14753.484E')).toBeCloseTo(147.8914, 5);
    expect(parseCoordinateValue('14758.600E')).toBeCloseTo(147.976667, 5);
  });
  it('returns null for non-numbers', () => {
    expect(parseCoordinateValue('')).toBeNull();
    expect(parseCoordinateValue('abc')).toBeNull();
  });
});

describe('parseWaypointsWPT (OziExplorer)', () => {
  it('parses records and skips the 4 header lines', () => {
    const wps = parseWaypointsWPT(OZI_WPT);
    expect(wps).toHaveLength(3);
    const corry = byName(wps, 'CORRY');
    expect(corry.latitude).toBeCloseTo(CORRY.lat, 6);
    expect(corry.longitude).toBeCloseTo(CORRY.lon, 6);
  });
  it('reads the proximity radius from field 13 when present', () => {
    const wps = parseWaypointsWPT(OZI_WPT_RADIUS);
    expect(byName(wps, 'CORRY').radius).toBe(1000);
    expect(byName(wps, 'ELLIOT').radius).toBe(5000);
  });
  it('defaults radius to 400 when the field is zero/absent', () => {
    expect(byName(parseWaypointsWPT(OZI_WPT), 'CORRY').radius).toBe(400);
  });
});

describe('parseWaypointsCUP (SeeYou)', () => {
  it('decodes DDMM.mmm coords to the same decimals as the WPT/CSV', () => {
    const wps = parseWaypointsCUP(SEEYOU_CUP);
    const corry = byName(wps, 'CORRY');
    expect(corry.latitude).toBeCloseTo(CORRY.lat, 4);
    expect(corry.longitude).toBeCloseTo(CORRY.lon, 4);
    const elliot = byName(wps, 'ELLIOT');
    expect(elliot.latitude).toBeCloseTo(ELLIOT.lat, 4);
    expect(elliot.longitude).toBeCloseTo(ELLIOT.lon, 4);
  });
  it('stops at the Related Tasks marker', () => {
    expect(parseWaypointsCUP(SEEYOU_CUP)).toHaveLength(2);
  });
  it('handles the Title/Latitude/Longitude header variant', () => {
    const wps = parseWaypointsCUP(SEEYOU_CUP_TITLE);
    expect(byName(wps, 'CORRY').latitude).toBeCloseTo(CORRY.lat, 4);
  });
});

describe('parseWaypointFile (autodetect)', () => {
  it('detects OziExplorer by its magic first line', () => {
    const r = parseWaypointFile(OZI_WPT);
    expect(r.format).toBe('ozi-wpt');
    expect(r.waypoints).toHaveLength(3);
  });
  it('detects SeeYou CUP', () => {
    const r = parseWaypointFile(SEEYOU_CUP, 'corryong.cup');
    expect(r.format).toBe('seeyou-cup');
    expect(byName(r.waypoints, 'ELLIOT').longitude).toBeCloseTo(ELLIOT.lon, 4);
  });
  it('detects generic CSV and reads decimal coords + radius', () => {
    const r = parseWaypointFile(GLIDECOMP_CSV, 'corryong.csv');
    expect(r.format).toBe('csv');
    const elliot = byName(r.waypoints, 'ELLIOT');
    expect(elliot.latitude).toBeCloseTo(ELLIOT.lat, 6);
    expect(elliot.radius).toBe(5000);
  });
  it('agrees on coordinates across all four formats', () => {
    const fromWpt = byName(parseWaypointFile(OZI_WPT).waypoints, 'CORRY');
    const fromCup = byName(parseWaypointFile(SEEYOU_CUP, 'x.cup').waypoints, 'CORRY');
    const fromCsv = byName(parseWaypointFile(GLIDECOMP_CSV).waypoints, 'CORRY');
    expect(fromCup.latitude).toBeCloseTo(fromWpt.latitude, 4);
    expect(fromCsv.latitude).toBeCloseTo(fromWpt.latitude, 4);
    expect(fromCup.longitude).toBeCloseTo(fromWpt.longitude, 4);
    expect(fromCsv.longitude).toBeCloseTo(fromWpt.longitude, 4);
  });
  it('yields no waypoints for an unrecognised file rather than throwing', () => {
    expect(parseWaypointFile('not a waypoint file at all').waypoints).toEqual([]);
  });
});
