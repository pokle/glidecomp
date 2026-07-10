import { describe, it, expect } from 'bun:test';
import {
  parseWaypointsCSV,
  parseWaypointsWPT,
  parseWaypointsCUP,
  parseWaypointFile,
  parseCoordinateValue,
  findWaypointByName,
  findWaypointByCoordinates,
  findWaypoint,
  type WaypointRecord,
} from '../src/waypoints';

const sampleCSV = `Name,Latitude,Longitude,Description,Proximity Distance,Altitude
ELLIOT,-36.185833,147.976667,Launch,5000,935
HALFWY,-36.265473,147.873444,Half Way Hill,400,818
CUDGWE,-36.223183,147.728800,CUDGWE,400,432
NCORGL,-36.177753,147.924060,North Corry Goal,1000,277
KANGCK,-36.264100,147.938467,KANGCK,400,376`;

describe('Waypoints Module', () => {
  describe('parseWaypointsCSV', () => {
    it('should parse a valid CSV file', () => {
      const waypoints = parseWaypointsCSV(sampleCSV);

      expect(waypoints).toHaveLength(5);
      expect(waypoints[0].name).toBe('ELLIOT');
      expect(waypoints[0].latitude).toBeCloseTo(-36.185833, 5);
      expect(waypoints[0].longitude).toBeCloseTo(147.976667, 5);
      expect(waypoints[0].description).toBe('Launch');
      expect(waypoints[0].radius).toBe(5000);
      expect(waypoints[0].altitude).toBe(935);
    });

    it('should handle empty CSV', () => {
      expect(parseWaypointsCSV('')).toEqual([]);
      expect(parseWaypointsCSV('Name,Latitude,Longitude,Description,Proximity Distance,Altitude')).toEqual([]);
    });

    it('should skip invalid rows', () => {
      const csvWithBadRow = `Name,Latitude,Longitude,Description,Proximity Distance,Altitude
ELLIOT,-36.185833,147.976667,Launch,5000,935
BAD,invalid,data
HALFWY,-36.265473,147.873444,Half Way Hill,400,818`;

      const waypoints = parseWaypointsCSV(csvWithBadRow);
      expect(waypoints).toHaveLength(2);
      expect(waypoints[0].name).toBe('ELLIOT');
      expect(waypoints[1].name).toBe('HALFWY');
    });

    it('should use default radius for invalid values', () => {
      const csv = `Name,Latitude,Longitude,Description,Proximity Distance,Altitude
TEST,-36.0,147.0,Test,invalid,100`;

      const waypoints = parseWaypointsCSV(csv);
      expect(waypoints[0].radius).toBe(400);
    });
  });

  describe('findWaypointByName', () => {
    const waypoints = parseWaypointsCSV(sampleCSV);

    it('should find by exact name match', () => {
      const wp = findWaypointByName(waypoints, 'ELLIOT');
      expect(wp?.name).toBe('ELLIOT');
    });

    it('should find by case-insensitive match', () => {
      const wp = findWaypointByName(waypoints, 'elliot');
      expect(wp?.name).toBe('ELLIOT');
    });

    it('should find with START prefix', () => {
      const wp = findWaypointByName(waypoints, 'START ELLIOT');
      expect(wp?.name).toBe('ELLIOT');
    });

    it('should find with TURN prefix', () => {
      const wp = findWaypointByName(waypoints, 'TURN HALFWY');
      expect(wp?.name).toBe('HALFWY');
    });

    it('should find with FINISH prefix', () => {
      const wp = findWaypointByName(waypoints, 'FINISH NCORGL');
      expect(wp?.name).toBe('NCORGL');
    });

    it('should return undefined for non-existent waypoint', () => {
      const wp = findWaypointByName(waypoints, 'NONEXISTENT');
      expect(wp).toBeUndefined();
    });
  });

  describe('findWaypointByCoordinates', () => {
    const waypoints = parseWaypointsCSV(sampleCSV);

    it('should find waypoint within tolerance', () => {
      // ELLIOT is at -36.185833, 147.976667
      const wp = findWaypointByCoordinates(waypoints, -36.185833, 147.976667, 50);
      expect(wp?.name).toBe('ELLIOT');
    });

    it('should find closest waypoint when multiple within tolerance', () => {
      // Create waypoints close together
      const closeWaypoints: WaypointRecord[] = [
        { name: 'A', latitude: -36.0, longitude: 147.0, description: 'A', radius: 400, altitude: 100 },
        { name: 'B', latitude: -36.0001, longitude: 147.0001, description: 'B', radius: 400, altitude: 100 },
      ];

      // Search at exact position of B
      const wp = findWaypointByCoordinates(closeWaypoints, -36.0001, 147.0001, 100);
      expect(wp?.name).toBe('B');
    });

    it('should return undefined when no waypoint within tolerance', () => {
      const wp = findWaypointByCoordinates(waypoints, 0, 0, 50);
      expect(wp).toBeUndefined();
    });
  });

  describe('findWaypoint', () => {
    const waypoints = parseWaypointsCSV(sampleCSV);

    it('should prefer name match over coordinate match', () => {
      // Search with name that matches ELLIOT but coords of HALFWY
      const wp = findWaypoint(waypoints, 'ELLIOT', -36.265473, 147.873444, 50);
      expect(wp?.name).toBe('ELLIOT');
    });

    it('should fall back to coordinate match when name not found', () => {
      // Search with unknown name but coords of ELLIOT
      const wp = findWaypoint(waypoints, 'UNKNOWN', -36.185833, 147.976667, 50);
      expect(wp?.name).toBe('ELLIOT');
    });

    it('should return undefined when neither match works', () => {
      const wp = findWaypoint(waypoints, 'UNKNOWN', 0, 0, 50);
      expect(wp).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Multi-format waypoint file parsing (.wpt / .cup + autodetect)
// ---------------------------------------------------------------------------

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
