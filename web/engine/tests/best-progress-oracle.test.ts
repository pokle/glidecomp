// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Oracle tests for the exact best-progress search (SEC-45).
 *
 * `computeBestProgress`'s exact mode is a branch-and-bound over the track's
 * fixes, and SEC-45 bounds how much work it may do. Bounding a search
 * changes WHICH fixes it evaluates, so before it was touched these tests
 * pinned what it returns, two ways:
 *
 * 1. Against the definition. S7F §9.3: "for every remaining track point, the
 *    shortest distance to goal is calculated using the method described in
 *    section 6.4.1". The brute-force oracle below does exactly that: it runs
 *    `optimizeRemainingRoute` on EVERY eligible fix and takes the minimum. The
 *    search may stop early only within BEST_PROGRESS_TOLERANCE_M (5 m) of
 *    that minimum. It never reports less than the minimum, because what it
 *    reports is the exact value at a real fix.
 *
 * 2. Against itself. GOLDEN holds the fix and distance the search returned
 *    for each case BEFORE the SEC-45 change (commit 8749808). On tracks this
 *    size the bound must not engage, so the answers must be identical. Do
 *    not regenerate GOLDEN to make a change pass: a difference here is a
 *    pilot's distance moving.
 *
 * The cases cover each remaining-route shape the search handles: a dogleg
 * around a big cylinder, a multi-turnpoint course from two different
 * last-reached turnpoints, a LINE goal, an ESS pinned before goal, an EXIT
 * cylinder still to leave, and the §13.4.6 stopped-task altitude bonus.
 * Tracks are seeded random walks with circling, so they are reproducible.
 */

import { describe, expect, it } from 'bun:test';
import {
  buildRemainingPath,
  computeBestProgress,
} from '../src/turnpoint-sequence-path';
import {
  calculateOptimizedTaskLine,
  getOptimizedSegmentDistances,
  optimizeRemainingRoute,
} from '../src/task-optimizer';
import { computeGoalLine } from '../src/goal-line';
import { destinationPoint } from '../src/geo';
import { fixAltitude, type IGCFix } from '../src/igc-parser';
import type { XCTask, Turnpoint } from '../src/xctsk-parser';
import type { NextTPMeasure } from '../src/turnpoint-sequence-types';

const TOLERANCE_M = 5; // BEST_PROGRESS_TOLERANCE_M in turnpoint-sequence-path.ts
const T0 = Date.parse('2026-01-05T02:00:00Z');

/** Seeded PRNG (mulberry32), so every track is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type LatLon = { lat: number; lon: number };
const DEG = Math.PI / 180;
const at = (p: LatLon, m: number, bearingDeg: number): LatLon =>
  destinationPoint(p.lat, p.lon, m, bearingDeg * DEG);

function tp(name: string, p: LatLon, radius: number, type?: Turnpoint['type']): Turnpoint {
  return { type, radius, waypoint: { name, lat: p.lat, lon: p.lon } };
}

/**
 * A pilot's track: start at `from`, then alternate glides and thermals.
 * A glide heads roughly along `heading` with ±60° of wander — reversed for
 * the last 45% of the fixes, so the pilot turns back and the best point is
 * mid-track with a crowd of near-equal fixes around it; a thermal
 * circles (radius 40–90 m, about 25 s a turn) while drifting with the wind.
 * One fix a second, 8–12 m apart, like a real logger.
 */
function wanderingTrack(seed: number, from: LatLon, heading: number, fixCount: number): IGCFix[] {
  const rand = mulberry32(seed);
  const fixes: IGCFix[] = [];
  let p = from;
  let alt = 1800;
  let i = 0;
  const push = () => {
    fixes.push({
      time: new Date(T0 + i * 1000),
      latitude: p.lat,
      longitude: p.lon,
      pressureAltitude: alt,
      gnssAltitude: alt,
      valid: true,
    });
    i++;
  };
  push();
  while (fixes.length < fixCount) {
    if (rand() < 0.5) {
      // Glide.
      const outbound = fixes.length < fixCount * 0.55;
      const brg = heading + (outbound ? 0 : 180) + (rand() - 0.5) * 120;
      const n = 30 + Math.floor(rand() * 120);
      for (let k = 0; k < n && fixes.length < fixCount; k++) {
        p = at(p, 8 + rand() * 4, brg + (rand() - 0.5) * 10);
        alt -= 1 + rand();
        push();
      }
    } else {
      // Thermal: circle while drifting.
      const r = 40 + rand() * 50;
      const drift = rand() * 360;
      const turns = 2 + Math.floor(rand() * 6);
      const centre0 = at(p, r, rand() * 360);
      for (let k = 0; k < turns * 25 && fixes.length < fixCount; k++) {
        const centre = at(centre0, k * 0.8, drift);
        p = at(centre, r, (k * 360) / 25);
        alt += 1.5 + rand();
        push();
      }
    }
  }
  return fixes;
}

interface OracleCase {
  name: string;
  task: XCTask;
  lastReachedIndex: number;
  fixes: IGCFix[];
  /** Fixes before this index are before the last reaching. */
  reachedAtFix: number;
  /** Fixes after this index are after the deadline / scored-window end. */
  deadlineFix: number | null;
  altitudeBonus?: { glideRatio: number; goalAltitude: number };
  /** Overrides the default next-turnpoint measure. */
  nextMeasure?: NextTPMeasure;
}

/** The resolver's default cheap measure for an ENTER next turnpoint. */
function defaultMeasure(task: XCTask, lastReachedIndex: number): NextTPMeasure {
  const nextIdx = lastReachedIndex + 1;
  const goalIdx = task.turnpoints.length - 1;
  if (nextIdx >= goalIdx) {
    const line = computeGoalLine(task);
    return line ? { kind: 'goal-line', line } : { kind: 'edge' };
  }
  return { kind: 'tag', point: calculateOptimizedTaskLine(task)[nextIdx] };
}

function run(c: OracleCase) {
  const { remainingTPs, remainingLegDistances } = buildRemainingPath(
    c.task,
    c.lastReachedIndex,
    getOptimizedSegmentDistances(c.task),
  );
  return computeBestProgress({
    task: c.task,
    lastReachedIndex: c.lastReachedIndex,
    fixes: c.fixes,
    lastReachingTime: c.fixes[c.reachedAtFix].time.getTime(),
    remainingTPs,
    remainingLegDistances,
    nextMeasure: c.nextMeasure ?? defaultMeasure(c.task, c.lastReachedIndex),
    deadlineMs: c.deadlineFix === null ? null : c.fixes[c.deadlineFix].time.getTime(),
    altitudeBonus: c.altitudeBonus ?? null,
  }, 'exact');
}

/**
 * The §9.3 definition, by brute force: the effective remaining distance at
 * EVERY eligible fix. The altitude bonus belongs only to the last eligible
 * fix (S7F 2026 §13.4.6), clamped to the geometric distance there.
 */
function bruteForce(c: OracleCase): number[] {
  const last = c.deadlineFix ?? c.fixes.length - 1;
  const eff: number[] = [];
  for (let i = c.reachedAtFix; i <= last; i++) {
    const f = c.fixes[i];
    const route = optimizeRemainingRoute(c.task, c.lastReachedIndex, {
      lat: f.latitude,
      lon: f.longitude,
    });
    const geom = route ? route.distance : 0;
    const bonus =
      c.altitudeBonus && i === last
        ? Math.min(
            geom,
            c.altitudeBonus.glideRatio * Math.max(0, fixAltitude(f) - c.altitudeBonus.goalAltitude),
          )
        : 0;
    eff[i] = geom - bonus;
  }
  return eff;
}

// --- Task geometries ------------------------------------------------------

const A: LatLon = { lat: -36.0, lon: 147.0 };

/** Start, an 8 km cylinder 25 km east, goal 25 km north of it. */
const BIG = at(A, 25000, 90);
const dogleg: XCTask = {
  taskType: 'CLASSIC',
  version: 1,
  turnpoints: [
    tp('START', A, 400, 'SSS'),
    tp('BIG', BIG, 8000),
    tp('GOAL', at(BIG, 25000, 0), 400, 'ESS'),
  ],
};

/** A zigzag course with mixed radii and a cylinder goal. */
const Z1 = at(A, 18000, 60);
const Z2 = at(Z1, 15000, 150);
const Z3 = at(Z2, 20000, 45);
const Z4 = at(Z3, 12000, 330);
const zigzag: XCTask = {
  taskType: 'CLASSIC',
  version: 1,
  turnpoints: [
    tp('START', A, 1000, 'SSS'),
    tp('Z1', Z1, 3000),
    tp('Z2', Z2, 400),
    tp('Z3', Z3, 2000),
    tp('Z4', Z4, 1000, 'ESS'),
    tp('GOAL', at(Z4, 8000, 20), 400),
  ],
};

/** A bent course to a LINE goal. */
const L1 = at(A, 20000, 100);
const lineGoal: XCTask = {
  taskType: 'CLASSIC',
  version: 1,
  turnpoints: [
    tp('START', A, 400, 'SSS'),
    tp('L1', L1, 2500),
    tp('GOAL', at(L1, 15000, 20), 400),
  ],
  goal: { type: 'LINE' },
};

/** The ESS sits mid-route, so the remaining route pins it. */
const E1 = at(A, 15000, 80);
const E2 = at(E1, 12000, 10);
const essMid: XCTask = {
  taskType: 'CLASSIC',
  version: 1,
  turnpoints: [
    tp('START', A, 400, 'SSS'),
    tp('E1', E1, 1500),
    tp('ESS', E2, 3000, 'ESS'),
    tp('GOAL', at(E2, 4000, 200), 400),
  ],
};

/** The next turnpoint is a big cylinder the pilot starts inside and must
 * leave (an EXIT cylinder), then a goal beyond it. */
const X1 = at(A, 3000, 0);
const exitNext: XCTask = {
  taskType: 'CLASSIC',
  version: 1,
  turnpoints: [
    tp('START', A, 400, 'SSS'),
    tp('X1', X1, 12000),
    tp('GOAL', at(X1, 30000, 70), 400),
  ],
};

// --- The cases ------------------------------------------------------------

const CASES: OracleCase[] = [];
for (let s = 0; s < 4; s++) {
  CASES.push({
    name: `dogleg #${s}`,
    task: dogleg,
    lastReachedIndex: 0,
    fixes: wanderingTrack(100 + s, A, 100 + s * 15, 1500),
    reachedAtFix: 0,
    deadlineFix: null,
  });
}
for (let s = 0; s < 3; s++) {
  CASES.push({
    name: `zigzag from start #${s}`,
    task: zigzag,
    lastReachedIndex: 0,
    fixes: wanderingTrack(200 + s, A, 50 + s * 20, 1500),
    reachedAtFix: 0,
    deadlineFix: null,
  });
  CASES.push({
    name: `zigzag from Z2 #${s}`,
    task: zigzag,
    lastReachedIndex: 2,
    fixes: wanderingTrack(300 + s, Z2, 30 + s * 25, 1500),
    reachedAtFix: 0,
    deadlineFix: null,
  });
}
for (let s = 0; s < 3; s++) {
  CASES.push({
    name: `line goal #${s}`,
    task: lineGoal,
    lastReachedIndex: 0,
    fixes: wanderingTrack(400 + s, A, 90 + s * 10, 1500),
    reachedAtFix: 0,
    deadlineFix: null,
  });
  CASES.push({
    name: `line goal, last leg #${s}`,
    task: lineGoal,
    lastReachedIndex: 1,
    fixes: wanderingTrack(450 + s, L1, 10 + s * 20, 1200),
    reachedAtFix: 0,
    deadlineFix: null,
  });
}
for (let s = 0; s < 3; s++) {
  CASES.push({
    name: `ESS mid-route #${s}`,
    task: essMid,
    lastReachedIndex: 0,
    fixes: wanderingTrack(500 + s, A, 60 + s * 15, 1500),
    reachedAtFix: 0,
    deadlineFix: null,
  });
}
for (let s = 0; s < 3; s++) {
  CASES.push({
    name: `exit cylinder next #${s}`,
    task: exitNext,
    lastReachedIndex: 0,
    fixes: wanderingTrack(600 + s, A, 40 + s * 30, 1500),
    reachedAtFix: 0,
    deadlineFix: null,
    nextMeasure: { kind: 'exit-boundary' },
  });
}
for (let s = 0; s < 3; s++) {
  // Reached the turnpoint 100 s in; the window closes 300 fixes early.
  CASES.push({
    name: `stopped task, altitude bonus #${s}`,
    task: dogleg,
    lastReachedIndex: 0,
    fixes: wanderingTrack(700 + s, A, 95 + s * 10, 1500),
    reachedAtFix: 100,
    deadlineFix: 1199,
    altitudeBonus: { glideRatio: [0.5, 5, 9][s], goalAltitude: 300 },
  });
}

/**
 * What the search returned for each case before SEC-45 (commit 8749808):
 * [fixIndex, distanceToGoal]. Never regenerate these to make a change pass.
 */
const GOLDEN: Record<string, [number, number]> = {
  'dogleg #0': [740, 33963.51089305842],
  'dogleg #1': [986, 36693.95803222534],
  'dogleg #2': [1077, 37859.156666610535],
  'dogleg #3': [644, 37715.007666592195],
  'zigzag from start #0': [981, 62069.41274641034],
  'zigzag from Z2 #0': [827, 32950.78186994061],
  'zigzag from start #1': [965, 59897.6180610265],
  'zigzag from Z2 #1': [900, 33581.82844481482],
  'zigzag from start #2': [831, 61325.580612251804],
  'zigzag from Z2 #2': [834, 34117.52852551578],
  'line goal #0': [589, 30258.768700171528],
  'line goal, last leg #0': [711, 12194.41309272342],
  'line goal #1': [556, 30276.963929127065],
  'line goal, last leg #1': [483, 12291.59525582712],
  'line goal #2': [724, 28897.89771483394],
  'line goal, last leg #2': [433, 14032.275502497905],
  'ESS mid-route #0': [1300, 19625.136539400235],
  'ESS mid-route #1': [971, 17169.605317279504],
  'ESS mid-route #2': [1002, 20501.180841870537],
  'exit cylinder next #0': [910, 27568.673562287207],
  'exit cylinder next #1': [987, 26261.464095502983],
  'exit cylinder next #2': [878, 26982.61739847906],
  'stopped task, altitude bonus #0': [853, 34272.200866540225],
  'stopped task, altitude bonus #1': [1199, 25529.85061952159],
  'stopped task, altitude bonus #2': [1199, 22028.162779909893],
};

describe('best-progress search against the §9.3 brute-force oracle', () => {
  for (const c of CASES) {
    it(c.name, () => {
      const result = run(c);
      expect(result).not.toBeNull();
      const eff = bruteForce(c);
      let min = Infinity;
      for (const v of eff) if (v !== undefined && v < min) min = v;

      // What it reports is the exact value at the fix it names…
      expect(eff[result!.fixIndex]).toBeDefined();
      expect(Math.abs(result!.distanceToGoal - eff[result!.fixIndex])).toBeLessThan(1e-6);
      // …so it can never beat the true minimum, and may stop short of it
      // by no more than the tolerance.
      expect(result!.distanceToGoal).toBeGreaterThanOrEqual(min - 1e-6);
      expect(result!.distanceToGoal).toBeLessThanOrEqual(min + TOLERANCE_M);
    });
  }
});

describe('best-progress search returns what it returned before SEC-45', () => {
  for (const c of CASES) {
    it(c.name, () => {
      const golden = GOLDEN[c.name];
      expect(golden).toBeDefined();
      const result = run(c)!;
      // Ordinary tracks never come near the work budget.
      expect(result.searchCapped).toBeUndefined();
      expect(result.fixIndex).toBe(golden[0]);
      expect(Math.abs(result.distanceToGoal - golden[1])).toBeLessThan(1e-6);
    });
  }
});
