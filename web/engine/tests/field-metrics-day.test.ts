/**
 * P6 day-profile metric family tests (day.wind, day.climb_by_hour,
 * day.launch_timing) — see docs/2026-07-18-field-analysis-plan.md.
 *
 * Synthetic fields via the frozen field-test-helpers factory, plus one smoke
 * test over the real kosci-loop-t1 comp (builder copied from
 * field-analysis.test.ts per the Stage 1 package rules).
 */

import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { IGCFix } from '../src/igc-parser';
import { parseIGC } from '../src/igc-parser';
import { parseXCTask } from '../src/xctsk-parser';
import { calculateOptimizedTaskDistance } from '../src/task-optimizer';
import { scoreTask, resolveCompGapParams, type PilotFlight } from '../src/gap-scoring';
import type { TurnpointReaching } from '../src/turnpoint-sequence';
import {
  buildFieldContext,
  evaluateField,
  renderFieldReport,
  type FieldContext,
  type ReportTable,
} from '../src/field-analysis';
import { DAY_METRICS } from '../src/field-analysis/metrics/day-profile';
import {
  makeTestField,
  straightFixes,
  createFix,
  BASE_TIME,
  TEST_ORIGIN,
  DEG_LAT_PER_M,
  DEG_LON_PER_M,
} from './field-test-helpers';

const [dayWind, dayClimbByHour, dayLaunchTiming] = DAY_METRICS;

// ---------------------------------------------------------------------------
// Fix builders
// ---------------------------------------------------------------------------

/**
 * A circling climb whose circle centre drifts east at `driftEastMps` — the
 * drift reads as wind to the circle detector's centre-drift (and the varying
 * ground speed to its ground-speed) estimator. 1 s fixes, 20 s circles, so
 * each circle has 20 fixes (over the detector's minimum of 8).
 */
function driftingCirclingFixes(
  startSeconds: number,
  durationSeconds: number,
  eastMeters: number,
  altitude: number,
  climbMps: number,
  driftEastMps: number,
): IGCFix[] {
  const fixes: IGCFix[] = [];
  const radius = 60;
  const circleSeconds = 20;
  for (let t = 0; t <= durationSeconds; t += 1) {
    const angle = (2 * Math.PI * t) / circleSeconds;
    const centerEast = eastMeters + driftEastMps * t;
    fixes.push(
      createFix(
        startSeconds + t,
        TEST_ORIGIN.lat + radius * Math.sin(angle) * DEG_LAT_PER_M,
        TEST_ORIGIN.lon + (centerEast + radius * Math.cos(angle)) * DEG_LON_PER_M,
        altitude + climbMps * t,
      ),
    );
  }
  return fixes;
}

/** A minimal TurnpointReaching at BASE_TIME + tSeconds. */
function reaching(taskIndex: number, tSeconds: number): TurnpointReaching {
  return {
    taskIndex,
    fixIndex: 0,
    time: new Date(BASE_TIME.getTime() + tSeconds * 1000),
    latitude: TEST_ORIGIN.lat,
    longitude: TEST_ORIGIN.lon,
    altitude: 1000,
    selectionReason: 'first_after_previous',
    candidateCount: 1,
  };
}

/**
 * Field with one pilot climbing in a wind-drifted thermal (SSS reached at
 * t=80 s, next turnpoint at t=600 s — the circling sits inside the SSS→ESS
 * leg) and one pilot gliding straight.
 */
function makeDriftField(opts?: { timeZone?: string }): FieldContext {
  const circler = [
    ...straightFixes(0, 60, -720, 800, 12, 0), // arrives at east = 0
    ...driftingCirclingFixes(70, 300, 0, 800, 2, 4), // 4 m/s eastward drift → wind FROM ~270°
    ...straightFixes(380, 300, 1300, 1400, 12, -1),
  ];
  const glider = straightFixes(0, 680, 0, 1500, 12, -0.5);
  return makeTestField(
    [
      {
        name: 'circler',
        fixes: circler,
        turnpointResult: {
          sssReaching: reaching(1, 80),
          sequence: [reaching(1, 80), reaching(2, 600)],
          lastTurnpointReached: 2,
        },
      },
      { name: 'glider', fixes: glider },
    ],
    { timeZone: opts?.timeZone },
  );
}

/** Field where nobody circles — no circles, no thermals. */
function makeStraightField(): FieldContext {
  return makeTestField([
    { name: 'a', fixes: straightFixes(0, 600, 0, 1500, 12, -0.5) },
    { name: 'b', fixes: straightFixes(0, 600, 2000, 1400, 12, -0.5) },
  ]);
}

function firstTable(metricIndex: number, field: FieldContext): ReportTable {
  const out = DAY_METRICS[metricIndex].compute(field);
  expect(out.extraTables?.length).toBe(1);
  return out.extraTables![0];
}

// ---------------------------------------------------------------------------
// #24 day.wind
// ---------------------------------------------------------------------------

describe('day.wind', () => {
  it('averages per-circle wind for task, hour, and leg scopes', () => {
    const field = makeDriftField();
    const out = dayWind.compute(field);

    // Field-level metric: every pilot present, all values null.
    expect(out.perPilot.length).toBe(2);
    expect(out.perPilot.every((v) => v.value === null)).toBe(true);

    const table = out.extraTables![0];
    expect(table.columns.length).toBe(4);

    // Task row first, with real samples from the drifting circles.
    const taskRow = table.rows[0];
    expect(taskRow[0]).toBe('Task');
    const n = Number(taskRow[3]);
    expect(n).toBeGreaterThan(0);
    const speedKmh = Number(taskRow[1]);
    expect(speedKmh).toBeGreaterThan(5); // 4 m/s drift = 14.4 km/h
    expect(speedKmh).toBeLessThan(40);
    const dir = Number(taskRow[2]);
    expect(dir).toBeGreaterThanOrEqual(225); // eastward drift → wind FROM ~west
    expect(dir).toBeLessThanOrEqual(315);

    // Hourly row: all fixes start at BASE_TIME (10:00 UTC).
    const hourRow = table.rows.find((r) => r[0] === '10:00 UTC');
    expect(hourRow).toBeDefined();
    expect(Number(hourRow![3])).toBe(n); // every sample falls in that hour

    // Leg rows: circling happened between SSS (t=80) and TP2 (t=600).
    const legRow = table.rows.find((r) => r[0] === 'SSS→ESS');
    expect(legRow).toBeDefined();
    expect(Number(legRow![3])).toBeGreaterThan(0);
    const laterLeg = table.rows.find((r) => r[0] === 'ESS→GOAL');
    expect(laterLeg).toBeDefined();
    expect(Number(laterLeg![3])).toBe(0);

    // Footnotes explain method and direction convention.
    expect(table.footnotes!.join(' ')).toContain('FROM');
    expect(table.footnotes!.join(' ')).toContain('drift');
  });

  it('emits a Task row with n=0 when the field produced no circles', () => {
    const table = firstTable(0, makeStraightField());
    expect(table.rows[0]).toEqual(['Task', '—', '—', '0']);
    // No hour rows; the two speed-section legs listed with zero samples.
    expect(table.rows.length).toBe(3);
    expect(table.rows[1][0]).toBe('SSS→ESS');
    expect(table.rows[2][0]).toBe('ESS→GOAL');
    expect(table.rows.every((r, i) => i === 0 || r[3] === '0')).toBe(true);
  });

  it('labels hour rows in the competition time zone when one is given', () => {
    // BASE_TIME is 2024-01-15T10:00:00Z; in Melbourne (AEDT, +11) that hour
    // reads 21:00. The default (no zone) stays UTC — proving it is the
    // explicit input, not the runtime's zone, that moves the label.
    const utcRow = firstTable(0, makeDriftField()).rows.find((r) => r[0] === '10:00 UTC');
    expect(utcRow).toBeDefined();

    const zoned = firstTable(0, makeDriftField({ timeZone: 'Australia/Melbourne' }));
    const zonedRow = zoned.rows.find((r) => r[0] === '21:00 AEDT');
    expect(zonedRow).toBeDefined();
    // Same samples, just a relabelled hour: no UTC hour row survives.
    expect(zoned.rows.some((r) => /UTC/.test(r[0]))).toBe(false);
    // The sample count is unchanged by the relabelling.
    expect(zonedRow![3]).toBe(utcRow![3]);
  });
});

// ---------------------------------------------------------------------------
// #25 day.climb_by_hour
// ---------------------------------------------------------------------------

describe('day.climb_by_hour', () => {
  it('buckets thermal uses by UTC hour with median and p90', () => {
    const field = makeDriftField();
    expect(field.sharedThermals.length).toBeGreaterThan(0); // the drifting climb was detected

    const out = dayClimbByHour.compute(field);
    expect(out.perPilot.every((v) => v.value === null)).toBe(true);

    const table = out.extraTables![0];
    expect(table.rows.length).toBeGreaterThanOrEqual(1);
    const row = table.rows[0];
    expect(row[0]).toBe('10:00 UTC'); // BASE_TIME hour
    const med = Number(row[1]);
    const p90 = Number(row[2]);
    expect(med).toBeGreaterThan(0.5); // built with a 2 m/s climb
    expect(med).toBeLessThan(3.5);
    expect(p90).toBeGreaterThanOrEqual(med);
    expect(Number(row[3])).toBeGreaterThanOrEqual(1);
  });

  it('renders an empty table when the field has no thermals', () => {
    const table = firstTable(1, makeStraightField());
    expect(table.rows.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// #26 day.launch_timing
// ---------------------------------------------------------------------------

describe('day.launch_timing', () => {
  it('scores non-sinking flight near 100 and hard sink near 0', () => {
    const field = makeTestField([
      { name: 'floaty', fixes: straightFixes(0, 600, 0, 1000, 12, 0) },
      { name: 'sinky', fixes: straightFixes(0, 600, 2000, 2000, 12, -2) },
    ]);
    const out = dayLaunchTiming.compute(field);
    const byFile = new Map(out.perPilot.map((v) => [v.trackFile, v.value]));

    const floaty = byFile.get('floaty.igc');
    expect(floaty).not.toBeNull();
    expect(floaty!).toBeGreaterThan(95);

    const sinky = byFile.get('sinky.igc');
    expect(sinky).not.toBeNull();
    expect(sinky!).toBeLessThan(10);

    // Field summary is one line: conditions vs takeoff spread, UTC clock.
    expect(out.fieldSummary?.length).toBe(1);
    expect(out.fieldSummary![0]).toContain('takeoffs earliest');
    expect(out.fieldSummary![0]).toContain('UTC');
  });

  it('names the best-conditions hour when thermals exist', () => {
    const out = dayLaunchTiming.compute(makeDriftField());
    expect(out.fieldSummary![0]).toContain('Best conditions around 10:00 UTC');
  });

  it('returns null for a pilot with no grid samples', () => {
    const field = makeTestField([
      { name: 'flies', fixes: straightFixes(0, 600, 0, 1000, 12, 0) },
      { name: 'ghost', fixes: straightFixes(0, 600, 2000, 1000, 12, 0) },
    ]);
    // Simulate a pilot who never made it onto the grid.
    const ghost = field.pilots.find((p) => p.trackFile === 'ghost.igc')!;
    ghost.track = { startStep: -1, endStep: -1, samples: ghost.track.samples.map(() => null) };

    const out = dayLaunchTiming.compute(field);
    const byFile = new Map(out.perPilot.map((v) => [v.trackFile, v.value]));
    expect(byFile.get('ghost.igc')).toBeNull();
    expect(byFile.get('flies.igc')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Smoke test over the real kosci-loop-t1 field
// ---------------------------------------------------------------------------

const KOSCI_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../samples/comps/kosci-loop-t1',
);

/** Score kosci-loop-t1 and build the field (pattern from field-analysis.test.ts). */
function buildKosciField(): FieldContext {
  const entries = readdirSync(KOSCI_DIR);
  const taskFile = entries.find((f) => f.endsWith('.xctsk'))!;
  const task = parseXCTask(readFileSync(join(KOSCI_DIR, taskFile), 'utf-8'));

  const pilots: PilotFlight[] = entries
    .filter((f) => f.endsWith('.igc'))
    .sort()
    .map((f) => {
      const igc = parseIGC(readFileSync(join(KOSCI_DIR, f), 'utf-8'));
      return { pilotName: igc.header.pilot || f, trackFile: join(KOSCI_DIR, f), fixes: igc.fixes };
    });

  const gapParams = resolveCompGapParams('pg', { scoring: 'PG' });
  gapParams.nominalDistance = 0.7 * calculateOptimizedTaskDistance(task);
  const result = scoreTask(task, pilots, gapParams);
  return buildFieldContext(task, pilots, result, 'pg');
}

describe('day metrics over kosci-loop-t1 (smoke)', () => {
  it('evaluates all three metrics without errors on a real field', () => {
    const field = buildKosciField();
    const report = evaluateField(field, DAY_METRICS);
    expect(report.metrics.length).toBe(3);
    for (const m of report.metrics) {
      expect(m.error).toBeUndefined();
      expect(m.perPilot.length).toBe(field.pilots.length);
    }

    // Wind table exists and starts with the Task row.
    const wind = report.metrics.find((m) => m.id === 'day.wind')!;
    expect(wind.extraTables![0].rows[0][0]).toBe('Task');

    // The day had thermals — the climb-by-hour table is non-empty.
    const climb = report.metrics.find((m) => m.id === 'day.climb_by_hour')!;
    expect(climb.extraTables![0].rows.length).toBeGreaterThan(0);

    // Launch timing is non-null for most of the field.
    const timing = report.metrics.find((m) => m.id === 'day.launch_timing')!;
    const nonNull = timing.perPilot.filter((v) => v.value !== null).length;
    expect(nonNull).toBeGreaterThan(field.pilots.length / 2);
    for (const v of timing.perPilot) {
      if (v.value !== null) {
        expect(v.value).toBeGreaterThanOrEqual(0);
        expect(v.value).toBeLessThanOrEqual(100);
      }
    }

    // The whole thing renders.
    const rendered = renderFieldReport(report);
    expect(rendered).toContain('Wind (from circling drift)');
    expect(rendered).toContain('Climb by hour');
  }, 120_000);
});
