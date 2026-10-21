/**
 * FAI S7F §7.2 distance-definition compliance.
 *
 * Two rules the optimizer must implement:
 *
 * 1. Launch centre (§7.2): "the distance is measured from the center
 *    of the launch waypoint (regardless of whether it has been given a
 *    radius)". The first route element is always a point — the first
 *    turnpoint's CENTRE — whatever its type. Tasks whose route begins
 *    directly at the start cylinder (no TAKEOFF row — common in AirScore
 *    imports) previously measured from the start cylinder's edge, losing
 *    exactly its radius: 5–10 km on real archive tasks.
 *
 * 2. Mid-route ESS (2026 §7.2): the ESS is an ordinary element of the task
 *    route, and the speed section is measured on its OWN route,
 *    launchToESSPath = RouteOptimizer(launchToESS). The 2024 edition instead
 *    pinned the ESS tag to the incoming leg (Annex A §3.2.4) so the task
 *    path's prefix equalled that route; 2026 dropped the pin, so the task
 *    path no longer kinks at the ESS and the two are computed apart.
 *
 * Real-task fixtures come from pokle/glidecomp-archive (see fixtures/README).
 * Published reference distances are AirScore's, from each task's
 * airscore-result-raw.json in that repo.
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  calculateOptimizedTaskLine,
  calculateOptimizedTaskDistance,
  getOptimizedSegmentDistances,
  getLaunchToESSSegmentDistances,
} from '../src/task-optimizer';
import { parseXCTask, getESSIndex, type XCTask, type Turnpoint } from '../src/xctsk-parser';
import { ellipsoidDistance, destinationPoint } from '../src/geo';
import { computeLeadingAggregate } from '../src/gap-leading';

const fixture = (name: string): XCTask =>
  parseXCTask(readFileSync(resolve(__dirname, 'fixtures', name), 'utf-8'));

const sample = (comp: string): XCTask =>
  parseXCTask(
    readFileSync(resolve(__dirname, `../../samples/comps/${comp}/task.xctsk`), 'utf-8'),
  );

function makeTurnpoint(name: string, lat: number, lon: number, radius: number, type?: Turnpoint['type']): Turnpoint {
  return { type, radius, waypoint: { name, lat, lon } };
}

function makeTask(turnpoints: Turnpoint[]): XCTask {
  return { taskType: 'CLASSIC', version: 1, turnpoints };
}

/**
 * The independent §7.2 launchToESS optimisation: the task truncated at the
 * ESS, optimised as its own route (its terminal element measured like a
 * goal). calculateLaunchToESSLine must equal this.
 */
function independentLaunchToEssDistance(task: XCTask, essIdx: number): number {
  const sub: XCTask = {
    ...task,
    turnpoints: task.turnpoints.slice(0, essIdx + 1),
    goal: undefined,
  };
  return calculateOptimizedTaskDistance(sub);
}

function launchToEssDistance(task: XCTask): number {
  return getLaunchToESSSegmentDistances(task).reduce((a, b) => a + b, 0);
}

describe('launch centre rule (§7.2)', () => {
  it('a route starting at the start cylinder measures from its CENTRE', () => {
    // Start cylinder r=5000 at A, goal r=400 20 km away: centre→edge is
    // 20 000 − 400, not (20 000 − 5 000 − 400) from the start's edge.
    const a = { lat: -36.0, lon: 147.0 };
    const b = destinationPoint(a.lat, a.lon, 20000, Math.PI / 2);
    const task = makeTask([
      makeTurnpoint('START', a.lat, a.lon, 5000, 'SSS'),
      makeTurnpoint('GOAL', b.lat, b.lon, 400),
    ]);
    expect(calculateOptimizedTaskDistance(task)).toBeCloseTo(19600, -1);
  });

  it('corryong-cup-2022-open-t1 (SSS-first): matches the published task distance', () => {
    // AirScore published (airscore-result-raw.json): task_dist 61.239 km,
    // per-waypoint cumulatives 14.791 / 33.097 / 47.410 / 61.239 — all
    // measured from the start cylinder's centre.
    //
    // The route crosses MTMITA's 400 m cylinder straight through. §7.1.3
    // (PathFinder, Ding et al.'s crossing case) tags the FIRST intersection
    // of the leg with the cylinder, where AirScore's optimiser published the
    // boundary point nearest the chord — ~157 m later along the same chord.
    // Both placements cost the identical total, so that one cumulative is
    // held to a cylinder radius rather than the 30 m the others get.
    const task = fixture('corryong-cup-2022-open-t1.xctsk');
    const segs = getOptimizedSegmentDistances(task);
    const cums: number[] = [0];
    for (const s of segs) cums.push(cums[cums.length - 1] + s);
    const published = [0, 14791, 33097, 47410, 61239];
    const crossedStraightThrough = new Set([2]); // MTMITA
    for (let i = 0; i < published.length; i++) {
      const tolerance = crossedStraightThrough.has(i) ? task.turnpoints[i].radius : 30;
      expect(Math.abs(cums[i] - published[i])).toBeLessThan(tolerance);
    }
  });

  it('a TAKEOFF-typed first turnpoint still measures from its centre', () => {
    // The rule is positional (index 0), so the previous TAKEOFF behaviour
    // is unchanged: corryong-cup-2026-open-t1 keeps its 78.846 km.
    const task = sample('corryong-cup-2026-open-t1');
    expect(calculateOptimizedTaskDistance(task) / 1000).toBeCloseTo(78.846, 2);
  });

  it('the first tag point IS the first turnpoint centre', () => {
    const task = fixture('corryong-cup-2022-open-t1.xctsk');
    const line = calculateOptimizedTaskLine(task);
    const tp0 = task.turnpoints[0].waypoint;
    expect(ellipsoidDistance(line[0].lat, line[0].lon, tp0.lat, tp0.lon)).toBeLessThan(1);
  });
});

describe('mid-route ESS (2026 §7.2)', () => {
  // A course that bends sharply at a big ESS cylinder: launch → ESS(r=5km)
  // → goal off at an angle. The 2024 pin fixed the ESS tag to the incoming
  // leg; under 2026 it floats like any other turnpoint.
  const bentTask = (): XCTask => {
    const a = { lat: -36.0, lon: 147.0 };
    const b = destinationPoint(a.lat, a.lon, 30000, Math.PI / 2); // ESS centre, due east
    const c = destinationPoint(b.lat, b.lon, 15000, Math.PI); // goal, due south of ESS
    return makeTask([
      makeTurnpoint('START', a.lat, a.lon, 1000, 'SSS'),
      makeTurnpoint('ESS', b.lat, b.lon, 5000, 'ESS'),
      makeTurnpoint('GOAL', c.lat, c.lon, 400),
    ]);
  };

  it('the ESS is not pinned: the task distance is the free-floating optimum', () => {
    const task = bentTask();
    const free = calculateOptimizedTaskDistance({
      ...task,
      turnpoints: task.turnpoints.map((tp, i) =>
        i === 1 ? { ...tp, type: undefined } : tp,
      ),
    });
    expect(Math.abs(calculateOptimizedTaskDistance(task) - free)).toBeLessThan(0.5);
  });

  it('the speed section is measured on its own route, not the task line', () => {
    const task = bentTask();
    // Launch→ESS on its own: the ESS tag faces the incoming leg — the
    // nearest boundary point to the start's tag.
    const own = launchToEssDistance(task);
    expect(Math.abs(own - independentLaunchToEssDistance(task, 1))).toBeLessThan(1);
    // The task line's ESS tag leans toward the goal, so its prefix is longer.
    expect(getOptimizedSegmentDistances(task)[0]).toBeGreaterThan(own + 100);
  });

  const launchToEssEqualsIndependent = (task: XCTask) => {
    const essIdx = getESSIndex(task);
    expect(essIdx).toBeGreaterThan(0);
    const own = launchToEssDistance(task);
    const independent = independentLaunchToEssDistance(task, essIdx);
    expect(Math.abs(own - independent)).toBeLessThan(3);
  };

  it('bright-open-2023-open-t1: launch→ESS equals the independent §7.2 optimisation', () => {
    launchToEssEqualsIndependent(fixture('bright-open-2023-open-t1.xctsk'));
  });

  it('unungra-cup-2020-open-t1: launch→ESS equals the independent optimisation', () => {
    launchToEssEqualsIndependent(sample('unungra-cup-2020-open-t1'));
  });

  it('kosci-loop-t3: launch→ESS equals the independent optimisation', () => {
    launchToEssEqualsIndependent(sample('kosci-loop-t3'));
  });

  it('task distances without the pin (engine code review 2026-10-20, finding 1.4)', () => {
    // With the 2024 pin these were 67.356 km and 17.431 km.
    expect(calculateOptimizedTaskDistance(sample('unungra-cup-2020-open-t1')) / 1000)
      .toBeCloseTo(66.729, 2);
    expect(calculateOptimizedTaskDistance(sample('kosci-loop-t3')) / 1000)
      .toBeCloseTo(17.281, 2);
  });

  it('ESS at goal: launch→ESS is the task line (corryong-cup-2026-open-t1 unchanged)', () => {
    const task = sample('corryong-cup-2026-open-t1');
    expect(getESSIndex(task)).toBe(task.turnpoints.length - 1);
    expect(calculateOptimizedTaskDistance(task) / 1000).toBeCloseTo(78.846, 2);
    expect(launchToEssDistance(task)).toBeCloseTo(calculateOptimizedTaskDistance(task), 6);
  });

  it('bright-open-2025-open-t3 (ENTER start concentric with the next TP): out-and-back route matches published', () => {
    // The takeoff sits INSIDE the 33.5 km ENTER start ring, so the optimised
    // route must go out to the ring boundary (published cumulative 3 243 m)
    // and come back through the whole course. AirScore's task_dist 101.72 km
    // includes that out-and-back; per-waypoint mid-route tags on the big
    // cylinders can differ while the total agrees, so only the SSS leg and
    // the total are pinned. The same file carries cylinderTolerance 0.0005 —
    // the declared band the sequence resolution must honour (issue #577).
    const task = fixture('bright-open-2025-open-t3.xctsk');
    expect(task.cylinderTolerance).toBe(0.0005);
    const segs = getOptimizedSegmentDistances(task);
    expect(Math.abs(segs[0] - 3243)).toBeLessThan(30);
    const total = segs.reduce((a, b) => a + b, 0);
    expect(Math.abs(total - 101722)).toBeLessThan(60);
  });

  it('feeds the leading coefficient the §7.2 speedSectionDistance', () => {
    // ssKm inside computeLeadingAggregate must be launchToESSDistance minus
    // the preSpeedSectionDistance, both on the launchToESSPath.
    const task = fixture('bright-open-2023-open-t1.xctsk');
    const essIdx = getESSIndex(task);
    const segs = getLaunchToESSSegmentDistances(task);
    const pre = segs[0]; // sssIdx = 1 (TAKEOFF first)
    const expectedSsKm = (independentLaunchToEssDistance(task, essIdx) - pre) / 1000;

    const t0 = Date.parse('2023-02-11T02:00:00Z');
    const fixes = [0, 60, 120].map((s) => ({
      time: new Date(t0 + s * 1000),
      latitude: task.turnpoints[1].waypoint.lat,
      longitude: task.turnpoints[1].waypoint.lon,
      gpsAltitude: 1000,
      pressureAltitude: 1000,
      valid: true,
    }));
    const agg = computeLeadingAggregate(fixes as never, task, [], t0, null);
    expect(agg.valid).toBe(true);
    expect(agg.ssKm).toBeCloseTo(expectedSsKm, 3);
  });
});
