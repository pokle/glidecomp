// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Adversarial-input coverage for the exact best-progress search (SEC-45).
 *
 * The search prunes a fix only when it lies CLOSE to a fix it has already
 * measured. A track that hugs a contour of equal remaining distance defeats
 * that: every fix is about as far from goal as the best, and no two are
 * within the 5 m tolerance of each other. Before SEC-45 each such fix cost a
 * route optimisation plus a scan over every fix measured before it, so
 * 60,000 of them (what the 2 MiB upload limit admits) took about 50 s on
 * the course below and 147 s on a larger one — on the server, after every
 * upload, anonymous ones included.
 *
 * The course is legal under the API: a 50 km cylinder (the largest
 * `validators.ts` admits) on a dogleg. The track walks the contour round
 * the cylinder's far side at 7 m a fix, then back along it offset by half
 * a step. The per-test timeout is the performance guard; the assertions
 * pin what a search that hits its budget must still promise.
 */

import { describe, expect, it } from 'bun:test';
import { resolveTurnpointSequence } from '../src/turnpoint-sequence';
import { optimizeRemainingRoute } from '../src/task-optimizer';
import { destinationPoint, ellipsoidDistance } from '../src/geo';
import type { IGCFix } from '../src/igc-parser';
import type { XCTask } from '../src/xctsk-parser';

type LatLon = { lat: number; lon: number };

const R = 50000;
const LEG = 150000;
const A: LatLon = { lat: -36.0, lon: 147.0 };
const BIG = destinationPoint(A.lat, A.lon, LEG + R, Math.PI / 2);
const GOAL = destinationPoint(BIG.lat, BIG.lon, LEG + R, 0);
const task: XCTask = {
  taskType: 'CLASSIC',
  version: 1,
  turnpoints: [
    { type: 'SSS', radius: 400, waypoint: { name: 'START', lat: A.lat, lon: A.lon } },
    { radius: R, waypoint: { name: 'BIG', lat: BIG.lat, lon: BIG.lon } },
    { type: 'ESS', radius: 400, waypoint: { name: 'GOAL', lat: GOAL.lat, lon: GOAL.lon } },
  ],
  sss: { type: 'RACE', direction: 'EXIT' },
};

const remaining = (p: LatLon) => optimizeRemainingRoute(task, 0, p)!.distance;

/**
 * Points round BIG's far side where the remaining distance equals that of
 * a point LEG/8 south of its edge, found by bisection along each bearing.
 */
function contour(anchors: number): { points: LatLon[]; level: number } {
  const ref = destinationPoint(BIG.lat, BIG.lon, R + LEG / 8, Math.PI);
  const level = remaining(ref);
  const points: LatLon[] = [];
  let guess = R + LEG / 8;
  for (let k = 0; k <= anchors; k++) {
    const theta = 0.6 * Math.PI + (0.9 * Math.PI * k) / anchors;
    // The first bearing is searched wide; each later one starts from its
    // neighbour, which the contour never strays far from.
    let lo = k === 0 ? R + 1 : Math.max(R + 1, guess - 3000);
    let hi = k === 0 ? R + 300000 : guess + 3000;
    for (let it = 0; it < (k === 0 ? 40 : 22); it++) {
      const mid = (lo + hi) / 2;
      if (remaining(destinationPoint(BIG.lat, BIG.lon, mid, theta)) < level) lo = mid;
      else hi = mid;
    }
    guess = (lo + hi) / 2;
    points.push(destinationPoint(BIG.lat, BIG.lon, guess, theta));
  }
  return { points, level };
}

function contourTrack(points: LatLon[], fixCount: number, spacingM: number): IGCFix[] {
  const t0 = Date.parse('2026-01-05T02:00:00Z');
  const path: LatLon[] = [];
  outer: for (let pass = 0; ; pass++) {
    const seq = pass % 2 === 0 ? points : [...points].reverse();
    for (let k = 1; k < seq.length; k++) {
      const a = seq[k - 1];
      const b = seq[k];
      const steps = Math.max(1, Math.round(ellipsoidDistance(a.lat, a.lon, b.lat, b.lon) / spacingM));
      for (let s = 0; s < steps; s++) {
        const f = (s + (pass % 2 ? 0.5 : 0)) / steps;
        path.push({ lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f });
        if (path.length >= fixCount) break outer;
      }
    }
  }
  // Launch inside the start cylinder, then fly straight out to the contour.
  const fixes: IGCFix[] = [];
  const push = (p: LatLon) =>
    fixes.push({
      time: new Date(t0 + fixes.length * 1000),
      latitude: p.lat,
      longitude: p.lon,
      pressureAltitude: 1500,
      gnssAltitude: 1500,
      valid: true,
    });
  push(A);
  push(destinationPoint(A.lat, A.lon, 1000, Math.PI / 2));
  for (const p of path) push(p);
  return fixes;
}

describe('best-progress search on a contour-hugging track (SEC-45)', () => {
  it('60,000 fixes finish in bounded time, and the answer keeps its promises', () => {
    const { points, level } = contour(1500);
    const fixes = contourTrack(points, 60000, 7);

    const result = resolveTurnpointSequence(task, fixes);
    expect(result.lastTurnpointReached).toBe(0);
    const bp = result.bestProgress!;
    expect(bp).toBeDefined();

    // The budget engaged, and the result says so.
    expect(bp.searchCapped).toBeDefined();
    const { routesMeasured, lowerBound } = bp.searchCapped!;
    expect(routesMeasured).toBeGreaterThan(1);
    expect(routesMeasured).toBeLessThanOrEqual(100_000 / 16);

    // What it reports is the exact remaining distance from a real fix, so
    // the pilot is never over-credited…
    const f = fixes[bp.fixIndex];
    expect(Math.abs(remaining({ lat: f.latitude, lon: f.longitude }) - bp.distanceToGoal)).toBeLessThan(1e-6);
    // …the bound on what it never checked is a bound…
    expect(lowerBound).toBeLessThanOrEqual(bp.distanceToGoal);
    // …and on this track every fix is about as far from goal as every
    // other, so stopping early cost nothing real.
    expect(Math.abs(bp.distanceToGoal - level)).toBeLessThan(1);
  }, 20_000);
});
