import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { parseIGC, type IGCFix } from '../src/igc-parser';
import { parseXCTask } from '../src/xctsk-parser';
import { calculateOptimizedTaskDistance } from '../src/task-optimizer';
import { scoreTask, resolveCompGapParams, type PilotFlight } from '../src/gap-scoring';
import {
  buildFieldContext,
  evaluateField,
  type FieldContext,
  type MetricOutput,
} from '../src/field-analysis';
import { GLIDING_METRICS } from '../src/field-analysis/metrics/gliding';
import type { TurnpointReaching } from '../src/turnpoint-sequence-types';
import {
  makeTestField,
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
  it('registers the five gliding metrics with valid metadata', () => {
    expect(GLIDING_METRICS.map((m) => m.id)).toEqual([
      'glide.speed',
      'glide.ld_vs_field',
      'glide.stf_proxy',
      'glide.track_efficiency',
      'glide.dolphin_fraction',
    ]);
    for (const m of GLIDING_METRICS) {
      expect(m.family).toBe('gliding');
      expect(m.explanation.length).toBeGreaterThan(20);
      expect(m.shortLabel!.length).toBeLessThanOrEqual(10);
    }
    expect(metric('glide.speed').direction).toBe('higher');
    expect(metric('glide.ld_vs_field').direction).toBe('higher');
    expect(metric('glide.stf_proxy').direction).toBe('higher');
    expect(metric('glide.track_efficiency').direction).toBe('lower');
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
// glide.stf_proxy
// ---------------------------------------------------------------------------

/**
 * Alternating glide/climb track: fast glides (15 m/s) before strong climbs
 * (2.5 m/s), slow glides (10 m/s) before weak climbs (1 m/s) — a pilot flying
 * textbook speed-to-fly. 5 glide→climb pairs (the takeoff detector may anchor
 * the flight at the first circling climb and drop the opening glide, so at
 * least 4 pairs always survive).
 */
function stfTrack(): IGCFix[] {
  const fixes: IGCFix[] = [];
  let t = 0;
  let east = 0;
  let alt = 2500;
  const glide = (speedMps: number) => {
    fixes.push(...straightFixes(t, 300, east, alt, speedMps, 0));
    east += speedMps * 300;
    t += 310;
  };
  const climb = (rateMps: number) => {
    east += 60; // circle centre just past the glide end
    fixes.push(...circlingFixes(t, 200, east, alt, rateMps));
    alt += rateMps * 200;
    t += 210;
    east += 60;
  };
  glide(15);
  climb(2.5);
  glide(10);
  climb(1.0);
  glide(15);
  climb(2.5);
  glide(10);
  climb(1.0);
  glide(15);
  climb(2.5);
  return fixes;
}

describe('glide.stf_proxy', () => {
  it('is positive for a pilot who glides faster before stronger climbs', () => {
    const fixes = stfTrack();
    const shortFixes = [
      ...straightFixes(0, 300, 0, 2500, 12, 0),
      ...circlingFixes(310, 200, 3660, 2500, 2),
    ];
    const field = makeTestField([
      {
        name: 'stf',
        fixes,
        turnpointResult: { sssReaching: reachingAt(fixes, 1, 0) },
      },
      {
        // Started but only 1 glide→climb pair (< 4) → null.
        name: 'fewpairs',
        fixes: shortFixes,
        turnpointResult: { sssReaching: reachingAt(shortFixes, 1, 0) },
      },
      { name: 'nostart', fixes: straightFixes(0, 900, 0, 2000, 12, -1) },
    ]);
    const out = metric('glide.stf_proxy').compute(field);
    expect(out.perPilot.length).toBe(3);

    // Expected ≈ (15 − 10) m/s × 3.6 = 18 km/h; lenient band for detector edges.
    const v = valueFor(out, 'stf');
    expect(v).not.toBeNull();
    expect(v!).toBeGreaterThan(5);
    expect(v!).toBeLessThan(32);

    expect(valueFor(out, 'fewpairs')).toBeNull();
    expect(valueFor(out, 'nostart')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// glide.track_efficiency
// ---------------------------------------------------------------------------

/** Zigzag east-bound track: each 10 s step is (+120 m E, ±90 m N) → path ×1.25. */
function zigzagFixes(): IGCFix[] {
  const fixes: IGCFix[] = [];
  for (let i = 0; i <= 120; i++) {
    fixes.push(
      createFix(
        i * 10,
        TEST_ORIGIN.lat + (i % 2) * 90 * DEG_LAT_PER_M,
        TEST_ORIGIN.lon + i * 120 * DEG_LON_PER_M,
        2500 - i,
      ),
    );
  }
  return fixes;
}

describe('glide.track_efficiency', () => {
  it('is ~1 for a straight-line pilot and higher for a zigzagger; pre-SSS legs excluded', () => {
    // makeTestTask: SSS r2000 @5 km E, ESS r1000 @15 km E. The SSS→ESS leg runs
    // roughly east 3000 → east 14000 along the course line.
    const straight = straightFixes(0, 1200, 0, 2500, 12, -0.5);
    const zigzag = zigzagFixes();
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
        name: 'zigzag',
        fixes: zigzag,
        turnpointResult: { sssReaching: legFor(zigzag)[0], sequence: legFor(zigzag) },
      },
      { name: 'nolegs', fixes: straightFixes(0, 900, 0, 2000, 12, -1) },
    ]);
    const out = metric('glide.track_efficiency').compute(field);
    expect(out.perPilot.length).toBe(4);

    const straightV = valueFor(out, 'straight');
    const withpreV = valueFor(out, 'withpre');
    const zigzagV = valueFor(out, 'zigzag');
    expect(straightV).not.toBeNull();
    expect(zigzagV).not.toBeNull();

    // The reaching fixes sit on the near cylinder boundaries while the
    // optimizer tags the far/near edges that minimize the whole route, so the
    // straight flier's ratio carries a constant geometric offset (> 1). It is
    // the same for every pilot on the leg — assert a sane band plus the
    // pilot-to-pilot discrimination.
    expect(straightV!).toBeGreaterThan(0.9);
    expect(straightV!).toBeLessThan(1.8);
    // Pre-SSS leg contributes nothing.
    expect(withpreV!).toBeCloseTo(straightV!, 5);
    // Zigzag path is ~25% longer than the straight one on the same leg.
    expect(zigzagV! / straightV!).toBeGreaterThan(1.15);
    expect(zigzagV! / straightV!).toBeLessThan(1.4);

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
    expect(nonNullCount('glide.track_efficiency')).toBeGreaterThanOrEqual(0.3 * started);

    // Sanity: track efficiency is a distance ratio ≥ ~1 for real tracks.
    const eff = report.metrics.find((m) => m.id === 'glide.track_efficiency')!;
    for (const v of eff.perPilot) {
      if (v.value !== null) expect(v.value).toBeGreaterThan(0.8);
    }
  }, 120_000);
});
