import { describe, it, expect } from 'bun:test';
import { detectFlightEvents, FlightEvent } from '../src/event-detector';
import { createFixAt as createFixAtTime, type IGCFix } from './test-helpers';

/**
 * Create a realistic flight track with multiple thermals and glides
 */
function createComplexFlightTrack(): IGCFix[] {
  const fixes: IGCFix[] = [];
  const startTime = new Date('2024-01-15T14:00:00Z');

  // Pre-takeoff (5 minutes stationary)
  for (let i = 0; i < 5; i++) {
    const time = new Date(startTime.getTime() + i * 60 * 1000);
    fixes.push(createFixAtTime(time, 47.0, 11.0, 500));
  }

  // Takeoff (rapid movement)
  const takeoffTime = new Date(startTime.getTime() + 5 * 60 * 1000);
  for (let i = 0; i < 5; i++) {
    const time = new Date(takeoffTime.getTime() + i * 1000);
    const lat = 47.0 + (i * 0.001);
    const lon = 11.0 + (i * 0.001);
    fixes.push(createFixAtTime(time, lat, lon, 500 + i * 20));
  }

  // First thermal (3 minutes, strong climb)
  const thermal1Start = new Date(takeoffTime.getTime() + 10 * 1000);
  for (let i = 0; i < 36; i++) {
    const time = new Date(thermal1Start.getTime() + i * 5 * 1000);
    const angle = (i / 36) * 2 * Math.PI * 3; // 3 circles
    const lat = 47.002 + Math.sin(angle) * 0.001;
    const lon = 11.002 + Math.cos(angle) * 0.001;
    const alt = 600 + (i * 25); // 5 m/s climb
    fixes.push(createFixAtTime(time, lat, lon, alt));
  }

  // Glide 1 (2 minutes)
  const glide1Start = new Date(thermal1Start.getTime() + 36 * 5 * 1000);
  for (let i = 0; i < 24; i++) {
    const time = new Date(glide1Start.getTime() + i * 5 * 1000);
    const lat = 47.003 + (i * 0.002);
    const lon = 11.003 + (i * 0.002);
    const alt = 1500 - (i * 20); // Losing altitude
    fixes.push(createFixAtTime(time, lat, lon, alt));
  }

  // Second thermal (2 minutes, weaker climb)
  const thermal2Start = new Date(glide1Start.getTime() + 24 * 5 * 1000);
  for (let i = 0; i < 24; i++) {
    const time = new Date(thermal2Start.getTime() + i * 5 * 1000);
    const angle = (i / 24) * 2 * Math.PI * 2; // 2 circles
    const lat = 47.05 + Math.sin(angle) * 0.0008;
    const lon = 11.05 + Math.cos(angle) * 0.0008;
    const alt = 1020 + (i * 15); // 3 m/s climb
    fixes.push(createFixAtTime(time, lat, lon, alt));
  }

  // Glide 2 (final glide, 3 minutes)
  const glide2Start = new Date(thermal2Start.getTime() + 24 * 5 * 1000);
  for (let i = 0; i < 36; i++) {
    const time = new Date(glide2Start.getTime() + i * 5 * 1000);
    const lat = 47.06 + (i * 0.003);
    const lon = 11.06 + (i * 0.003);
    const alt = 1380 - (i * 25); // Losing altitude
    fixes.push(createFixAtTime(time, lat, lon, alt));
  }

  // Landing approach (slow down)
  const landingStart = new Date(glide2Start.getTime() + 36 * 5 * 1000);
  for (let i = 0; i < 10; i++) {
    const time = new Date(landingStart.getTime() + i * 1000);
    const lat = 47.15 + (i * 0.0001);
    const lon = 11.15 + (i * 0.0001);
    fixes.push(createFixAtTime(time, lat, lon, 480 - i * 5));
  }

  return fixes;
}

describe('Event Detector - Non-Overlapping Segments', () => {
  describe('Thermal segments should not overlap', () => {
    it('should not detect a new thermal_entry before previous thermal_exit', () => {
      const fixes = createComplexFlightTrack();
      const events = detectFlightEvents(fixes);

      const thermalEntries = events.filter(e => e.type === 'thermal_entry');
      const thermalExits = events.filter(e => e.type === 'thermal_exit');

      // Should have matching entries and exits
      expect(thermalEntries.length).toBeGreaterThan(0);
      expect(thermalEntries.length).toBe(thermalExits.length);

      // Check that no thermal entry occurs before the previous exit
      for (let i = 1; i < thermalEntries.length; i++) {
        const prevExit = thermalExits[i - 1];
        const currentEntry = thermalEntries[i];

        expect(currentEntry.time.getTime()).toBeGreaterThanOrEqual(
          prevExit.time.getTime()
        );
      }
    });

    it('should not have overlapping thermal segments', () => {
      const fixes = createComplexFlightTrack();
      const events = detectFlightEvents(fixes);

      const thermalEvents = events.filter(e =>
        e.type === 'thermal_entry' || e.type === 'thermal_exit'
      );

      // Pair up entry/exit events
      const thermalSegments: Array<{ entry: FlightEvent; exit: FlightEvent }> = [];
      for (let i = 0; i < thermalEvents.length; i += 2) {
        if (thermalEvents[i].type === 'thermal_entry' &&
            thermalEvents[i + 1]?.type === 'thermal_exit') {
          thermalSegments.push({
            entry: thermalEvents[i],
            exit: thermalEvents[i + 1],
          });
        }
      }

      // Verify no overlaps between segments
      for (let i = 0; i < thermalSegments.length - 1; i++) {
        const currentExit = thermalSegments[i].exit.time.getTime();
        const nextEntry = thermalSegments[i + 1].entry.time.getTime();

        expect(nextEntry).toBeGreaterThanOrEqual(currentExit);
      }
    });

    it('should ensure thermal segments use correct indices', () => {
      const fixes = createComplexFlightTrack();
      const events = detectFlightEvents(fixes);

      const thermalEntries = events.filter(e => e.type === 'thermal_entry');

      for (const entry of thermalEntries) {
        expect(entry.segment).toBeDefined();
        const { startIndex, endIndex } = entry.segment!;

        // Indices should be valid
        expect(startIndex).toBeGreaterThanOrEqual(0);
        expect(endIndex).toBeGreaterThan(startIndex);
        expect(endIndex).toBeLessThan(fixes.length);

        // Time should match the fix at startIndex
        expect(entry.time.getTime()).toBe(fixes[startIndex].time.getTime());
      }
    });
  });

  describe('Glide segments should not overlap', () => {
    it('should not detect a new glide_start before previous glide_end', () => {
      const fixes = createComplexFlightTrack();
      const events = detectFlightEvents(fixes);

      const glideStarts = events.filter(e => e.type === 'glide_start');
      const glideEnds = events.filter(e => e.type === 'glide_end');

      // Should have matching starts and ends
      expect(glideStarts.length).toBeGreaterThan(0);
      expect(glideStarts.length).toBe(glideEnds.length);

      // Check that no glide start occurs before the previous end
      for (let i = 1; i < glideStarts.length; i++) {
        const prevEnd = glideEnds[i - 1];
        const currentStart = glideStarts[i];

        expect(currentStart.time.getTime()).toBeGreaterThanOrEqual(
          prevEnd.time.getTime()
        );
      }
    });

    it('should not have overlapping glide segments', () => {
      const fixes = createComplexFlightTrack();
      const events = detectFlightEvents(fixes);

      const glideEvents = events.filter(e =>
        e.type === 'glide_start' || e.type === 'glide_end'
      );

      // Pair up start/end events
      const glideSegments: Array<{ start: FlightEvent; end: FlightEvent }> = [];
      for (let i = 0; i < glideEvents.length; i += 2) {
        if (glideEvents[i].type === 'glide_start' &&
            glideEvents[i + 1]?.type === 'glide_end') {
          glideSegments.push({
            start: glideEvents[i],
            end: glideEvents[i + 1],
          });
        }
      }

      // Verify no overlaps between segments
      for (let i = 0; i < glideSegments.length - 1; i++) {
        const currentEnd = glideSegments[i].end.time.getTime();
        const nextStart = glideSegments[i + 1].start.time.getTime();

        expect(nextStart).toBeGreaterThanOrEqual(currentEnd);
      }
    });

    it('should ensure glide segments use correct indices', () => {
      const fixes = createComplexFlightTrack();
      const events = detectFlightEvents(fixes);

      const glideStarts = events.filter(e => e.type === 'glide_start');

      for (const start of glideStarts) {
        expect(start.segment).toBeDefined();
        const { startIndex, endIndex } = start.segment!;

        // Indices should be valid
        expect(startIndex).toBeGreaterThanOrEqual(0);
        expect(endIndex).toBeGreaterThan(startIndex);
        expect(endIndex).toBeLessThan(fixes.length);

        // Time should match the fix at startIndex
        expect(start.time.getTime()).toBe(fixes[startIndex].time.getTime());
      }
    });
  });

  describe('Thermals and glides should be mutually exclusive', () => {
    it('should not have thermal and glide events at the same time', () => {
      const fixes = createComplexFlightTrack();
      const events = detectFlightEvents(fixes);

      const thermalEvents = events.filter(e =>
        e.type === 'thermal_entry' || e.type === 'thermal_exit'
      );
      const glideEvents = events.filter(e =>
        e.type === 'glide_start' || e.type === 'glide_end'
      );

      // Build thermal time ranges
      const thermalRanges: Array<{ start: number; end: number }> = [];
      for (let i = 0; i < thermalEvents.length; i += 2) {
        if (thermalEvents[i].type === 'thermal_entry' &&
            thermalEvents[i + 1]?.type === 'thermal_exit') {
          thermalRanges.push({
            start: thermalEvents[i].time.getTime(),
            end: thermalEvents[i + 1].time.getTime(),
          });
        }
      }

      // Build glide time ranges
      const glideRanges: Array<{ start: number; end: number }> = [];
      for (let i = 0; i < glideEvents.length; i += 2) {
        if (glideEvents[i].type === 'glide_start' &&
            glideEvents[i + 1]?.type === 'glide_end') {
          glideRanges.push({
            start: glideEvents[i].time.getTime(),
            end: glideEvents[i + 1].time.getTime(),
          });
        }
      }

      // Check that no glide overlaps with any thermal
      for (const glide of glideRanges) {
        for (const thermal of thermalRanges) {
          // Glide should either end before thermal starts, or start after thermal ends
          const noOverlap = glide.end <= thermal.start || glide.start >= thermal.end;
          expect(noOverlap).toBe(true);
        }
      }
    });

    it('should alternate between thermals and glides', () => {
      const fixes = createComplexFlightTrack();
      const events = detectFlightEvents(fixes);

      const flightEvents = events.filter(e =>
        e.type === 'thermal_entry' || e.type === 'thermal_exit' ||
        e.type === 'glide_start' || e.type === 'glide_end'
      );

      // After a thermal_exit, we shouldn't see another thermal_entry without a glide in between
      // (or vice versa)
      let lastSegmentType: 'thermal' | 'glide' | null = null;

      for (const event of flightEvents) {
        if (event.type === 'thermal_entry') {
          // Starting a new thermal
          if (lastSegmentType === 'thermal') {
            throw new Error('Detected thermal_entry while already in a thermal');
          }
          lastSegmentType = 'thermal';
        } else if (event.type === 'thermal_exit') {
          // Ending thermal
          expect(lastSegmentType).toBe('thermal');
        } else if (event.type === 'glide_start') {
          // Starting a new glide
          if (lastSegmentType === 'glide') {
            throw new Error('Detected glide_start while already in a glide');
          }
          lastSegmentType = 'glide';
        } else if (event.type === 'glide_end') {
          // Ending glide
          expect(lastSegmentType).toBe('glide');
        }
      }
    });
  });

  describe('Edge cases', () => {
    it('should handle a thermal that weakens and restarts', () => {
      const fixes: IGCFix[] = [];
      const startTime = new Date('2024-01-15T14:00:00Z');

      // Takeoff
      for (let i = 0; i < 5; i++) {
        const time = new Date(startTime.getTime() + i * 1000);
        fixes.push(createFixAtTime(time, 47.0 + i * 0.001, 11.0, 500 + i * 20));
      }

      // Strong thermal
      for (let i = 0; i < 30; i++) {
        const time = new Date(startTime.getTime() + (5 + i) * 5 * 1000);
        const angle = (i / 30) * 2 * Math.PI * 2;
        fixes.push(createFixAtTime(
          time,
          47.01 + Math.sin(angle) * 0.001,
          11.0 + Math.cos(angle) * 0.001,
          600 + i * 20 // 4 m/s climb
        ));
      }

      // Longer period of no climb (should clearly exit thermal) - 30 fixes = 150 seconds
      for (let i = 0; i < 30; i++) {
        const time = new Date(startTime.getTime() + (35 + i) * 5 * 1000);
        fixes.push(createFixAtTime(time, 47.011 + i * 0.0001, 11.001, 1200)); // Flat
      }

      // Another thermal starts (should be separate)
      for (let i = 0; i < 30; i++) {
        const time = new Date(startTime.getTime() + (65 + i) * 5 * 1000);
        const angle = (i / 30) * 2 * Math.PI * 2;
        fixes.push(createFixAtTime(
          time,
          47.012 + Math.sin(angle) * 0.001,
          11.002 + Math.cos(angle) * 0.001,
          1200 + i * 25 // 5 m/s climb
        ));
      }

      const events = detectFlightEvents(fixes);
      const thermalEntries = events.filter(e => e.type === 'thermal_entry');
      const thermalExits = events.filter(e => e.type === 'thermal_exit');

      // Should detect 2 separate thermals
      expect(thermalEntries.length).toBe(2);
      expect(thermalExits.length).toBe(2);

      // They should not overlap
      expect(thermalExits[0].time.getTime()).toBeLessThanOrEqual(
        thermalEntries[1].time.getTime()
      );
    });
  });
});
