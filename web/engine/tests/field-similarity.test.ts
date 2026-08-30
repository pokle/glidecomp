import { describe, it, expect } from 'bun:test';
import { findSimilarPilots } from '../src/analysis/similarity';
import type {
  TaskAnalysisReport,
  MetricFamily,
  MetricReport,
} from '../src/analysis/types';

interface MetricSpec {
  id: string;
  family?: MetricFamily;
  outcome?: true;
  /** Aligned to the pilot names; null = not applicable. */
  values: (number | null)[];
}

/** A minimal-but-valid report. Ranks are filled in but deliberately never
 * asserted on: this surface must not depend on the leaderboard at all. */
function makeReport(names: string[], specs: MetricSpec[]): TaskAnalysisReport {
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
function shapedReport(): TaskAnalysisReport {
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
    expect(r.neighbours[0].similarity).toBeGreaterThan(0.9);
    // D and E both mirror A's shape, D at full amplitude and E at half. Their
    // SHAPE-only figure is −1 for both — that is what cosine alone would say —
    // but the similarity separates them, because D opposes A at A's own
    // magnitude while E is a half-sized opposite.
    for (const n of r.neighbours.slice(-2)) expect(n.shapeOnly).toBeCloseTo(-1, 10);
    expect(r.neighbours.at(-1)!.pilotName).toBe('D');
    expect(r.neighbours.at(-1)!.similarity).toBeLessThan(0);
  });

  it('contributions sum to the similarity', () => {
    const r = findSimilarPilots(shapedReport(), { subjectTrackFile: 'p0.igc' })!;
    for (const n of r.neighbours) {
      const sum = n.contributions.reduce((acc, c) => acc + c.contribution, 0);
      expect(sum).toBeCloseTo(n.similarity, 10);
    }
  });

  it('charges for a magnitude mismatch, where shape alone does not', () => {
    // B departs from the field average in exactly A's direction, but barely:
    // A sits at ±2.98 SD and B at ±0.04 SD. Cosine cannot tell them apart at
    // all; the measure we ship must. (Eight filler pilots keep A from dragging
    // the mean far enough to flip B's sign — z is measured from the field
    // average, so "a fraction of the amount" in raw units is not a fraction of
    // the z unless the field is wide enough to hold both.)
    const filler = [2, 2, 2, 2, 2, 2, 2, 2];
    const report = makeReport(
      ['A', 'B', ...filler.map((_, i) => `F${i}`)],
      [
        { id: 'm1', values: [10, 3, ...filler] },
        { id: 'm2', values: [10, 3, ...filler] },
        { id: 'm3', values: [-10, -3, ...filler.map((v) => -v)] },
      ],
    );
    const r = findSimilarPilots(report, { subjectTrackFile: 'p0.igc' })!;
    const b = r.neighbours.find((n) => n.pilotName === 'B')!;
    expect(b.shapeOnly).toBeCloseTo(1, 6); // shape alone sees no difference
    expect(b.similarity).toBeLessThan(0.05); // the shipped measure charges for it
    expect(b.typicalGap).toBeGreaterThan(2.5);
  });

  it('agrees with shape alone when the two magnitudes match', () => {
    // Identical vectors: both measures top out together.
    const report = makeReport(
      ['A', 'Twin', 'C'],
      [
        { id: 'm1', values: [8, 8, 1] },
        { id: 'm2', values: [3, 3, 9] },
        { id: 'm3', values: [6, 6, 2] },
      ],
    );
    const r = findSimilarPilots(report, { subjectTrackFile: 'p0.igc' })!;
    const twin = r.neighbours.find((n) => n.pilotName === 'Twin')!;
    expect(twin.shapeOnly).toBeCloseTo(1, 10);
    expect(twin.similarity).toBeCloseTo(1, 10);
    expect(twin.typicalGap).toBeCloseTo(0, 10);
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
      expect(n.similarity).toBeCloseTo(base.neighbours[i].similarity, 10),
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
    expect(b.similarity).toBeGreaterThan(c.similarity);
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

  it('ignores unknown metric ids rather than erroring', () => {
    const withGhost = findSimilarPilots(shapedReport(), {
      subjectTrackFile: 'p0.igc',
      metricIds: ['m1', 'm2', 'm3', 'gone.away'],
    })!;
    expect(withGhost.metrics.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    // Nothing usable at all is the only null.
    expect(
      findSimilarPilots(shapedReport(), {
        subjectTrackFile: 'p0.igc',
        metricIds: ['gone.away'],
      }),
    ).toBeNull();
  });

  it('two behaviours are enough for a cosine — the old floor of three was wrong', () => {
    const r = findSimilarPilots(shapedReport(), {
      subjectTrackFile: 'p0.igc',
      metricIds: ['m1', 'm3'],
    })!;
    expect(r.ranking).toBe('cosine');
    expect(r.neighbours.length).toBeGreaterThan(0);
    expect(r.neighbours.every((n) => n.sharedMetrics === 2)).toBe(true);
  });

  it('one behaviour ranks by the gap, because cosine can only say ±1 there', () => {
    const r = findSimilarPilots(shapedReport(), {
      subjectTrackFile: 'p0.igc',
      metricIds: ['m1'],
    })!;
    expect(r.ranking).toBe('gap');
    // m1 is [9, 8, 5, 1, 2] for A..E, and A is the subject: nearest by value
    // first, all the way out to the far end of the field.
    expect(r.neighbours.map((n) => n.pilotName)).toEqual(['B', 'C', 'E', 'D']);
    // Ordered by gap ascending, and every gap is |Δz| on that one behaviour.
    const gaps = r.neighbours.map((n) => n.typicalGap);
    expect([...gaps].sort((a, b) => a - b)).toEqual(gaps);
    for (const n of r.neighbours) {
      const c = n.contributions[0];
      expect(n.typicalGap).toBeCloseTo(Math.abs(c.subjectZ - c.neighbourZ), 10);
    }
    // Shape alone really is degenerate here — exactly the reason for the mode.
    // In one dimension it can only be +1 (same side of the average), −1 (the
    // other side), or 0 (a pilot sitting exactly ON the average, where there is
    // no direction). Three values, and no ordering inside any of them.
    const seen = new Set(r.neighbours.map((n) => n.shapeOnly));
    expect([...seen].every((c) => c === 1 || c === -1 || c === 0)).toBe(true);
    expect(seen.size).toBeLessThanOrEqual(3);
    expect(r.explanation).toContain('one behaviour');
  });

  it('a gap sheet keeps a pilot sitting exactly at the field average', () => {
    // C's m1 value IS the mean, so their z is 0 — no direction, which a cosine
    // sheet must skip. On a gap sheet they are a legitimate (and here, close)
    // answer, so they must NOT be dropped.
    const r = findSimilarPilots(shapedReport(), {
      subjectTrackFile: 'p0.igc',
      metricIds: ['m1'],
    })!;
    expect(r.skipped).toHaveLength(0);
    const c = r.neighbours.find((n) => n.pilotName === 'C')!;
    expect(c.contributions[0].neighbourZ).toBeCloseTo(0, 10);
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

  it('carries a per-row noise floor, and flags rows that do not clear it', () => {
    const r = findSimilarPilots(shapedReport(), { subjectTrackFile: 'p0.igc' })!;
    for (const n of r.neighbours) {
      expect(n.noiseFloor).toBeGreaterThan(0);
      expect(n.aboveNoiseFloor).toBe(n.similarity > n.noiseFloor);
    }
    // B is a genuine near-twin over four behaviours and must clear its floor.
    expect(r.neighbours.find((x) => x.pilotName === 'B')!.aboveNoiseFloor).toBe(true);
  });

  it('gives a sparse pair a harder floor than a well-supported one', () => {
    // Sparse shares 3 behaviours with A; everyone else shares all 6. The
    // sparse row must be held to a much higher bar before it means anything.
    const report = makeReport(
      ['A', 'B', 'C', 'Sparse'],
      [
        { id: 'm1', values: [9, 8, 1, 7] },
        { id: 'm2', values: [8, 7, 2, 6] },
        { id: 'm3', values: [2, 3, 9, 4] },
        { id: 'm4', values: [1, 2, 8, null] },
        { id: 'm5', values: [7, 6, 3, null] },
        { id: 'm6', values: [3, 4, 7, null] },
      ],
    );
    const r = findSimilarPilots(report, { subjectTrackFile: 'p0.igc' })!;
    const sparse = r.neighbours.find((n) => n.pilotName === 'Sparse')!;
    const dense = r.neighbours.find((n) => n.pilotName === 'B')!;
    expect(sparse.sharedMetrics).toBe(3);
    expect(dense.sharedMetrics).toBe(6);
    expect(sparse.noiseFloor).toBeGreaterThan(dense.noiseFloor);
  });

  it('a gap-ranked sheet has no noise floor to report', () => {
    const r = findSimilarPilots(shapedReport(), {
      subjectTrackFile: 'p0.igc',
      metricIds: ['m1'],
    })!;
    expect(r.ranking).toBe('gap');
    for (const n of r.neighbours) {
      expect(n.noiseFloor).toBeNaN();
      expect(n.aboveNoiseFloor).toBe(false);
    }
  });

  it('is deterministic and independent of the leaderboard', () => {
    const a = findSimilarPilots(shapedReport(), { subjectTrackFile: 'p0.igc' })!;
    // The same field with the ranks reversed must produce the same answer.
    const reranked = shapedReport();
    reranked.pilots = reranked.pilots.map((p, i) => ({ ...p, rank: 5 - i }));
    const b = findSimilarPilots(reranked, { subjectTrackFile: 'p0.igc' })!;
    expect(b.neighbours.map((n) => [n.pilotName, n.similarity])).toEqual(
      a.neighbours.map((n) => [n.pilotName, n.similarity]),
    );
  });
});
