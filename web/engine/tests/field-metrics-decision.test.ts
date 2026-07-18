/**
 * Stage 1 package P3 — decision-making metrics (plan metrics 12–15).
 *
 * Synthetic fields via the frozen makeTestField factory, one happy path and
 * one null/edge case per metric, plus a smoke test over the real
 * kosci-loop-t1 field.
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
import { buildFieldContext, evaluateField, type FieldContext } from '../src/field-analysis';
import { DECISION_METRICS } from '../src/field-analysis/metrics/decision';
import {
  makeTestField,
  straightFixes,
  circlingFixes,
  BASE_TIME,
  TEST_ORIGIN,
} from './field-test-helpers';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const byId = (id: string) => {
  const m = DECISION_METRICS.find((m) => m.id === id);
  if (!m) throw new Error(`metric ${id} not registered`);
  return m;
};

/** A minimal TurnpointReaching at BASE_TIME + seconds (for sss/ess overrides). */
function reachingAt(seconds: number, taskIndex = 1): TurnpointReaching {
  return {
    taskIndex,
    fixIndex: 0,
    time: new Date(BASE_TIME.getTime() + seconds * 1000),
    latitude: TEST_ORIGIN.lat,
    longitude: TEST_ORIGIN.lon,
    altitude: 1000,
    selectionReason: 'first_after_previous',
    candidateCount: 1,
  };
}

/** turnpointResult override for a pilot who started at BASE_TIME + seconds. */
const startedAt = (seconds: number) => ({ sssReaching: reachingAt(seconds, 1) });

function valueFor(field: FieldContext, id: string, name: string): number | null {
  const out = byId(id).compute(field);
  const entry = out.perPilot.find((v) => v.trackFile === `${name}.igc`);
  if (!entry) throw new Error(`no perPilot entry for ${name}`);
  return entry.value;
}

function noteFor(field: FieldContext, id: string, name: string): string | undefined {
  const out = byId(id).compute(field);
  return out.perPilot.find((v) => v.trackFile === `${name}.igc`)?.note;
}

/**
 * A wavy altitude profile with two prominent (600 m) dips down to `base`,
 * ending in a climb so both minima have a confirmed rise after them.
 */
function twoDipFixes(base: number): IGCFix[] {
  return [
    ...straightFixes(0, 240, 0, base + 600, 12, -2.5), // descend to base
    ...straightFixes(250, 240, 3000, base, 12, 2.5), // climb back out
    ...straightFixes(500, 240, 6000, base + 600, 12, -2.5), // descend again
    ...straightFixes(750, 240, 9000, base, 12, 2.5), // climb out
  ];
}

// ---------------------------------------------------------------------------
// Metric 12 — decision.altitude_floor
// ---------------------------------------------------------------------------

describe('decision.altitude_floor', () => {
  const field = makeTestField([
    { name: 'hi', fixes: twoDipFixes(1300), turnpointResult: startedAt(0) },
    { name: 'lo', fixes: twoDipFixes(1000), turnpointResult: startedAt(0) },
    // Started but only ONE prominent dip (down once, up once) → < 2 minima.
    {
      name: 'onedip',
      fixes: [
        ...straightFixes(0, 240, 0, 1600, 12, -2.5),
        ...straightFixes(250, 240, 3000, 1000, 12, 2.5),
      ],
      turnpointResult: startedAt(0),
    },
    // Never started → null regardless of profile.
    { name: 'ns', fixes: twoDipFixes(1000) },
  ]);

  it('reports the median dip altitude as a band percentage, higher for the pilot who stays higher', () => {
    const hi = valueFor(field, 'decision.altitude_floor', 'hi');
    const lo = valueFor(field, 'decision.altitude_floor', 'lo');
    expect(hi).not.toBeNull();
    expect(lo).not.toBeNull();
    expect(Number.isFinite(hi!)).toBe(true);
    expect(hi!).toBeGreaterThan(lo!);
    expect(noteFor(field, 'decision.altitude_floor', 'hi')).toContain('dips');
  });

  it('is null for a never-started pilot and for fewer than 2 prominent minima', () => {
    expect(valueFor(field, 'decision.altitude_floor', 'ns')).toBeNull();
    expect(valueFor(field, 'decision.altitude_floor', 'onedip')).toBeNull();
  });

  it('covers every pilot exactly once', () => {
    const out = byId('decision.altitude_floor').compute(field);
    expect(out.perPilot.length).toBe(field.pilots.length);
    expect(new Set(out.perPilot.map((v) => v.trackFile)).size).toBe(field.pilots.length);
  });
});

// ---------------------------------------------------------------------------
// Metric 13 — decision.low_saves
// ---------------------------------------------------------------------------

describe('decision.low_saves', () => {
  // saver: digs down to ~250 m then climbs 500 m — a textbook low save.
  const saver = [
    ...straightFixes(0, 500, 0, 1500, 12, -2.5), // 1500 → 250
    ...circlingFixes(510, 250, 6100, 250, 2), // 250 → 750 (gain 500 ≥ 300)
    ...straightFixes(770, 300, 6200, 750, 12, -0.5),
  ];
  // high: a solid 400 m climb, but entered from high in the band.
  const high = [
    ...straightFixes(0, 300, 0, 1600, 12, -0.5),
    ...circlingFixes(310, 250, 3700, 1450, 1.6), // 1450 → 1850
    ...straightFixes(570, 300, 3800, 1850, 12, -0.5),
  ];
  const field = makeTestField([
    { name: 'saver', fixes: saver, turnpointResult: startedAt(0) },
    { name: 'high', fixes: high, turnpointResult: startedAt(0) },
    { name: 'ns', fixes: saver.map((f) => ({ ...f })) },
  ]);

  it('fixture sanity: the save entry sits below the low-save threshold', () => {
    const threshold = field.workingBand.floorMeters + 0.15 * field.workingBand.spanMeters;
    const saverCtx = field.pilots.find((p) => p.trackFile === 'saver.igc')!;
    expect(saverCtx.thermals.length).toBeGreaterThan(0);
    expect(Math.min(...saverCtx.thermals.map((t) => t.startAltitude))).toBeLessThan(threshold);
  });

  it('counts the save and notes its depth', () => {
    expect(valueFor(field, 'decision.low_saves', 'saver')).toBeGreaterThanOrEqual(1);
    expect(noteFor(field, 'decision.low_saves', 'saver')).toContain('deepest save');
  });

  it('scores a started pilot with no low saves as a valid 0, never-started as null', () => {
    expect(valueFor(field, 'decision.low_saves', 'high')).toBe(0);
    expect(noteFor(field, 'decision.low_saves', 'high')).toBeUndefined();
    expect(valueFor(field, 'decision.low_saves', 'ns')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Metric 14 — decision.climbs_per_100km
// ---------------------------------------------------------------------------

describe('decision.climbs_per_100km', () => {
  // fast + slow share one thermal (same place, same time, different rates).
  const climbAndGlide = (rate: number) => [
    ...circlingFixes(0, 300, 0, 1000, rate),
    ...straightFixes(310, 400, 60, 1000 + rate * 300, 12, -1),
  ];
  const field = makeTestField([
    {
      name: 'fast',
      fixes: climbAndGlide(2.5),
      turnpointResult: startedAt(0),
      score: { flownDistance: 50_000 },
    },
    {
      name: 'slow',
      fixes: climbAndGlide(1.0),
      turnpointResult: startedAt(0),
      score: { flownDistance: 50_000 },
    },
    // Started but flew < 20 km → null.
    {
      name: 'short',
      fixes: straightFixes(0, 600, 0, 1500, 12, -1),
      turnpointResult: startedAt(0),
      score: { flownDistance: 10_000 },
    },
    // Never started → null.
    { name: 'ns', fixes: straightFixes(0, 600, 0, 1500, 12, -1) },
  ]);

  it('divides post-start thermal count by flown distance per 100 km', () => {
    const fastCtx = field.pilots.find((p) => p.trackFile === 'fast.igc')!;
    expect(fastCtx.thermals.length).toBeGreaterThan(0);
    // 50 km flown → count / 0.5.
    expect(valueFor(field, 'decision.climbs_per_100km', 'fast')).toBe(
      fastCtx.thermals.length * 2,
    );
  });

  it('notes the shared-thermal climb percentile (faster climber ranks above slower)', () => {
    // The two pilots' thermals overlap in space and time → one shared thermal.
    expect(field.sharedThermals.some((s) => s.pilotCount >= 2)).toBe(true);
    expect(noteFor(field, 'decision.climbs_per_100km', 'fast')).toContain('pctile 100%');
    expect(noteFor(field, 'decision.climbs_per_100km', 'slow')).toContain('pctile 0%');
  });

  it('is null below 20 km flown and for never-started pilots', () => {
    expect(valueFor(field, 'decision.climbs_per_100km', 'short')).toBeNull();
    expect(valueFor(field, 'decision.climbs_per_100km', 'ns')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Metric 15 — decision.search_fraction
// ---------------------------------------------------------------------------

describe('decision.search_fraction', () => {
  // climb 300 s, fast glide 300 s, then a slow 4 m/s meander (search) 300 s.
  const searcherTrack = [
    ...circlingFixes(0, 300, 0, 1000, 2), // climb 1000 → 1600
    ...straightFixes(310, 300, 60, 1600, 12, -1), // glide → 1300
    ...straightFixes(620, 300, 3720, 1300, 4, 0), // slow meander → search
  ];
  const cruiserTrack = [
    ...circlingFixes(0, 300, 0, 1000, 2),
    ...straightFixes(310, 600, 60, 1600, 12, -0.5),
  ];
  const field = makeTestField([
    { name: 'searcher', fixes: searcherTrack, turnpointResult: startedAt(0) },
    { name: 'cruiser', fixes: cruiserTrack, turnpointResult: startedAt(0) },
    // Same track as searcher, but ESS before the meander → search clipped out.
    {
      name: 'clipped',
      fixes: searcherTrack.map((f) => ({ ...f })),
      turnpointResult: { sssReaching: reachingAt(0, 1), essReaching: reachingAt(610, 2) },
    },
    { name: 'ns', fixes: cruiserTrack.map((f) => ({ ...f })) },
  ]);

  it('charges the slow meander as search time', () => {
    const searcher = valueFor(field, 'decision.search_fraction', 'searcher');
    const cruiser = valueFor(field, 'decision.search_fraction', 'cruiser');
    expect(searcher).not.toBeNull();
    expect(cruiser).not.toBeNull();
    // ~1/3 of the window is the meander; allow generous detector fuzz.
    expect(searcher!).toBeGreaterThan(15);
    expect(searcher!).toBeLessThan(55);
    expect(cruiser!).toBeLessThan(searcher!);
  });

  it('clips the window at ESS, excluding post-ESS wandering', () => {
    const clipped = valueFor(field, 'decision.search_fraction', 'clipped');
    expect(clipped).not.toBeNull();
    expect(clipped!).toBeLessThan(10);
  });

  it('is null for a never-started pilot and summarises the field phase shares', () => {
    expect(valueFor(field, 'decision.search_fraction', 'ns')).toBeNull();
    const out = byId('decision.search_fraction').compute(field);
    expect(out.fieldSummary).toBeDefined();
    expect(out.fieldSummary!.join('\n')).toContain('climb');
    expect(out.fieldSummary!.join('\n')).toContain('search');
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

describe('decision metrics over kosci-loop-t1 (smoke)', () => {
  it('produces sane coverage and finite correlations on a real field', () => {
    const field = buildKosciField();
    const started = field.pilots.filter((p) => p.sssMs !== null);
    expect(started.length).toBeGreaterThan(20);

    const report = evaluateField(field, DECISION_METRICS);
    expect(report.metrics.length).toBe(DECISION_METRICS.length);

    const startedFiles = new Set(started.map((p) => p.trackFile));
    for (const m of report.metrics) {
      expect(m.error).toBeUndefined();
      expect(m.perPilot.length).toBe(field.pilots.length);
      // Never-started pilots are always null for this SSS-scoped family.
      for (const v of m.perPilot) {
        if (!startedFiles.has(v.trackFile)) expect(v.value).toBeNull();
        if (v.value !== null) expect(Number.isFinite(v.value)).toBe(true);
      }
      // Lenient coverage: at least half the ELIGIBLE started field gets a
      // value. climbs_per_100km additionally requires ≥ 20 km flown (kosci
      // T1 is a ~19.6 km task, so its eligible set can legitimately be empty).
      const eligible =
        m.id === 'decision.climbs_per_100km'
          ? started.filter((p) => p.score.flownDistance >= 20_000)
          : started;
      const nonNull = m.perPilot.filter((v) => v.value !== null).length;
      expect(nonNull).toBeGreaterThanOrEqual(Math.floor(eligible.length / 2));
      if (m.correlation) {
        expect(Number.isFinite(m.correlation.rho)).toBe(true);
        expect(m.correlation.n).toBeGreaterThanOrEqual(3);
      }
    }

    // search_fraction always publishes a field summary on a populated field.
    const search = report.metrics.find((m) => m.id === 'decision.search_fraction')!;
    expect(search.fieldSummary?.length).toBeGreaterThan(0);
  }, 120_000);
});
