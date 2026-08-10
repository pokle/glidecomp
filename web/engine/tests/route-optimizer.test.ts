/**
 * S7F 2026 §7.1 route-optimisation algorithm set (issue #599).
 *
 * Covers the pieces the corpus tests can't isolate:
 * - the §7.1.2 LTM projection (Annex A): the latitude-dependent scaling
 *   constants, round-trip accuracy, and the (0,0)-at-centre convention;
 * - §7.1.6.1/2 FindBoundingBox / FindCentrePointOfBox, including the
 *   antimeridian largest-gap rule;
 * - PathFinder's crossing / reflection / both-inside case split (§7.1.3,
 *   Ding et al. §3.1–§3.2) on synthetic geometries with known answers;
 * - the Annex B line-control-zone cases a/b/c;
 * - §7.1.7 ProjectionCorrection: every cylinder path point lands exactly on
 *   its boundary.
 *
 * Real-task verification lives in spec-distances.test.ts and
 * distance-corpus.test.ts, which assert parity with AirScore-published
 * distances over the bundled tasks and the archive.
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  createLtmProjection,
  ltmScaling,
  findBoundingBox,
  findCentrePointOfBox,
  findTaskAreaCentre,
  routeOptimizer,
  type GeodesicRouteDefinition,
} from '../src/route-optimizer';
import { ellipsoidDistance, destinationPoint } from '../src/geo';
import { calculateOptimizedTaskLine } from '../src/task-optimizer';
import { parseXCTask, type XCTask } from '../src/xctsk-parser';

const fixture = (name: string): XCTask =>
  parseXCTask(readFileSync(resolve(__dirname, 'fixtures', name), 'utf-8'));

describe('LTM scaling (§7.1.2)', () => {
  it('is 0.99994 up to |lat| = 55°', () => {
    expect(ltmScaling(0)).toBe(0.99994);
    expect(ltmScaling(-36.5)).toBe(0.99994);
    expect(ltmScaling(55)).toBe(0.99994);
  });

  it('grows linearly above 55°, on |lat| for both hemispheres', () => {
    expect(ltmScaling(61)).toBeCloseTo(0.99994 + (6 / 60) * 1.3e-4, 12);
    expect(ltmScaling(-61)).toBe(ltmScaling(61));
  });
});

describe('LTM projection (§7.1.2, Annex A)', () => {
  const centre = { lat: -36.5, lon: 147.2 }; // Australian alps, task country

  it('maps the centre point to (0, 0)', () => {
    const proj = createLtmProjection(centre.lat, centre.lon);
    const p = proj.toCartesian(centre.lat, centre.lon);
    expect(Math.abs(p.x)).toBeLessThan(1e-6);
    expect(Math.abs(p.y)).toBeLessThan(1e-6);
  });

  it('round-trips points across a 100 km task area to millimetres', () => {
    const proj = createLtmProjection(centre.lat, centre.lon);
    for (const bearingDeg of [0, 45, 90, 135, 180, 225, 270, 315]) {
      for (const dist of [1000, 25000, 100000]) {
        const p = destinationPoint(centre.lat, centre.lon, dist, (bearingDeg * Math.PI) / 180);
        const xy = proj.toCartesian(p.lat, p.lon);
        const back = proj.toGeodesic(xy.x, xy.y);
        expect(ellipsoidDistance(p.lat, p.lon, back.lat, back.lon)).toBeLessThan(5e-3);
      }
    }
  });

  it('applies the scale factor: planar distance ≈ 0.99994 × geodesic near the centre', () => {
    const proj = createLtmProjection(centre.lat, centre.lon);
    const a = destinationPoint(centre.lat, centre.lon, 5000, Math.PI / 2);
    const b = destinationPoint(centre.lat, centre.lon, 5000, -Math.PI / 2);
    const pa = proj.toCartesian(a.lat, a.lon);
    const pb = proj.toCartesian(b.lat, b.lon);
    const planar = Math.hypot(pa.x - pb.x, pa.y - pb.y);
    const geodesic = ellipsoidDistance(a.lat, a.lon, b.lat, b.lon);
    expect(Math.abs(planar / geodesic - 0.99994)).toBeLessThan(2e-5);
  });

  it('round-trips across the antimeridian', () => {
    const proj = createLtmProjection(-17.5, 179.9); // Fiji
    const p = { lat: -17.6, lon: -179.95 }; // 0.15° east of the centre, across ±180
    const xy = proj.toCartesian(p.lat, p.lon);
    expect(xy.x).toBeGreaterThan(10000); // east of the centre, not 38 000 km west
    const back = proj.toGeodesic(xy.x, xy.y);
    expect(ellipsoidDistance(p.lat, p.lon, back.lat, back.lon)).toBeLessThan(1e-3);
  });
});

describe('FindBoundingBox / FindCentrePointOfBox (§7.1.6)', () => {
  it('ordinary extent: min/max of lat and lon', () => {
    const box = findBoundingBox([
      { lat: -36, lon: 147 },
      { lat: -37, lon: 148.5 },
      { lat: -36.2, lon: 146.8 },
    ]);
    expect(box.sw).toEqual({ lat: -37, lon: 146.8 });
    expect(box.ne).toEqual({ lat: -36, lon: 148.5 });
    const c = findCentrePointOfBox(box);
    expect(c.lat).toBeCloseTo(-36.5, 10);
    expect(c.lon).toBeCloseTo(147.65, 10);
  });

  it('antimeridian: the largest-gap rule wraps the box through ±180', () => {
    const box = findBoundingBox([
      { lat: -17, lon: 179.5 },
      { lat: -17.5, lon: -179.5 },
    ]);
    expect(box.sw.lon).toBe(179.5);
    expect(box.ne.lon).toBe(-179.5);
    const c = findCentrePointOfBox(box);
    expect(Math.abs(c.lon)).toBe(180);
    expect(c.lat).toBeCloseTo(-17.25, 10);
  });
});

/** Points laid out east/north in metres from a base, on the real ellipsoid. */
function eastNorth(base: { lat: number; lon: number }, east: number, north: number) {
  const alongNorth = destinationPoint(base.lat, base.lon, Math.abs(north), north >= 0 ? 0 : Math.PI);
  return destinationPoint(
    alongNorth.lat,
    alongNorth.lon,
    Math.abs(east),
    east >= 0 ? Math.PI / 2 : -Math.PI / 2,
  );
}

const BASE = { lat: -36.5, lon: 147.2 };

function optimise(route: GeodesicRouteDefinition) {
  const centre = findTaskAreaCentre(route);
  return routeOptimizer(route, createLtmProjection(centre.lat, centre.lon));
}

describe('PathFinder case split (§7.1.3)', () => {
  it('crossing: a leg through a cylinder tags its FIRST intersection, at no extra distance', () => {
    const start = eastNorth(BASE, 0, 0);
    const mid = eastNorth(BASE, 10000, 0);
    const end = eastNorth(BASE, 20000, 0);
    const { path, distance } = optimise({
      startPoint: start,
      elements: [{ kind: 'cylinder', center: mid, radius: 1000 }],
      endPoint: end,
    });
    const straight = ellipsoidDistance(start.lat, start.lon, end.lat, end.lon);
    expect(Math.abs(distance - straight)).toBeLessThan(0.5);
    // The tag is the entry intersection — ~9 km from the start, on the chord.
    expect(ellipsoidDistance(start.lat, start.lon, path[1].lat, path[1].lon)).toBeCloseTo(
      straight / 2 - 1000,
      -1,
    );
  });

  it('reflection: a cylinder beside the leg is tagged at the bounce point', () => {
    const start = eastNorth(BASE, 0, 0);
    const mid = eastNorth(BASE, 10000, 5000); // 5 km north of the straight leg
    const end = eastNorth(BASE, 20000, 0);
    const { path, distance } = optimise({
      startPoint: start,
      elements: [{ kind: 'cylinder', center: mid, radius: 1000 }],
      endPoint: end,
    });
    // The tag sits on the boundary, on the leg-facing side of the circle.
    const tagToCentre = ellipsoidDistance(path[1].lat, path[1].lon, mid.lat, mid.lon);
    expect(Math.abs(tagToCentre - 1000)).toBeLessThan(0.01);
    const viaCentre =
      ellipsoidDistance(start.lat, start.lon, mid.lat, mid.lon) +
      ellipsoidDistance(mid.lat, mid.lon, end.lat, end.lon);
    expect(distance).toBeLessThan(viaCentre);
    expect(distance).toBeGreaterThan(viaCentre - 2 * 1000);
  });

  it('both neighbours inside: the path reaches OUT to the ring (Ding fig. 5d)', () => {
    // Start 1 km west and goal 1 km east of a 5 km ring's centre, with the
    // ring as the only control zone between them: the optimum leaves via the
    // near side, |A−P| + |P−B| = 4 000 + 6 000 = 10 000.
    const start = eastNorth(BASE, -1000, 0);
    const ring = eastNorth(BASE, 0, 0);
    const end = eastNorth(BASE, 1000, 0);
    const { path, distance } = optimise({
      startPoint: start,
      elements: [{ kind: 'cylinder', center: ring, radius: 5000 }],
      endPoint: end,
    });
    expect(Math.abs(distance - 10000)).toBeLessThan(1);
    expect(
      Math.abs(ellipsoidDistance(path[1].lat, path[1].lon, ring.lat, ring.lon) - 5000),
    ).toBeLessThan(0.01);
  });

  it('a zero-radius element is a fixed point on the path', () => {
    const start = eastNorth(BASE, 0, 0);
    const mid = eastNorth(BASE, 5000, 3000);
    const end = eastNorth(BASE, 10000, 0);
    const { path } = optimise({
      startPoint: start,
      elements: [{ kind: 'cylinder', center: mid, radius: 0 }],
      endPoint: end,
    });
    expect(ellipsoidDistance(path[1].lat, path[1].lon, mid.lat, mid.lon)).toBeLessThan(1e-6);
  });
});

describe('Annex B: line control zones', () => {
  it('case a: the direct leg crosses the line — tag at the crossing', () => {
    const start = eastNorth(BASE, 0, -2000);
    const end = eastNorth(BASE, 0, 2000);
    const line = {
      kind: 'line' as const,
      point1: eastNorth(BASE, -1500, 0),
      point2: eastNorth(BASE, 1500, 0),
    };
    const { path, distance } = optimise({ startPoint: start, elements: [line], endPoint: end });
    expect(Math.abs(distance - 4000)).toBeLessThan(1);
    // Crossing at the line's midpoint.
    expect(ellipsoidDistance(path[1].lat, path[1].lon, BASE.lat, BASE.lon)).toBeLessThan(2);
  });

  it('case b: both neighbours on one side — tag at the mirror crossing', () => {
    // A at (0,0), B at (4000,0), line y=2000 for x ∈ [1000, 3000]. B mirrors
    // to (4000, 4000); A–B′ crosses y=2000 at x=2000: total = |A−B′| = 4000√2.
    const start = eastNorth(BASE, 0, 0);
    const end = eastNorth(BASE, 4000, 0);
    const line = {
      kind: 'line' as const,
      point1: eastNorth(BASE, 1000, 2000),
      point2: eastNorth(BASE, 3000, 2000),
    };
    const { path, distance } = optimise({ startPoint: start, elements: [line], endPoint: end });
    expect(Math.abs(distance - 4000 * Math.SQRT2)).toBeLessThan(1);
    const expected = eastNorth(BASE, 2000, 2000);
    expect(ellipsoidDistance(path[1].lat, path[1].lon, expected.lat, expected.lon)).toBeLessThan(2);
  });

  it('case c: neither crossing exists — the cheaper endpoint wins', () => {
    // Line off to the north-east; the best route bends at its nearer end.
    const start = eastNorth(BASE, 0, 0);
    const end = eastNorth(BASE, 4000, 0);
    const p1 = eastNorth(BASE, 4500, 2000);
    const p2 = eastNorth(BASE, 6500, 2000);
    const { path, distance } = optimise({
      startPoint: start,
      elements: [{ kind: 'line', point1: p1, point2: p2 }],
      endPoint: end,
    });
    expect(ellipsoidDistance(path[1].lat, path[1].lon, p1.lat, p1.lon)).toBeLessThan(2);
    const viaP1 =
      ellipsoidDistance(start.lat, start.lon, p1.lat, p1.lon) +
      ellipsoidDistance(p1.lat, p1.lon, end.lat, end.lon);
    expect(Math.abs(distance - viaP1)).toBeLessThan(1);
  });

  it('terminal line: tagged at the closest point from the incoming leg (B.1.2)', () => {
    const start = eastNorth(BASE, 0, 0);
    const line = {
      kind: 'line' as const,
      point1: eastNorth(BASE, -1500, 5000),
      point2: eastNorth(BASE, 1500, 5000),
    };
    const { path, distance } = optimise({ startPoint: start, elements: [line] });
    expect(Math.abs(distance - 5000)).toBeLessThan(1);
    const expected = eastNorth(BASE, 0, 5000);
    expect(ellipsoidDistance(path[1].lat, path[1].lon, expected.lat, expected.lon)).toBeLessThan(2);
  });
});

describe('ProjectionCorrection (§7.1.7)', () => {
  it('every cylinder tag of a real task lies exactly on its boundary', () => {
    const task = fixture('corryong-cup-2022-open-t1.xctsk');
    const line = calculateOptimizedTaskLine(task);
    // Skip index 0: the launch is measured from its centre (§7.2).
    for (let i = 1; i < task.turnpoints.length; i++) {
      const tp = task.turnpoints[i];
      const d = ellipsoidDistance(line[i].lat, line[i].lon, tp.waypoint.lat, tp.waypoint.lon);
      expect(Math.abs(d - tp.radius)).toBeLessThan(0.01);
    }
  });
});
