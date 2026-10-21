import { describe, it, expect } from 'bun:test';
import { aggregateComp, signConsistency } from '../src/analysis/aggregate';
import type {
  CompTaskResult,
  TaskAnalysisBasis,
  MetricCorrelation,
  MetricReport,
} from '../src/analysis/types';

const BASIS: TaskAnalysisBasis = {
  pilotCount: 2,
  gridStepSeconds: 10,
  sharedThermalCount: 0,
  multiPilotThermalCount: 0,
  workingBandFloor: 0,
  workingBandCeiling: 1,
  workingBandFallback: false,
  airtimeSplit: { climbPct: 40, glidePct: 40, searchPct: 20, airborneSeconds: 3600 },
};

/** One-metric task result with an injected correlation (or none). */
function mkTask(
  label: string,
  correlation: Partial<MetricCorrelation> & { rho: number; n: number } | null,
): CompTaskResult {
  const metric: MetricReport = {
    id: 'test.metric',
    label: 'Test metric',
    unit: 'ratio',
    family: 'gliding',
    direction: 'neutral',
    explanation: 'test',
    perPilot: [
      { trackFile: 'a.igc', value: 1 },
      { trackFile: 'b.igc', value: 2 },
    ],
    correlation: correlation
      ? {
          metricId: 'test.metric',
          absRho: Math.abs(correlation.rho),
          verdict: 'weak',
          ...correlation,
        }
      : null,
  };
  return {
    label,
    report: {
      basis: BASIS,
      pilots: [
        { trackFile: 'a.igc', pilotName: 'A', rank: 1 },
        { trackFile: 'b.igc', pilotName: 'B', rank: 2 },
      ],
      metrics: [metric],
    },
    pilotKeyByTrackFile: { 'a.igc': 'A', 'b.igc': 'B' },
    totals: [
      { trackFile: 'a.igc', pilotName: 'A', totalScore: 100 },
      { trackFile: 'b.igc', pilotName: 'B', totalScore: 50 },
    ],
  };
}

describe('signConsistency', () => {
  it('classifies by informative sign counts', () => {
    expect(signConsistency({ negative: 1, positive: 0, quiet: 3 })).toBe('quiet');
    expect(signConsistency({ negative: 4, positive: 0, quiet: 1 })).toBe('consistent');
    expect(signConsistency({ negative: 3, positive: 1, quiet: 0 })).toBe('leaning');
    expect(signConsistency({ negative: 2, positive: 2, quiet: 0 })).toBe('split');
    expect(signConsistency({ negative: 3, positive: 2, quiet: 0 })).toBe('split');
    expect(signConsistency({ negative: 0, positive: 0, quiet: 5 })).toBe('quiet');
  });
});

describe('aggregateComp sign-consistency aggregation', () => {
  it('counts only tasks that cleared their noise floor, and n-weights the signed mean', () => {
    const agg = aggregateComp([
      mkTask('T1', { rho: -0.6, n: 20, noiseFloor: 0.444 }),
      mkTask('T2', { rho: -0.5, n: 20, noiseFloor: 0.444 }),
      // Under its floor: sub-noise coefficients must not vote on the sign.
      mkTask('T3', { rho: 0.55, n: 10, noiseFloor: 0.632 }),
      mkTask('T4', null),
    ]);
    const m = agg.metrics[0];
    expect(m.signSummary).toEqual({ negative: 2, positive: 0, quiet: 1 });
    expect(m.consistency).toBe('consistent');
    expect(m.perTaskCorrelation.length).toBe(4);
    expect(m.perTaskCorrelation[3]).toBeNull();
    expect(m.perTaskCorrelation[0]).toEqual({ rho: -0.6, n: 20, noiseFloor: 0.444 });
    // (−0.6·20 − 0.5·20 + 0.55·10) / 50 — flip-flops cancel, unlike meanAbsRho.
    expect(m.meanSignedRho!).toBeCloseTo(-0.33, 6);
    expect(m.meanAbsRho!).toBeCloseTo(0.55, 6);
  });

  it('an even split of informative signs classifies as split', () => {
    const agg = aggregateComp([
      mkTask('T1', { rho: -0.6, n: 20, noiseFloor: 0.444 }),
      mkTask('T2', { rho: 0.6, n: 20, noiseFloor: 0.444 }),
    ]);
    const m = agg.metrics[0];
    expect(m.consistency).toBe('split');
    // Strong per-day power, no consistent direction — the day-dependence gap.
    expect(Math.abs(m.meanSignedRho!)).toBeCloseTo(0, 6);
    expect(m.meanAbsRho!).toBeCloseTo(0.6, 6);
  });

  it('recomputes a missing noise floor from n (pre-v8 stored reports)', () => {
    const agg = aggregateComp([
      // No noiseFloor field: at n = 10 the recomputed floor (~0.63) exceeds
      // |ρ| = 0.5, so this task must count as quiet, not vote positive.
      mkTask('T1', { rho: 0.5, n: 10 }),
      mkTask('T2', { rho: 0.5, n: 10 }),
    ]);
    const m = agg.metrics[0];
    expect(m.signSummary).toEqual({ negative: 0, positive: 0, quiet: 2 });
    expect(m.consistency).toBe('quiet');
    expect(m.perTaskCorrelation[0]!.noiseFloor).toBeGreaterThan(0.6);
  });
});

// ---------------------------------------------------------------------------
// Comp-level ρ (engine review 2026-10-20, 5.1)
// ---------------------------------------------------------------------------

/** A task with free per-pilot metric values and totals. */
function mkFieldTask(
  label: string,
  rows: { key: string; value: number; total: number }[],
): CompTaskResult {
  const metric: MetricReport = {
    id: 'test.metric',
    label: 'Test metric',
    unit: 'ratio',
    family: 'gliding',
    direction: 'neutral',
    explanation: 'test',
    perPilot: rows.map((r) => ({ trackFile: `${r.key}-${label}.igc`, value: r.value })),
    correlation: null,
  };
  return {
    label,
    report: {
      basis: BASIS,
      pilots: rows.map((r, i) => ({ trackFile: `${r.key}-${label}.igc`, pilotName: r.key, rank: i + 1 })),
      metrics: [metric],
    },
    pilotKeyByTrackFile: Object.fromEntries(rows.map((r) => [`${r.key}-${label}.igc`, r.key])),
    totals: rows.map((r) => ({ trackFile: `${r.key}-${label}.igc`, pilotName: r.key, totalScore: r.total })),
  };
}

describe('aggregateComp comp-level ρ', () => {
  it('keeps a day-level offset out of the comp ρ when pilots skip that day', () => {
    // Inside every task the metric says nothing (everyone reads the same),
    // but day 1 reads 100 and days 2–3 read 0. D, E and F skip day 1, so
    // they rank lower AND, on raw means, read lower — a perfect fake ρ.
    const all = ['A', 'B', 'C', 'D', 'E', 'F'];
    const day1 = mkFieldTask('T1', ['A', 'B', 'C'].map((key) => ({ key, value: 100, total: 500 })));
    const day2 = mkFieldTask('T2', all.map((key) => ({ key, value: 0, total: 500 })));
    const day3 = mkFieldTask('T3', all.map((key) => ({ key, value: 0, total: 500 })));
    const agg = aggregateComp([day1, day2, day3]);
    // Every pilot sits mid-field (percentile 0.5) in every task: no ρ.
    expect(agg.metrics[0].compRho).toBeNull();
    // …and the imbalance that would have produced one is reported.
    expect(agg.participation).toEqual({ minTasks: 2, maxTasks: 3, rho: expect.any(Number) });
    expect(agg.participation!.rho!).toBeLessThan(-0.8);
  });

  it('ranks within each task before averaging', () => {
    // Value order matches result order inside both tasks, at very
    // different levels: within-task percentiles agree perfectly.
    const t1 = mkFieldTask('T1', [
      { key: 'A', value: 30, total: 1000 },
      { key: 'B', value: 20, total: 600 },
      { key: 'C', value: 10, total: 300 },
    ]);
    const t2 = mkFieldTask('T2', [
      { key: 'A', value: 3000, total: 1000 },
      { key: 'B', value: 2000, total: 600 },
      { key: 'C', value: 1000, total: 300 },
    ]);
    const agg = aggregateComp([t1, t2]);
    expect(agg.metrics[0].compRho!.rho).toBeCloseTo(-1, 10);
    expect(agg.rankBasis).toBe('analysed-task-totals');
  });

  it('shares a comp rank between totals equal to one decimal', () => {
    const t1 = mkFieldTask('T1', [
      { key: 'A', value: 1, total: 812.44 },
      { key: 'B', value: 2, total: 812.36 },
      { key: 'C', value: 3, total: 811.6 },
    ]);
    const agg = aggregateComp([t1]);
    expect(agg.pilots.map((p) => [p.key, p.rank])).toEqual([
      ['A', 1],
      ['B', 1],
      ['C', 3],
    ]);
  });

  it('measures against the official ranking when given, leaving out pilots it does not rank', () => {
    const t1 = mkFieldTask('T1', [
      { key: 'A', value: 1, total: 900 },
      { key: 'B', value: 2, total: 800 },
      { key: 'C', value: 3, total: 700 },
      { key: 'X', value: 4, total: 100 },
    ]);
    // FTV (say) put C first overall.
    const agg = aggregateComp([t1], {
      compRanking: {
        C: { rank: 1, totalScore: 1500 },
        A: { rank: 2, totalScore: 1400 },
        B: { rank: 3, totalScore: 1300 },
      },
    });
    expect(agg.rankBasis).toBe('official');
    expect(agg.pilots.map((p) => [p.key, p.rank, p.totalScore])).toEqual([
      ['C', 1, 1500],
      ['A', 2, 1400],
      ['B', 3, 1300],
    ]);
    expect(agg.metrics[0].compRho!.n).toBe(3);
  });
});
