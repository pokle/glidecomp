import { describe, it, expect } from 'bun:test';
import { findSimilarPilots } from '../src/field-analysis/similarity';
import type {
  FieldAnalysisReport,
  MetricFamily,
  MetricReport,
} from '../src/field-analysis/types';

interface MetricSpec {
  id: string;
  family?: MetricFamily;
  outcome?: true;
  /** Aligned to the pilot names; null = not applicable. */
  values: (number | null)[];
}

/** A minimal-but-valid report. Ranks are filled in but deliberately never
 * asserted on: this surface must not depend on the leaderboard at all. */
function makeReport(names: string[], specs: MetricSpec[]): FieldAnalysisReport {
  const pilots = names.map((pilotName, i) => ({
    trackFile: `p${i}.igc`,
    pilotName,
    rank: i + 1,
  }));
  const metrics: MetricReport[] = specs.map((s) => {
    expect(s.values.length).toBe(names.length);
    return {
      id: s.id,
      label: s.id,
      unit: 'ratio',
      family: s.family ?? 'gliding',
      direction: 'neutral' as const,
      explanation: 'synthetic',
      ...(s.outcome ? { outcome: true as const } : {}),
      perPilot: pilots.map((p, i) => ({ trackFile: p.trackFile, value: s.values[i] })),
      correlation: null,
    };
  });
  return {
    basis: {
      pilotCount: pilots.length,
      gridStepSeconds: 5,
      sharedThermalCount: 0,
      multiPilotThermalCount: 0,
      workingBandFloor: 500,
      workingBandCeiling: 2500,
      workingBandFallback: false,
      airtimeSplit: { climbPct: 40, glidePct: 40, searchPct: 20, airborneSeconds: 3600 },
    },
    pilots,
    metrics,
  };
}

/**
 * Five pilots over four behaviours. A and B share a shape (high on m1/m2,
 * low on m3/m4); D is A's mirror image; C sits in the middle of the field.
 */
function shapedReport(): FieldAnalysisReport {
  return makeReport(
    ['A', 'B', 'C', 'D', 'E'],
    [
      { id: 'm1', values: [9, 8, 5, 1, 2] },
      { id: 'm2', values: [9, 8, 5, 1, 2] },
      { id: 'm3', values: [1, 2, 5, 9, 8] },
      { id: 'm4', values: [1, 2, 5, 9, 8] },
    ],
  );
}

describe('findSimilarPilots', () => {
  it('puts the pilot with the same shape first and the mirror image last', () => {
    const r = findSimilarPilots(shapedReport(), { subjectTrackFile: 'p0.igc' })!;
    expect(r).not.toBeNull();
    expect(r.subject.pilotName).toBe('A');
    expect(r.neighbours[0].pilotName).toBe('B');
    expect(r.neighbours[0].cosine).toBeGreaterThan(0.9);
    // D and E are both exact mirrors of A's shape (D at full amplitude, E at
    // half) — cosine ignores amplitude, so they tie at −1 and sort by name.
    expect(r.neighbours.slice(-2).map((n) => n.pilotName)).toEqual(['D', 'E']);
    for (const n of r.neighbours.slice(-2)) expect(n.cosine).toBeCloseTo(-1, 10);
  });

  it('contributions sum to the cosine', () => {
    const r = findSimilarPilots(shapedReport(), { subjectTrackFile: 'p0.igc' })!;
    for (const n of r.neighbours) {
      const sum = n.contributions.reduce((acc, c) => acc + c.contribution, 0);
      expect(sum).toBeCloseTo(n.cosine, 10);
    }
  });

  it('is unaffected by the unit a behaviour is recorded in', () => {
    // The whole reason for normalising: cosine over RAW values is dominated by
    // whichever behaviour happens to be measured in big numbers, so recording
    // one in a smaller unit would change who your nearest neighbour is. A
    // z-score divides the unit out, so it cannot.
    const base = findSimilarPilots(shapedReport(), { subjectTrackFile: 'p0.igc' })!;
    const rescaled = shapedReport();
    // m3 rescaled and shifted — metres rather than kilometres, say.
    rescaled.metrics[2].perPilot = rescaled.metrics[2].perPilot.map((p) => ({
      ...p,
      value: p.value === null ? null : p.value * 1000 + 7,
    }));
    const after = findSimilarPilots(rescaled, { subjectTrackFile: 'p0.igc' })!;
    expect(after.neighbours.map((n) => n.pilotName)).toEqual(
      base.neighbours.map((n) => n.pilotName),
    );
    after.neighbours.forEach((n, i) =>
      expect(n.cosine).toBeCloseTo(base.neighbours[i].cosine, 10),
    );
  });

  it('keeps the size of a gap, not just its order', () => {
    // A and B are near-identical on m1/m3 while C is far off. A rank transform
    // would put A and B a full place apart regardless; a z-score records them
    // as nearly touching, which is the whole reason for choosing it.
    const report = makeReport(
      ['A', 'B', 'C'],
      [
        { id: 'm1', values: [10, 9.99, 1] },
        { id: 'm2', values: [5, 5.01, 9] },
        { id: 'm3', values: [2, 2.01, 9] },
      ],
    );
    const r = findSimilarPilots(report, { subjectTrackFile: 'p0.igc' })!;
    const b = r.neighbours.find((n) => n.pilotName === 'B')!;
    const c = r.neighbours.find((n) => n.pilotName === 'C')!;
    expect(b.typicalGap).toBeLessThan(0.1);
    expect(c.typicalGap).toBeGreaterThan(1);
    expect(b.cosine).toBeGreaterThan(c.cosine);
  });

  it('typicalGap is the RMS difference in z over the shared behaviours', () => {
    const r = findSimilarPilots(shapedReport(), { subjectTrackFile: 'p0.igc' })!;
    for (const n of r.neighbours) {
      const rms = Math.sqrt(
        n.contributions.reduce((s, c) => s + (c.subjectZ - c.neighbourZ) ** 2, 0) /
          n.contributions.length,
      );
      expect(n.typicalGap).toBeCloseTo(rms, 10);
    }
  });

  it('honours the selected behaviours', () => {
    const r = findSimilarPilots(shapedReport(), {
      subjectTrackFile: 'p0.igc',
      metricIds: ['m1', 'm2', 'm3'],
    })!;
    expect(r.metrics.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    expect(r.neighbours.every((n) => n.sharedMetrics === 3)).toBe(true);
  });

  it('z-scores are measured against the field average, and are unit-free', () => {
    const r = findSimilarPilots(shapedReport(), { subjectTrackFile: 'p0.igc' })!;
    const c = r.neighbours[0].contributions.find((x) => x.metricId === 'm1')!;
    // m1 values are [9, 8, 5, 1, 2]: mean 5, population SD 3.03…
    const vals = [9, 8, 5, 1, 2];
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length);
    expect(c.subjectValue).toBe(9);
    expect(c.subjectZ).toBeCloseTo((9 - mean) / sd, 10);
    // ...and the neighbour's z comes off the same field statistics.
    expect(c.neighbourValue).toBe(8);
    expect(c.neighbourZ).toBeCloseTo((8 - mean) / sd, 10);
    // The field average itself scores 0: C's m1 value IS the mean. (C has no
    // direction at all here, so they are skipped rather than ranked — see the
    // "no direction" test — hence reading them off the report, not a row.)
    expect(r.skipped.map((x) => x.pilotName)).toContain('C');
  });

  it('ignores unknown metric ids rather than erroring, and refuses too few', () => {
    const withGhost = findSimilarPilots(shapedReport(), {
      subjectTrackFile: 'p0.igc',
      metricIds: ['m1', 'm2', 'm3', 'gone.away'],
    })!;
    expect(withGhost.metrics.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    expect(
      findSimilarPilots(shapedReport(), {
        subjectTrackFile: 'p0.igc',
        metricIds: ['m1', 'm2'],
      }),
    ).toBeNull();
  });

  it('excludes outcome metrics — no score-derived value may enter the vector', () => {
    const report = makeReport(
      ['A', 'B', 'C', 'D', 'E'],
      [
        { id: 'm1', values: [9, 8, 5, 1, 2] },
        { id: 'm2', values: [9, 8, 5, 1, 2] },
        { id: 'm3', values: [1, 2, 5, 9, 8] },
        { id: 'm4', values: [1, 2, 5, 9, 8] },
        { id: 'score.points', outcome: true, values: [100, 90, 80, 70, 60] },
      ],
    );
    const r = findSimilarPilots(report, { subjectTrackFile: 'p0.igc' })!;
    expect(r.metrics.map((m) => m.id)).not.toContain('score.points');
    expect(r.metrics).toHaveLength(4);
  });

  it('skips a pilot sharing too few behaviours instead of scoring them', () => {
    const report = makeReport(
      ['A', 'B', 'Sparse'],
      [
        { id: 'm1', values: [9, 8, 5] },
        { id: 'm2', values: [9, 8, null] },
        { id: 'm3', values: [1, 2, null] },
        { id: 'm4', values: [1, 2, null] },
      ],
    );
    const r = findSimilarPilots(report, { subjectTrackFile: 'p0.igc' })!;
    expect(r.neighbours.map((n) => n.pilotName)).toEqual(['B']);
    expect(r.skipped.map((s) => s.pilotName)).toEqual(['Sparse']);
    expect(r.skipped[0].reason).toContain('in common');
  });

  it('says so rather than inventing a 0 for a pilot with no direction', () => {
    // C sits at the field average on every behaviour, so every z is 0: their
    // vector has zero length and the angle to them is undefined.
    const report = makeReport(
      ['A', 'C', 'D'],
      [
        { id: 'm1', values: [9, 5, 1] },
        { id: 'm2', values: [9, 5, 1] },
        { id: 'm3', values: [1, 5, 9] },
        { id: 'm4', values: [1, 5, 9] },
      ],
    );
    const r = findSimilarPilots(report, { subjectTrackFile: 'p0.igc' })!;
    expect(r.neighbours.map((n) => n.pilotName)).toEqual(['D']);
    expect(r.skipped.map((s) => s.pilotName)).toEqual(['C']);
    expect(r.skipped[0].reason).toContain('no direction to compare');
  });

  it('is null for a pilot who is not in the report', () => {
    expect(findSimilarPilots(shapedReport(), { subjectTrackFile: 'nope.igc' })).toBeNull();
  });

  it('is deterministic and independent of the leaderboard', () => {
    const a = findSimilarPilots(shapedReport(), { subjectTrackFile: 'p0.igc' })!;
    // The same field with the ranks reversed must produce the same answer.
    const reranked = shapedReport();
    reranked.pilots = reranked.pilots.map((p, i) => ({ ...p, rank: 5 - i }));
    const b = findSimilarPilots(reranked, { subjectTrackFile: 'p0.igc' })!;
    expect(b.neighbours.map((n) => [n.pilotName, n.cosine])).toEqual(
      a.neighbours.map((n) => [n.pilotName, n.cosine]),
    );
  });
});
