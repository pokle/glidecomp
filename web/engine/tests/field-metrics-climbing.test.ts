import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { parseIGC } from '../src/igc-parser';
import { parseXCTask } from '../src/xctsk-parser';
import { calculateOptimizedTaskDistance } from '../src/task-optimizer';
import { scoreTask, resolveCompGapParams, type PilotFlight } from '../src/gap-scoring';
import type { IGCFix } from '../src/igc-parser';
import type { TurnpointSequenceResult } from '../src/turnpoint-sequence';
import {
  buildFieldContext,
  evaluateField,
  type FieldContext,
  type MetricOutput,
} from '../src/field-analysis';
import { CLIMBING_METRICS } from '../src/field-analysis/metrics/climbing';
import {
  makeTestField,
  straightFixes,
  circlingFixes,
  createFix,
  BASE_TIME,
  TEST_ORIGIN,
  DEG_LAT_PER_M,
  DEG_LON_PER_M,
} from './field-test-helpers';

// ---------------------------------------------------------------------------
// Local helpers (frozen field-test-helpers has constant-climb circling only)
// ---------------------------------------------------------------------------

/** Circling fixes with a time-varying climb rate (and optionally radius). */
function profileCircling(
  startSeconds: number,
  durationSeconds: number,
  eastMeters: number,
  altitude: number,
  climbAt: (t: number) => number,
  intervalSeconds = 5,
  radiusAt: (t: number) => number = () => 60,
): IGCFix[] {
  const fixes: IGCFix[] = [];
  const circleSeconds = 20;
  let alt = altitude;
  for (let t = 0; t <= durationSeconds; t += intervalSeconds) {
    const angle = (2 * Math.PI * t) / circleSeconds;
    const r = radiusAt(t);
    fixes.push(
      createFix(
        startSeconds + t,
        TEST_ORIGIN.lat + r * Math.sin(angle) * DEG_LAT_PER_M,
        TEST_ORIGIN.lon + (eastMeters + r * Math.cos(angle)) * DEG_LON_PER_M,
        alt,
      ),
    );
    alt += climbAt(t) * intervalSeconds;
  }
  return fixes;
}

/** A started pilot: SSS reached at `atSeconds` after BASE_TIME. */
function sssAt(atSeconds: number, altitude = 1000): Partial<TurnpointSequenceResult> {
  return {
    sssReaching: {
      taskIndex: 1,
      fixIndex: 0,
      time: new Date(BASE_TIME.getTime() + atSeconds * 1000),
      latitude: TEST_ORIGIN.lat,
      longitude: TEST_ORIGIN.lon,
      altitude,
      selectionReason: 'first_after_previous',
      candidateCount: 1,
    },
  };
}

const metricById = new Map(CLIMBING_METRICS.map((m) => [m.id, m]));

function compute(id: string, field: FieldContext): MetricOutput {
  const metric = metricById.get(id);
  if (!metric) throw new Error(`unknown metric ${id}`);
  return metric.compute(field);
}

function entryFor(out: MetricOutput, name: string) {
  const entry = out.perPilot.find((v) => v.trackFile === `${name}.igc`);
  if (!entry) throw new Error(`no perPilot entry for ${name}`);
  return entry;
}

const valueFor = (out: MetricOutput, name: string) => entryFor(out, name).value;

describe('metric registration', () => {
  it('exposes the six climbing metrics with family/direction per spec', () => {
    expect(CLIMBING_METRICS.map((m) => m.id)).toEqual([
      'climb.shared_percentile',
      'climb.time_to_core',
      'climb.exit_decay',
      'climb.selectivity',
      'climb.departure_band',
      'climb.circle_smoothness',
    ]);
    for (const m of CLIMBING_METRICS) {
      expect(m.family).toBe('climbing');
      expect(m.explanation.length).toBeGreaterThan(20);
      expect((m.shortLabel ?? '').length).toBeLessThanOrEqual(10);
      expect(m.shortLabel).toBeTruthy();
    }
    expect(metricById.get('climb.shared_percentile')!.direction).toBe('higher');
    expect(metricById.get('climb.time_to_core')!.direction).toBe('lower');
  });
});

describe('climb.shared_percentile', () => {
  // Three pilots share one thermal (same place, same time) at different climb
  // rates; one pilot thermals alone far away; one never thermals at all.
  const tail = (startSeconds: number, alt: number) =>
    straightFixes(startSeconds, 240, 100, alt, 12, -1);
  const field = makeTestField([
    { name: 'fast', fixes: [...circlingFixes(0, 300, 0, 1000, 2.5), ...tail(310, 1750)] },
    { name: 'mid', fixes: [...circlingFixes(0, 300, 0, 1000, 1.6), ...tail(310, 1480)] },
    { name: 'slow', fixes: [...circlingFixes(0, 300, 0, 1000, 0.8), ...tail(310, 1240)] },
    {
      name: 'loner',
      fixes: [
        ...circlingFixes(1000, 300, 20_000, 1000, 2),
        ...straightFixes(1310, 240, 20_100, 1600, 12, -1),
      ],
    },
    { name: 'glideonly', fixes: straightFixes(0, 600, 0, 2000, 12, -1) },
  ]);

  it('ranks pilots within the shared thermal by climb rate', () => {
    expect(field.sharedThermals.some((st) => st.pilotCount >= 3)).toBe(true);
    const out = compute('climb.shared_percentile', field);
    const fast = valueFor(out, 'fast')!;
    const mid = valueFor(out, 'mid')!;
    const slow = valueFor(out, 'slow')!;
    expect(fast).toBeGreaterThan(66);
    expect(mid).toBeGreaterThan(25);
    expect(mid).toBeLessThan(75);
    expect(slow).toBeLessThan(34);
    expect(fast).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(slow);
    expect(entryFor(out, 'fast').note).toContain('shared climb');
  });

  it('is null for solo-thermal and no-thermal pilots', () => {
    const out = compute('climb.shared_percentile', field);
    expect(valueFor(out, 'loner')).toBeNull(); // thermalled 20 km away, alone
    expect(valueFor(out, 'glideonly')).toBeNull(); // never thermalled
  });
});

describe('climb.time_to_core', () => {
  // 'ramp' finds the core a minute in (1 m/s then 3 m/s); 'steady' is centred
  // from the start (constant 2 m/s).
  const field = makeTestField([
    { name: 'ramp', fixes: profileCircling(0, 180, 0, 1000, (t) => (t < 60 ? 1 : 3)) },
    { name: 'steady', fixes: profileCircling(0, 180, 0, 1000, () => 2) },
    { name: 'glideonly', fixes: straightFixes(0, 600, 0, 2000, 12, -1) },
  ]);

  it('detects late coring vs immediate coring', () => {
    const out = compute('climb.time_to_core', field);
    const ramp = valueFor(out, 'ramp')!;
    const steady = valueFor(out, 'steady')!;
    // 30 s rolling rate crosses 0.9×peak (2.7 m/s) around t ≈ 85 s for ramp.
    expect(ramp).toBeGreaterThan(55);
    expect(ramp).toBeLessThan(135);
    expect(steady).toBeLessThan(45);
    expect(ramp).toBeGreaterThan(steady);
  });

  it('is null without a qualifying (≥ 60 s) thermal', () => {
    const out = compute('climb.time_to_core', field);
    expect(valueFor(out, 'glideonly')).toBeNull();
  });
});

describe('climb.exit_decay', () => {
  // 'fade' rides the thermal into weak lift (0.7 m/s at the end); 'steady'
  // leaves while it is still strong; 'shortie' has only a < 90 s thermal.
  const field = makeTestField([
    { name: 'fade', fixes: profileCircling(0, 150, 0, 1000, (t) => (t < 110 ? 2.5 : 0.7)) },
    { name: 'steady', fixes: profileCircling(0, 150, 0, 1000, () => 2.5) },
    { name: 'shortie', fixes: profileCircling(0, 70, 0, 1000, () => 2) },
  ]);

  it('measures the climb rate over the final 30 s', () => {
    const out = compute('climb.exit_decay', field);
    const fade = valueFor(out, 'fade')!;
    const steady = valueFor(out, 'steady')!;
    expect(Math.abs(fade - 0.7)).toBeLessThan(0.4);
    expect(Math.abs(steady - 2.5)).toBeLessThan(0.5);
    expect(fade).toBeLessThan(steady);
  });

  it('is null without a ≥ 90 s thermal', () => {
    const out = compute('climb.exit_decay', field);
    expect(valueFor(out, 'shortie')).toBeNull();
  });
});

describe('climb.selectivity', () => {
  // 'picky' turns in four bouts post-SSS and climbs away from three (one bout
  // is zero-lift circling → rejected); 'fewenc' has only two encounters;
  // 'nosss' never crossed the start.
  const pickyFixes = [
    ...circlingFixes(0, 60, 0, 2000, 2),
    ...straightFixes(70, 120, 0, 2120, 12, -1),
    ...circlingFixes(200, 60, 1500, 2000, 2),
    ...straightFixes(270, 120, 1500, 2120, 12, -1),
    ...circlingFixes(400, 60, 3000, 2000, 2),
    ...straightFixes(470, 120, 3000, 2120, 12, -1),
    ...circlingFixes(600, 60, 4500, 2000, 0),
    ...straightFixes(670, 120, 4500, 2000, 12, -1),
  ];
  const fewencFixes = [
    ...circlingFixes(0, 60, 0, 2000, 2),
    ...straightFixes(70, 120, 0, 2120, 12, -1),
    ...circlingFixes(200, 60, 1500, 2000, 2),
    ...straightFixes(270, 240, 1500, 2120, 12, -1),
  ];
  const field = makeTestField([
    { name: 'picky', fixes: pickyFixes, turnpointResult: sssAt(0, 2000) },
    { name: 'fewenc', fixes: fewencFixes, turnpointResult: sssAt(0, 2000) },
    {
      name: 'nosss',
      fixes: [...circlingFixes(0, 300, 0, 2000, 2), ...straightFixes(310, 240, 100, 2600, 12, -1)],
    },
  ]);

  it('scores accepted vs rejected circling encounters', () => {
    const out = compute('climb.selectivity', field);
    const picky = valueFor(out, 'picky')!;
    // 3 of 4 bouts accepted → 75%; tolerate detector-boundary wobble.
    expect(picky).toBeGreaterThanOrEqual(50);
    expect(picky).toBeLessThan(100);
    expect(entryFor(out, 'picky').note).toContain('circling bouts');
    // Acceptance-by-hour is a table of instants now (no baked "…UTC" prose).
    const byHour = out.extraTables?.find((t) => t.title === 'Acceptance by hour');
    expect(byHour).toBeDefined();
    expect(byHour!.rows.length).toBeGreaterThan(0);
    expect(typeof byHour!.rows[0][0]).toBe('object'); // an { t } instant
    expect(out.fieldSummary).toBeUndefined();
  });

  it('is null for < 3 encounters or without a start', () => {
    const out = compute('climb.selectivity', field);
    expect(valueFor(out, 'fewenc')).toBeNull();
    expect(valueFor(out, 'nosss')).toBeNull();
  });
});

describe('climb.departure_band', () => {
  // 'high' climbs 600 m before leaving; 'low' leaves 400 m lower; 'nostart'
  // flies identically but never crossed the start.
  const field = makeTestField([
    {
      name: 'high',
      fixes: [...circlingFixes(0, 200, 0, 1000, 3), ...straightFixes(210, 300, 100, 1600, 12, -1.5)],
      turnpointResult: sssAt(0),
    },
    {
      name: 'low',
      fixes: [...circlingFixes(0, 200, 0, 1000, 1), ...straightFixes(210, 300, 100, 1200, 12, -1.5)],
      turnpointResult: sssAt(0),
    },
    {
      name: 'nostart',
      fixes: [...circlingFixes(0, 200, 0, 1000, 1), ...straightFixes(210, 300, 100, 1200, 12, -1.5)],
    },
  ]);

  it('ranks departure altitudes within the working band', () => {
    const out = compute('climb.departure_band', field);
    const high = valueFor(out, 'high')!;
    const low = valueFor(out, 'low')!;
    expect(high).toBeGreaterThan(low);
    expect(high).toBeGreaterThanOrEqual(-50);
    expect(high).toBeLessThanOrEqual(150);
    expect(entryFor(out, 'high').note).toContain('on-course');
    if (field.workingBand.usedFallback) {
      expect(out.fieldSummary?.[0]).toContain('fell back');
    }
  });

  it('is null without a start', () => {
    const out = compute('climb.departure_band', field);
    expect(valueFor(out, 'nostart')).toBeNull();
  });
});

describe('climb.circle_smoothness', () => {
  // 2 s fixes give ~10 fixes per 20 s circle so circles are detectable.
  // 'smooth' flies perfect circles; 'wobbly' wanders ±18 m in radius.
  const field = makeTestField([
    { name: 'smooth', fixes: circlingFixes(0, 300, 0, 1000, 2, 2) },
    {
      name: 'wobbly',
      fixes: profileCircling(0, 300, 0, 1000, () => 2, 2, (t) => 60 + 18 * Math.sin((2 * Math.PI * t) / 13)),
    },
    { name: 'glideonly', fixes: straightFixes(0, 600, 0, 2000, 12, -1) },
  ]);

  it('separates round circles from wobbly ones', () => {
    const out = compute('climb.circle_smoothness', field);
    const smooth = valueFor(out, 'smooth')!;
    const wobbly = valueFor(out, 'wobbly')!;
    expect(smooth).not.toBeNull();
    expect(wobbly).not.toBeNull();
    expect(smooth).toBeLessThan(0.2);
    expect(wobbly).toBeGreaterThan(smooth);
    expect(out.fieldSummary?.[0]).toContain('% left');
  });

  it('is null below 10 circles', () => {
    const out = compute('climb.circle_smoothness', field);
    expect(valueFor(out, 'glideonly')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Smoke test over the real kosci-loop-t1 field
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

describe('climbing metrics over kosci-loop-t1 (smoke)', () => {
  it('evaluates cleanly with sensible coverage and finite correlations', () => {
    const field = buildKosciField();
    const report = evaluateField(field, CLIMBING_METRICS);
    expect(report.metrics.length).toBe(6);

    const nonNullCount: Record<string, number> = {};
    for (const m of report.metrics) {
      expect(m.error).toBeUndefined();
      expect(m.perPilot.length).toBe(field.pilots.length);
      nonNullCount[m.id] = m.perPilot.filter((v) => v.value !== null).length;
      if (m.correlation) {
        expect(isFinite(m.correlation.rho)).toBe(true);
        expect(m.correlation.n).toBeGreaterThanOrEqual(3);
      }
    }

    // Own-thermal metrics should cover a decent share of the 44 pilots
    // (observed 40–43; thresholds kept lenient below that). Selectivity and
    // circle smoothness are legitimately all-null here: kosci's synthetic
    // triangle-wave tracks barely circle (0 detected circles).
    expect(nonNullCount['climb.time_to_core']).toBeGreaterThanOrEqual(25);
    expect(nonNullCount['climb.exit_decay']).toBeGreaterThanOrEqual(25);
    expect(nonNullCount['climb.departure_band']).toBeGreaterThanOrEqual(25);
    expect(nonNullCount['climb.shared_percentile']).toBeGreaterThanOrEqual(20);
  }, 120_000);
});
