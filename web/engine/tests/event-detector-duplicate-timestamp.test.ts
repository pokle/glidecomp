import { describe, it, expect } from 'bun:test';
import { detectFlightEvents } from '../src/event-detector';
import { createFixAt, type IGCFix } from './test-helpers';

/**
 * Regression test for the duplicate-timestamp takeoff slice bug.
 *
 * detectFlightEvents used to re-derive the takeoff fix index by scanning for
 * the first fix whose timestamp matches the takeoff event's timestamp:
 *
 *   const takeoffIndex = fixes.findIndex(
 *     f => f.time.getTime() === takeoffEvent.time.getTime()
 *   );
 *
 * Cheap GPS loggers stall and emit several fixes with identical timestamps.
 * When a pre-takeoff fix shared the takeoff fix's timestamp, findIndex
 * returned the earlier index. The downstream slice then began at fix 0,
 * silently feeding pre-takeoff data (e.g. a stalled climb) into thermal /
 * glide / altitude detection and producing spurious events.
 *
 * The fix is to use takeoffEvent.details.fixIndex, which detectTakeoff
 * stores directly when it emits the event.
 */
describe('Event Detector - duplicate-timestamp takeoff slice', () => {
  it('does not detect pre-takeoff thermals when a pre-takeoff fix shares the takeoff timestamp', () => {
    const fixes: IGCFix[] = [];
    const t0 = new Date('2024-01-15T14:00:00Z');

    // Fixes 0-9: stationary at 500m, 1s apart. Establishes startAltitude.
    for (let i = 0; i < 10; i++) {
      fixes.push(createFixAt(new Date(t0.getTime() + i * 1000), 47.0, 11.0, 500));
    }

    // Fixes 10-69: slow climb at ~0.6 m/s for 60s with near-zero ground speed.
    // This sustained climb meets the thermal threshold (min 0.5 m/s, 20s) but
    // is engineered to NOT trip detectTakeoff:
    //  - ground speed ≈ 0  → fails takeoff criterion 1 (>5 m/s)
    //  - altitude gain ≤ 36m  → fails criterion 2 (>50m above startAlt 500m)
    //  - climb rate 0.6 m/s → fails criterion 3 (>1 m/s)
    for (let i = 0; i < 60; i++) {
      fixes.push(createFixAt(
        new Date(t0.getTime() + (10 + i) * 1000),
        47.0 + i * 1e-7,
        11.0 + i * 1e-7,
        500 + i * 0.6,
      ));
    }

    // Fixes 70+: clear takeoff with rapid horizontal motion and 5 m/s climb.
    for (let i = 0; i < 90; i++) {
      fixes.push(createFixAt(
        new Date(t0.getTime() + (70 + i) * 1000),
        47.001 + i * 0.0005,
        11.001 + i * 0.0005,
        536 + i * 5,
      ));
    }

    // Sanity check on the clean track: takeoff is detected somewhere past
    // the slow-climb segment, and no thermal entries occur during it.
    const cleanEvents = detectFlightEvents(fixes);
    const cleanTakeoff = cleanEvents.find(e => e.type === 'takeoff');
    expect(cleanTakeoff).toBeDefined();
    const cleanTakeoffIdx = (cleanTakeoff!.details as { fixIndex: number }).fixIndex;
    expect(cleanTakeoffIdx).toBeGreaterThanOrEqual(70);

    const cleanThermalEntries = cleanEvents.filter(e => e.type === 'thermal_entry');
    for (const t of cleanThermalEntries) {
      expect(t.segment!.startIndex).toBeGreaterThanOrEqual(cleanTakeoffIdx);
    }

    // Now inject the duplicate-timestamp scenario: rewrite fix[0]'s timestamp
    // to match the takeoff fix's timestamp (simulating a GPS clock stall at
    // the very beginning of the log). The buggy findIndex-by-time would
    // collapse the takeoff slice down to fix 0 and let the pre-takeoff
    // slow climb leak into thermal detection.
    const corruptedFixes = fixes.map((f, i) =>
      i === 0 ? { ...f, time: fixes[cleanTakeoffIdx].time } : f,
    );

    const events = detectFlightEvents(corruptedFixes);
    const takeoff = events.find(e => e.type === 'takeoff');
    expect(takeoff).toBeDefined();

    const takeoffFixIdx = (takeoff!.details as { fixIndex: number }).fixIndex;

    // Every thermal entry must sit at or after the real takeoff fix.
    const thermalEntries = events.filter(e => e.type === 'thermal_entry');
    for (const t of thermalEntries) {
      expect(t.segment!.startIndex).toBeGreaterThanOrEqual(takeoffFixIdx);
    }
  });
});
