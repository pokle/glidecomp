import { describe, it, expect } from 'bun:test';
import { detectFlightEvents, FlightEvent } from '../src/event-detector';
import { createFixAt as createFixAtTime, type IGCFix } from './test-helpers';

/**
 * Helper to create a flight track with pre-takeoff period
 * Simulates a pilot who starts logging while on the ground/walking
 */
function createTrackWithPreTakeoff(): IGCFix[] {
  const fixes: IGCFix[] = [];
  const startTime = new Date('2024-01-15T14:00:00Z'); // 2pm UTC

  // Pre-takeoff: 30 minutes on the ground (stationary or slow walking)
  // Small movements, low altitude
  for (let i = 0; i < 30; i++) {
    const time = new Date(startTime.getTime() + i * 60 * 1000); // Every minute
    // Very small position changes (< 5 m/s ground speed)
    const lat = 47.0 + (i * 0.00001); // ~1.1m per minute
    const lon = 11.0 + (i * 0.00001);
    fixes.push(createFixAtTime(time, lat, lon, 500));
  }

  // Takeoff at 2:30pm - rapid position change
  const takeoffTime = new Date(startTime.getTime() + 30 * 60 * 1000);
  for (let i = 0; i < 5; i++) {
    const time = new Date(takeoffTime.getTime() + i * 1000); // Every second
    // Rapid movement (>5 m/s ground speed) - about 100m per second = 360 km/h (unrealistic but clear)
    const lat = 47.0 + 0.0003 + (i * 0.001);
    const lon = 11.0 + 0.0003 + (i * 0.001);
    const alt = 500 + (i * 50); // Climbing
    fixes.push(createFixAtTime(time, lat, lon, alt));
  }

  // Post-takeoff flight: thermal at 2:31pm
  const postTakeoffStart = new Date(takeoffTime.getTime() + 60 * 1000);
  for (let i = 0; i < 40; i++) {
    const time = new Date(postTakeoffStart.getTime() + i * 5 * 1000); // Every 5 seconds
    // Circling in thermal - slow horizontal movement, rapid climb
    const angle = (i / 40) * 2 * Math.PI * 3; // 3 circles
    const lat = 47.002 + Math.sin(angle) * 0.001;
    const lon = 11.002 + Math.cos(angle) * 0.001;
    const alt = 750 + (i * 30); // 30m per 5 seconds = 6 m/s climb (strong thermal)
    fixes.push(createFixAtTime(time, lat, lon, alt));
  }

  // Glide after thermal at 2:34:20pm
  const glideStart = new Date(postTakeoffStart.getTime() + 40 * 5 * 1000);
  for (let i = 0; i < 20; i++) {
    const time = new Date(glideStart.getTime() + i * 5 * 1000); // Every 5 seconds
    // Straight line, losing altitude
    const lat = 47.003 + (i * 0.002);
    const lon = 11.003 + (i * 0.002);
    const alt = 1950 - (i * 40); // Losing 40m per 5 seconds
    fixes.push(createFixAtTime(time, lat, lon, alt));
  }

  return fixes;
}

describe('Event Detector - Takeoff First Requirement', () => {
  describe('Takeoff as first event', () => {
    it('should have takeoff as the first event chronologically', () => {
      const fixes = createTrackWithPreTakeoff();
      const events = detectFlightEvents(fixes);

      // Events should be sorted by time
      expect(events.length).toBeGreaterThan(0);

      // First event must be takeoff
      expect(events[0].type).toBe('takeoff');
    });

    it('should have takeoff at 2:30pm when tracklog starts at 2pm', () => {
      const fixes = createTrackWithPreTakeoff();
      const events = detectFlightEvents(fixes);

      const takeoff = events.find(e => e.type === 'takeoff');
      expect(takeoff).toBeDefined();

      // Takeoff should be around 2:30pm (30 minutes after 2pm start)
      const expectedTime = new Date('2024-01-15T14:30:00Z');
      const takeoffTime = takeoff!.time;

      // Allow 1 minute tolerance
      const timeDiff = Math.abs(takeoffTime.getTime() - expectedTime.getTime());
      expect(timeDiff).toBeLessThan(60 * 1000);
    });
  });

  describe('Events only after takeoff', () => {
    it('should not detect thermals before takeoff', () => {
      const fixes = createTrackWithPreTakeoff();
      const events = detectFlightEvents(fixes);

      const takeoff = events.find(e => e.type === 'takeoff');
      expect(takeoff).toBeDefined();

      const thermalEvents = events.filter(e =>
        e.type === 'thermal_entry' || e.type === 'thermal_exit'
      );

      // All thermal events must be after takeoff
      for (const thermal of thermalEvents) {
        expect(thermal.time.getTime()).toBeGreaterThanOrEqual(
          takeoff!.time.getTime()
        );
      }
    });

    it('should not detect glides before takeoff', () => {
      const fixes = createTrackWithPreTakeoff();
      const events = detectFlightEvents(fixes);

      const takeoff = events.find(e => e.type === 'takeoff');
      expect(takeoff).toBeDefined();

      const glideEvents = events.filter(e =>
        e.type === 'glide_start' || e.type === 'glide_end'
      );

      // All glide events must be after takeoff
      for (const glide of glideEvents) {
        expect(glide.time.getTime()).toBeGreaterThanOrEqual(
          takeoff!.time.getTime()
        );
      }
    });

    it('should calculate altitude extremes only from takeoff onwards', () => {
      const fixes = createTrackWithPreTakeoff();
      const events = detectFlightEvents(fixes);

      const takeoff = events.find(e => e.type === 'takeoff');
      expect(takeoff).toBeDefined();

      const maxAlt = events.find(e => e.type === 'max_altitude');
      const minAlt = events.find(e => e.type === 'min_altitude');

      // Max/min altitude events must be at or after takeoff time
      if (maxAlt) {
        expect(maxAlt.time.getTime()).toBeGreaterThanOrEqual(
          takeoff!.time.getTime()
        );
      }

      if (minAlt) {
        expect(minAlt.time.getTime()).toBeGreaterThanOrEqual(
          takeoff!.time.getTime()
        );
      }
    });

    it('should calculate vario extremes only from takeoff onwards', () => {
      const fixes = createTrackWithPreTakeoff();
      const events = detectFlightEvents(fixes);

      const takeoff = events.find(e => e.type === 'takeoff');
      expect(takeoff).toBeDefined();

      const maxClimb = events.find(e => e.type === 'max_climb');
      const maxSink = events.find(e => e.type === 'max_sink');

      // Max climb/sink events must be at or after takeoff time
      if (maxClimb) {
        expect(maxClimb.time.getTime()).toBeGreaterThanOrEqual(
          takeoff!.time.getTime()
        );
      }

      if (maxSink) {
        expect(maxSink.time.getTime()).toBeGreaterThanOrEqual(
          takeoff!.time.getTime()
        );
      }
    });
  });

  describe('Edge cases', () => {
    it('should handle tracklog with no clear takeoff', () => {
      const fixes: IGCFix[] = [];
      const startTime = new Date('2024-01-15T14:00:00Z');

      // All points stationary (no takeoff)
      for (let i = 0; i < 60; i++) {
        const time = new Date(startTime.getTime() + i * 1000);
        fixes.push(createFixAtTime(time, 47.0, 11.0, 500));
      }

      const events = detectFlightEvents(fixes);

      // Should not have a takeoff event
      const takeoff = events.find(e => e.type === 'takeoff');
      expect(takeoff).toBeUndefined();

      // Should not detect flight events if no takeoff
      const thermals = events.filter(e =>
        e.type === 'thermal_entry' || e.type === 'thermal_exit'
      );
      const glides = events.filter(e =>
        e.type === 'glide_start' || e.type === 'glide_end'
      );

      // Without takeoff, we shouldn't detect thermals or glides
      expect(thermals.length).toBe(0);
      expect(glides.length).toBe(0);
    });

    it('should handle immediate takeoff (no pre-flight period)', () => {
      const fixes: IGCFix[] = [];
      const startTime = new Date('2024-01-15T14:00:00Z');

      // Immediate high-speed movement from first fix
      for (let i = 0; i < 60; i++) {
        const time = new Date(startTime.getTime() + i * 1000);
        const lat = 47.0 + (i * 0.001);
        const lon = 11.0 + (i * 0.001);
        const alt = 500 + (i * 10);
        fixes.push(createFixAtTime(time, lat, lon, alt));
      }

      const events = detectFlightEvents(fixes);

      // Should still detect takeoff
      const takeoff = events.find(e => e.type === 'takeoff');
      expect(takeoff).toBeDefined();

      // Takeoff should be near the beginning
      expect(takeoff!.time.getTime()).toBeLessThanOrEqual(
        startTime.getTime() + 5000 // Within 5 seconds
      );
    });

    it('should detect thermal that occurs after takeoff time', () => {
      const fixes = createTrackWithPreTakeoff();
      const events = detectFlightEvents(fixes);

      const takeoff = events.find(e => e.type === 'takeoff');
      const thermalEntry = events.find(e => e.type === 'thermal_entry');

      expect(takeoff).toBeDefined();
      expect(thermalEntry).toBeDefined();

      // Thermal should be detected (occurs at or after takeoff)
      // Use >= since thermal can start exactly at takeoff time
      expect(thermalEntry!.time.getTime()).toBeGreaterThanOrEqual(
        takeoff!.time.getTime()
      );
    });
  });

  describe('Event ordering validation', () => {
    it('should maintain correct chronological order of all events', () => {
      const fixes = createTrackWithPreTakeoff();
      const events = detectFlightEvents(fixes);

      // Verify events are sorted by time
      for (let i = 1; i < events.length; i++) {
        expect(events[i].time.getTime()).toBeGreaterThanOrEqual(
          events[i - 1].time.getTime()
        );
      }
    });

    it('should have takeoff before any other flight events', () => {
      const fixes = createTrackWithPreTakeoff();
      const events = detectFlightEvents(fixes);

      const takeoffIndex = events.findIndex(e => e.type === 'takeoff');
      expect(takeoffIndex).toBeGreaterThanOrEqual(0);

      // All events before takeoff should only be takeoff itself (or landing if detected early)
      for (let i = 0; i < takeoffIndex; i++) {
        // Only takeoff or landing should come before takeoff index
        // (landing might be detected but should be at end chronologically)
        expect(['takeoff', 'landing']).toContain(events[i].type);
      }
    });
  });
});
