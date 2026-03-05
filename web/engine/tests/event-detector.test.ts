import { describe, it, expect } from 'bun:test';
import { detectFlightEvents, filterEventsByBounds, getEventStyle, FlightEvent } from '../src/event-detector';
import { XCTask } from '../src/xctsk-parser';
import { createFix as createFixSeconds, type IGCFix } from './test-helpers';

/** Create a fix using minutes (for backward compatibility with existing tests) */
function createFix(timeMinutes: number, lat: number, lon: number, altitude: number) {
  return createFixSeconds(timeMinutes * 60, lat, lon, altitude);
}

/**
 * Helper to create a simple flight track
 */
function createFlightTrack(durationMinutes: number): IGCFix[] {
  const fixes: IGCFix[] = [];
  const startLat = 47.0;
  const startLon = 11.0;

  for (let i = 0; i <= durationMinutes; i++) {
    // Simulate a flight moving north-east with varying altitude
    const progress = i / durationMinutes;
    const lat = startLat + progress * 0.5;
    const lon = startLon + progress * 0.5;

    // Altitude profile: takeoff, climb, glide, thermal, glide, land
    let altitude = 500;
    if (i > 5 && i < 20) {
      altitude = 500 + (i - 5) * 100; // Climbing
    } else if (i >= 20 && i < 40) {
      altitude = 2000 - (i - 20) * 30; // Gliding
    } else if (i >= 40 && i < 60) {
      altitude = 1400 + (i - 40) * 50; // Thermal
    } else if (i >= 60) {
      altitude = 2400 - (i - 60) * 50; // Final glide
    }

    fixes.push(createFix(i, lat, lon, altitude));
  }

  return fixes;
}

describe('Event Detector', () => {
  describe('detectFlightEvents', () => {
    it('should detect takeoff and landing', () => {
      const fixes = createFlightTrack(90);
      const events = detectFlightEvents(fixes);

      const takeoff = events.find(e => e.type === 'takeoff');
      const landing = events.find(e => e.type === 'landing');

      expect(takeoff).toBeDefined();
      expect(landing).toBeDefined();
    });

    it('should detect altitude extremes', () => {
      const fixes = createFlightTrack(90);
      const events = detectFlightEvents(fixes);

      const maxAlt = events.find(e => e.type === 'max_altitude');
      const minAlt = events.find(e => e.type === 'min_altitude');

      expect(maxAlt).toBeDefined();
      expect(minAlt).toBeDefined();
      expect(maxAlt!.altitude).toBeGreaterThan(minAlt!.altitude);
    });

    it('should detect thermal entry and exit', () => {
      const fixes = createFlightTrack(90);
      const events = detectFlightEvents(fixes);

      const thermalEntries = events.filter(e => e.type === 'thermal_entry');
      const thermalExits = events.filter(e => e.type === 'thermal_exit');

      // Should have at least one thermal
      expect(thermalEntries.length).toBeGreaterThanOrEqual(1);
      expect(thermalExits.length).toBeGreaterThanOrEqual(1);
    });

    it('should detect turnpoint crossings when task is provided', () => {
      const fixes: IGCFix[] = [];
      const taskCenter = { lat: 47.2, lon: 11.2 };

      // Add pre-flight fixes (stationary, no takeoff)
      for (let i = 0; i < 5; i++) {
        fixes.push(createFix(i, 47.0, 11.0, 500));
      }

      // Add takeoff with rapid movement
      for (let i = 5; i < 10; i++) {
        const lat = 47.0 + (i - 5) * 0.002; // Fast movement to trigger takeoff
        const lon = 11.0 + (i - 5) * 0.002;
        fixes.push(createFix(i, lat, lon, 500 + (i - 5) * 50));
      }

      // Create a track that enters and exits a turnpoint cylinder
      for (let i = 0; i < 60; i++) {
        const angle = (i / 60) * Math.PI;
        const radius = 0.005; // About 500m
        const lat = taskCenter.lat + Math.sin(angle) * radius;
        const lon = taskCenter.lon + Math.cos(angle) * radius - 0.01; // Offset to cross through

        fixes.push(createFix(i + 10, lat, lon, 1500));
      }

      const task: XCTask = {
        taskType: 'CLASSIC',
        version: 1,
        turnpoints: [
          {
            type: 'SSS',
            radius: 400,
            waypoint: { name: 'Start', lat: taskCenter.lat, lon: taskCenter.lon },
          },
        ],
      };

      const events = detectFlightEvents(fixes, task);
      const startCrossing = events.find(e => e.type === 'start_crossing');

      expect(startCrossing).toBeDefined();
    });

    it('should apply indexOffset to altitude/vario fixIndex (BUG-03)', () => {
      // Create a track with stationary pre-flight fixes before takeoff
      const fixes: IGCFix[] = [];

      // 10 minutes stationary on the ground (no takeoff)
      for (let i = 0; i < 10; i++) {
        fixes.push(createFix(i, 47.0, 11.0, 500));
      }

      // Takeoff with rapid movement and climb
      for (let i = 10; i < 20; i++) {
        const progress = (i - 10) / 10;
        fixes.push(createFix(i, 47.0 + progress * 0.01, 11.0 + progress * 0.01, 500 + (i - 10) * 100));
      }

      // Cruise at high altitude
      for (let i = 20; i < 60; i++) {
        const progress = (i - 20) / 40;
        fixes.push(createFix(i, 47.01 + progress * 0.2, 11.01 + progress * 0.2, 1800 - (i - 20) * 20));
      }

      // Descend and land
      for (let i = 60; i < 80; i++) {
        fixes.push(createFix(i, 47.21, 11.21, 1000 - (i - 60) * 30));
      }

      const events = detectFlightEvents(fixes);

      // Find the takeoff to know the expected offset
      const takeoff = events.find(e => e.type === 'takeoff');
      expect(takeoff).toBeDefined();
      const takeoffIndex = fixes.findIndex(f => f.time.getTime() === takeoff!.time.getTime());
      expect(takeoffIndex).toBeGreaterThan(0); // Must have pre-flight fixes

      // Check altitude extreme fixIndex values reference the original fixes array
      const maxAlt = events.find(e => e.type === 'max_altitude');
      const minAlt = events.find(e => e.type === 'min_altitude');
      expect(maxAlt).toBeDefined();
      expect(minAlt).toBeDefined();

      // fixIndex must be >= takeoffIndex (not relative to flightFixes)
      const maxAltDetails = maxAlt!.details as { fixIndex: number };
      const minAltDetails = minAlt!.details as { fixIndex: number };
      expect(maxAltDetails.fixIndex).toBeGreaterThanOrEqual(takeoffIndex);
      expect(minAltDetails.fixIndex).toBeGreaterThanOrEqual(takeoffIndex);

      // Verify the fixIndex actually points to the correct fix in the original array
      expect(fixes[maxAltDetails.fixIndex].gnssAltitude).toBe(maxAlt!.altitude);
      expect(fixes[minAltDetails.fixIndex].gnssAltitude).toBe(minAlt!.altitude);

      // Check vario extreme fixIndex values if present
      const maxClimb = events.find(e => e.type === 'max_climb');
      if (maxClimb?.details) {
        const details = maxClimb.details as { fixIndex: number };
        expect(details.fixIndex).toBeGreaterThanOrEqual(takeoffIndex);
      }
      const maxSink = events.find(e => e.type === 'max_sink');
      if (maxSink?.details) {
        const details = maxSink.details as { fixIndex: number };
        expect(details.fixIndex).toBeGreaterThanOrEqual(takeoffIndex);
      }
    });

    it('should sort events by time', () => {
      const fixes = createFlightTrack(90);
      const events = detectFlightEvents(fixes);

      for (let i = 1; i < events.length; i++) {
        expect(events[i].time.getTime()).toBeGreaterThanOrEqual(
          events[i - 1].time.getTime()
        );
      }
    });
  });

  describe('filterEventsByBounds', () => {
    it('should filter events within bounds', () => {
      const events: FlightEvent[] = [
        {
          id: '1',
          type: 'thermal_entry',
          time: new Date(),
          latitude: 47.5,
          longitude: 11.5,
          altitude: 1500,
          description: 'Thermal 1',
        },
        {
          id: '2',
          type: 'thermal_entry',
          time: new Date(),
          latitude: 48.5,
          longitude: 12.5,
          altitude: 1500,
          description: 'Thermal 2',
        },
        {
          id: '3',
          type: 'thermal_entry',
          time: new Date(),
          latitude: 47.0,
          longitude: 11.0,
          altitude: 1500,
          description: 'Thermal 3',
        },
      ];

      const bounds = {
        north: 48.0,
        south: 47.0,
        east: 12.0,
        west: 11.0,
      };

      const filtered = filterEventsByBounds(events, bounds);

      expect(filtered).toHaveLength(2);
      expect(filtered.map(e => e.id)).toContain('1');
      expect(filtered.map(e => e.id)).toContain('3');
      expect(filtered.map(e => e.id)).not.toContain('2');
    });

    it('should return all events if bounds include all', () => {
      const events: FlightEvent[] = [
        {
          id: '1',
          type: 'takeoff',
          time: new Date(),
          latitude: 47.5,
          longitude: 11.5,
          altitude: 500,
          description: 'Takeoff',
        },
      ];

      const bounds = {
        north: 90,
        south: -90,
        east: 180,
        west: -180,
      };

      const filtered = filterEventsByBounds(events, bounds);
      expect(filtered).toHaveLength(1);
    });

    it('should return empty array for events outside bounds', () => {
      const events: FlightEvent[] = [
        {
          id: '1',
          type: 'takeoff',
          time: new Date(),
          latitude: 47.5,
          longitude: 11.5,
          altitude: 500,
          description: 'Takeoff',
        },
      ];

      const bounds = {
        north: 40,
        south: 30,
        east: 5,
        west: 0,
      };

      const filtered = filterEventsByBounds(events, bounds);
      expect(filtered).toHaveLength(0);
    });
  });

  describe('getEventStyle', () => {
    it('should return correct colors for event types', () => {
      expect(getEventStyle('takeoff').color).toBe('#22c55e');
      expect(getEventStyle('landing').color).toBe('#ef4444');
      expect(getEventStyle('thermal_entry').color).toBe('#f97316');
      expect(getEventStyle('start_crossing').color).toBe('#22c55e');
      expect(getEventStyle('goal_crossing').color).toBe('#eab308');
    });

    it('should return icon names for all event types', () => {
      const types: FlightEvent['type'][] = [
        'takeoff',
        'landing',
        'thermal_entry',
        'thermal_exit',
        'glide_start',
        'glide_end',
        'turnpoint_entry',
        'turnpoint_exit',
        'start_crossing',
        'goal_crossing',
        'max_altitude',
        'min_altitude',
        'max_climb',
        'max_sink',
      ];

      for (const type of types) {
        const style = getEventStyle(type);
        expect(style.icon).toBeDefined();
        expect(style.color).toBeDefined();
      }
    });
  });
});
