import { describe, it, expect } from 'bun:test';
import { detectThermals } from '../src/flight-phase-detectors';
import { fixAltitude, type IGCFix } from '../src/igc-parser';
import { estimateWorkingBand } from '../src/field-analysis/working-band';
import { DEFAULT_THRESHOLDS } from '../src/thresholds';
import type { ThermalSegment } from '../src/event-types';
import { createFix } from './test-helpers';

/** A steady 1.5 m/s climb from `startAlt`, one fix per second. */
function climbFixes(seconds: number, startAlt: number): IGCFix[] {
  const fixes: IGCFix[] = [];
  for (let t = 0; t <= seconds; t++) {
    fixes.push(createFix(t, -36.5 + t * 1e-5, 148.2 + t * 1e-5, startAlt + t * 1.5));
  }
  return fixes;
}

describe('fixAltitude', () => {
  it('prefers GNSS, falls back to pressure on the zero sentinel', () => {
    expect(fixAltitude({ ...createFix(0, 0, 0, 900), gnssAltitude: 950 })).toBe(950);
    expect(fixAltitude({ ...createFix(0, 0, 0, 900), gnssAltitude: 0 })).toBe(900);
  });
});

describe('thermal segment altitudes under GNSS dropout', () => {
  it('a zero-GNSS boundary fix reads its pressure altitude, not sea level', () => {
    const fixes = climbFixes(120, 800);
    // Kill the GNSS altitude on the fix the detector will use as the thermal
    // entry (the window start) — the classic dropout shape.
    const clean = detectThermals(fixes, DEFAULT_THRESHOLDS);
    expect(clean.length).toBe(1);
    const entryIdx = clean[0].startIndex;

    const dropped = fixes.map((f, i) =>
      i === entryIdx ? { ...f, gnssAltitude: 0 } : f,
    );
    const thermals = detectThermals(dropped, DEFAULT_THRESHOLDS);
    expect(thermals.length).toBe(1);
    // Pressure altitude on that fix is the true ~800 m entry; before the
    // fixAltitude guard this read 0 and dragged the field working band's
    // p10 floor toward sea level.
    expect(thermals[0].startAltitude).toBe(fixes[entryIdx].pressureAltitude);
    expect(thermals[0].startAltitude).toBeGreaterThan(700);
  });
});

describe('estimateWorkingBand fix-altitude fallback', () => {
  const noThermals: ThermalSegment[] = [];

  /** Ground logging at `groundAlt`, then a flight between 1200–1800 m, then
   * ground again — the shape a real logger records. */
  function trackWithGroundTails(groundAlt: number): IGCFix[] {
    const fixes: IGCFix[] = [];
    let t = 0;
    for (; t < 300; t++) fixes.push(createFix(t, -36.5, 148.2, groundAlt));
    for (let i = 0; i < 600; i++, t++) {
      fixes.push(createFix(t, -36.5 + i * 1e-5, 148.2, 1200 + (i % 100) * 6));
    }
    for (let i = 0; i < 300; i++, t++) fixes.push(createFix(t, -36.51, 148.2, groundAlt));
    return fixes;
  }

  it('restricts to the airborne range when takeoff/landing indices are given', () => {
    const fixes = trackWithGroundTails(300);
    const band = estimateWorkingBand([
      { thermals: noThermals, fixes, takeoffIndex: 300, landingIndex: 900 },
    ]);
    expect(band.usedFallback).toBe(true);
    // Airborne altitudes span 1200–1794 m; a floor at ground elevation would
    // mean the pre-takeoff logging leaked in.
    expect(band.floorMeters).toBeGreaterThanOrEqual(1200);
    expect(band.ceilingMeters).toBeLessThanOrEqual(1794);
  });

  it('without the indices, ground logging drags the floor down (the old behaviour)', () => {
    const fixes = trackWithGroundTails(300);
    const band = estimateWorkingBand([{ thermals: noThermals, fixes }]);
    expect(band.usedFallback).toBe(true);
    expect(band.floorMeters).toBeLessThan(1200);
  });
});
