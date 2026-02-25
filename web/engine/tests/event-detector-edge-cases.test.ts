import { describe, it, expect } from 'bun:test';
import { detectFlightEvents } from '../src/event-detector';
import { createFixAt as createFixAtTime, type IGCFix } from './test-helpers';

describe('Event Detector - Edge Cases (Zero Ground Speed)', () => {
  describe('Takeoff in strong headwind', () => {
    it('should detect takeoff based on altitude gain even with low ground speed', () => {
      const fixes: IGCFix[] = [];
      const startTime = new Date('2024-01-15T14:00:00Z');
      const startLat = 47.0;
      const startLon = 11.0;

      // Pre-flight: stationary on launch
      for (let i = 0; i < 30; i++) {
        const time = new Date(startTime.getTime() + i * 1000);
        fixes.push(createFixAtTime(time, startLat, startLon, 500));
      }

      // Launch into strong headwind: very slow ground speed but climbing
      // Simulates: airspeed 25 km/h, headwind 20 km/h = ground speed 5 km/h (1.4 m/s)
      for (let i = 0; i < 20; i++) {
        const time = new Date(startTime.getTime() + (30 + i) * 1000);
        // Very small position changes (< 5 m/s threshold)
        const lat = startLat + (i * 0.00002); // ~2.2m per second
        const lon = startLon + (i * 0.00002);
        const alt = 500 + (i * 3); // Climbing 3m/s = 180m/min
        fixes.push(createFixAtTime(time, lat, lon, alt));
      }

      // After initial climb, better ground speed
      for (let i = 0; i < 20; i++) {
        const time = new Date(startTime.getTime() + (50 + i) * 1000);
        const lat = startLat + 0.0004 + (i * 0.0001);
        const lon = startLon + 0.0004 + (i * 0.0001);
        const alt = 560 + (i * 2);
        fixes.push(createFixAtTime(time, lat, lon, alt));
      }

      const events = detectFlightEvents(fixes);
      const takeoff = events.find(e => e.type === 'takeoff');

      // Should detect takeoff despite low initial ground speed
      expect(takeoff).toBeDefined();

      // Takeoff should be detected around the time of sustained altitude gain
      // Not at the very end when ground speed picks up
      const takeoffTimeOffset = takeoff!.time.getTime() - startTime.getTime();
      expect(takeoffTimeOffset).toBeLessThan(60 * 1000); // Within first minute
    });

    it('should detect takeoff based on sustained climb rate', () => {
      const fixes: IGCFix[] = [];
      const startTime = new Date('2024-01-15T14:00:00Z');

      // Stationary period
      for (let i = 0; i < 20; i++) {
        const time = new Date(startTime.getTime() + i * 1000);
        fixes.push(createFixAtTime(time, 47.0, 11.0, 1000));
      }

      // Launch: climbing at 2 m/s for 15 seconds (sustained climb)
      // Ground speed near zero due to headwind
      for (let i = 0; i < 15; i++) {
        const time = new Date(startTime.getTime() + (20 + i) * 1000);
        const lat = 47.0 + (i * 0.00001); // Minimal movement
        const lon = 11.0 + (i * 0.00001);
        const alt = 1000 + (i * 2); // 2 m/s climb
        fixes.push(createFixAtTime(time, lat, lon, alt));
      }

      // Continue flight
      for (let i = 0; i < 30; i++) {
        const time = new Date(startTime.getTime() + (35 + i) * 5000);
        const lat = 47.001 + (i * 0.0005);
        const lon = 11.001 + (i * 0.0005);
        const alt = 1030 + (i * 10);
        fixes.push(createFixAtTime(time, lat, lon, alt));
      }

      const events = detectFlightEvents(fixes);
      const takeoff = events.find(e => e.type === 'takeoff');

      expect(takeoff).toBeDefined();

      // Takeoff should be detected during the sustained climb period
      const takeoffTime = takeoff!.time.getTime();
      const climbStartTime = startTime.getTime() + 20 * 1000;
      const climbEndTime = startTime.getTime() + 35 * 1000;

      expect(takeoffTime).toBeGreaterThanOrEqual(climbStartTime);
      expect(takeoffTime).toBeLessThanOrEqual(climbEndTime);
    });
  });

  describe('Flying with zero ground speed', () => {
    it('should not detect landing while thermalling with low ground speed', () => {
      const fixes: IGCFix[] = [];
      const startTime = new Date('2024-01-15T14:00:00Z');

      // Normal takeoff
      for (let i = 0; i < 10; i++) {
        const time = new Date(startTime.getTime() + i * 1000);
        fixes.push(createFixAtTime(time, 47.0 + i * 0.001, 11.0, 500 + i * 20));
      }

      // Strong thermal with wind: circling with very low ground speed
      // (wind cancels out ground speed on upwind side of thermal)
      for (let i = 0; i < 40; i++) {
        const time = new Date(startTime.getTime() + (10 + i) * 5 * 1000);
        const angle = (i / 40) * 2 * Math.PI * 3; // 3 circles
        // Very tight circle = low ground speed
        const lat = 47.01 + Math.sin(angle) * 0.0003; // 30m radius
        const lon = 11.0 + Math.cos(angle) * 0.0003;
        const alt = 700 + (i * 15); // Strong 3 m/s climb
        fixes.push(createFixAtTime(time, lat, lon, alt));
      }

      // Glide out
      for (let i = 0; i < 20; i++) {
        const time = new Date(startTime.getTime() + (50 + i) * 5 * 1000);
        const lat = 47.01 + (i * 0.002);
        const lon = 11.0 + (i * 0.002);
        const alt = 1300 - (i * 30);
        fixes.push(createFixAtTime(time, lat, lon, alt));
      }

      const events = detectFlightEvents(fixes);
      const landing = events.find(e => e.type === 'landing');

      // Landing should be at the end, not during the thermal
      expect(landing).toBeDefined();

      const landingTime = landing!.time.getTime();
      const thermalEndTime = startTime.getTime() + 50 * 5 * 1000;

      // Landing should be after the thermal period
      expect(landingTime).toBeGreaterThan(thermalEndTime);
    });

    it('should not detect landing while ridge soaring with minimal ground speed', () => {
      const fixes: IGCFix[] = [];
      const startTime = new Date('2024-01-15T14:00:00Z');

      // Takeoff
      for (let i = 0; i < 10; i++) {
        const time = new Date(startTime.getTime() + i * 1000);
        fixes.push(createFixAtTime(time, 47.0 + i * 0.001, 11.0, 500 + i * 20));
      }

      // Ridge soaring: flying back and forth along ridge with headwind on one leg
      // Ground speed alternates between fast and very slow
      for (let i = 0; i < 60; i++) {
        const time = new Date(startTime.getTime() + (10 + i) * 5 * 1000);

        // Simulate back-and-forth pattern
        const legPosition = i % 20;
        let lat, lon;

        if (legPosition < 10) {
          // Downwind leg: good ground speed
          lat = 47.01 + (legPosition * 0.001);
          lon = 11.0;
        } else {
          // Upwind leg: very low ground speed (headwind = airspeed)
          lat = 47.02 - ((legPosition - 10) * 0.0001); // Slow progress
          lon = 11.0;
        }

        // Maintaining altitude (ridge lift)
        const alt = 800 + Math.sin((i / 20) * Math.PI) * 50; // +/- 50m variation
        fixes.push(createFixAtTime(time, lat, lon, alt));
      }

      // Final glide to landing
      for (let i = 0; i < 20; i++) {
        const time = new Date(startTime.getTime() + (70 + i) * 5 * 1000);
        const lat = 47.02 + (i * 0.001);
        const lon = 11.0 + (i * 0.001);
        const alt = 800 - (i * 40);
        fixes.push(createFixAtTime(time, lat, lon, alt));
      }

      const events = detectFlightEvents(fixes);
      const landing = events.find(e => e.type === 'landing');

      expect(landing).toBeDefined();

      // Landing should be at the end, not during ridge soaring
      const landingTime = landing!.time.getTime();
      const ridgeEndTime = startTime.getTime() + 70 * 5 * 1000;

      expect(landingTime).toBeGreaterThanOrEqual(ridgeEndTime);
    });
  });

  describe('Landing detection with strong headwind', () => {
    it('should detect landing based on sustained low altitude even with some ground speed', () => {
      const fixes: IGCFix[] = [];
      const startTime = new Date('2024-01-15T14:00:00Z');

      // Normal flight
      for (let i = 0; i < 40; i++) {
        const time = new Date(startTime.getTime() + i * 5 * 1000);
        fixes.push(createFixAtTime(
          time,
          47.0 + i * 0.001,
          11.0 + i * 0.001,
          1000 + Math.sin(i / 10) * 200
        ));
      }

      // Final approach: descending but with some ground speed from wind
      for (let i = 0; i < 20; i++) {
        const time = new Date(startTime.getTime() + (40 + i) * 5 * 1000);
        const lat = 47.04 + (i * 0.0003); // Some ground speed
        const lon = 11.04 + (i * 0.0003);
        const alt = Math.max(500, 1000 - (i * 40)); // Descending to 500m
        fixes.push(createFixAtTime(time, lat, lon, alt));
      }

      // On ground but wind causes some GPS drift
      for (let i = 0; i < 30; i++) {
        const time = new Date(startTime.getTime() + (60 + i) * 5 * 1000);
        // Small position changes from GPS drift
        const lat = 47.046 + (i * 0.00001);
        const lon = 11.046 + (i * 0.00001);
        fixes.push(createFixAtTime(time, lat, lon, 500));
      }

      const events = detectFlightEvents(fixes);
      const landing = events.find(e => e.type === 'landing');

      expect(landing).toBeDefined();

      // Landing should be detected when altitude stabilizes, not just when ground speed drops
      expect(landing!.altitude).toBeLessThan(600);
    });
  });

  describe('Altitude-based takeoff detection', () => {
    it('should detect takeoff when altitude gain exceeds threshold', () => {
      const fixes: IGCFix[] = [];
      const startTime = new Date('2024-01-15T14:00:00Z');
      const launchAlt = 1000;

      // On launch for 1 minute
      for (let i = 0; i < 60; i++) {
        const time = new Date(startTime.getTime() + i * 1000);
        fixes.push(createFixAtTime(time, 47.0, 11.0, launchAlt));
      }

      // Slow altitude gain (sled ride or weak conditions)
      // Very low ground speed throughout
      for (let i = 0; i < 30; i++) {
        const time = new Date(startTime.getTime() + (60 + i) * 2 * 1000);
        const lat = 47.0 + (i * 0.00001); // Very slow
        const lon = 11.0 + (i * 0.00001);
        const alt = launchAlt + (i * 3); // Slow climb: 1.5 m/s
        fixes.push(createFixAtTime(time, lat, lon, alt));
      }

      // Continue flight
      for (let i = 0; i < 20; i++) {
        const time = new Date(startTime.getTime() + (120 + i) * 5 * 1000);
        fixes.push(createFixAtTime(
          time,
          47.001 + i * 0.001,
          11.001 + i * 0.001,
          launchAlt + 90 + i * 10
        ));
      }

      const events = detectFlightEvents(fixes);
      const takeoff = events.find(e => e.type === 'takeoff');

      expect(takeoff).toBeDefined();

      // Should detect takeoff when significant altitude gain is achieved
      // Not wait until much later when ground speed increases
      const takeoffAlt = takeoff!.altitude;
      expect(takeoffAlt).toBeGreaterThanOrEqual(launchAlt);
      expect(takeoffAlt).toBeLessThan(launchAlt + 100); // Within 100m of launch
    });
  });
});
