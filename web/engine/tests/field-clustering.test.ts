import { describe, it, expect } from 'bun:test';
import {
  clusterPilotStyles,
  MIN_CLUSTER_PILOTS,
} from '../src/field-analysis/clustering';
import { renderFieldReport } from '../src/field-analysis/report';
import type {
  FieldAnalysisReport,
  MetricDirection,
  MetricFamily,
  MetricReport,
} from '../src/field-analysis/types';

/** A synthetic metric column for makeReport. */
interface MetricSpec {
  id: string;
  family?: MetricFamily;
  direction?: MetricDirection;
  outcome?: true;
  error?: string;
  /** Aligned to the pilots array; null = not applicable. */
  values: (number | null)[];
}

/**
 * A minimal-but-valid FieldAnalysisReport: pilot i is `Pilot i` on track
 * `p<i>.igc`; ranks come from the caller so style groups and the leaderboard
 * can deliberately disagree.
 */
function makeReport(ranks: number[], specs: MetricSpec[]): FieldAnalysisReport {
  const pilots = ranks.map((rank, i) => ({
    trackFile: `p${i}.igc`,
    pilotName: `Pilot ${i}`,
    rank,
  }));
  const metrics: MetricReport[] = specs.map((s) => {
    expect(s.values.length).toBe(ranks.length);
    return {
      id: s.id,
      label: s.id,
      unit: 'ratio',
      family: s.family ?? 'gliding',
      direction: s.direction ?? 'higher',
      explanation: 'synthetic',
      ...(s.outcome ? { outcome: true as const } : {}),
      perPilot: pilots.map((p, i) => ({ trackFile: p.trackFile, value: s.values[i] })),
      correlation: null,
      ...(s.error !== undefined ? { error: s.error } : {}),
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
      phaseCoveragePct: 100,
    },
    pilots,
    metrics,
  };
}

/** n values around a centre with a small deterministic spread. */
function around(centre: number, n: number, step = 0.01): number[] {
  return Array.from({ length: n }, (_, i) => centre + i * step);
}

/** Two 6-pilot style groups over 6 metrics: pilots 0–5 run HIGH on metrics
 * a1–a3 and LOW on b1–b3; pilots 6–11 the reverse. Ranks interleave the
 * groups so style ≠ leaderboard order. */
function twoGroupReport(): FieldAnalysisReport {
  const hi = around(10, 6);
  const lo = around(1, 6);
  const ranks = [1, 3, 5, 7, 9, 11, 2, 4, 6, 8, 10, 12];
  const specs: MetricSpec[] = [
    { id: 'a1', values: [...hi, ...lo] },
    { id: 'a2', values: [...hi, ...lo] },
    { id: 'a3', values: [...hi, ...lo] },
    { id: 'b1', values: [...lo, ...hi] },
    { id: 'b2', values: [...lo, ...hi] },
    { id: 'b3', values: [...lo, ...hi] },
  ];
  return makeReport(ranks, specs);
}

const membersOf = (sc: NonNullable<ReturnType<typeof clusterPilotStyles>>) =>
  sc.clusters.map((c) => c.members.map((m) => m.trackFile).sort());

describe('clusterPilotStyles', () => {
  it('recovers two planted style groups regardless of rank order', () => {
    const sc = clusterPilotStyles(twoGroupReport());
    expect(sc).not.toBeNull();
    expect(sc!.k).toBe(2);
    expect(sc!.pilotCount).toBe(12);
    expect(sc!.metricCount).toBe(6);
    const groups = membersOf(sc!);
    const groupA = ['p0.igc', 'p1.igc', 'p2.igc', 'p3.igc', 'p4.igc', 'p5.igc'];
    const groupB = ['p6.igc', 'p7.igc', 'p8.igc', 'p9.igc', 'p10.igc', 'p11.igc'].sort();
    expect(groups).toContainEqual(groupA);
    expect(groups).toContainEqual(groupB);
    // Well-separated planted groups → a high silhouette.
    expect(sc!.meanSilhouette).toBeGreaterThan(0.5);
  });

  it('orders clusters by median rank and letters them from A', () => {
    const sc = clusterPilotStyles(twoGroupReport())!;
    expect(sc.clusters.map((c) => c.id)).toEqual(['A', 'B']);
    expect(sc.clusters[0].rankMedian).toBeLessThan(sc.clusters[1].rankMedian);
    // The interleaved ranks: group of pilots 0–5 holds ranks 1,3,5,7,9,11.
    const a = sc.clusters[0];
    expect(a.rankBest).toBe(1);
    expect(a.rankWorst).toBe(11);
    expect(a.rankMedian).toBe(6);
    // Members sorted by rank ascending.
    for (const c of sc.clusters) {
      for (let i = 1; i < c.members.length; i++) {
        expect(c.members[i].rank).toBeGreaterThan(c.members[i - 1].rank);
      }
    }
  });

  it('annotates each group with signature metrics on both sides of P50', () => {
    const sc = clusterPilotStyles(twoGroupReport())!;
    for (const c of sc.clusters) {
      expect(c.signatures.length).toBeGreaterThan(0);
      const highIds = c.signatures.filter((s) => s.deviation > 0).map((s) => s.metricId);
      const lowIds = c.signatures.filter((s) => s.deviation < 0).map((s) => s.metricId);
      const isAGroup = c.members.some((m) => m.trackFile === 'p0.igc');
      // The planted profile: a-metrics high for group with pilot 0, low for the other.
      for (const id of highIds) expect(id.startsWith(isAGroup ? 'a' : 'b')).toBe(true);
      for (const id of lowIds) expect(id.startsWith(isAGroup ? 'b' : 'a')).toBe(true);
      // Sorted by |deviation| descending (ties, within float noise, by id).
      for (let i = 1; i < c.signatures.length; i++) {
        expect(Math.abs(c.signatures[i].deviation)).toBeLessThanOrEqual(
          Math.abs(c.signatures[i - 1].deviation) + 1e-9,
        );
      }
    }
  });

  it('is deterministic: same report, same clusters', () => {
    const a = clusterPilotStyles(twoGroupReport());
    const b = clusterPilotStyles(twoGroupReport());
    expect(a).toEqual(b);
  });

  it('recovers three planted groups via the silhouette search', () => {
    const n = 5;
    const g1 = around(1, n);
    const g2 = around(10, n);
    const g3 = around(20, n);
    const ranks = Array.from({ length: 3 * n }, (_, i) => i + 1);
    const report = makeReport(ranks, [
      { id: 'm1', values: [...g1, ...g2, ...g3] },
      { id: 'm2', values: [...g1, ...g3, ...g2] },
      { id: 'm3', values: [...g3, ...g1, ...g2] },
      { id: 'm4', values: [...g2, ...g1, ...g3] },
    ]);
    const sc = clusterPilotStyles(report)!;
    expect(sc.k).toBe(3);
    const groups = membersOf(sc);
    expect(groups).toContainEqual(['p0.igc', 'p1.igc', 'p2.igc', 'p3.igc', 'p4.igc']);
  });

  it('never clusters on outcome-derived or errored metrics', () => {
    const report = twoGroupReport();
    // An outcome metric and a broken metric that would place pilot 0 with
    // pilots 6–11 if either entered the distance.
    const flipped = [1, 10.1, 10.2, 10.3, 10.4, 10.5, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6];
    report.metrics.push(
      makeReport(
        report.pilots.map((p) => p.rank),
        [{ id: 'race.time_behind', outcome: true, values: flipped }],
      ).metrics[0],
      makeReport(
        report.pilots.map((p) => p.rank),
        [{ id: 'broken', error: 'boom', values: flipped }],
      ).metrics[0],
    );
    const sc = clusterPilotStyles(report)!;
    expect(sc.metricCount).toBe(6);
    for (const c of sc.clusters) {
      for (const s of c.signatures) {
        expect(s.metricId).not.toBe('race.time_behind');
        expect(s.metricId).not.toBe('broken');
      }
    }
    expect(membersOf(sc)).toContainEqual([
      'p0.igc',
      'p1.igc',
      'p2.igc',
      'p3.igc',
      'p4.igc',
      'p5.igc',
    ]);
  });

  it('reports low-coverage pilots unclustered instead of imputing', () => {
    const base = twoGroupReport();
    // A 13th pilot with only one observed metric (coverage 1/6 < 60%).
    base.pilots.push({ trackFile: 'p12.igc', pilotName: 'Pilot 12', rank: 13 });
    base.metrics.forEach((m, i) => {
      m.perPilot.push({ trackFile: 'p12.igc', value: i === 0 ? 5 : null });
    });
    base.basis.pilotCount = 13;
    const sc = clusterPilotStyles(base)!;
    expect(sc.pilotCount).toBe(12);
    expect(sc.unclustered.length).toBe(1);
    expect(sc.unclustered[0].trackFile).toBe('p12.igc');
    expect(sc.unclustered[0].reason).toContain('1 of 6 metrics');
    for (const c of sc.clusters) {
      expect(c.members.some((m) => m.trackFile === 'p12.igc')).toBe(false);
    }
  });

  it('returns null when fewer than MIN_CLUSTER_PILOTS pilots are comparable', () => {
    const n = MIN_CLUSTER_PILOTS - 1;
    const ranks = Array.from({ length: n }, (_, i) => i + 1);
    const values = around(1, n);
    const report = makeReport(ranks, [
      { id: 'm1', values },
      { id: 'm2', values },
      { id: 'm3', values: around(5, n) },
    ]);
    expect(clusterPilotStyles(report)).toBeNull();
  });

  it('returns null when there are too few usable metrics', () => {
    const ranks = Array.from({ length: 12 }, (_, i) => i + 1);
    const report = makeReport(ranks, [
      { id: 'only1', values: around(1, 12) },
      { id: 'flat', values: new Array(12).fill(7) }, // zero variance → unusable
    ]);
    expect(clusterPilotStyles(report)).toBeNull();
  });

  it('nicknames groups from the strongest signature, with direction hints', () => {
    const hi = around(10, 6);
    const lo = around(1, 6);
    const ranks = Array.from({ length: 12 }, (_, i) => i + 1);
    // Three clean splits — all three signatures tie on |deviation|, and the
    // float-tolerant tie-break names the group by the alphabetically first
    // metric id: gaggle.affinity.
    const report = makeReport(ranks, [
      { id: 'gaggle.affinity', direction: 'neutral', values: [...lo, ...hi] },
      { id: 'glide.speed', direction: 'higher', values: [...hi, ...lo] },
      { id: 'glide.track_efficiency', direction: 'lower', values: [...hi, ...lo] },
    ]);
    const sc = clusterPilotStyles(report)!;
    const wolves = sc.clusters.find((c) => c.members.some((m) => m.trackFile === 'p0.igc'))!;
    const flyers = sc.clusters.find((c) => c !== wolves)!;
    expect(wolves.label).toBe('Lone wolves');
    expect(flyers.label).toBe('Gaggle flyers');
    expect(wolves.labelMetricId).toBe('gaggle.affinity');
    expect(wolves.labelMetricId).toBe(wolves.signatures[0].metricId);

    const sig = (c: (typeof sc.clusters)[0], id: string) =>
      c.signatures.find((s) => s.metricId === id)!;
    // 'higher' metric, group runs high → the prior calls it a strength.
    expect(sig(wolves, 'glide.speed').hint).toBe('strength');
    // 'lower' metric, group runs high → usually costly.
    expect(sig(wolves, 'glide.track_efficiency').hint).toBe('cost');
    // Mirror group: same metrics, opposite sides, opposite hints.
    expect(sig(flyers, 'glide.speed').hint).toBe('cost');
    expect(sig(flyers, 'glide.track_efficiency').hint).toBe('strength');
    // Neutral metrics carry no prior, so no hint.
    expect(sig(wolves, 'gaggle.affinity').hint).toBeUndefined();
  });

  it('falls back to an honest generic nickname for unknown metric ids', () => {
    const sc = clusterPilotStyles(twoGroupReport())!;
    // twoGroupReport's synthetic ids (a1…b3) are not in STYLE_NICKNAMES.
    for (const c of sc.clusters) {
      expect(c.label).toMatch(/^(High|Low) /);
      expect(c.labelMetricId).toBe(c.signatures[0].metricId);
    }
  });

  it('marks each cluster exemplar as one of its own members', () => {
    const sc = clusterPilotStyles(twoGroupReport())!;
    for (const c of sc.clusters) {
      expect(c.members.map((m) => m.trackFile)).toContain(c.exemplarTrackFile);
    }
  });

  it('renders a style-clusters section in the text report', () => {
    const text = renderFieldReport(twoGroupReport());
    expect(text).toContain('Pilot style clusters');
    expect(text).toContain('Group A "');
    expect(text).toContain('mean silhouette');
  });

  it('says why when the field is too small to cluster, in the text report', () => {
    const ranks = [1, 2, 3];
    const v = around(1, 3);
    const text = renderFieldReport(
      makeReport(ranks, [
        { id: 'm1', values: v },
        { id: 'm2', values: v },
        { id: 'm3', values: v },
      ]),
    );
    expect(text).toContain('fewer than 8 pilots');
  });
});
