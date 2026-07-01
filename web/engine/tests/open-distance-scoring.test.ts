import { describe, it, expect } from 'bun:test';
import { scoreOpenDistance } from '../src/open-distance-scoring';
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
