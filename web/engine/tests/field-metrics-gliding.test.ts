import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { parseIGC, type IGCFix } from '../src/igc-parser';
import { parseXCTask } from '../src/xctsk-parser';
import { calculateOptimizedTaskDistance, calculateOptimizedTaskLine } from '../src/task-optimizer';
import { ellipsoidDistance } from '../src/geo';
import { scoreTask, resolveCompGapParams, type PilotFlight } from '../src/gap-scoring';
import {
  buildFieldContext,
  evaluateField,
  type FieldContext,
  type MetricOutput,
} from '../src/analysis';
import { GLIDING_METRICS } from '../src/analysis/metrics/gliding';
import type { TurnpointReaching } from '../src/turnpoint-sequence-types';
import {
  makeTestField,
  makeTestTask,
  straightFixes,
  circlingFixes,
  createFix,
  TEST_ORIGIN,
  DEG_LAT_PER_M,
  DEG_LON_PER_M,
} from './field-test-helpers';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function metric(id: string) {
  const m = GLIDING_METRICS.find((x) => x.id === id);
  if (!m) throw new Error(`metric ${id} not registered`);
  return m;
}

/** Value for a pilot by trackFile (makeTestField uses `<name>.igc`). */
function valueFor(out: MetricOutput, name: string): number | null {
  const entry = out.perPilot.find((v) => v.trackFile === `${name}.igc`);
  if (!entry) throw new Error(`no perPilot entry for ${name}.igc`);
  return entry.value;
}

/** A TurnpointReaching anchored on an existing fix of the track. */
function reachingAt(fixes: IGCFix[], taskIndex: number, fixIndex: number): TurnpointReaching {
  const f = fixes[fixIndex];
  return {
    taskIndex,
    fixIndex,
    time: f.time,
    latitude: f.latitude,
    longitude: f.longitude,
    altitude: f.gnssAltitude,
    selectionReason: 'first_after_previous',
    candidateCount: 1,
  };
}

/** East offset (m) of a fix from TEST_ORIGIN. */
function eastOf(fix: IGCFix): number {
  return (fix.longitude - TEST_ORIGIN.lon) / DEG_LON_PER_M;
}

/** First fix index at/after the given east offset. */
function indexAtEast(fixes: IGCFix[], eastMeters: number): number {
  const i = fixes.findIndex((f) => eastOf(f) >= eastMeters);
  if (i < 0) throw new Error(`track never reaches east=${eastMeters}`);
  return i;
}

// ---------------------------------------------------------------------------
// Registry shape
// ---------------------------------------------------------------------------

describe('GLIDING_METRICS registry', () => {
  it('registers the four gliding metrics with valid metadata', () => {
    expect(GLIDING_METRICS.map((m) => m.id)).toEqual([
      'glide.speed',
      'glide.ld_vs_field',
      'glide.extra_distance',
      'glide.dolphin_fraction',
    ]);
    for (const m of GLIDING_METRICS) {
      expect(m.family).toBe('gliding');
      expect(m.explanation.length).toBeGreaterThan(20);
      expect(m.shortLabel!.length).toBeLessThanOrEqual(10);
    }
    expect(metric('glide.speed').direction).toBe('higher');
    expect(metric('glide.ld_vs_field').direction).toBe('higher');
    // Neutral since TASK_ANALYSIS_VERSION 27: over the archive this metric
    // REVERSES with the day — wide costs on a day the field completes, and
    // pays on a day it lands out. See docs/2026-09-02-metric-evidence.md.
    expect(metric('glide.extra_distance').direction).toBe('neutral');
    expect(metric('glide.dolphin_fraction').direction).toBe('neutral');
  });
});

// ---------------------------------------------------------------------------
// glide.speed
// ---------------------------------------------------------------------------

describe('glide.speed', () => {
  it('computes the duration-weighted glide speed for started pilots, null for non-starters', () => {
    // Runner: 900 s straight glide at 12 m/s (43.2 km/h), started at fix 0.
    const runnerFixes = straightFixes(0, 900, 0, 2000, 12, -1);
    const field = makeTestField([
      {
        name: 'runner',
        fixes: runnerFixes,
        turnpointResult: { sssReaching: reachingAt(runnerFixes, 1, 0) },
      },
      { name: 'nostart', fixes: straightFixes(0, 900, 0, 2000, 12, -1) },
    ]);
    const out = metric('glide.speed').compute(field);
    expect(out.perPilot.length).toBe(2);

    const v = valueFor(out, 'runner');
    expect(v).not.toBeNull();
    expect(v!).toBeGreaterThan(38);
    expect(v!).toBeLessThan(48);

    expect(valueFor(out, 'nostart')).toBeNull();
    expect(out.fieldSummary?.[0]).toContain('median');
  });
});

// ---------------------------------------------------------------------------
// glide.ld_vs_field
// ---------------------------------------------------------------------------

describe('glide.ld_vs_field', () => {
  it('ratios each pilot leg L/D against the field median for that leg', () => {
    // Same SSS→ESS leg (fixes 10..70, 600 s at 12 m/s ≈ 7.2 km) flown by an
    // efficient pilot (−0.5 m/s → L/D 24) and a sinky one (−1.5 m/s → L/D 8).
    // Field median = 16, so values are 1.5 and 0.5.
    const mk = (sink: number) => straightFixes(0, 900, 0, 2500, 12, sink);
    const withLeg = (fixes: IGCFix[]) => ({
      sssReaching: reachingAt(fixes, 1, 10),
      sequence: [reachingAt(fixes, 1, 10), reachingAt(fixes, 2, 70)],
    });
    const eff = mk(-0.5);
    const sinky = mk(-1.5);
    const flat = mk(0); // loses no altitude → leg skipped (< 100 m) → null
    const field = makeTestField([
      { name: 'eff', fixes: eff, turnpointResult: withLeg(eff) },
      { name: 'sinky', fixes: sinky, turnpointResult: withLeg(sinky) },
      { name: 'flat', fixes: flat, turnpointResult: withLeg(flat) },
      { name: 'nolegs', fixes: mk(-1) }, // no reachings → null
    ]);
    const out = metric('glide.ld_vs_field').compute(field);
    expect(out.perPilot.length).toBe(4);

    const effV = valueFor(out, 'eff');
    const sinkyV = valueFor(out, 'sinky');
    expect(effV).not.toBeNull();
    expect(sinkyV).not.toBeNull();
    expect(effV!).toBeCloseTo(1.5, 1);
    expect(sinkyV!).toBeCloseTo(0.5, 1);
    expect(effV!).toBeGreaterThan(sinkyV!);

    expect(valueFor(out, 'flat')).toBeNull();
    expect(valueFor(out, 'nolegs')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// glide.extra_distance
// ---------------------------------------------------------------------------

/**
 * Dog-legging east-bound track: each 10 s step is (+120 m E, ±90 m N) → path
 * ×1.25, but the north/south sense flips only every 30 fixes. The bearing is
 * constant inside a block, so the circle detector stays out of it and the
 * phase partition calls this a GLIDE — which is the point. A per-fix sawtooth
 * instead reads as circling, lands in a `search` phase, and is deliberately
 * NOT counted as line deviation (see the search-meander test above).
 */
function doglegFixes(): IGCFix[] {
  const fixes: IGCFix[] = [];
  let north = 0;
  for (let i = 0; i <= 120; i++) {
    if (i > 0) north += (Math.floor((i - 1) / 30) % 2 === 0 ? 1 : -1) * 90;
    fixes.push(
      createFix(
        i * 10,
        TEST_ORIGIN.lat + north * DEG_LAT_PER_M,
        TEST_ORIGIN.lon + i * 120 * DEG_LON_PER_M,
        2500 - i,
      ),
    );
  }
  return fixes;
}

describe('glide.extra_distance', () => {
  // THE ZERO POINT. This metric claims "0% = flew the optimised line", so the
  // pilot who literally flies `calculateOptimizedTaskLine` must score 0 — if
  // this drifts, every absolute reading on the page is quietly wrong and the
  // only honest thing left to say would be "compare pilots, not absolutes".
  it('reads 0% for a pilot who flies the optimizer’s own line', () => {
    const task = makeTestTask();
    const line = calculateOptimizedTaskLine(task);
    expect(line.length).toBe(task.turnpoints.length);

    // Straight-line interpolation between consecutive tag points at ~50 km/h,
    // one fix every 2 s, descending gently so the phase partition calls it a
    // glide throughout. tagFixIndex[i] is the fix that sits ON tag point i.
    const SPEED_MPS = 50 / 3.6;
    const STEP_S = 2;
    const fixes: IGCFix[] = [];
    const tagFixIndex: number[] = [];
    let t = 0;
    let alt = 3000;
    for (let i = 0; i + 1 < line.length; i++) {
      const a = line[i];
      const b = line[i + 1];
      const d = ellipsoidDistance(a.lat, a.lon, b.lat, b.lon);
      const steps = Math.max(1, Math.round(d / (SPEED_MPS * STEP_S)));
      tagFixIndex.push(fixes.length);
      for (let k = 0; k < steps; k++) {
        const f = k / steps;
        fixes.push(
          createFix(t, a.lat + (b.lat - a.lat) * f, a.lon + (b.lon - a.lon) * f, alt),
        );
        t += STEP_S;
        alt -= 0.4 * STEP_S;
      }
    }
    const last = line[line.length - 1];
    tagFixIndex.push(fixes.length);
    fixes.push(createFix(t, last.lat, last.lon, alt));

    // Reachings anchored exactly on the tag points: this pilot's legs and the
    // optimizer's legs are then the same two endpoints, so any excess the
    // metric reports is excess the pilot actually flew.
    const sequence = line.map((_, i) => reachingAt(fixes, i, tagFixIndex[i]));
    const field = makeTestField(
      [
        {
          name: 'optimal',
          fixes,
          turnpointResult: { sssReaching: sequence[1], sequence },
        },
      ],
      { task },
    );

    const value = valueFor(metric('glide.extra_distance').compute(field), 'optimal');
    expect(value).not.toBeNull();
    expect(Math.abs(value!)).toBeLessThan(0.5); // percent
  });

  // Scratching is not a line choice. A pilot who wanders while SEARCHING for
  // lift must read the same as one who flew straight between the same points
  // — otherwise this metric re-measures decision.search_fraction (the v9
  // mistake with circles, repeated).
  it('ignores meander inside search phases, counting only their displacement', () => {
    // Descend hard enough (and slowly enough) that partitionPhases calls it
    // 'search' rather than 'glide': low ground speed, no circling.
    const straightSearch: IGCFix[] = [];
    const wanderSearch: IGCFix[] = [];
    for (let i = 0; i <= 300; i++) {
      const east = 3000 + i * 30;
      straightSearch.push(
        createFix(i * 10, TEST_ORIGIN.lat, TEST_ORIGIN.lon + east * DEG_LON_PER_M, 2500 - i * 2),
      );
      // Same east progress, but sawtoothing ±200 m north — pure meander.
      wanderSearch.push(
        createFix(
          i * 10,
          TEST_ORIGIN.lat + (i % 2 ? 200 : -200) * DEG_LAT_PER_M,
          TEST_ORIGIN.lon + east * DEG_LON_PER_M,
          2500 - i * 2,
        ),
      );
    }
    const legFor = (f: IGCFix[]) => [
      reachingAt(f, 1, indexAtEast(f, 3000)),
      reachingAt(f, 2, indexAtEast(f, 11000)),
    ];
    const field = makeTestField([
      {
        name: 'straight',
        fixes: straightSearch,
        turnpointResult: { sssReaching: legFor(straightSearch)[0], sequence: legFor(straightSearch) },
      },
      {
        name: 'wander',
        fixes: wanderSearch,
        turnpointResult: { sssReaching: legFor(wanderSearch)[0], sequence: legFor(wanderSearch) },
      },
    ]);
    const out = metric('glide.extra_distance').compute(field);
    const straight = valueFor(out, 'straight');
    const wander = valueFor(out, 'wander');
    expect(straight).not.toBeNull();
    expect(wander).not.toBeNull();
    // The wanderer's raw path is ~4x longer; only the phases the partition
    // calls 'glide' may differ between them.
    const searchSeconds = (name: string) => {
      const p = field.pilots.find((x) => x.trackFile === `${name}.igc`)!;
      return p.phases
        .filter((ph) => ph.phase !== 'glide')
        .reduce((acc, ph) => acc + (p.fixes[ph.endIndex].time.getTime()
          - p.fixes[ph.startIndex].time.getTime()) / 1000, 0);
    };
    // Guard the fixture itself: if these tracks came out as pure glides the
    // assertion below would pass for the wrong reason.
    expect(searchSeconds('wander')).toBeGreaterThan(0);
    expect(Math.abs(wander! - straight!)).toBeLessThan(5);
  });

  it('rises with glide-path deviation between the same leg endpoints; pre-SSS legs excluded', () => {
    // makeTestTask: SSS r2000 @5 km E, ESS r1000 @15 km E. The SSS→ESS leg runs
    // roughly east 3000 → east 14000 along the course line.
    const straight = straightFixes(0, 1200, 0, 2500, 12, -0.5);
    const dogleg = doglegFixes();
    const legFor = (fixes: IGCFix[]) => [
      reachingAt(fixes, 1, indexAtEast(fixes, 3000)),
      reachingAt(fixes, 2, indexAtEast(fixes, 14000)),
    ];
    const field = makeTestField([
      {
        name: 'straight',
        fixes: straight,
        turnpointResult: { sssReaching: legFor(straight)[0], sequence: legFor(straight) },
      },
      {
        // Same fixes + a pre-SSS takeoff→SSS leg, which must be excluded.
        name: 'withpre',
        fixes: straight,
        turnpointResult: {
          sssReaching: legFor(straight)[0],
          sequence: [reachingAt(straight, 0, 0), ...legFor(straight)],
        },
      },
      {
        name: 'dogleg',
        fixes: dogleg,
        turnpointResult: { sssReaching: legFor(dogleg)[0], sequence: legFor(dogleg) },
      },
      { name: 'nolegs', fixes: straightFixes(0, 900, 0, 2000, 12, -1) },
    ]);
    const out = metric('glide.extra_distance').compute(field);
    expect(out.perPilot.length).toBe(4);

    const straightV = valueFor(out, 'straight');
    const withpreV = valueFor(out, 'withpre');
    const doglegV = valueFor(out, 'dogleg');
    expect(straightV).not.toBeNull();
    expect(doglegV).not.toBeNull();

    // The metric reports percentage EXCESS over the optimized line; compare
    // pilots on the underlying distance ratio it is derived from.
    const asRatio = (pct: number) => 1 + pct / 100;

    // NOTE: these pilots' reachings are pinned at arbitrary east offsets, NOT
    // at the optimizer's tag points, so they fly a different route from the
    // optimized one and read well above 0% — a property of THIS FIXTURE, not
    // of the metric. The zero point is pinned by the optimizer's-own-line test
    // above; this test only asserts pilot-to-pilot discrimination.
    expect(asRatio(straightV!)).toBeGreaterThan(0.9);
    // Pre-SSS leg contributes nothing.
    expect(withpreV!).toBeCloseTo(straightV!, 5);
    // The dog-leg's glide path is ~25% longer over the same leg endpoints.
    expect(asRatio(doglegV!) / asRatio(straightV!)).toBeGreaterThan(1.15);
    expect(asRatio(doglegV!) / asRatio(straightV!)).toBeLessThan(1.4);

    expect(valueFor(out, 'nolegs')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// glide.dolphin_fraction
// ---------------------------------------------------------------------------

describe('glide.dolphin_fraction', () => {
  it('is high for straight-line climbing, low for thermal-only gain, null otherwise', () => {
    // Dolphin: gains 360 m on a dead-straight run (+0.4 m/s — below the 0.5
    // thermal-detection threshold, so no ThermalSegment exists).
    const dolphin = straightFixes(0, 900, 0, 2000, 12, 0.4);
    // Circler: all 600 m gained inside a detected circling thermal.
    const circler = [
      ...circlingFixes(0, 300, 0, 1000, 2),
      ...straightFixes(310, 600, 60, 1600, 12, -1),
    ];
    // Sinker: never gains → total gain < 200 m → null.
    const sinker = straightFixes(0, 900, 0, 2000, 12, -1);
    const field = makeTestField([
      {
        name: 'dolphin',
        fixes: dolphin,
        turnpointResult: { sssReaching: reachingAt(dolphin, 1, 0) },
      },
      {
        name: 'circler',
        fixes: circler,
        turnpointResult: { sssReaching: reachingAt(circler, 1, 0) },
      },
      {
        name: 'sinker',
        fixes: sinker,
        turnpointResult: { sssReaching: reachingAt(sinker, 1, 0) },
      },
      { name: 'nostart', fixes: straightFixes(0, 900, 0, 2000, 12, 0.4) },
    ]);
    const out = metric('glide.dolphin_fraction').compute(field);
    expect(out.perPilot.length).toBe(4);

    const dolphinV = valueFor(out, 'dolphin');
    expect(dolphinV).not.toBeNull();
    expect(dolphinV!).toBeGreaterThan(90);

    const circlerV = valueFor(out, 'circler');
    expect(circlerV).not.toBeNull();
    expect(circlerV!).toBeLessThan(15);

    expect(valueFor(out, 'sinker')).toBeNull();
    expect(valueFor(out, 'nostart')).toBeNull();
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

describe('gliding metrics over kosci-loop-t1 (smoke)', () => {
  it('covers a reasonable share of started pilots with finite values', () => {
    const field = buildKosciField();
    const started = field.pilots.filter((p) => p.sssMs !== null).length;
    expect(started).toBeGreaterThan(30);

    const report = evaluateField(field, GLIDING_METRICS);
    expect(report.metrics.length).toBe(GLIDING_METRICS.length);

    for (const m of report.metrics) {
      expect(m.error).toBeUndefined();
      expect(m.perPilot.length).toBe(field.pilots.length);
      for (const v of m.perPilot) {
        if (v.value !== null) expect(Number.isFinite(v.value)).toBe(true);
      }
      if (m.correlation) {
        expect(Number.isFinite(m.correlation.rho)).toBe(true);
        expect(m.correlation.n).toBeGreaterThanOrEqual(3);
      }
    }

    const nonNullCount = (id: string) =>
      report.metrics.find((m) => m.id === id)!.perPilot.filter((v) => v.value !== null).length;

    // Lenient coverage thresholds — every started pilot glides post-start;
    // leg metrics need at least one completed speed-section leg.
    expect(nonNullCount('glide.speed')).toBeGreaterThanOrEqual(0.6 * started);
    expect(nonNullCount('glide.dolphin_fraction')).toBeGreaterThanOrEqual(0.5 * started);
    expect(nonNullCount('glide.extra_distance')).toBeGreaterThanOrEqual(0.3 * started);

    // Sanity: real tracks fly at least the optimized line, so the excess over
    // it sits at or a little above 0% (never far below).
    const extra = report.metrics.find((m) => m.id === 'glide.extra_distance')!;
    for (const v of extra.perPilot) {
      if (v.value !== null) expect(v.value).toBeGreaterThan(-20);
    }
  }, 120_000);
});
