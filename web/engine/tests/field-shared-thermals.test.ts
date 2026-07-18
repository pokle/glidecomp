import { describe, it, expect } from 'bun:test';
import { clusterSharedThermals } from '../src/field-analysis';
import type { ThermalSegment } from '../src/event-types';
import { createFix, TEST_ORIGIN, DEG_LAT_PER_M } from './field-test-helpers';
import type { IGCFix } from '../src/igc-parser';

/**
 * Build a pilot whose fixes span [startSeconds, endSeconds] (one fix per 10 s)
 * and one ThermalSegment covering the whole span at the given offset north of
 * TEST_ORIGIN.
 */
function pilotWithThermal(
  startSeconds: number,
  endSeconds: number,
  northMeters: number,
  avgClimbRate = 1.5,
): { thermals: ThermalSegment[]; fixes: IGCFix[] } {
  const lat = TEST_ORIGIN.lat + northMeters * DEG_LAT_PER_M;
  const fixes: IGCFix[] = [];
  for (let t = startSeconds; t <= endSeconds; t += 10) {
    fixes.push(createFix(t, lat, TEST_ORIGIN.lon, 1000 + (t - startSeconds)));
  }
  const thermal: ThermalSegment = {
    startIndex: 0,
    endIndex: fixes.length - 1,
    startAltitude: fixes[0].gnssAltitude,
    endAltitude: fixes[fixes.length - 1].gnssAltitude,
    avgClimbRate,
    duration: endSeconds - startSeconds,
    location: { lat, lon: TEST_ORIGIN.lon },
  };
  return { thermals: [thermal], fixes };
}

describe('clusterSharedThermals', () => {
  it('clusters two pilots circling 300 m apart at the same time', () => {
    const shared = clusterSharedThermals([
      pilotWithThermal(0, 120, 0),
      pilotWithThermal(60, 180, 300),
    ]);
    expect(shared.length).toBe(1);
    expect(shared[0].pilotCount).toBe(2);
    expect(shared[0].uses.length).toBe(2);
    expect(shared[0].startMs).toBeLessThanOrEqual(shared[0].endMs);
  });

  it('does not cluster pilots 2 km apart', () => {
    const shared = clusterSharedThermals([
      pilotWithThermal(0, 120, 0),
      pilotWithThermal(0, 120, 2000),
    ]);
    expect(shared.length).toBe(2);
    expect(shared.every((s) => s.pilotCount === 1)).toBe(true);
  });

  it('does not cluster the same spot 10 minutes apart', () => {
    const shared = clusterSharedThermals([
      pilotWithThermal(0, 120, 0),
      pilotWithThermal(720, 840, 0), // 600 s after the first ends
    ]);
    expect(shared.length).toBe(2);
  });

  it('bridges a gap within maxGapSeconds (thermal cycling)', () => {
    const shared = clusterSharedThermals([
      pilotWithThermal(0, 120, 0),
      pilotWithThermal(200, 320, 100), // 80 s gap, 100 m away
    ]);
    expect(shared.length).toBe(1);
    expect(shared[0].pilotCount).toBe(2);
  });

  it('keeps singletons (the marker-usage denominator needs them)', () => {
    const shared = clusterSharedThermals([pilotWithThermal(0, 120, 0)]);
    expect(shared.length).toBe(1);
    expect(shared[0].pilotCount).toBe(1);
    expect(shared[0].uses[0].avgClimbRate).toBe(1.5);
    expect(shared[0].uses[0].gainMeters).toBe(120);
  });

  it('records use metadata and sorts clusters chronologically', () => {
    const shared = clusterSharedThermals([
      pilotWithThermal(900, 1020, 5000), // later, far away
      pilotWithThermal(0, 120, 0, 2.5),
    ]);
    expect(shared.length).toBe(2);
    expect(shared[0].startMs).toBeLessThan(shared[1].startMs);
    expect(shared[0].id).toBe(0);
    expect(shared[1].id).toBe(1);
    // The early thermal belongs to pilot index 1 (second in the input array).
    expect(shared[0].uses[0].pilotIndex).toBe(1);
    expect(shared[0].uses[0].avgClimbRate).toBe(2.5);
    expect(shared[0].uses[0].entryAltitude).toBe(1000);
    expect(shared[0].uses[0].exitAltitude).toBe(1120);
  });
});
