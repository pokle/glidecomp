/**
 * Track packer — manifest fields consumed by the 3D replay viewer.
 *
 * Covers the required-glide inputs added for the metrics callout: turnpoint
 * altitudes, the effective SSS index, and per-pilot turnpoint reach times
 * rebased onto the manifest's tRel clock.
 */
import { describe, it, expect } from 'bun:test';
import { packTracks } from '../src/track-packer';
import { requiredGlideToTarget } from '../src/glide-speed';
import { andoyerDistance } from '../src/geo';
import type { XCTask } from '../src/xctsk-parser';

const task: XCTask = {
  taskType: 'CLASSIC',
  version: 1,
  earthModel: 'WGS84',
  turnpoints: [
    { type: 'TAKEOFF', radius: 400, waypoint: { name: 'TO', lat: 47.0, lon: 10.9, altSmoothed: 1800 } },
    { type: 'SSS', radius: 1000, waypoint: { name: 'SSS', lat: 47.0, lon: 11.0, altSmoothed: 900 } },
    { radius: 400, waypoint: { name: 'TP1', lat: 47.0, lon: 11.13, altSmoothed: 750 } },
    { type: 'ESS', radius: 200, waypoint: { name: 'GOAL', lat: 47.0, lon: 11.26 } },
  ],
  sss: { type: 'RACE', direction: 'EXIT' },
  goal: { type: 'CYLINDER' },
};

const fixes = [
  { lat: 47.0, lon: 11.0, alt: 1500, t: 1000 },
  { lat: 47.0, lon: 11.1, alt: 1400, t: 1600 },
  { lat: 47.0, lon: 11.2, alt: 1300, t: 2200 },
];

describe('packTracks manifest fields for the replay callout', () => {
  it('packs turnpoint altitudes and the effective SSS index', () => {
    const packed = packTracks({ pilots: [{ id: 'p1', name: 'Pilot One', fixes }], task });
    const t = packed.manifest.task!;
    expect(t.turnpoints.map((tp) => tp.alt)).toEqual([1800, 900, 750, undefined]);
    expect(t.sssIndex).toBe(1);
  });

  it('falls back to turnpoint 0 as the start when no SSS is typed', () => {
    const noSss: XCTask = {
      ...task,
      turnpoints: task.turnpoints.map(({ type: _type, ...tp }) => tp),
    };
    const packed = packTracks({ pilots: [{ id: 'p1', name: 'Pilot One', fixes }], task: noSss });
    expect(packed.manifest.task!.sssIndex).toBe(0);
  });

  it('rebases per-pilot reach times onto the tRel clock', () => {
    const packed = packTracks({
      pilots: [
        { id: 'p1', name: 'Pilot One', fixes, reached: [{ tp: 1, t: 1300 }, { tp: 2, t: 2100 }] },
        { id: 'p2', name: 'Pilot Two', fixes: [{ lat: 47.0, lon: 11.0, alt: 1500, t: 900 }] },
      ],
    });
    // t0 is the earliest fix across all pilots (900), so p1's reach times shift by -900.
    expect(packed.manifest.pilots[0].reached).toEqual([{ tp: 1, t: 400 }, { tp: 2, t: 1200 }]);
    expect(packed.manifest.pilots[1].reached).toBeUndefined();
  });
});

describe('requiredGlideToTarget', () => {
  const target = { lat: 47.0, lon: 11.26, altitude: 400 };

  it('is distance over height above the target', () => {
    const lat = 47.0;
    const lon = 11.2;
    const alt = 1400;
    const expected = andoyerDistance(lat, lon, target.lat, target.lon) / (alt - target.altitude);
    expect(requiredGlideToTarget(lat, lon, alt, target)).toBeCloseTo(expected, 10);
    // ~4.56 km over 1000 m height → mid-single-digit L/D
    expect(requiredGlideToTarget(lat, lon, alt, target)!).toBeGreaterThan(4);
    expect(requiredGlideToTarget(lat, lon, alt, target)!).toBeLessThan(5);
  });

  it('is undefined at or below the target altitude', () => {
    expect(requiredGlideToTarget(47.0, 11.2, 400, target)).toBeUndefined();
    expect(requiredGlideToTarget(47.0, 11.2, 300, target)).toBeUndefined();
  });
});
