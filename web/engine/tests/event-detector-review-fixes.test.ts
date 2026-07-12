import { describe, it, expect } from 'bun:test';
import { detectFlightEvents, type GlideEventDetails } from '../src/event-detector';
import { extractSinks, extractGlides } from '../src/segment-extractors';
import { createFix, type IGCFix } from './test-helpers';

/**
 * Regression tests for the event-detection findings in
 * docs/2026-07-12-web-engine-code-review.md §2 "Event detection".
 */

describe('Glide ratio convention (no Infinity)', () => {
  /**
   * A flight whose single glide gains altitude: takeoff, then a long straight
   * segment climbing gently at ~0.3 m/s — below the 0.5 m/s thermal threshold,
   * so it stays a glide, but with net altitude GAIN.
   */
  function createClimbingGlideTrack(): IGCFix[] {
    const fixes: IGCFix[] = [];

    // Stationary pre-flight
    for (let i = 0; i < 10; i++) {
      fixes.push(createFix(i, 47.0, 11.0, 1000));
    }

    // Takeoff: fast movement with a brief climb
    for (let i = 0; i < 10; i++) {
      fixes.push(createFix(10 + i, 47.0 + i * 0.0002, 11.0 + i * 0.0002, 1000 + i * 3));
    }

    // Straight "glide" through lifting air: 10 minutes at 5 s intervals,
    // fast ground speed, climbing ~0.3 m/s (below thermal threshold)
    for (let i = 0; i < 120; i++) {
      fixes.push(createFix(20 + i * 5, 47.002 + i * 0.001, 11.002 + i * 0.001, 1030 + i * 1.5));
    }

    return fixes;
  }

  it('reports glideRatio as undefined (not Infinity) when altitude was gained', () => {
    const events = detectFlightEvents(createClimbingGlideTrack());

    const glideStarts = events.filter(e => e.type === 'glide_start');
    expect(glideStarts.length).toBeGreaterThanOrEqual(1);

    for (const glideStart of glideStarts) {
      const details = glideStart.details as GlideEventDetails;
      // The climbing glide must not produce Infinity — it becomes null through
      // JSON.stringify and "L/D Infinity" in descriptions
      if (details.glideRatio !== undefined) {
        expect(Number.isFinite(details.glideRatio)).toBe(true);
      }
      expect(glideStart.description).not.toContain('Infinity');
    }

    // At least one glide has net gain → undefined ratio
    const climbing = glideStarts.filter(
      e => (e.details as GlideEventDetails).glideRatio === undefined
    );
    expect(climbing.length).toBeGreaterThanOrEqual(1);
    expect(climbing[0].description).toBe('Glide start (altitude gained)');
  });

  it('survives JSON round-trips without turning the ratio into null', () => {
    const events = detectFlightEvents(createClimbingGlideTrack());
    const glideStart = events.find(e => e.type === 'glide_start')!;

    const roundTripped = JSON.parse(JSON.stringify(glideStart.details));
    // undefined is dropped by JSON.stringify; it must never appear as null
    expect(roundTripped.glideRatio).not.toBe(null);
  });

  it('never classifies a climbing glide as a sink', () => {
    const events = detectFlightEvents(createClimbingGlideTrack());

    const glides = extractGlides(events);
    expect(glides.length).toBeGreaterThanOrEqual(1);

    const sinks = extractSinks(events);
    // The climbing glide (missing ratio) must not fall into the sink bucket
    for (const sink of sinks) {
      expect((sink.sourceEvent.details as GlideEventDetails).glideRatio).toBeDefined();
    }
  });
});

describe('Landing detection at low fix rates', () => {
  it('detects a landing that happens within the first landingTimeWindow fixes (10 s logging)', () => {
    const fixes: IGCFix[] = [];
    const interval = 10; // seconds between fixes — landingTimeWindow (30 s) spans only 3 fixes

    // Stationary pre-flight: indices 0-4
    for (let i = 0; i < 5; i++) {
      fixes.push(createFix(i * interval, 47.0, 11.0, 1200));
    }
    // Flying: fast movement, descending — indices 5-19
    for (let i = 0; i < 15; i++) {
      fixes.push(createFix((5 + i) * interval, 47.001 + i * 0.001, 11.001 + i * 0.001, 1180 - i * 60));
    }
    // Landed, stationary: indices 20-25
    for (let i = 0; i < 6; i++) {
      fixes.push(createFix((20 + i) * interval, 47.016, 11.016, 280));
    }

    const events = detectFlightEvents(fixes);

    // The old loop bound (i >= landingTimeWindow, i.e. index 30) never ran for
    // this 26-fix track and silently returned no landing
    const landing = events.find(e => e.type === 'landing');
    expect(landing).toBeDefined();

    // Landing should be at/near the last flying fix (index 19, t = 190 s) —
    // the backward scan stops within one lookback window of it
    const landingOffsetSeconds =
      (landing!.time.getTime() - fixes[0].time.getTime()) / 1000;
    expect(landingOffsetSeconds).toBeGreaterThanOrEqual(15 * interval);
    expect(landingOffsetSeconds).toBeLessThanOrEqual(22 * interval);
  });
});

describe('Takeoff rejection of isolated GPS spikes', () => {
  it('does not detect a takeoff from two isolated speed spikes while grounded', () => {
    const fixes: IGCFix[] = [];

    // 4 minutes stationary on the ground at 1 s logging, with two isolated
    // single-fix GPS spikes (~220 m out-and-back) that produce two fast
    // fix-pair speeds each
    for (let i = 0; i < 240; i++) {
      const isSpike = i === 50 || i === 120;
      const lat = isSpike ? 47.002 : 47.0;
      fixes.push(createFix(i, lat, 11.0, 500));
    }

    const events = detectFlightEvents(fixes);
    expect(events.find(e => e.type === 'takeoff')).toBeUndefined();
  });

  it('still detects a genuine takeoff with sustained movement', () => {
    const fixes: IGCFix[] = [];

    for (let i = 0; i < 60; i++) {
      fixes.push(createFix(i, 47.0, 11.0, 500));
    }
    // Real takeoff: sustained fast movement and climb
    for (let i = 0; i < 60; i++) {
      fixes.push(createFix(60 + i, 47.0 + i * 0.0002, 11.0 + i * 0.0002, 500 + i * 2));
    }

    const events = detectFlightEvents(fixes);
    const takeoff = events.find(e => e.type === 'takeoff');
    expect(takeoff).toBeDefined();

    const takeoffOffsetSeconds =
      (takeoff!.time.getTime() - fixes[0].time.getTime()) / 1000;
    expect(takeoffOffsetSeconds).toBeGreaterThanOrEqual(55);
    expect(takeoffOffsetSeconds).toBeLessThanOrEqual(70);
  });
});

describe('Thermal entry/exit event coordinates', () => {
  // Intentional (Tushar, 2026-07-12): both events carry the thermal centroid
  // so markers point at the thermal itself, not the trigger fixes.
  it('places entry/exit events at the thermal centroid', () => {
    const fixes: IGCFix[] = [];

    // Takeoff
    for (let i = 0; i < 10; i++) {
      fixes.push(createFix(i, 47.0 + i * 0.001, 11.0, 500 + i * 20));
    }
    // Drifting thermal: circling while the whole circle moves downwind,
    // so the centroid is far from both the entry and the exit fix
    for (let i = 0; i < 60; i++) {
      const angle = (i / 60) * 2 * Math.PI * 5;
      fixes.push(createFix(
        10 + i * 5,
        47.01 + Math.sin(angle) * 0.001 + i * 0.0005, // drift north
        11.0 + Math.cos(angle) * 0.001,
        700 + i * 15
      ));
    }
    // Trailing glide
    for (let i = 0; i < 60; i++) {
      fixes.push(createFix(310 + i * 5, 47.04 + i * 0.002, 11.0 + i * 0.002, 1600 - i * 15));
    }

    const events = detectFlightEvents(fixes);

    const entry = events.find(e => e.type === 'thermal_entry');
    const exit = events.find(e => e.type === 'thermal_exit');
    expect(entry).toBeDefined();
    expect(exit).toBeDefined();

    // Entry and exit share the centroid position
    expect(entry!.latitude).toBe(exit!.latitude);
    expect(entry!.longitude).toBe(exit!.longitude);

    // The centroid is the mean of the segment's fixes
    const { startIndex, endIndex } = entry!.segment!;
    let sumLat = 0;
    let sumLon = 0;
    for (let i = startIndex; i <= endIndex; i++) {
      sumLat += fixes[i].latitude;
      sumLon += fixes[i].longitude;
    }
    const count = endIndex - startIndex + 1;
    expect(entry!.latitude).toBeCloseTo(sumLat / count, 10);
    expect(entry!.longitude).toBeCloseTo(sumLon / count, 10);
  });
});
