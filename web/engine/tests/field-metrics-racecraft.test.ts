/**
 * Race-craft metric family tests (Stage 1 package P5, metrics 19–23).
 *
 * The synthetic field drives the metrics through hand-crafted
 * `turnpointResult` overrides — chosen crossing times produce known delays,
 * leg times, and horserace deltas — plus one real-fixes pilot (alpha) whose
 * detected thermal exercises `race.final_glide_init`. A final smoke test runs
 * the family over the real kosci-loop-t1 field.
 */

import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { parseIGC } from '../src/igc-parser';
import { parseXCTask, type XCTask } from '../src/xctsk-parser';
import { calculateOptimizedTaskDistance } from '../src/task-optimizer';
import { scoreTask, resolveCompGapParams, type PilotFlight } from '../src/gap-scoring';
import type { TurnpointReaching } from '../src/turnpoint-sequence-types';
import { andoyerDistance } from '../src/geo';
import {
  buildFieldContext,
  evaluateField,
  type FieldContext,
  type MetricOutput,
} from '../src/field-analysis';
import { spearman } from '../src/field-analysis/stats';
import { RACECRAFT_METRICS } from '../src/field-analysis/metrics/racecraft';
import {
  makeTestField,
  straightFixes,
  circlingFixes,
  BASE_TIME,
  TEST_ORIGIN,
  DEG_LON_PER_M,
} from './field-test-helpers';

// ---------------------------------------------------------------------------
// Synthetic field
// ---------------------------------------------------------------------------

/**
 * A race with two speed-section legs: TAKEOFF, SSS (5 km), MIDTP (10 km),
 * ESS (15 km), GOALWP (22 km east). The long final leg keeps the
 * final-glide-init distance gate (1.5× last-leg distance) satisfiable.
 */
function makeRaceTask(): XCTask {
  const tp = (
    eastMeters: number,
    radius: number,
    name: string,
    type?: 'TAKEOFF' | 'SSS' | 'ESS',
  ) => ({
    ...(type ? { type } : {}),
    radius,
    waypoint: {
      name,
      lat: TEST_ORIGIN.lat,
      lon: TEST_ORIGIN.lon + eastMeters * DEG_LON_PER_M,
      altSmoothed: 300,
    },
  });
  return {
    taskType: 'CLASSIC',
    version: 1,
    turnpoints: [
      tp(0, 400, 'LAUNCH', 'TAKEOFF'),
      tp(5_000, 2_000, 'START', 'SSS'),
      tp(10_000, 400, 'MIDTP'),
      tp(15_000, 400, 'END', 'ESS'),
      tp(22_000, 200, 'GOALWP'),
    ],
    sss: { type: 'RACE', direction: 'ENTER' },
    goal: { type: 'CYLINDER' },
  };
}

const GATE_SECONDS = 600;
const gateTime = new Date(BASE_TIME.getTime() + GATE_SECONDS * 1000);

function reach(
  taskIndex: number,
  seconds: number,
  eastMeters: number,
  altitude: number,
): TurnpointReaching {
  return {
    taskIndex,
    fixIndex: 0,
    time: new Date(BASE_TIME.getTime() + seconds * 1000),
    latitude: TEST_ORIGIN.lat,
    longitude: TEST_ORIGIN.lon + eastMeters * DEG_LON_PER_M,
    altitude,
    selectionReason: 'first_after_previous',
    candidateCount: 1,
  };
}

function seqResult(sequence: TurnpointReaching[], essTaskIndex: number | null) {
  return {
    sequence,
    sssReaching: sequence[0] ?? null,
    essReaching:
      essTaskIndex === null
        ? null
        : (sequence.find((r) => r.taskIndex === essTaskIndex) ?? null),
    startGate: { time: gateTime, index: 0, gateCount: 1 },
  };
}

function buildSyntheticField(): FieldContext {
  // alpha (rank 1, wins both legs): real climb near goal for final_glide_init.
  const alphaFixes = [
    ...straightFixes(0, 700, 0, 1200, 20, 0), // → 14 km east at t=700
    ...circlingFixes(710, 300, 14_000, 1200, 2), // climb to ~1800 m, exit t=1010
    ...straightFixes(1020, 400, 14_000, 1800, 15, -2.5), // glide out and land
  ];
  const alphaSeq = [
    reach(1, 610, 5_000, 1450),
    reach(2, 1210, 10_000, 1300),
    reach(3, 1810, 15_000, 1500),
    reach(4, 1900, 22_000, 400),
  ];
  // bravo (rank 2): +60 s on each leg, low at ESS.
  const bravoSeq = [
    reach(1, 640, 5_000, 1300),
    reach(2, 1300, 10_000, 1200),
    reach(3, 1960, 15_000, 500),
  ];
  // charlie (rank 3): slow first leg, never reaches ESS.
  const charlieSeq = [reach(1, 700, 5_000, 1200), reach(2, 1500, 10_000, 900)];

  return makeTestField(
    [
      { name: 'alpha', fixes: alphaFixes, turnpointResult: seqResult(alphaSeq, 3) },
      {
        name: 'bravo',
        fixes: straightFixes(0, 1500, 0, 1500, 12, -0.5),
        turnpointResult: seqResult(bravoSeq, 3),
      },
      {
        name: 'charlie',
        fixes: straightFixes(0, 1500, 0, 1400, 10, -0.6),
        turnpointResult: seqResult(charlieSeq, null),
      },
      // delta (rank 4): never started — the universal null case.
      { name: 'delta', fixes: straightFixes(0, 600, 0, 800, 12, -0.5) },
    ],
    { task: makeRaceTask() },
  );
}

const field = buildSyntheticField();

function metric(id: string) {
  const m = RACECRAFT_METRICS.find((m) => m.id === id);
  expect(m).toBeDefined();
  return m!;
}

function valueOf(out: MetricOutput, trackFile: string): number | null {
  const entry = out.perPilot.find((v) => v.trackFile === trackFile);
  expect(entry).toBeDefined();
  return entry!.value;
}

describe('racecraft metric family (contract)', () => {
  it('registers the five metrics with one perPilot entry per pilot', () => {
    expect(RACECRAFT_METRICS.map((m) => m.id)).toEqual([
      'race.start_delay',
      'race.leg_time_lost',
      'race.time_behind',
      'race.ess_margin',
      'race.final_glide_init',
    ]);
    for (const m of RACECRAFT_METRICS) {
      expect(m.family).toBe('racecraft');
      expect((m.shortLabel ?? '').length).toBeLessThanOrEqual(10);
      const out = m.compute(field);
      expect(out.perPilot.length).toBe(field.pilots.length);
      const files = new Set(out.perPilot.map((v) => v.trackFile));
      expect(files.size).toBe(field.pilots.length);
    }
  });
});

describe('race.start_delay', () => {
  const out = metric('race.start_delay').compute(field);

  it('measures gate → crossing seconds, null when never started', () => {
    expect(valueOf(out, 'alpha.igc')).toBe(10);
    expect(valueOf(out, 'bravo.igc')).toBe(40);
    expect(valueOf(out, 'charlie.igc')).toBe(100);
    expect(valueOf(out, 'delta.igc')).toBeNull(); // null case: no start
  });

  it('emits a start-execution table for started pilots in rank order', () => {
    const table = out.extraTables![0];
    expect(table.title).toBe('Start execution');
    expect(table.columns.length).toBe(5);
    expect(table.rows.length).toBe(3);
    expect(table.rows.map((r) => r[0])).toEqual(['alpha', 'bravo', 'charlie']);
    expect(table.rows.map((r) => r[1])).toEqual(['0:10', '0:40', '1:40']);
    // Crossing altitudes come straight from the sssReaching.
    expect(table.rows[0][2]).toBe('1450');
    // Behind-at-start cells are km strings (grid-based; value depends on fixes).
    for (const row of table.rows) {
      expect(row[4]).toMatch(/^(—|-?\d+\.\d)$/);
    }
  });
});

describe('race.leg_time_lost (waterfall)', () => {
  const out = metric('race.leg_time_lost').compute(field);

  it('sums losses vs the top-N mean leg time', () => {
    // Leg SSS→MIDTP: alpha 600, bravo 660, charlie 800 → mean 686.67.
    // Leg MIDTP→ESS: alpha 600, bravo 660 → mean 630.
    expect(valueOf(out, 'alpha.igc')).toBe(0);
    expect(valueOf(out, 'bravo.igc')).toBeCloseTo(30, 6);
    expect(valueOf(out, 'charlie.igc')).toBeCloseTo(800 - (600 + 660 + 800) / 3, 6);
    expect(valueOf(out, 'delta.igc')).toBeNull(); // null case: no completed leg
  });

  it('renders the waterfall vs the winner with signed m:ss cells', () => {
    const table = out.extraTables![0];
    expect(table.columns.map((c) => c.header)).toEqual([
      'Pilot',
      'SSS→MIDTP',
      'MIDTP→ESS',
      'Total',
    ]);
    expect(table.rows).toEqual([
      ['alpha', '+0:00', '+0:00', '+0:00'],
      ['bravo', '+1:00', '+1:00', '+2:00'],
      ['charlie', '+3:20', '—', '+3:20'],
    ]);
    expect(table.footnotes!.length).toBeGreaterThan(0);
  });
});

describe('race.time_behind (horserace)', () => {
  const out = metric('race.time_behind').compute(field);

  it('scores minutes behind the leader at ESS', () => {
    expect(valueOf(out, 'alpha.igc')).toBe(0);
    // bravo: elapsed 1360 s vs alpha's 1210 s → 150 s = 2.5 min behind.
    expect(valueOf(out, 'bravo.igc')).toBeCloseTo(2.5, 6);
    expect(valueOf(out, 'charlie.igc')).toBeNull(); // null case: no ESS
    expect(valueOf(out, 'delta.igc')).toBeNull(); // null case: no start
  });

  it('renders per-turnpoint minutes behind with — for unreached turnpoints', () => {
    const table = out.extraTables![0];
    expect(table.columns.map((c) => c.header)).toEqual([
      'Pilot',
      'START',
      'MIDTP',
      'END',
      'GOALWP',
    ]);
    expect(table.rows).toEqual([
      ['alpha', '0.0', '0.0', '0.0', '0.0'],
      ['bravo', '0.5', '1.5', '2.5', '—'],
      ['charlie', '1.5', '4.8', '—', '—'],
    ]);
  });

  it('notes the sanity-check role in its explanation', () => {
    expect(metric('race.time_behind').explanation).toContain('sanity check');
  });
});

describe('race.ess_margin', () => {
  const out = metric('race.ess_margin').compute(field);
  const goalWp = field.task.turnpoints[4].waypoint;
  // Both ESS pilots crossed at the ESS waypoint, 7 km short of goal.
  const essLon = TEST_ORIGIN.lon + 15_000 * DEG_LON_PER_M;
  const distToGoal = andoyerDistance(TEST_ORIGIN.lat, essLon, goalWp.lat, goalWp.lon);
  const required = 300 + distToGoal / 4; // PG stopped glide ratio 4.0, goal alt 300 m

  it('measures altitude above the required final glide (PG ratio 4.0)', () => {
    expect(valueOf(out, 'alpha.igc')).toBeCloseTo(1500 - required, 6);
    expect(valueOf(out, 'bravo.igc')).toBeCloseTo(500 - required, 6);
    expect(valueOf(out, 'bravo.igc')!).toBeLessThan(0); // bravo arrived below glide
    expect(valueOf(out, 'charlie.igc')).toBeNull(); // null case: no ESS
    expect(valueOf(out, 'delta.igc')).toBeNull();
  });

  it('summarises top-N vs rest margins', () => {
    expect(out.fieldSummary![0]).toContain('ESS altitude margin');
  });
});

describe('race.final_glide_init', () => {
  const out = metric('race.final_glide_init').compute(field);

  it('computes the required glide ratio at the last climb before ESS', () => {
    const alpha = field.pilots.find((p) => p.trackFile === 'alpha.igc')!;
    expect(alpha.thermals.length).toBeGreaterThan(0);
    const lastThermal = alpha.thermals[alpha.thermals.length - 1];
    const exitFix = alpha.fixes[lastThermal.endIndex];
    const goalWp = field.task.turnpoints[4].waypoint;
    const dist = andoyerDistance(exitFix.latitude, exitFix.longitude, goalWp.lat, goalWp.lon);
    const expected = dist / (lastThermal.endAltitude - 300);
    expect(valueOf(out, 'alpha.igc')).toBeCloseTo(expected, 6);
    const note = out.perPilot.find((v) => v.trackFile === 'alpha.igc')!.note!;
    expect(note).toContain('left last climb');
  });

  it('is null without a qualifying post-SSS climb or without a start', () => {
    expect(valueOf(out, 'bravo.igc')).toBeNull(); // started, but never climbed
    expect(valueOf(out, 'delta.igc')).toBeNull(); // never started
  });
});

// ---------------------------------------------------------------------------
// Real-field smoke test (kosci-loop-t1)
// ---------------------------------------------------------------------------

const KOSCI_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../samples/comps/kosci-loop-t1',
);

/** Score kosci-loop-t1 (deterministic synthetic PG race) and build the field. */
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

describe('racecraft over kosci-loop-t1 (smoke)', () => {
  it('produces the horserace/waterfall and a sane time_behind correlation', () => {
    const kosci = buildKosciField();
    const report = evaluateField(kosci, RACECRAFT_METRICS);
    for (const m of report.metrics) {
      expect(m.error).toBeUndefined();
      expect(m.perPilot.length).toBe(kosci.pilots.length);
    }

    const behind = report.metrics.find((m) => m.id === 'race.time_behind')!;
    expect(behind.correlation).not.toBeNull();
    // Only ~7 of 44 pilots reach ESS on kosci-t1, and the fastest-at-ESS
    // pilots are the ones who then bombed on the return leg — so the
    // whole-field |ρ| is deterministic but moderate, not ≈1.
    expect(behind.correlation!.absRho).toBeGreaterThan(0.3);
    // The real sanity check: among pilots who MADE GOAL, rank is decided by
    // speed, so time behind at ESS must reproduce their order almost exactly.
    const valueByTrackFile = new Map(behind.perPilot.map((v) => [v.trackFile, v.value]));
    const goalPairs = kosci.pilots
      .map((p) => ({ p, v: valueByTrackFile.get(p.trackFile) ?? null }))
      .filter(({ p, v }) => p.score.madeGoal && v !== null);
    expect(goalPairs.length).toBeGreaterThanOrEqual(3);
    const rhoGoal = spearman(
      goalPairs.map(({ v }) => v!),
      goalPairs.map(({ p }) => p.score.rank),
    );
    expect(rhoGoal).toBeGreaterThan(0.9);
    expect(behind.extraTables![0].rows.length).toBeGreaterThan(0);

    const waterfall = report.metrics.find((m) => m.id === 'race.leg_time_lost')!;
    expect(waterfall.extraTables![0].rows.length).toBeGreaterThan(0);
    expect(waterfall.extraTables![0].columns.length).toBeGreaterThan(2);
  }, 120_000);
});
