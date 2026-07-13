// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

import { describe, it, expect } from 'vitest';
import { convexHullXZ, roundedHullOutline, type Pt } from './gaggle-hull';

const p = (x: number, z: number): Pt => ({ x, z });

describe('convexHullXZ', () => {
  it('returns the 4 corners of a square (interior points dropped)', () => {
    const hull = convexHullXZ([p(0, 0), p(2, 0), p(2, 2), p(0, 2), p(1, 1)]);
    expect(hull).toHaveLength(4);
    expect(new Set(hull.map((h) => `${h.x},${h.z}`))).toEqual(
      new Set(['0,0', '2,0', '2,2', '0,2']),
    );
  });

  it('drops collinear points on an edge', () => {
    const hull = convexHullXZ([p(0, 0), p(1, 0), p(2, 0), p(2, 2), p(0, 2)]);
    // the midpoint (1,0) is collinear on the bottom edge → excluded
    expect(hull).toHaveLength(4);
    expect(hull.some((h) => h.x === 1 && h.z === 0)).toBe(false);
  });

  it('de-duplicates coincident points', () => {
    const hull = convexHullXZ([p(0, 0), p(0, 0), p(2, 0), p(2, 0), p(1, 2)]);
    expect(hull).toHaveLength(3);
  });

  it('returns the unique points when fewer than three', () => {
    expect(convexHullXZ([p(0, 0), p(1, 1)])).toHaveLength(2);
    expect(convexHullXZ([p(5, 5)])).toHaveLength(1);
    expect(convexHullXZ([])).toHaveLength(0);
  });

  it('winds counter-clockwise (positive signed area)', () => {
    const h = convexHullXZ([p(0, 0), p(2, 0), p(2, 2), p(0, 2)]);
    let area = 0;
    for (let i = 0; i < h.length; i++) {
      const a = h[i];
      const b = h[(i + 1) % h.length];
      area += a.x * b.z - b.x * a.z;
    }
    expect(area).toBeGreaterThan(0);
  });
});

describe('roundedHullOutline', () => {
  const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.z - b.z);

  it('wraps a single point as a circle of radius pad', () => {
    const ring = roundedHullOutline([p(0, 0)], 10);
    expect(ring.length).toBeGreaterThan(8);
    for (const pt of ring) expect(dist(pt, p(0, 0))).toBeCloseTo(10, 3);
  });

  it('wraps two points as a capsule (every vertex is pad from the segment)', () => {
    const a = p(0, 0);
    const b = p(100, 0);
    const ring = roundedHullOutline([a, b], 10);
    expect(ring.length).toBeGreaterThan(8);
    for (const pt of ring) {
      // distance to the segment a–b: along the segment x∈[0,100] it's |z|
      const onSeg = pt.x >= 0 && pt.x <= 100;
      const d = onSeg ? Math.abs(pt.z) : Math.min(dist(pt, a), dist(pt, b));
      expect(d).toBeLessThanOrEqual(10 + 1e-6);
      expect(d).toBeGreaterThanOrEqual(10 - 1e-6);
    }
  });

  it('produces an outline strictly outside the hull for a triangle', () => {
    const ring = roundedHullOutline([p(0, 0), p(100, 0), p(50, 100)], 8);
    // every outline point sits ~8 m outside; centroid stays interior
    const cx = 50;
    const cz = 33.3;
    for (const pt of ring) {
      expect(dist(pt, { x: cx, z: cz })).toBeGreaterThan(8);
    }
    // the ring encloses more area than the bare triangle
    const area = (pts: Pt[]) => {
      let s = 0;
      for (let i = 0; i < pts.length; i++) {
        const u = pts[i];
        const v = pts[(i + 1) % pts.length];
        s += u.x * v.z - v.x * u.z;
      }
      return Math.abs(s) / 2;
    };
    expect(area(ring)).toBeGreaterThan(area([p(0, 0), p(100, 0), p(50, 100)]));
  });
});
