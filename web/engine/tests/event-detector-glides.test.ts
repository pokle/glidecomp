import { describe, it, expect } from 'bun:test';
import { detectFlightEvents } from '../src/event-detector';
import { createFixAt as createFixAtTime, type IGCFix } from './test-helpers';
import type { GlideEventDetails } from '../src/event-detector';

describe('Event Detector - Trailing Glide', () => {
  it('should detect a glide after the last thermal', () => {
    const fixes: IGCFix[] = [];
    const startTime = new Date('2024-01-15T14:00:00Z');

    // Takeoff with rapid movement
    for (let i = 0; i < 10; i++) {
      const time = new Date(startTime.getTime() + i * 1000);
      fixes.push(createFixAtTime(time, 47.0 + i * 0.001, 11.0, 500 + i * 20));
    }

    // Thermal: 60 fixes at 5s intervals = 5 minutes, climbing 3 m/s
    for (let i = 0; i < 60; i++) {
      const time = new Date(startTime.getTime() + (10 + i) * 5 * 1000);
      const angle = (i / 60) * 2 * Math.PI * 5;
      fixes.push(createFixAtTime(
        time,
        47.01 + Math.sin(angle) * 0.001,
        11.0 + Math.cos(angle) * 0.001,
        700 + i * 15
      ));
    }

    // Final glide after thermal: 60 fixes at 5s intervals = 5 minutes, descending
    for (let i = 0; i < 60; i++) {
      const time = new Date(startTime.getTime() + (70 + i) * 5 * 1000);
      fixes.push(createFixAtTime(
        time,
        47.01 + i * 0.002,
        11.0 + i * 0.002,
        1600 - i * 15
      ));
    }

    const events = detectFlightEvents(fixes);

    const thermalEntries = events.filter(e => e.type === 'thermal_entry');
    const glideStarts = events.filter(e => e.type === 'glide_start');
    const glideEnds = events.filter(e => e.type === 'glide_end');

    expect(thermalEntries.length).toBeGreaterThanOrEqual(1);

    // Should have a trailing glide after the thermal
    const lastThermalExit = events.filter(e => e.type === 'thermal_exit').pop();
    expect(lastThermalExit).toBeDefined();

    // Find glides that start after the last thermal exit
    const trailingGlides = glideStarts.filter(
      g => g.time.getTime() >= lastThermalExit!.time.getTime()
    );
    expect(trailingGlides.length).toBeGreaterThanOrEqual(1);

    // Matching glide_end should exist
    expect(glideEnds.length).toBe(glideStarts.length);
  });

  it('should calculate correct statistics for trailing glide', () => {
    const fixes: IGCFix[] = [];
    const startTime = new Date('2024-01-15T14:00:00Z');

    // Takeoff
    for (let i = 0; i < 10; i++) {
      const time = new Date(startTime.getTime() + i * 1000);
      fixes.push(createFixAtTime(time, 47.0 + i * 0.001, 11.0, 500 + i * 20));
    }

    // Thermal
    for (let i = 0; i < 60; i++) {
      const time = new Date(startTime.getTime() + (10 + i) * 5 * 1000);
      const angle = (i / 60) * 2 * Math.PI * 5;
      fixes.push(createFixAtTime(
        time,
        47.01 + Math.sin(angle) * 0.001,
        11.0 + Math.cos(angle) * 0.001,
        700 + i * 15
      ));
    }

    // Final glide: descending from 1600m to 700m over 60 fixes
    for (let i = 0; i < 60; i++) {
      const time = new Date(startTime.getTime() + (70 + i) * 5 * 1000);
      fixes.push(createFixAtTime(
        time,
        47.01 + i * 0.002,
        11.0 + i * 0.002,
        1600 - i * 15
      ));
    }

    const events = detectFlightEvents(fixes);
    const lastGlideStart = events.filter(e => e.type === 'glide_start').pop();

    expect(lastGlideStart).toBeDefined();
    expect(lastGlideStart!.details).toBeDefined();
    const details = lastGlideStart!.details as GlideEventDetails;
    expect(details.distance).toBeGreaterThan(0);
    expect(details.glideRatio).toBeGreaterThan(0);
    expect(details.duration).toBeGreaterThan(30);
  });
});

describe('Event Detector - No-Thermal Flights', () => {
  it('should detect a single glide for a sled ride with no thermals', () => {
    const fixes: IGCFix[] = [];
    const startTime = new Date('2024-01-15T14:00:00Z');

    // Pre-flight stationary on hill launch at 1500m
    for (let i = 0; i < 10; i++) {
      const time = new Date(startTime.getTime() + i * 1000);
      fixes.push(createFixAtTime(time, 47.0, 11.0, 1500));
    }

    // Takeoff: fast ground speed, slight altitude gain to trigger detection
    for (let i = 0; i < 10; i++) {
      const time = new Date(startTime.getTime() + (10 + i) * 1000);
      fixes.push(createFixAtTime(
        time,
        47.0 + i * 0.001,
        11.0 + i * 0.001,
        1500 + i * 6 // Moderate climb during launch (6 m/s, brief)
      ));
    }

    // Sled ride: steady descent, no thermals. 120 fixes at 5s intervals = 10 min
    for (let i = 0; i < 120; i++) {
      const time = new Date(startTime.getTime() + (20 + i) * 5 * 1000);
      fixes.push(createFixAtTime(
        time,
        47.01 + i * 0.001,
        11.01 + i * 0.0005,
        1560 - i * 7 // Descending ~1.4 m/s
      ));
    }

    const events = detectFlightEvents(fixes);

    const thermalEntries = events.filter(e => e.type === 'thermal_entry');
    const glideStarts = events.filter(e => e.type === 'glide_start');
    const glideEnds = events.filter(e => e.type === 'glide_end');

    // No thermals
    expect(thermalEntries.length).toBe(0);

    // Should have at least one glide covering the flight
    expect(glideStarts.length).toBeGreaterThanOrEqual(1);
    expect(glideEnds.length).toBe(glideStarts.length);

    // The glide should have meaningful statistics
    const glideDetails = glideStarts[0].details as GlideEventDetails;
    expect(glideDetails.distance).toBeGreaterThan(0);
    expect(glideDetails.duration).toBeGreaterThan(30);
  });

  it('should have valid segment indices for a no-thermal glide', () => {
    const fixes: IGCFix[] = [];
    const startTime = new Date('2024-01-15T14:00:00Z');

    // Pre-flight stationary
    for (let i = 0; i < 10; i++) {
      const time = new Date(startTime.getTime() + i * 1000);
      fixes.push(createFixAtTime(time, 47.0, 11.0, 1500));
    }

    // Takeoff: fast ground speed, moderate climb
    for (let i = 0; i < 10; i++) {
      const time = new Date(startTime.getTime() + (10 + i) * 1000);
      fixes.push(createFixAtTime(
        time,
        47.0 + i * 0.001,
        11.0 + i * 0.001,
        1500 + i * 6
      ));
    }

    // Steady descent
    for (let i = 0; i < 120; i++) {
      const time = new Date(startTime.getTime() + (20 + i) * 5 * 1000);
      fixes.push(createFixAtTime(
        time,
        47.01 + i * 0.001,
        11.01 + i * 0.0005,
        1560 - i * 7
      ));
    }

    const events = detectFlightEvents(fixes);
    const glideStart = events.find(e => e.type === 'glide_start');

    expect(glideStart).toBeDefined();
    expect(glideStart!.segment).toBeDefined();

    const { startIndex, endIndex } = glideStart!.segment!;
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(endIndex).toBeLessThan(fixes.length);
    expect(endIndex).toBeGreaterThan(startIndex);
  });
});
