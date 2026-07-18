import { describe, it, expect } from 'bun:test';
import { buildTimeGrid, sampleAt } from '../src/field-analysis';
import { createFix, BASE_TIME, TEST_ORIGIN, DEG_LAT_PER_M } from './field-test-helpers';

const ORIGIN = TEST_ORIGIN;

describe('buildTimeGrid', () => {
  it('interpolates linearly between bracketing fixes', () => {
    const fixes = [
      createFix(0, ORIGIN.lat, ORIGIN.lon, 1000),
      createFix(30, ORIGIN.lat, ORIGIN.lon, 1030),
      createFix(60, ORIGIN.lat, ORIGIN.lon, 1090),
    ];
    const { grid, tracks } = buildTimeGrid(
      [{ fixes, takeoffIndex: 0, landingIndex: 2 }],
      ORIGIN,
      10,
    );
    expect(grid.t0Ms).toBe(BASE_TIME.getTime());
    const t = tracks[0];
    expect(t.samples[0]!.alt).toBe(1000);
    expect(t.samples[1]!.alt).toBeCloseTo(1010, 6); // 10 s into the 0→30 s fix pair
    expect(t.samples[3]!.alt).toBe(1030);
    expect(t.samples[4]!.alt).toBeCloseTo(1050, 6); // 10 s into the 30→60 s pair
  });

  it('computes vario from consecutive samples', () => {
    const fixes = [
      createFix(0, ORIGIN.lat, ORIGIN.lon, 1000),
      createFix(60, ORIGIN.lat, ORIGIN.lon, 1120), // steady 2 m/s
    ];
    const { tracks } = buildTimeGrid([{ fixes, takeoffIndex: 0, landingIndex: 1 }], ORIGIN, 10);
    expect(tracks[0].samples[0]!.vario).toBe(0); // first sample has no predecessor
    expect(tracks[0].samples[1]!.vario).toBeCloseTo(2, 6);
    expect(tracks[0].samples[6]!.vario).toBeCloseTo(2, 6);
  });

  it('yields nulls across a logger gap longer than 60 s and resets vario after', () => {
    const fixes = [
      createFix(0, ORIGIN.lat, ORIGIN.lon, 1000),
      createFix(20, ORIGIN.lat, ORIGIN.lon, 1020),
      createFix(200, ORIGIN.lat, ORIGIN.lon, 1200), // 180 s dropout
      createFix(220, ORIGIN.lat, ORIGIN.lon, 1220),
    ];
    const { tracks } = buildTimeGrid([{ fixes, takeoffIndex: 0, landingIndex: 3 }], ORIGIN, 10);
    const t = tracks[0];
    expect(t.samples[2]!.alt).toBe(1020); // t=20 sits exactly on a fix
    for (let i = 3; i < 20; i++) expect(t.samples[i]).toBeNull(); // inside the gap
    expect(t.samples[20]!.alt).toBe(1200); // t=200 resumes on the fix
    expect(t.samples[20]!.vario).toBe(0); // no predecessor across the gap
  });

  it('only samples between takeoff and landing', () => {
    // Pilot A anchors the grid at t=0; pilot B takes off at t=30.
    const anchor = [
      createFix(0, ORIGIN.lat, ORIGIN.lon, 1000),
      createFix(120, ORIGIN.lat, ORIGIN.lon, 1000),
    ];
    const fixes = [
      createFix(0, ORIGIN.lat, ORIGIN.lon, 300), // pre-takeoff ground fix
      createFix(30, ORIGIN.lat, ORIGIN.lon, 300),
      createFix(60, ORIGIN.lat, ORIGIN.lon, 500),
      createFix(120, ORIGIN.lat, ORIGIN.lon, 800),
    ];
    const { tracks } = buildTimeGrid(
      [
        { fixes: anchor, takeoffIndex: 0, landingIndex: 1 },
        { fixes, takeoffIndex: 1, landingIndex: 3 },
      ],
      ORIGIN,
      10,
    );
    const t = tracks[1];
    expect(t.startStep).toBe(3); // first step at/after the takeoff fix (t=30)
    expect(t.endStep).toBe(12); // landing fix (t=120)
    expect(t.samples[0]).toBeNull();
    expect(t.samples[2]).toBeNull();
    expect(t.samples[3]).not.toBeNull();
  });

  it('builds frames in the cluster-detector ENU convention (z = −north)', () => {
    const northMeters = 500;
    const fixes = [
      createFix(0, ORIGIN.lat + northMeters * DEG_LAT_PER_M, ORIGIN.lon, 1500),
      createFix(60, ORIGIN.lat + northMeters * DEG_LAT_PER_M, ORIGIN.lon, 1500),
    ];
    const { grid } = buildTimeGrid([{ fixes, takeoffIndex: 0, landingIndex: 1 }], ORIGIN, 10);
    const state = grid.frames[0].states[0];
    expect(state.pilot).toBe(0);
    expect(state.y).toBe(1500); // y = altitude
    // geo.ts uses the WGS84 metres-per-degree series, so allow a few metres
    // against the test's flat-earth constant.
    expect(state.z).toBeCloseTo(-northMeters, -1); // north of origin → negative z
    expect(Math.abs(state.x)).toBeLessThan(1);
    expect(grid.frames[3].t).toBe(30); // Frame.t is relative seconds
  });

  it('handles a pilot with no usable flight window', () => {
    const fixes = [createFix(0, ORIGIN.lat, ORIGIN.lon, 300)];
    const { tracks } = buildTimeGrid(
      [
        { fixes, takeoffIndex: 0, landingIndex: 0 },
        {
          fixes: [createFix(0, ORIGIN.lat, ORIGIN.lon, 1000), createFix(60, ORIGIN.lat, ORIGIN.lon, 1000)],
          takeoffIndex: 0,
          landingIndex: 1,
        },
      ],
      ORIGIN,
      10,
    );
    expect(tracks[0].startStep).toBe(-1);
    expect(tracks[0].samples.every((s) => s === null)).toBe(true);
    expect(tracks[1].startStep).toBe(0);
  });
});

describe('sampleAt', () => {
  it('returns the nearest grid step sample and null out of range', () => {
    const fixes = [
      createFix(0, ORIGIN.lat, ORIGIN.lon, 1000),
      createFix(50, ORIGIN.lat, ORIGIN.lon, 1050),
    ];
    const { grid, tracks } = buildTimeGrid([{ fixes, takeoffIndex: 0, landingIndex: 1 }], ORIGIN, 10);
    const at = sampleAt(grid, tracks[0], BASE_TIME.getTime() + 34_000);
    expect(at!.alt).toBeCloseTo(1030, 6); // nearest step is t=30
    expect(sampleAt(grid, tracks[0], BASE_TIME.getTime() - 60_000)).toBeNull();
  });
});
