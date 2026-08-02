import { describe, it, expect } from 'bun:test';
import {
  evaluateField,
  extractThermalShapes,
  type ThermalShapePilot,
} from '../src/field-analysis';
import type { ThermalSegment } from '../src/event-types';
import type { IGCFix } from '../src/igc-parser';
import {
  createFix,
  makeTestField,
  TEST_ORIGIN,
  DEG_LAT_PER_M,
  DEG_LON_PER_M,
} from './field-test-helpers';

/**
 * Synthetic climb through a thermal with KNOWN geometry, so the extraction's
 * measured core axis, lean and asymmetry can be checked against ground truth.
 *
 * The pilot circles at `circleRadius` around a core whose horizontal position
 * moves east with altitude at `leanEastPerMetre` (a column leaning toward
 * 090°). The climb rate depends on which side of the core the pilot is:
 * strongest due east of the core, weakest due west
 * (vario = base + amplitude*cos(bearing-90°)), so the east sector must come
 * out strongest. One fix per second; altitude integrates the vario.
 */
function spiralPilot(opts: {
  startSeconds: number;
  durationSeconds: number;
  startAltitude: number;
  eastOffset?: number; // where the pilot's own circle centre sits (m east)
  leanEastPerMetre?: number;
  label?: string;
}): ThermalShapePilot {
  const {
    startSeconds,
    durationSeconds,
    startAltitude,
    eastOffset = 0,
    leanEastPerMetre = 0.3,
  } = opts;
  const circleRadius = 80;
  const degPerSecond = 18; // 20 s per circle
  const fixes: IGCFix[] = [];
  let altitude = startAltitude;
  for (let t = 0; t < durationSeconds; t++) {
    const phase = ((t * degPerSecond) % 360) * (Math.PI / 180);
    const coreEast = eastOffset + (altitude - startAltitude) * leanEastPerMetre;
    const east = coreEast + circleRadius * Math.sin(phase);
    const north = circleRadius * Math.cos(phase);
    // Bearing of the pilot from the core; lift peaks due east (090°).
    const bearing = Math.atan2(east - coreEast, north) * (180 / Math.PI);
    const vario = 2 + 1.5 * Math.cos(((bearing - 90) * Math.PI) / 180);
    altitude += vario; // dt = 1 s
    fixes.push(createFix(
      startSeconds + t,
      TEST_ORIGIN.lat + north * DEG_LAT_PER_M,
      TEST_ORIGIN.lon + east * DEG_LON_PER_M,
      altitude,
    ));
  }
  const thermal: ThermalSegment = {
    startIndex: 0,
    endIndex: fixes.length - 1,
    startAltitude: fixes[0].gnssAltitude,
    endAltitude: fixes[fixes.length - 1].gnssAltitude,
    avgClimbRate: 2,
    duration: durationSeconds,
    location: {
      lat: TEST_ORIGIN.lat,
      lon: TEST_ORIGIN.lon + eastOffset * DEG_LON_PER_M,
    },
  };
  return { fixes, thermals: [thermal], circles: [], label: opts.label ?? 'pilot' };
}

describe('extractThermalShapes', () => {
  it('recovers core axis, lean and strongest side from a known synthetic thermal', () => {
    // Three pilots through the same leaning column at staggered times, so
    // altitude and time decorrelate across the pool.
    const pilots = [
      spiralPilot({ startSeconds: 0, durationSeconds: 400, startAltitude: 1000, label: 'a' }),
      spiralPilot({ startSeconds: 120, durationSeconds: 400, startAltitude: 1000, label: 'b' }),
      spiralPilot({ startSeconds: 240, durationSeconds: 400, startAltitude: 1000, label: 'c' }),
    ];
    const shapes = extractThermalShapes(pilots);
    expect(shapes.length).toBe(1);
    const shape = shapes[0];
    expect(shape.pilotCount).toBe(3);
    expect(shape.useCount).toBe(3);
    expect(shape.bands.length).toBeGreaterThanOrEqual(6);

    // Band cores should follow the known lean: east grows with altitude at
    // ~0.3 m/m, north stays ~0. Sampling bias (the pilot spends longer in
    // lift) shifts the lift-weighted core a little east of the true core, so
    // the tolerance is loose in absolute terms but tight relative to the
    // 80 m circle radius.
    const alt0 = 1000;
    for (const b of shape.bands) {
      const expectedEast = (b.altMid - alt0) * 0.3;
      expect(Math.abs(b.core.east - expectedEast)).toBeLessThan(40);
      expect(Math.abs(b.core.north)).toBeLessThan(40);
      // The pilot flies a fixed 80 m circle; the measured working radius
      // must be in that neighbourhood, not collapsed or inflated.
      expect(b.coreRadius).toBeGreaterThan(30);
      expect(b.extentRadius).toBeLessThan(200);
    }

    // Lean: toward 090° at ~0.3 m/m.
    expect(shape.lean).not.toBeNull();
    expect(Math.abs(shape.lean!.bearing - 90)).toBeLessThan(20);
    expect(shape.lean!.metresPerMetre).toBeGreaterThan(0.15);
    expect(shape.lean!.metresPerMetre).toBeLessThan(0.45);

    // Strongest side: due east of the core (090° sector, allow a neighbour).
    expect(shape.strongestSide).not.toBeNull();
    const sideDelta = Math.abs(((shape.strongestSide!.bearing - 90 + 540) % 360) - 180);
    expect(sideDelta).toBeLessThanOrEqual(45);
    // East must beat west decisively (true contrast is 3.5 vs 0.5 m/s).
    expect(shape.strongestSide!.meanVario).toBeGreaterThan(
      (shape.strongestSide!.oppositeMeanVario ?? 0) + 1,
    );
  });

  it('reports each pilot\'s climb range, parallel to the pilot labels', () => {
    const pilots = [
      spiralPilot({ startSeconds: 0, durationSeconds: 400, startAltitude: 1000, label: 'a' }),
      spiralPilot({ startSeconds: 120, durationSeconds: 400, startAltitude: 1000, label: 'b' }),
    ];
    const shapes = extractThermalShapes(pilots);
    expect(shapes.length).toBe(1);
    const shape = shapes[0];
    expect(shape.pilotClimbs).toHaveLength(shape.pilots.length);
    for (const climb of shape.pilotClimbs!) {
      // The synthetic vario is base 2 ± 1.5 m/s around the circle; smoothing
      // narrows the extremes, so bound loosely but keep the ordering strict.
      expect(climb.samples).toBeGreaterThan(0);
      expect(climb.minVario).toBeLessThanOrEqual(climb.medianVario);
      expect(climb.medianVario).toBeLessThanOrEqual(climb.maxVario);
      expect(climb.medianVario).toBeGreaterThan(1);
      expect(climb.medianVario).toBeLessThan(3);
      expect(climb.maxVario).toBeLessThanOrEqual(3.5);
      expect(climb.minVario).toBeGreaterThanOrEqual(0.5);
    }
  });

  it('keeps two simultaneous but distant thermals apart', () => {
    const pilots = [
      spiralPilot({ startSeconds: 0, durationSeconds: 300, startAltitude: 1000, label: 'a' }),
      spiralPilot({ startSeconds: 0, durationSeconds: 300, startAltitude: 1000, eastOffset: 2500, label: 'b' }),
    ];
    const shapes = extractThermalShapes(pilots);
    expect(shapes.length).toBe(2);
    expect(shapes[0].pilotCount).toBe(1);
    expect(shapes[1].pilotCount).toBe(1);
  });

  it('splits a transitively chained ridge line into separate columns', () => {
    // Six pilots at 400 m spacing: each neighbour pair links (< 800 m), so
    // union-find chains all six into one 2 km cluster. The splitter must cut
    // it back down; no resulting shape may span anywhere near 2 km.
    const pilots = Array.from({ length: 6 }, (_, i) =>
      spiralPilot({
        startSeconds: 0,
        durationSeconds: 300,
        startAltitude: 1000,
        eastOffset: i * 400,
        label: `p${i}`,
      }),
    );
    const shapes = extractThermalShapes(pilots);
    expect(shapes.length).toBeGreaterThanOrEqual(2);
    for (const shape of shapes) {
      // Cluster extent check via band cores: the widest spread of band core
      // east positions must stay well under the chained 2 km.
      const coreEasts = shape.bands.map((b) => b.core.east);
      expect(Math.max(...coreEasts) - Math.min(...coreEasts)).toBeLessThan(1200);
    }
  });

  it('rides the field-analysis report as report.thermals (real detectors)', () => {
    // Two pilots spiralling up the same column at overlapping times, through
    // the REAL foundation pass — detectors find the thermals, evaluateField
    // summarises the shapes into the report.
    const a = spiralPilot({ startSeconds: 0, durationSeconds: 500, startAltitude: 1000, label: 'a' });
    const b = spiralPilot({ startSeconds: 200, durationSeconds: 500, startAltitude: 1000, label: 'b' });
    const field = makeTestField([
      { name: 'a', fixes: a.fixes },
      { name: 'b', fixes: b.fixes },
    ]);
    const report = evaluateField(field);
    expect(report.thermals).toBeDefined();
    expect(report.thermals!.shapes.length).toBeGreaterThanOrEqual(1);
    expect(report.thermals!.totalShapeCount).toBeGreaterThanOrEqual(report.thermals!.shapes.length);
    const shape = report.thermals!.shapes[0];
    expect(shape.pilotCount).toBe(2);
    expect(shape.bands.length).toBeGreaterThanOrEqual(3);
    // Summaries never carry the point cloud.
    expect('samples' in shape).toBe(false);
  });

  it('splits an all-afternoon house thermal into episodes', () => {
    // One location used continuously for 80 minutes by overlapping pilots.
    const pilots = Array.from({ length: 8 }, (_, i) =>
      spiralPilot({
        startSeconds: i * 600,
        durationSeconds: 660, // overlaps the next pilot by 60 s
        startAltitude: 1000,
        label: `p${i}`,
      }),
    );
    const shapes = extractThermalShapes(pilots);
    expect(shapes.length).toBeGreaterThanOrEqual(2);
    for (const shape of shapes) {
      expect((shape.endMs - shape.startMs) / 1000).toBeLessThanOrEqual(3600);
    }
  });
});
