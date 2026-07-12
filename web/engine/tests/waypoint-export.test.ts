import { describe, it, expect } from 'bun:test';
import {
  toSeeYouCup,
  toGPX,
  toKML,
  toCompeGPS,
  toOziExplorer,
  toFsGeo,
  toFsUtm,
  toCSV,
  WAYPOINT_EXPORT_FORMATS,
  encodeTurnpointZ,
  encodeXctskQR,
  swapCodeName,
} from '../src/waypoint-export';
import { parseWaypointFile, type WaypointFileRecord } from '../src/waypoint-files';
import { latLonToUtm, utmToLatLon } from '../src/utm';

// A representative Corryong set: mixed hemispheres of longitude sign are not
// needed here, but altitude 0, a long name distinct from the code, and a
// non-default radius all exercise the round-trip.
const SET: WaypointFileRecord[] = [
  { code: 'CORRY', name: 'CORRY Airport', latitude: -36.185, longitude: 147.8914, altitude: 291, radius: 1000 },
  { code: 'ELLIOT', name: 'ELLIOT', latitude: -36.18583, longitude: 147.97667, altitude: 935, radius: 5000 },
  { code: 'DWYERS', name: 'DWYERS', latitude: -36.24279, longitude: 147.88368, altitude: 0, radius: 400 },
];

/** Coordinates must survive a round-trip to ~1 m; altitude to the metre. */
function expectSameCore(got: WaypointFileRecord, want: WaypointFileRecord, latTol = 2e-4) {
  expect(got.code).toBe(want.code);
  expect(got.name).toBe(want.name);
  expect(got.latitude).toBeCloseTo(want.latitude, 3);
  expect(got.longitude).toBeCloseTo(want.longitude, 3);
  expect(Math.abs(got.latitude - want.latitude)).toBeLessThan(latTol);
  expect(Math.abs(got.longitude - want.longitude)).toBeLessThan(latTol);
  expect(got.altitude).toBe(want.altitude);
}

describe('waypoint file serializers round-trip through the parsers', () => {
  const cases: [string, (w: WaypointFileRecord[]) => string, string][] = [
    ['SeeYou .cup', toSeeYouCup, 'wp.cup'],
    ['GPX', toGPX, 'wp.gpx'],
    ['KML', toKML, 'wp.kml'],
    ['CompeGPS .wpt', toCompeGPS, 'wp.wpt'],
    ['OziExplorer .wpt', toOziExplorer, 'wp.wpt'],
    ['FS $FormatGEO', toFsGeo, 'wp.wpt'],
    ['FS $FormatUTM', toFsUtm, 'wp.wpt'],
    ['CSV', toCSV, 'wp.csv'],
  ];

  for (const [name, serialize, filename] of cases) {
    it(`${name}: code/name/coords/alt survive serialize→parse`, () => {
      const text = serialize(SET);
      const { waypoints } = parseWaypointFile(text, filename);
      expect(waypoints).toHaveLength(SET.length);
      waypoints.forEach((got, i) => expectSameCore(got, SET[i]));
    });
  }

  it('OziExplorer, CUP and CSV preserve the radius column', () => {
    for (const serialize of [toOziExplorer, toCSV]) {
      const { waypoints } = parseWaypointFile(serialize(SET), serialize === toCSV ? 'wp.csv' : 'wp.wpt');
      waypoints.forEach((got, i) => expect(got.radius).toBe(SET[i].radius));
    }
  });

  it('every registered export format produces non-empty, parseable text', () => {
    for (const fmt of WAYPOINT_EXPORT_FORMATS) {
      const text = fmt.serialize(SET);
      expect(text.length).toBeGreaterThan(0);
      const { waypoints } = parseWaypointFile(text, `wp.${fmt.extension}`);
      expect(waypoints.length).toBe(SET.length);
    }
  });
});

describe('serializers survive swapped / awkward identifiers', () => {
  // After a code/name swap the multi-word long name lands in `code`.
  const SWAPPED = swapCodeName(SET); // e.g. code "CORRY Airport"

  it('quoted / XML formats round-trip a multi-word swapped code exactly', () => {
    const quoted: [(w: WaypointFileRecord[]) => string, string][] = [
      [toSeeYouCup, 'wp.cup'],
      [toCSV, 'wp.csv'],
      [toGPX, 'wp.gpx'],
      [toKML, 'wp.kml'],
    ];
    for (const [serialize, filename] of quoted) {
      const { waypoints } = parseWaypointFile(serialize(SWAPPED), filename);
      const corry = waypoints.find((w) => w.name === 'CORRY');
      expect(corry?.code).toBe('CORRY Airport');
    }
  });

  it('CompeGPS keeps a multi-word code as one token (no silent truncation)', () => {
    const { waypoints } = parseWaypointFile(toCompeGPS(SWAPPED), 'wp.wpt');
    const corry = waypoints[0];
    expect(corry.code).toBe('CORRY-Airport'); // hyphenated, not truncated to "CORRY"
    expect(corry.latitude).toBeCloseTo(-36.185, 3);
    expect(corry.altitude).toBe(291);
  });

  it('OziExplorer stays column-aligned when a name contains a comma', () => {
    const withComma: WaypointFileRecord[] = [
      { code: 'MTB', name: 'Mt Beauty, VIC', latitude: -36.74, longitude: 147.17, altitude: 1200, radius: 700 },
    ];
    const { waypoints } = parseWaypointFile(toOziExplorer(withComma), 'wp.wpt');
    // The comma must not shift the radius/elevation into the wrong slots.
    expect(waypoints[0].radius).toBe(700);
    expect(waypoints[0].altitude).toBe(1200);
    expect(waypoints[0].code).toBe('MTB');
  });

  it('fractional altitude does not produce malformed CUP elevation', () => {
    const frac: WaypointFileRecord[] = [
      { code: 'X', name: 'X', latitude: -36, longitude: 147, altitude: 291.5, radius: 400 },
    ];
    const cup = toSeeYouCup(frac);
    expect(cup).toContain('292.0m'); // rounded, single decimal
    expect(cup).not.toMatch(/\d+\.\d+\.\d/); // never "291.5.0m"
    const { waypoints } = parseWaypointFile(cup, 'wp.cup');
    expect(waypoints[0].altitude).toBe(292);
  });

  it('packDDM carries 59.9995 minutes up to the next degree', () => {
    // -35.99999 → 35°59.9994'S, which rounds to 60.000 without a carry guard.
    const near: WaypointFileRecord[] = [
      { code: 'N', name: 'N', latitude: -35.9999999, longitude: 147.5, altitude: 0, radius: 400 },
    ];
    const cup = toSeeYouCup(near);
    expect(cup).not.toContain('60.000'); // carried to 36°00.000'
    const { waypoints } = parseWaypointFile(cup, 'wp.cup');
    expect(waypoints[0].latitude).toBeCloseTo(-36, 3);
  });
});

describe('XCTrack QR encoding matches real app output', () => {
  // The exact `z` strings decoded from a real Flyskyhy competition QR — the
  // encoder must reproduce them byte-for-byte so pilots' apps import correctly.
  const REAL: [WaypointFileRecord, string][] = [
    [{ code: 'ELLIOT', name: 'ELLIOT', latitude: -36.18583, longitude: 147.97667, altitude: 935, radius: 5000 }, 'eudf[lpz{Emy@owH'],
    [{ code: 'LIGHTH', name: 'LIGHTH', latitude: -36.08653, longitude: 148.04558, altitude: 678, radius: 400 }, '{crf[xcg{Eki@_X'],
    [{ code: 'DWYERS', name: 'DWYERS', latitude: -36.24279, longitude: 147.88368, altitude: 0, radius: 400 }, '_pre[lte|E?_X'],
    [{ code: 'CUDG', name: 'CUDG', latitude: -36.19228, longitude: 147.77022, altitude: 325, radius: 400 }, '{j|d[vx{{EiS_X'],
    [{ code: 'CORRY', name: 'CORRY Airport', latitude: -36.185, longitude: 147.8914, altitude: 291, radius: 1000 }, 'g`te[fkz{EeQo}@'],
  ];

  it('reproduces the sampled z strings exactly', () => {
    for (const [wp, z] of REAL) {
      expect(encodeTurnpointZ(wp)).toBe(z);
    }
  });

  it('builds a full XCTSK: payload the parser reads back', () => {
    const s = encodeXctskQR(REAL.map(([w]) => w));
    expect(s.startsWith('XCTSK:')).toBe(true);
    const data = JSON.parse(s.slice('XCTSK:'.length));
    expect(data.version).toBe(2);
    expect(data.taskType).toBe('CLASSIC');
    expect(data.t).toHaveLength(REAL.length);
    // n = short code (device waypoint id), d = long name.
    expect(data.t[4]).toEqual({ n: 'CORRY', d: 'CORRY Airport', z: 'g`te[fkz{EeQo}@' });
  });

  it('matches a real Flyskyhy waypoint QR (n=code, d=long name)', () => {
    // Two entries lifted from a real 45-waypoint Corryong QR.
    const bigara: WaypointFileRecord = { code: 'BIGARA', name: 'BIGARA', latitude: -36.26362, longitude: 148.02096, altitude: 310, radius: 0 };
    const brad: WaypointFileRecord = { code: 'BRADGP', name: 'Bradneys', latitude: -36.17521, longitude: 148.14959, altitude: 464, radius: 0 };
    expect(encodeTurnpointZ(bigara)).toBe('_jmf[rvi|EkR?');
    expect(encodeTurnpointZ(brad)).toBe('}mfg[`nx{E_\\?');
    const data = JSON.parse(encodeXctskQR([bigara, brad]).slice('XCTSK:'.length));
    expect(data.t[0]).toEqual({ n: 'BIGARA', d: 'BIGARA', z: '_jmf[rvi|EkR?' });
    expect(data.t[1]).toEqual({ n: 'BRADGP', d: 'Bradneys', z: '}mfg[`nx{E_\\?' });
  });
});

describe('swapCodeName flips the identifier fields for both files and the QR', () => {
  const one: WaypointFileRecord[] = [
    { code: 'CORRY', name: 'CORRY Airport', latitude: -36.185, longitude: 147.8914, altitude: 291, radius: 1000 },
  ];

  it('swaps code and name on each record', () => {
    const [s] = swapCodeName(one);
    expect(s.code).toBe('CORRY Airport');
    expect(s.name).toBe('CORRY');
    // Coordinates and the rest are untouched.
    expect(s.latitude).toBe(-36.185);
    expect(s.radius).toBe(1000);
  });

  it('flips the XCTSK n/d fields when applied before encoding', () => {
    const normal = JSON.parse(encodeXctskQR(one).slice('XCTSK:'.length));
    const swapped = JSON.parse(encodeXctskQR(swapCodeName(one)).slice('XCTSK:'.length));
    expect(normal.t[0]).toMatchObject({ n: 'CORRY', d: 'CORRY Airport' });
    expect(swapped.t[0]).toMatchObject({ n: 'CORRY Airport', d: 'CORRY' });
    // The position payload is identical — only the labels move.
    expect(swapped.t[0].z).toBe(normal.t[0].z);
  });

  it('is a no-op for records whose code and name already match', () => {
    const same: WaypointFileRecord[] = [
      { code: 'CUDG', name: 'CUDG', latitude: -36.19228, longitude: 147.77022, altitude: 325, radius: 400 },
    ];
    expect(swapCodeName(same)[0]).toMatchObject({ code: 'CUDG', name: 'CUDG' });
  });
});

describe('latLonToUtm is the inverse of utmToLatLon', () => {
  it('round-trips a spread of coordinates to sub-metre', () => {
    const pts = [
      { lat: -36.185, lon: 147.8914 }, // Corryong (zone 55H)
      { lat: 46.308828, lon: 13.1125 }, // Italian Alps (zone 33T)
      { lat: 60.1, lon: 24.9 }, // Helsinki (northern)
      { lat: -1.5, lon: -78.0 }, // near equator, southern
    ];
    for (const p of pts) {
      const u = latLonToUtm(p.lat, p.lon);
      const back = utmToLatLon(u.zone, u.isNorthern, u.easting, u.northing);
      expect(back.lat).toBeCloseTo(p.lat, 5);
      expect(back.lon).toBeCloseTo(p.lon, 5);
    }
  });

  it('assigns the expected zone and hemisphere', () => {
    const u = latLonToUtm(-36.185, 147.8914);
    expect(u.zone).toBe(55);
    expect(u.band).toBe('H');
    expect(u.isNorthern).toBe(false);
  });
});
