import { describe, it, expect } from 'bun:test';
import type { Turnpoint, XCTask, TurnpointType } from '../src/xctsk-parser';
import { destinationPoint, projectOntoSegment } from '../src/geo';
import {
  describeThermalPlace,
  formatThermalPlace,
  type ThermalPlace,
} from '../src/analysis/thermal-place';

function tp(name: string, lat: number, lon: number, radius: number, type?: TurnpointType): Turnpoint {
  return { type, radius, waypoint: { name, lat, lon } };
}

function task(turnpoints: Turnpoint[]): XCTask {
  return { taskType: 'CLASSIC', version: 1, turnpoints };
}

const deg = (d: number) => (d * Math.PI) / 180;

/** A point `m` metres from a turnpoint on bearing `b` degrees. */
function from(t: Turnpoint, m: number, b: number) {
  return destinationPoint(t.waypoint.lat, t.waypoint.lon, m, deg(b));
}

// A west-to-east course: launch, an exit start round it, two turnpoints ~30 km
// apart, goal.
const LAUNCH = tp('LAUNCH', -36.5, 147.0, 400, 'TAKEOFF');
const START = tp('LAUNCH', -36.5, 147.0, 5000, 'SSS');
const B03 = tp('B03', -36.5, 147.3, 400);
const B04 = tp('B04', -36.5, 147.65, 1000, 'ESS');
const GOAL = tp('GOAL', -36.5, 147.66, 400);
const COURSE = task([LAUNCH, START, B03, B04, GOAL]);

function place(lat: number, lon: number): ThermalPlace | null {
  return describeThermalPlace(COURSE, lat, lon);
}

describe('describeThermalPlace', () => {
  it('names the turnpoint whose cylinder holds it', () => {
    const p = from(B03, 300, 45);
    expect(place(p.lat, p.lon)).toEqual({ kind: 'at', turnpoint: 'B03' });
  });

  it('names the smallest cylinder when several hold it', () => {
    // GOAL (400 m) sits inside the ESS cylinder (1 km) — the goal is the more specific place.
    expect(place(GOAL.waypoint.lat, GOAL.waypoint.lon)).toEqual({ kind: 'at', turnpoint: 'GOAL' });
    // Inside the 5 km start but outside the 400 m launch: the start, by its name.
    const p = from(START, 3000, 90);
    expect(place(p.lat, p.lon)).toEqual({ kind: 'at', turnpoint: 'LAUNCH' });
  });

  it('is near a turnpoint within 1 km of its edge', () => {
    const p = from(B03, 400 + 900, 0);
    expect(place(p.lat, p.lon)).toEqual({ kind: 'near', turnpoint: 'B03' });
  });

  it('is not near a turnpoint past 1 km of its edge', () => {
    const p = from(B03, 400 + 1200, 0);
    expect(place(p.lat, p.lon)?.kind).not.toBe('near');
  });

  it('measures "near" from the edge, so a big cylinder does not steal a small one', () => {
    // 1.2 km north of B03's centre (800 m outside its edge). Every other
    // cylinder's edge is further, even the 5 km start's.
    const p = from(B03, 1200, 0);
    expect(place(p.lat, p.lon)).toEqual({ kind: 'near', turnpoint: 'B03' });
  });

  it('is between the ends of the leg it sits beside', () => {
    // Halfway along B03 → B04, 3 km north of the line.
    const mid = destinationPoint(-36.5, 147.475, 3000, 0);
    expect(place(mid.lat, mid.lon)).toEqual({ kind: 'between', from: 'B03', to: 'B04' });
  });

  it('never says between a turnpoint and itself', () => {
    // Launch → start share a waypoint; a point beside "that leg" is off-course instead.
    for (const r of describeAround(LAUNCH, 8000)) {
      if (r?.kind === 'between') expect(r.from).not.toBe(r.to);
    }
  });

  it('falls back to a distance and bearing past the leg limit', () => {
    // Halfway along B03 → B04, 8 km south: beyond the 5 km limit.
    const p = destinationPoint(-36.5, 147.475, 8000, deg(180));
    const r = place(p.lat, p.lon);
    expect(r?.kind).toBe('off');
    if (r?.kind !== 'off') return;
    expect(['B03', 'B04']).toContain(r.turnpoint);
    expect(r.bearing).toBeGreaterThan(90);
    expect(r.bearing).toBeLessThan(270);
  });

  it('falls back to a distance and bearing behind launch', () => {
    const p = from(LAUNCH, 12000, 270);
    const r = place(p.lat, p.lon);
    expect(r).toMatchObject({ kind: 'off', turnpoint: 'LAUNCH' });
    if (r?.kind !== 'off') return;
    expect(r.distanceMeters).toBeCloseTo(12000, -1);
    expect(r.bearing).toBeCloseTo(270, 0);
  });

  it('caps "between" at half a short leg', () => {
    const A = tp('A', -36.5, 147.0, 100);
    const B = tp('B', -36.5, 147.03, 100); // ~2.7 km leg
    const short = task([A, B]);
    const mid = destinationPoint(-36.5, 147.015, 2000, 0); // 2 km off a 2.7 km leg
    expect(describeThermalPlace(short, mid.lat, mid.lon)?.kind).toBe('off');
  });

  it('returns null for a task with no turnpoints', () => {
    expect(describeThermalPlace(task([]), 0, 0)).toBeNull();
  });
});

function describeAround(t: Turnpoint, m: number) {
  return [0, 90, 180, 270].map((b) => {
    const p = from(t, m, b);
    return describeThermalPlace(COURSE, p.lat, p.lon);
  });
}

describe('formatThermalPlace', () => {
  it('reads as the course is read', () => {
    expect(formatThermalPlace({ kind: 'at', turnpoint: 'B12' })).toBe('B12');
    expect(formatThermalPlace({ kind: 'near', turnpoint: 'B12' })).toBe('Near B12');
    expect(formatThermalPlace({ kind: 'between', from: 'B03', to: 'B04' })).toBe('Between B03 and B04');
    expect(
      formatThermalPlace({ kind: 'off', turnpoint: 'B12', distanceMeters: 4200, bearing: 50 }),
    ).toBe('4.2 km NE of B12');
  });

  it("honours the reader's distance unit", () => {
    const s = formatThermalPlace(
      { kind: 'off', turnpoint: 'B12', distanceMeters: 1609.344, bearing: 0 },
      { prefs: { speed: 'km/h', altitude: 'm', distance: 'mi', climbRate: 'm/s' } },
    );
    expect(s).toBe('1.0 mi N of B12');
  });
});

describe('projectOntoSegment', () => {
  it('finds the foot and the offset', () => {
    const r = projectOntoSegment(-36.48, 147.5, -36.5, 147.0, -36.5, 148.0);
    expect(r.fraction).toBeCloseTo(0.5, 2);
    expect(r.offsetMeters).toBeCloseTo(2220, -1);
  });

  it('says when the foot is beyond an end', () => {
    expect(projectOntoSegment(-36.5, 146.9, -36.5, 147.0, -36.5, 148.0).fraction).toBeLessThan(0);
    expect(projectOntoSegment(-36.5, 148.1, -36.5, 147.0, -36.5, 148.0).fraction).toBeGreaterThan(1);
  });

  it('copes with a zero-length segment', () => {
    const r = projectOntoSegment(-36.5, 147.01, -36.5, 147.0, -36.5, 147.0);
    expect(r.lengthMeters).toBe(0);
    expect(r.fraction).toBe(0);
  });
});
