import { describe, it, expect } from 'bun:test';
import { partitionPhases } from '../src/field-analysis';
import type { ThermalSegment } from '../src/event-types';
import type { CircleDetectionResult } from '../src/circle-detector';
import { createFix, TEST_ORIGIN, DEG_LON_PER_M } from './field-test-helpers';
import type { IGCFix } from '../src/igc-parser';

const NO_CIRCLES: CircleDetectionResult = { circlingSegments: [], circles: [], bearingRates: [] };

/**
 * A flight in three acts (fixes every 10 s):
 *   0–200 s   parked over one spot climbing (indices 0–20)  → thermal
 *   200–500 s running east at 20 m/s (indices 20–50)        → fast = glide
 *   500–800 s crawling east at 2 m/s (indices 50–80)        → slow = search
 */
function threeActFixes(): { fixes: IGCFix[]; thermal: ThermalSegment } {
  const fixes: IGCFix[] = [];
  let east = 0;
  for (let i = 0; i <= 80; i++) {
    const t = i * 10;
    if (i > 20 && i <= 50) east += 200; // 20 m/s over the 10 s step
    else if (i > 50) east += 20; // 2 m/s
    const alt = i <= 20 ? 1000 + i * 15 : 1300 - (i - 20) * 5;
    fixes.push(createFix(t, TEST_ORIGIN.lat, TEST_ORIGIN.lon + east * DEG_LON_PER_M, alt));
  }
  const thermal: ThermalSegment = {
    startIndex: 0,
    endIndex: 20,
    startAltitude: 1000,
    endAltitude: 1300,
    avgClimbRate: 1.5,
    duration: 200,
    location: { lat: TEST_ORIGIN.lat, lon: TEST_ORIGIN.lon },
  };
  return { fixes, thermal };
}

describe('partitionPhases', () => {
  it('classifies climb, glide and search and merges windows', () => {
    const { fixes, thermal } = threeActFixes();
    const phases = partitionPhases(fixes, [thermal], NO_CIRCLES, 0, 80);
    expect(phases.map((p) => p.phase)).toEqual(['climb', 'glide', 'search']);
    expect(phases[0].durationSeconds).toBeCloseTo(200, 6);
    expect(phases[1].durationSeconds).toBeCloseTo(300, 6);
    expect(phases[2].durationSeconds).toBeCloseTo(300, 6);
  });

  it('covers takeoff..landing exactly with boundary-sharing intervals', () => {
    const { fixes, thermal } = threeActFixes();
    const phases = partitionPhases(fixes, [thermal], NO_CIRCLES, 0, 80);
    expect(phases[0].startIndex).toBe(0);
    expect(phases[phases.length - 1].endIndex).toBe(80);
    for (let i = 1; i < phases.length; i++) {
      expect(phases[i].startIndex).toBe(phases[i - 1].endIndex);
    }
    const total = phases.reduce((s, p) => s + p.durationSeconds, 0);
    expect(total).toBeCloseTo(800, 6); // full takeoff→landing time, no double counting
  });

  it('classifies fast movement overlapping a circling segment as search, not glide', () => {
    const { fixes, thermal } = threeActFixes();
    const circling: CircleDetectionResult = {
      circlingSegments: [{ startIndex: 20, endIndex: 50, avgTurnRate: 12, duration: 300 }],
      circles: [],
      bearingRates: [],
    };
    const phases = partitionPhases(fixes, [thermal], circling, 0, 80);
    // The fast act now reads as circling → search; it merges with the slow act.
    expect(phases.map((p) => p.phase)).toEqual(['climb', 'search']);
    expect(phases[1].durationSeconds).toBeCloseTo(600, 6);
  });

  it('handles a flight with no thermals (all gap)', () => {
    const { fixes } = threeActFixes();
    const phases = partitionPhases(fixes, [], NO_CIRCLES, 0, 80);
    expect(phases[0].startIndex).toBe(0);
    expect(phases[phases.length - 1].endIndex).toBe(80);
    expect(phases.some((p) => p.phase === 'climb')).toBe(false);
  });

  it('returns [] for an empty or degenerate window', () => {
    expect(partitionPhases([], [], NO_CIRCLES, 0, 0)).toEqual([]);
    const { fixes } = threeActFixes();
    expect(partitionPhases(fixes, [], NO_CIRCLES, 50, 50)).toEqual([]);
  });
});
