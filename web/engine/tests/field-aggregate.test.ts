import { describe, it, expect } from 'bun:test';
import { aggregateComp, signConsistency } from '../src/field-analysis/aggregate';
import type {
  CompTaskResult,
  FieldAnalysisBasis,
  MetricCorrelation,
  MetricReport,
} from '../src/field-analysis/types';

const BASIS: FieldAnalysisBasis = {
  pilotCount: 2,
  gridStepSeconds: 10,
  sharedThermalCount: 0,
  multiPilotThermalCount: 0,
  workingBandFloor: 0,
  workingBandCeiling: 1,
  workingBandFallback: false,
  phaseCoveragePct: 100,
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
