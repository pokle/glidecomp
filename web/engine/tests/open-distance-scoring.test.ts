import { describe, it, expect } from 'bun:test';
import {
  scoreOpenDistance,
  scoreOpenDistanceFlights,
  openDistanceForFlight,
  openDistanceGeometryForFlight,
  isOpenDistanceTask,
} from '../src/open-distance-scoring';
import type { PilotFlight } from '../src/gap-scoring';
import type { XCTask } from '../src/xctsk-parser';
import { destinationPoint } from '../src/geo';
import { createFix, type IGCFix } from './test-helpers';

// ---------------------------------------------------------------------------
// Geometry helpers
//
// A single TAKEOFF turnpoint at (LAT, LON) with a 1000 m cylinder. Fixes are
// placed due east of it at a known number of metres, so a pilot's furthest
// open distance is easy to reason about: distance from the ~1000 m exit point
// to the furthest eastward fix.
// ---------------------------------------------------------------------------

const LAT = -36;
const LON = 147;
const TAKEOFF_RADIUS = 1000;
const EAST = Math.PI / 2;

const TASK: XCTask = {
  taskType: 'OPEN-DISTANCE',
  version: 1,
  earthModel: 'WGS84',
  turnpoints: [
    { type: 'TAKEOFF', radius: TAKEOFF_RADIUS, waypoint: { name: 'Launch', lat: LAT, lon: LON } },
  ],
};

/** A fix `metres` due east of the take-off centre, at time `t` seconds. */
function fixEast(t: number, metres: number, alt = 1000): IGCFix {
  if (metres === 0) return createFix(t, LAT, LON, alt);
  const p = destinationPoint(LAT, LON, metres, EAST);
  return createFix(t, p.lat, p.lon, alt);
}

function flight(name: string, fixes: IGCFix[]): PilotFlight {
  return { pilotName: name, trackFile: `${name}.igc`, fixes };
}

describe('scoreOpenDistance', () => {
  it('scores open distance from the take-off exit, not the centre', () => {
    // Start at the centre, cross out through the 1000 m boundary, fly to 50 km.
    const pilot = flight('far', [fixEast(0, 0), fixEast(60, 2000), fixEast(120, 50000)]);
    const result = scoreOpenDistance(TASK, [pilot]);
    const ps = result.pilotScores[0];

    // Measured from the exit (~1000 m east), so ~49 km — NOT the full 50 km.
    expect(ps.flownDistance).toBeGreaterThan(48800);
    expect(ps.flownDistance).toBeLessThan(49200);
    // Score is the distance in whole metres.
    expect(ps.totalScore).toBe(Math.round(ps.flownDistance));
    expect(ps.rank).toBe(1);
    // Open distance carries no GAP components.
    expect(ps.timePoints).toBe(0);
    expect(ps.leadingPoints).toBe(0);
    expect(ps.arrivalPoints).toBe(0);
    expect(ps.madeGoal).toBe(false);
  });

  it('takes the furthest point reached, not the landing point', () => {
    // Out to 40 km, then back toward launch and land at 10 km east.
    const pilot = flight('outandback', [
      fixEast(0, 0),
      fixEast(60, 2000),
      fixEast(120, 40000), // furthest
      fixEast(180, 10000), // lands back closer in
    ]);
    const result = scoreOpenDistance(TASK, [pilot]);
    const ps = result.pilotScores[0];

    // ~39 km from the exit to the 40 km point, well above the ~9 km landing.
    expect(ps.flownDistance).toBeGreaterThan(38800);
    expect(ps.flownDistance).toBeLessThan(39200);
  });

  it('ranks pilots by open distance, furthest first', () => {
    const a = flight('A', [fixEast(0, 0), fixEast(60, 2000), fixEast(120, 60000)]);
    const b = flight('B', [fixEast(0, 0), fixEast(60, 2000), fixEast(120, 30000)]);
    const c = flight('C', [fixEast(0, 0), fixEast(60, 2000), fixEast(120, 45000)]);
    const result = scoreOpenDistance(TASK, [a, b, c]);

    expect(result.pilotScores.map((p) => p.pilotName)).toEqual(['A', 'C', 'B']);
    expect(result.pilotScores.map((p) => p.rank)).toEqual([1, 2, 3]);
    // Scores strictly decrease with rank.
    expect(result.pilotScores[0].totalScore).toBeGreaterThan(result.pilotScores[1].totalScore);
    expect(result.pilotScores[1].totalScore).toBeGreaterThan(result.pilotScores[2].totalScore);
    // Best distance is reflected in stats.
    expect(result.stats.bestDistance).toBe(result.pilotScores[0].flownDistance);
  });

  it('scores 0 for a pilot who never leaves the take-off cylinder', () => {
    // Wanders inside the 1000 m cylinder and lands without ever crossing out.
    const pilot = flight('stayer', [fixEast(0, 0), fixEast(60, 500), fixEast(120, 0)]);
    const result = scoreOpenDistance(TASK, [pilot]);
    expect(result.pilotScores[0].flownDistance).toBe(0);
    expect(result.pilotScores[0].totalScore).toBe(0);
  });

  it('falls back to the first fix when the track starts already outside the cylinder', () => {
    // Logger started airborne at 3 km east (no take-off crossing), flew to 30 km.
    const pilot = flight('airborne', [fixEast(0, 3000), fixEast(60, 30000)]);
    const result = scoreOpenDistance(TASK, [pilot]);
    const ps = result.pilotScores[0];
    // ~27 km from the first fix (3 km) to the furthest fix (30 km).
    expect(ps.flownDistance).toBeGreaterThan(26800);
    expect(ps.flownDistance).toBeLessThan(27200);
  });

  it('returns an empty result for no pilots', () => {
    const result = scoreOpenDistance(TASK, []);
    expect(result.pilotScores).toEqual([]);
    expect(result.stats.bestDistance).toBe(0);
  });
});

describe('openDistanceGeometryForFlight', () => {
  it('returns the take-off exit origin and the furthest fix', () => {
    const pilot = flight('outandback', [
      fixEast(0, 0),
      fixEast(60, 2000),
      fixEast(120, 40000), // furthest
      fixEast(180, 10000), // lands back closer in
    ]);
    const geom = openDistanceGeometryForFlight(TASK, pilot)!;

    // Origin sits on the 1000 m cylinder boundary, due east of the centre.
    const originFromCentre = destinationPoint(LAT, LON, TAKEOFF_RADIUS, EAST);
    expect(geom.origin.latitude).toBeCloseTo(originFromCentre.lat, 3);
    expect(geom.origin.longitude).toBeCloseTo(originFromCentre.lon, 3);

    // Furthest is the 40 km fix (index 2), not the landing fix.
    expect(geom.furthest.fixIndex).toBe(2);
    expect(geom.furthest.latitude).toBeCloseTo(pilot.fixes[2].latitude, 6);
    expect(geom.furthest.longitude).toBeCloseTo(pilot.fixes[2].longitude, 6);

    // Distance matches the scored open distance.
    expect(geom.distance).toBe(openDistanceForFlight(TASK, pilot));
    expect(geom.distance).toBeGreaterThan(38800);
    expect(geom.distance).toBeLessThan(39200);
  });

  it('uses the first fix as origin when the track starts outside the cylinder', () => {
    const pilot = flight('airborne', [fixEast(0, 3000), fixEast(60, 30000)]);
    const geom = openDistanceGeometryForFlight(TASK, pilot)!;
    expect(geom.origin.fixIndex).toBe(0);
    expect(geom.origin.latitude).toBeCloseTo(pilot.fixes[0].latitude, 6);
    expect(geom.furthest.fixIndex).toBe(1);
  });

  it('returns null for a pilot who never leaves the take-off cylinder', () => {
    const pilot = flight('stayer', [fixEast(0, 0), fixEast(60, 500), fixEast(120, 0)]);
    expect(openDistanceGeometryForFlight(TASK, pilot)).toBeNull();
  });
});

describe('isOpenDistanceTask', () => {
  it('recognises a single-TAKEOFF task', () => {
    expect(isOpenDistanceTask(TASK)).toBe(true);
  });

  it('recognises a declared OPEN-DISTANCE task regardless of turnpoints', () => {
    expect(isOpenDistanceTask({ ...TASK, taskType: 'OPEN-DISTANCE' })).toBe(true);
  });

  it('rejects a classic race task', () => {
    const race: XCTask = {
      taskType: 'CLASSIC',
      version: 1,
      earthModel: 'WGS84',
      turnpoints: [
        { type: 'TAKEOFF', radius: 400, waypoint: { name: 'Launch', lat: LAT, lon: LON } },
        { type: 'SSS', radius: 2000, waypoint: { name: 'Start', lat: LAT, lon: LON } },
      ],
    };
    expect(isOpenDistanceTask(race)).toBe(false);
  });
});

describe('openDistanceForFlight + scoreOpenDistanceFlights (cacheable split)', () => {
  it('openDistanceForFlight returns the furthest distance from the take-off exit', () => {
    const pilot = flight('far', [fixEast(0, 0), fixEast(60, 2000), fixEast(120, 50000)]);
    const d = openDistanceForFlight(TASK, pilot);
    expect(d).toBeGreaterThan(48800);
    expect(d).toBeLessThan(49200);
  });

  it('scoreOpenDistanceFlights ranks pre-computed distances furthest-first', () => {
    const result = scoreOpenDistanceFlights([
      { pilotName: 'A', trackFile: 'A.igc', distance: 30000 },
      { pilotName: 'B', trackFile: 'B.igc', distance: 60000 },
      { pilotName: 'C', trackFile: 'C.igc', distance: 45000 },
    ]);
    expect(result.pilotScores.map((p) => p.pilotName)).toEqual(['B', 'C', 'A']);
    expect(result.pilotScores.map((p) => p.rank)).toEqual([1, 2, 3]);
    // Score is the distance in whole metres.
    expect(result.pilotScores[0].totalScore).toBe(60000);
    expect(result.pilotScores[0].flownDistance).toBe(60000);
  });

  it('matches scoreOpenDistance when fed the same per-track distances', () => {
    const pilots = [
      flight('A', [fixEast(0, 0), fixEast(60, 2000), fixEast(120, 60000)]),
      flight('B', [fixEast(0, 0), fixEast(60, 2000), fixEast(120, 30000)]),
    ];
    const direct = scoreOpenDistance(TASK, pilots);
    const viaSplit = scoreOpenDistanceFlights(
      pilots.map((p) => ({
        pilotName: p.pilotName,
        trackFile: p.trackFile,
        distance: openDistanceForFlight(TASK, p),
      }))
    );
    expect(viaSplit.pilotScores.map((p) => [p.trackFile, p.totalScore, p.rank]))
      .toEqual(direct.pilotScores.map((p) => [p.trackFile, p.totalScore, p.rank]));
  });
});
