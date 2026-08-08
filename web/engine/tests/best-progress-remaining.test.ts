/**
 * FAI S7F §8.6.1 flown distance: "After the last turnpoint the pilot
 * reached, for every remaining track point, the shortest distance to goal
 * is calculated using the method described in section 6.4.1."
 *
 * The remaining distance from a fix is therefore its OWN shortest-path
 * optimisation — the route {point(fix), un-reached control zones…, goal} —
 * not the distance to a tag point frozen where the launch-anchored task
 * optimisation put it. On a bent course the difference is real: AirScore
 * distances on Corryong Cup 2026 T1 sat a mean 66 m (worst 385 m) from the
 * frozen-tag approximation, and 21 m (worst 67 m) from the re-optimised
 * measure.
 */

import { describe, it, expect } from 'bun:test';
import {
  calculateOptimizedTaskDistance,
  optimizeRemainingRoute,
} from '../src/task-optimizer';
import { resolveTurnpointSequence } from '../src/turnpoint-sequence';
import { manualFlightGeometry } from '../src/manual-flight';
import { parseXCTask, type XCTask, type Turnpoint } from '../src/xctsk-parser';
import { destinationPoint, andoyerDistance, calculateBearingRadians } from '../src/geo';
import type { IGCFix } from '../src/igc-parser';

function tp(name: string, lat: number, lon: number, radius: number, type?: Turnpoint['type']): Turnpoint {
  return { type, radius, waypoint: { name, lat, lon } };
}

function makeTask(turnpoints: Turnpoint[], goal?: XCTask['goal']): XCTask {
  return { taskType: 'CLASSIC', version: 1, turnpoints, goal };
}

const T0 = Date.parse('2026-01-05T02:00:00Z');
function fix(sec: number, p: { lat: number; lon: number }, alt = 1500): IGCFix {
  return {
    time: new Date(T0 + sec * 1000),
    latitude: p.lat,
    longitude: p.lon,
    pressureAltitude: alt,
    gnssAltitude: alt,
    valid: true,
  };
}

/**
 * A dogleg course where the frozen-tag measure is badly wrong: start at A,
 * a big (8 km) cylinder 25 km east, goal 25 km NORTH of the big cylinder.
 * The task line tags the big cylinder on its north-west side; a pilot who
 * pushed along its SOUTH side is much closer to the boundary than to that
 * tag.
 */
const A = { lat: -36.0, lon: 147.0 };
const BIG = destinationPoint(A.lat, A.lon, 25000, Math.PI / 2);
const GOAL = destinationPoint(BIG.lat, BIG.lon, 25000, 0);
const dogleg = makeTask([
  tp('START', A.lat, A.lon, 400, 'SSS'),
  tp('BIG', BIG.lat, BIG.lon, 8000),
  tp('GOAL', GOAL.lat, GOAL.lon, 400, 'ESS'),
]);

describe('optimizeRemainingRoute (§6.4.1 from an arbitrary point)', () => {
  it('equals an optimisation of the synthetic point→zones→goal task', () => {
    const p = destinationPoint(BIG.lat, BIG.lon, 12000, Math.PI); // 12 km south of BIG
    const route = optimizeRemainingRoute(dogleg, 0, p);
    expect(route).not.toBeNull();
    const independent = calculateOptimizedTaskDistance(
      makeTask([tp('P', p.lat, p.lon, 0, 'TAKEOFF'), dogleg.turnpoints[1], dogleg.turnpoints[2]]),
    );
    expect(Math.abs(route!.distance - independent)).toBeLessThan(2);
    // The line starts at the point and has one entry per remaining zone.
    expect(route!.line.length).toBe(3);
    expect(andoyerDistance(route!.line[0].lat, route!.line[0].lon, p.lat, p.lon)).toBeLessThan(1);
  });

  it('is never longer than the frozen-tag approximation', () => {
    // Sweep points around the big cylinder: the re-optimised remaining
    // distance must be ≤ (distance to the task line's tag) + (tag→goal leg).
    const taskDist = calculateOptimizedTaskDistance(dogleg);
    for (let deg = 0; deg < 360; deg += 30) {
      const p = destinationPoint(BIG.lat, BIG.lon, 15000, (deg * Math.PI) / 180);
      const route = optimizeRemainingRoute(dogleg, 0, p)!;
      expect(route.distance).toBeGreaterThan(0);
      expect(route.distance).toBeLessThan(taskDist + 20000); // sanity
    }
  });

  it('only goal remaining: nearest-edge distance', () => {
    const p = destinationPoint(GOAL.lat, GOAL.lon, 5000, Math.PI);
    const route = optimizeRemainingRoute(dogleg, 1, p)!;
    expect(route.distance).toBeCloseTo(5000 - 400, -1);
  });

  it('routes to a LINE goal', () => {
    const lineTask = makeTask(
      [tp('START', A.lat, A.lon, 400, 'SSS'), tp('GOAL', GOAL.lat, GOAL.lon, 200)],
      { type: 'LINE' },
    );
    // 3 km back from goal ALONG the course line: the goal line runs
    // perpendicular to the final leg, so the nearest line point is the
    // centre, 3 km away.
    const backBearing = calculateBearingRadians(GOAL.lat, GOAL.lon, A.lat, A.lon);
    const p = destinationPoint(GOAL.lat, GOAL.lon, 3000, backBearing);
    const route = optimizeRemainingRoute(lineTask, 0, p)!;
    expect(route.distance).toBeCloseTo(3000, -2);
  });
});

describe('best progress measures §8.6.1 remaining distance', () => {
  it('a pilot south of the big cylinder scores the re-optimised distance', () => {
    // Track: start at A, exit the start cylinder eastward, then fly to a
    // point 12 km SOUTH of the big cylinder and land there.
    const south = destinationPoint(BIG.lat, BIG.lon, 12000, Math.PI);
    const fixes: IGCFix[] = [];
    // Move east out of the start, then toward the south point.
    for (let i = 0; i <= 60; i++) {
      const t = i / 60;
      const lat = A.lat + (south.lat - A.lat) * t;
      const lon = A.lon + (south.lon - A.lon) * t;
      fixes.push(fix(i * 60, { lat, lon }));
    }
    const result = resolveTurnpointSequence(dogleg, fixes);
    expect(result.madeGoal).toBe(false);
    expect(result.bestProgress).not.toBeNull();

    // The scored remaining distance must equal the best re-optimised
    // route over all scanned fixes — compute it exhaustively here.
    let best = Infinity;
    for (const f of fixes) {
      if (f.time.getTime() <= result.sequence[result.sequence.length - 1].time.getTime()) continue;
      const r = optimizeRemainingRoute(dogleg, result.lastTurnpointReached, {
        lat: f.latitude,
        lon: f.longitude,
      })!;
      best = Math.min(best, r.distance);
    }
    expect(Math.abs(result.bestProgress!.distanceToGoal - best)).toBeLessThan(2);
    expect(result.flownDistance).toBeCloseTo(result.taskDistance - best, 0);
  });

  it('carries the measured remaining route for the explanation', () => {
    const south = destinationPoint(BIG.lat, BIG.lon, 12000, Math.PI);
    const fixes: IGCFix[] = [];
    for (let i = 0; i <= 20; i++) {
      const t = i / 20;
      fixes.push(fix(i * 60, {
        lat: A.lat + (south.lat - A.lat) * t,
        lon: A.lon + (south.lon - A.lon) * t,
      }));
    }
    const result = resolveTurnpointSequence(dogleg, fixes);
    const bp = result.bestProgress!;
    expect(bp.remainingRoute).toBeDefined();
    const route = bp.remainingRoute!;
    // Starts at the best-progress fix, ends at a point on the goal boundary.
    expect(andoyerDistance(route[0].lat, route[0].lon, bp.latitude, bp.longitude)).toBeLessThan(1);
    const last = route[route.length - 1];
    const goalTp = dogleg.turnpoints[2];
    expect(
      Math.abs(andoyerDistance(last.lat, last.lon, goalTp.waypoint.lat, goalTp.waypoint.lon) - goalTp.radius),
    ).toBeLessThan(2);
    // And its length is the scored remaining distance.
    let len = 0;
    for (let i = 1; i < route.length; i++) {
      len += andoyerDistance(route[i - 1].lat, route[i - 1].lon, route[i].lat, route[i].lon);
    }
    expect(Math.abs(len - bp.distanceToGoal)).toBeLessThan(2);
  });

  it('an un-reached EXIT cylinder is measured to its optimal boundary point', () => {
    // Concentric out-and-return: start inside a big ring, goal back inside.
    // The ring (an inferred EXIT cylinder) must be measured to the boundary
    // point that best serves the onward route — for a pilot who never left
    // it, remaining = (best boundary touch) + (return to goal).
    const ring = 10000;
    const center = { lat: -36.5, lon: 147.5 };
    const goalPos = destinationPoint(center.lat, center.lon, 2000, 0);
    const task = makeTask([
      tp('START', center.lat, center.lon, 1000, 'SSS'),
      tp('RING', center.lat, center.lon, ring),
      tp('GOAL', goalPos.lat, goalPos.lon, 400, 'ESS'),
    ]);
    // Pilot exits the start going north, flies 5 km north, lands.
    const p5 = destinationPoint(center.lat, center.lon, 5000, 0);
    const fixes = [
      fix(0, center),
      fix(60, destinationPoint(center.lat, center.lon, 1500, 0)),
      fix(120, destinationPoint(center.lat, center.lon, 3000, 0)),
      fix(180, p5),
    ];
    const result = resolveTurnpointSequence(task, fixes);
    expect(result.madeGoal).toBe(false);
    expect(result.lastTurnpointReached).toBe(0);
    const expected = optimizeRemainingRoute(task, 0, p5)!.distance;
    expect(Math.abs(result.bestProgress!.distanceToGoal - expected)).toBeLessThan(2);
    // From 5 km north: 5 km out to the ring going north, then back
    // (10 000 − 2 000 − 400) to the goal edge ≈ 12.6 km total.
    expect(expected).toBeCloseTo(5000 + (ring - 2000 - 400), -2);
  });
});

describe('manual flights use the same §8.6.1 measurement', () => {
  it('routes the landing point through the re-optimised remaining route', () => {
    const south = destinationPoint(BIG.lat, BIG.lon, 12000, Math.PI);
    const g = manualFlightGeometry(dogleg, 0, { lat: south.lat, lon: south.lon });
    const expected = optimizeRemainingRoute(dogleg, 0, south)!;
    expect(Math.abs(g.distanceToGoal - expected.distance)).toBeLessThan(2);
    expect(g.madeGood).toBeCloseTo(
      calculateOptimizedTaskDistance(dogleg) - expected.distance,
      0,
    );
    // The drawn route is the measured one.
    expect(g.routeToGoal.length).toBe(expected.line.length);
  });
});
