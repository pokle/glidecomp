/**
 * P6 day-profile metric family tests (day.wind, day.climb_by_hour,
 * day.airtime_quality) — see docs/2026-07-18-field-analysis-plan.md.
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
import { DAY_METRICS, pickBestConditionsHour,
  climbQuantiles,
} from '../src/field-analysis/metrics/day-profile';
import {
  makeTestField,
  straightFixes,
  createFix,
  BASE_TIME,
  TEST_ORIGIN,
  DEG_LAT_PER_M,
  DEG_LON_PER_M,
} from './field-test-helpers';

const [dayWind, dayClimbByHour, dayAirtimeQuality] = DAY_METRICS;

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
function makeDriftField(): FieldContext {
  const circler = [
    ...straightFixes(0, 60, -720, 800, 12, 0), // arrives at east = 0
    ...driftingCirclingFixes(70, 300, 0, 800, 2, 4), // 4 m/s eastward drift → wind FROM ~270°
    ...straightFixes(380, 300, 1300, 1400, 12, -1),
  ];
  const glider = straightFixes(0, 680, 0, 1500, 12, -0.5);
  return makeTestField([
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
  ]);
}

/**
 * The reported symptom, reproduced: a leader who glides most of leg 1 and
 * circles EARLY on leg 2, plus a tail pilot still circling leg 1 long after
 * the leader has left it. The legs' circling windows then come out of course
 * order — which is honest about where the wind was measured, and reads as the
 * course being flown out of order unless the flown windows are drawn too.
 */
function makeGlidedLastLegField(): FieldContext {
  const leader = [
    ...straightFixes(0, 390, 0, 1600, 12, -0.5),
    ...driftingCirclingFixes(400, 100, 4800, 1400, 2, 4), // inside leg 2 (300–1400 s)
    ...straightFixes(510, 890, 6000, 1600, 12, -0.5),
  ];
  const tail = [
    ...straightFixes(0, 790, 0, 1600, 12, -0.5),
    ...driftingCirclingFixes(800, 100, 9600, 1400, 2, 4), // inside leg 1 (0–1000 s)
    ...straightFixes(910, 90, 10800, 1600, 12, -0.5),
  ];
  return makeTestField([
    {
      name: 'leader',
      fixes: leader,
      turnpointResult: {
        sssReaching: reaching(1, 0),
        sequence: [reaching(1, 0), reaching(2, 300), reaching(3, 1400)],
        lastTurnpointReached: 3,
      },
    },
    {
      name: 'tail',
      fixes: tail,
      turnpointResult: {
        sssReaching: reaching(1, 0),
        sequence: [reaching(1, 0), reaching(2, 1000)],
        lastTurnpointReached: 2,
      },
    },
  ]);
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
  expect(out.extraTables?.length).toBeGreaterThanOrEqual(1);
  return out.extraTables![0];
}

// ---------------------------------------------------------------------------
// #24 day.wind
// ---------------------------------------------------------------------------

describe('day.wind', () => {
  it('splits into a by-hour table (whole-task total + hours) and a by-leg table', () => {
    const field = makeDriftField();
    const out = dayWind.compute(field);

    // Field-level metric: every pilot present, all values null.
    expect(out.perPilot.length).toBe(2);
    expect(out.perPilot.every((v) => v.value === null)).toBe(true);

    expect(out.extraTables!.map((t) => t.title)).toEqual(['Wind by hour', 'Wind by leg']);
    const [byHour, byLeg] = out.extraTables!;

    // By-hour table: whole-task total first, with real samples from the drift.
    expect(byHour.columns[0].header).toBe('Period');
    const taskRow = byHour.rows[0];
    expect(taskRow[0]).toBe('Whole task');
    const n = Number(taskRow[3]);
    expect(n).toBeGreaterThan(0);
    const speedKmh = Number(taskRow[1]);
    expect(speedKmh).toBeGreaterThan(5); // 4 m/s drift = 14.4 km/h
    expect(speedKmh).toBeLessThan(40);
    const dir = Number(taskRow[2]);
    expect(dir).toBeGreaterThanOrEqual(225); // eastward drift → wind FROM ~west
    expect(dir).toBeLessThanOrEqual(315);

    // Hourly row: all fixes start at BASE_TIME (10:00 UTC), emitted as an instant.
    const hourRow = byHour.rows.find(
      (r) => typeof r[0] === 'object' && 't' in r[0] && r[0].t === '2024-01-15T10:00:00.000Z',
    );
    expect(hourRow).toBeDefined();
    expect(Number(hourRow![3])).toBe(n); // every sample falls in that hour

    // By-leg table: labelled by waypoint name + role, with the leg's flown
    // window and the narrower window its wind was measured in.
    expect(byLeg.columns.map((c) => c.header)).toEqual([
      'Leg', 'Flown', 'Pilots', 'Circling', 'Speed (km/h)', 'Dir (°)', 'n', 'From pilots',
    ]);
    const legRow = byLeg.rows.find((r) => r[0] === 'START (SSS)→END (ESS)');
    expect(legRow).toBeDefined();
    expect(Number(legRow![6])).toBeGreaterThan(0); // n
    expect(legRow![7]).toBe('1'); // one pilot behind those estimates
    // The circler flew the whole leg (SSS at t=80 s → next TP at t=600 s).
    expect(legRow![2]).toBe('1');
    const flownWhen = legRow![1] as { from: string; to: string };
    expect(typeof flownWhen).toBe('object');
    expect('from' in flownWhen && 'to' in flownWhen).toBe(true);
    // Circling happened on this leg, so it too is an instant range — and it
    // sits INSIDE the flown window, which is the invariant the chart nests on.
    const circling = legRow![3] as { from: string; to: string };
    expect(typeof circling).toBe('object');
    expect(new Date(circling.from).getTime()).toBeGreaterThanOrEqual(new Date(flownWhen.from).getTime());
    expect(new Date(circling.to).getTime()).toBeLessThanOrEqual(new Date(flownWhen.to).getTime());

    // A leg no one flew or circled on: every window "—" and both counts 0.
    const laterLeg = byLeg.rows.find((r) => r[0] === 'END (ESS)→GOAL (GOAL)');
    expect(laterLeg).toBeDefined();
    expect(Number(laterLeg![6])).toBe(0);
    expect(laterLeg![1]).toBe('—');
    expect(laterLeg![3]).toBe('—');
    expect(laterLeg![7]).toBe('0');

    // Footnotes explain method, direction convention, and both windows.
    expect(byHour.footnotes!.join(' ')).toContain('FROM');
    expect(byLeg.footnotes!.join(' ')).toContain('when the field was ON the leg');
    expect(byLeg.footnotes!.join(' ')).toContain('EARLIER than the leg before it');
  });

  it('handles a field that produced no circles', () => {
    const out = dayWind.compute(makeStraightField());
    const [byHour, byLeg] = out.extraTables!;

    // By-hour: just the whole-task total, empty, no hour rows.
    expect(byHour.rows.length).toBe(1);
    expect(byHour.rows[0]).toEqual(['Whole task', '—', '—', '0']);

    // By-leg: both speed-section legs, zero samples, both windows dashed.
    expect(byLeg.rows.map((r) => r[0])).toEqual([
      'START (SSS)→END (ESS)',
      'END (ESS)→GOAL (GOAL)',
    ]);
    expect(byLeg.rows.every((r) => r[1] === '—' && r[3] === '—' && r[6] === '0')).toBe(true);
  });

  it('emits wind-hourly and wind-legs series that agree with the tables', () => {
    const out = dayWind.compute(makeDriftField());
    expect(out.extraSeries!.map((s) => s.kind)).toEqual(['wind-hourly', 'wind-legs']);
    const [hourly, legs] = out.extraSeries!;
    if (hourly.kind !== 'wind-hourly' || legs.kind !== 'wind-legs') throw new Error('kinds');

    // The whole-task vector mean matches the table's "Whole task" row.
    const taskRow = out.extraTables![0].rows[0];
    expect(hourly.wholeTask).not.toBeNull();
    expect(hourly.wholeTask!.speedKmh.toFixed(1)).toBe(taskRow[1] as string);
    expect(String(Math.round(hourly.wholeTask!.directionDeg) % 360)).toBe(taskRow[2] as string);
    expect(String(hourly.wholeTask!.n)).toBe(taskRow[3] as string);

    // One hourly point, in the BASE_TIME hour, same numbers as the hour row.
    expect(hourly.hours.length).toBe(1);
    expect(hourly.hours[0].t).toBe('2024-01-15T10:00:00.000Z');
    expect(hourly.hours[0].n).toBe(hourly.wholeTask!.n);

    // Legs: the circled leg carries both windows + wind; the empty leg is null/0.
    const circled = legs.legs.find((l) => l.label === 'START (SSS)→END (ESS)')!;
    expect(circled.n).toBeGreaterThan(0);
    expect(circled.from).not.toBeNull();
    expect(circled.to).not.toBeNull();
    expect(circled.speedKmh!).toBeGreaterThan(5);
    // The flown window contains the circling window, and both counts are the
    // one pilot who flew the leg.
    expect(new Date(circled.flownFrom!).getTime()).toBeLessThanOrEqual(new Date(circled.from!).getTime());
    expect(new Date(circled.flownTo!).getTime()).toBeGreaterThanOrEqual(new Date(circled.to!).getTime());
    expect(circled.pilotsOnLeg).toBe(1);
    expect(circled.pilotsWithEstimates).toBe(1);
    const empty = legs.legs.find((l) => l.label === 'END (ESS)→GOAL (GOAL)')!;
    expect(empty).toEqual({
      label: 'END (ESS)→GOAL (GOAL)',
      from: null,
      to: null,
      flownFrom: null,
      flownTo: null,
      pilotsOnLeg: 0,
      speedKmh: null,
      directionDeg: null,
      n: 0,
      pilotsWithEstimates: 0,
    });
  });

  it('gives a later leg an earlier circling window, but never an earlier flown one', () => {
    const out = dayWind.compute(makeGlidedLastLegField());
    const legs = out.extraSeries!.find((s) => s.kind === 'wind-legs')!;
    if (legs.kind !== 'wind-legs') throw new Error('kind');
    const [leg1, leg2] = legs.legs;
    expect([leg1.label, leg2.label]).toEqual([
      'START (SSS)→END (ESS)',
      'END (ESS)→GOAL (GOAL)',
    ]);
    expect(leg1.n).toBeGreaterThan(0);
    expect(leg2.n).toBeGreaterThan(0);

    // The symptom: leg 2's wind was measured and done before leg 1's was
    // taken at all, because the leader glided leg 1 and the tail pilot's
    // circles on it came late.
    expect(new Date(leg2.to!).getTime()).toBeLessThan(new Date(leg1.from!).getTime());

    // The fix: the flown windows are in course order and each contains its
    // own circling window, so the chart can nest one inside the other.
    expect(new Date(leg1.flownFrom!).getTime()).toBeLessThanOrEqual(
      new Date(leg2.flownFrom!).getTime(),
    );
    for (const l of [leg1, leg2]) {
      expect(new Date(l.flownFrom!).getTime()).toBeLessThanOrEqual(new Date(l.from!).getTime());
      expect(new Date(l.flownTo!).getTime()).toBeGreaterThanOrEqual(new Date(l.to!).getTime());
    }

    // Both pilots flew leg 1; only the leader flew leg 2, and one pilot's
    // circles are the whole of its wind.
    expect(leg1.pilotsOnLeg).toBe(2);
    expect(leg2.pilotsOnLeg).toBe(1);
    expect(leg1.pilotsWithEstimates).toBe(1);
    expect(leg2.pilotsWithEstimates).toBe(1);
  });

  it('emits times as instants the consumer renders in its zone', () => {
    // The engine never bakes a zone: hours are instants and the leg window is a
    // range; no cell is a pre-formatted "…UTC" string.
    const out = dayWind.compute(makeDriftField());
    const hourCell = out.extraTables![0].rows.map((r) => r[0]).find((c) => typeof c === 'object');
    expect(hourCell).toEqual({ t: '2024-01-15T10:00:00.000Z' });

    // The CLI renderer formats those in the zone it is given: Melbourne (AEDT,
    // +11) reads 21:00 for BASE_TIME's 10:00Z hour; the default is UTC. The leg
    // leg windows render as a range with a single trailing token.
    const report = evaluateField(makeDriftField(), DAY_METRICS);
    const zoned = renderFieldReport(report, { timeZone: 'Australia/Melbourne' });
    expect(zoned).toContain('21:00 AEDT');
    expect(zoned).toMatch(/\d{2}:\d{2}–\d{2}:\d{2} AEDT/); // the leg When range
    expect(renderFieldReport(report)).toContain('10:00 UTC');
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
    expect(table.rows.length).toBeGreaterThanOrEqual(2);
    // Row 0 is the whole-task total; the hours follow it.
    expect(table.rows[0][0]).toBe('Whole task');
    const row = table.rows[1];
    expect(row[0]).toEqual({ t: '2024-01-15T10:00:00.000Z' }); // BASE_TIME hour, as an instant
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

  it('emits a climb-hourly series with an ordered quantile fan matching the table', () => {
    const out = dayClimbByHour.compute(makeDriftField());
    const series = out.extraSeries![0];
    if (series.kind !== 'climb-hourly') throw new Error('kind');
    // One row per hour, plus the leading whole-task total.
    expect(series.hours.length).toBe(out.extraTables![0].rows.length - 1);

    const hour = series.hours[0];
    const row = out.extraTables![0].rows[1];
    expect(hour.t).toBe((row[0] as { t: string }).t);
    expect(hour.median.toFixed(1)).toBe(row[1] as string);
    expect(hour.p90.toFixed(1)).toBe(row[2] as string);
    expect(String(hour.n)).toBe(row[3] as string);
    // The fan is ordered.
    expect(hour.p10).toBeLessThanOrEqual(hour.p25);
    expect(hour.p25).toBeLessThanOrEqual(hour.median);
    expect(hour.median).toBeLessThanOrEqual(hour.p75);
    expect(hour.p75).toBeLessThanOrEqual(hour.p90);
  });
});

// ---------------------------------------------------------------------------
// #26 day.airtime_quality
// ---------------------------------------------------------------------------

describe('day.airtime_quality', () => {
  it('scores non-sinking flight near 100 and hard sink near 0', () => {
    const field = makeTestField([
      { name: 'floaty', fixes: straightFixes(0, 600, 0, 1000, 12, 0) },
      { name: 'sinky', fixes: straightFixes(0, 600, 2000, 2000, 12, -2) },
    ]);
    const out = dayAirtimeQuality.compute(field);
    const byFile = new Map(out.perPilot.map((v) => [v.trackFile, v.value]));

    const floaty = byFile.get('floaty.igc');
    expect(floaty).not.toBeNull();
    expect(floaty!).toBeGreaterThan(95);

    const sinky = byFile.get('sinky.igc');
    expect(sinky).not.toBeNull();
    expect(sinky!).toBeLessThan(10);

    // The timing summary is a table of instants (no baked zone), not prose.
    expect(out.fieldSummary).toBeUndefined();
    const timing = out.extraTables![0];
    expect(timing.title).toBe('Day timing');
    const labels = timing.rows.map((r) => r[0]);
    expect(labels).toContain('Earliest takeoff');
    expect(labels).toContain('Median takeoff');
    expect(labels).toContain('Latest takeoff');
    // Every time cell is a machine-readable instant, never a "…UTC" string.
    for (const r of timing.rows) {
      expect(typeof r[1]).toBe('object');
      expect((r[1] as { t: string }).t).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it('gives the best-conditions hour as a one-hour range', () => {
    // makeDriftField's climbs are all in the 10:00Z hour, so that hour wins and
    // is reported as the 10:00–11:00 window (not a bare 10:00 instant) — a
    // takeoff inside the window then reads as no contradiction.
    const out = dayAirtimeQuality.compute(makeDriftField());
    const timing = out.extraTables![0];
    const best = timing.rows.find((r) => r[0] === 'Best conditions');
    expect(best).toBeDefined();
    expect(best![1]).toEqual({
      from: '2024-01-15T10:00:00.000Z',
      to: '2024-01-15T11:00:00.000Z',
    });
  });

  it('ignores a sparse edge hour when picking best conditions', () => {
    const t = (hour: number) => Date.UTC(2024, 0, 15, hour, 0, 0);
    // 01:00 has one very strong climb (median 5); 02:00 and 03:00 are busy at
    // median 1. Raw median would crown 01:00 — but with only 1 of 20 climbs it
    // is below the 20% floor, so 02:00 (the earliest busy hour) wins instead.
    const buckets = new Map<number, number[]>([
      [t(1), [5]],
      [t(2), Array(20).fill(1)],
      [t(3), Array(18).fill(1)],
    ]);
    const best = pickBestConditionsHour(buckets);
    expect(best).toEqual({ hourMs: t(2), median: 1 });
    // With only the sparse hour present it is the busiest, so it qualifies.
    expect(pickBestConditionsHour(new Map([[t(1), [5]]]))).toEqual({ hourMs: t(1), median: 5 });
  });

  it('emits a day-timing series with best hour, takeoffs, and the task clock', () => {
    const out = dayAirtimeQuality.compute(makeDriftField());
    const series = out.extraSeries![0];
    if (series.kind !== 'day-timing') throw new Error('kind');

    // Best hour mirrors the table's range cell.
    expect(series.bestHour).toEqual({
      from: '2024-01-15T10:00:00.000Z',
      to: '2024-01-15T11:00:00.000Z',
    });
    // Every pilot's takeoff, ascending ISO instants.
    expect(series.takeoffs.length).toBe(2);
    expect([...series.takeoffs].sort()).toEqual(series.takeoffs);
    // The test task defines no gates, launch window, or deadline.
    expect(series.startGates).toEqual([]);
    expect(series.launchOpen).toBeNull();
    expect(series.deadline).toBeNull();
  });

  it('returns null for a pilot with no grid samples', () => {
    const field = makeTestField([
      { name: 'flies', fixes: straightFixes(0, 600, 0, 1000, 12, 0) },
      { name: 'ghost', fixes: straightFixes(0, 600, 2000, 1000, 12, 0) },
    ]);
    // Simulate a pilot who never made it onto the grid.
    const ghost = field.pilots.find((p) => p.trackFile === 'ghost.igc')!;
    ghost.track = { startStep: -1, endStep: -1, samples: ghost.track.samples.map(() => null) };

    const out = dayAirtimeQuality.compute(field);
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

    // Wind splits into by-hour (whole-task total first) and by-leg tables.
    const wind = report.metrics.find((m) => m.id === 'day.wind')!;
    expect(wind.extraTables!.map((t) => t.title)).toEqual(['Wind by hour', 'Wind by leg']);
    expect(wind.extraTables![0].rows[0][0]).toBe('Whole task');

    // The day had thermals — the climb-by-hour table is non-empty.
    const climb = report.metrics.find((m) => m.id === 'day.climb_by_hour')!;
    expect(climb.extraTables![0].rows.length).toBeGreaterThan(0);

    // Launch timing is non-null for most of the field.
    const timing = report.metrics.find((m) => m.id === 'day.airtime_quality')!;
    const nonNull = timing.perPilot.filter((v) => v.value !== null).length;
    expect(nonNull).toBeGreaterThan(field.pilots.length / 2);
    for (const v of timing.perPilot) {
      if (v.value !== null) {
        expect(v.value).toBeGreaterThanOrEqual(0);
        expect(v.value).toBeLessThanOrEqual(100);
      }
    }

    // Every charting series ships alongside its table. Kosci tasks are gated
    // races (4 gates, no goal deadline), so the timing series carries them.
    expect(wind.extraSeries!.map((s) => s.kind)).toEqual(['wind-hourly', 'wind-legs']);
    expect(climb.extraSeries!.map((s) => s.kind)).toEqual(['climb-hourly']);
    const timingSeries = timing.extraSeries![0];
    if (timingSeries.kind !== 'day-timing') throw new Error('kind');
    expect(timingSeries.takeoffs.length).toBe(field.pilots.length);
    expect(timingSeries.startGates.length).toBe(4);
    expect(timingSeries.deadline).toBeNull();

    // The whole thing renders.
    const rendered = renderFieldReport(report);
    expect(rendered).toContain('Wind by hour');
    expect(rendered).toContain('Wind by leg');
    expect(rendered).toContain('Climb by hour');
  }, 120_000);
});

describe('climbQuantiles', () => {
  it('is null for no climbs rather than a fan of NaN', () => {
    expect(climbQuantiles([])).toBeNull();
  });

  it('orders the fan and counts every sample', () => {
    const fan = climbQuantiles([3, 1, 2, 5, 4])!;
    expect(fan.n).toBe(5);
    expect(fan.p10).toBeLessThanOrEqual(fan.p25);
    expect(fan.p25).toBeLessThanOrEqual(fan.median);
    expect(fan.median).toBeLessThanOrEqual(fan.p75);
    expect(fan.p75).toBeLessThanOrEqual(fan.p90);
    expect(fan.median).toBeCloseTo(3, 10);
  });

  it('does not mutate the caller’s array', () => {
    const rates = [3, 1, 2];
    climbQuantiles(rates);
    expect(rates).toEqual([3, 1, 2]);
  });

  it('pools the climbs instead of averaging the hours', () => {
    // A lopsided day: one busy weak hour, one thin strong hour — exactly the
    // shape that makes a mean of hourly medians misdescribe the day. A pilot
    // asking "what was a typical climb?" is answered by the 21 climbs, not by
    // the two hours weighted equally.
    const weakHour = Array.from({ length: 18 }, () => 1);
    const strongHour = [5, 5, 5];
    const hourlyMedians = [
      climbQuantiles(weakHour)!.median,
      climbQuantiles(strongHour)!.median,
    ];
    const meanOfHourlyMedians = (hourlyMedians[0] + hourlyMedians[1]) / 2;

    const pooled = climbQuantiles([...weakHour, ...strongHour])!;
    expect(pooled.n).toBe(21);
    expect(pooled.median).toBe(1); // the 11th of 21 sorted samples
    expect(meanOfHourlyMedians).toBe(3); // what the wrong answer would be
    expect(pooled.median).not.toBe(meanOfHourlyMedians);
    // The strong hour still reaches the top of the fan — it is a tenth of the
    // day's climbs, so p90 sits inside it.
    expect(pooled.p90).toBeGreaterThan(1);
  });

  it('cuts the same fan for one hour as for a whole task of that hour', () => {
    // The helper is the ONLY path to a published climb percentile, so the
    // hourly rows and the total can never disagree about what p90 means.
    const rates = [0.4, 1.1, 1.9, 2.2, 2.8, 3.6];
    expect(climbQuantiles(rates)).toEqual(climbQuantiles([...rates].reverse()));
  });
});
