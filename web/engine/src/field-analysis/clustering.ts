// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Pilot style clustering — who flew alike, and how did each group fare?
 *
 * The correlation tables say which single behaviours separate the
 * leaderboard; this answers a different question: which PILOTS fly the same
 * way. Each cluster is annotated with the rank spread of its members, so the
 * interesting finding is visible directly — "this group climbs in the top
 * quartile but gives it back on glide".
 *
 * Method (the explainability rule — every step below is deliberate):
 *  - Input is a finished FieldAnalysisReport, so clustering is a pure
 *    derivation at read time: nothing new is stored, and already-stored
 *    reports gain clusters without a recompute.
 *  - Only behavioural metrics enter (outcome-derived ones correlate with
 *    rank by construction and would collapse "style" into "the leaderboard,
 *    chunked").
 *  - Every metric is rank-transformed to a within-field percentile (the same
 *    rank-first philosophy as the Spearman eval; robust to the heavy-tailed
 *    outliers flying metrics produce, and unit-free so no metric dominates).
 *  - Pilots are compared by Gower distance: the mean percentile gap over the
 *    metrics BOTH pilots have. Missing values are never imputed — matching
 *    the drop-don't-fill convention everywhere else in field analysis — and
 *    pilots with under {@link MIN_COVERAGE} of the metrics are reported
 *    unclustered rather than forced into a group.
 *  - Ward-linkage agglomeration (Lance–Williams on squared distances) builds
 *    the tree deterministically — no random initialisation, so the same
 *    report always yields the same groups (stale-first caching would make a
 *    seed-dependent grouping look like a bug).
 *  - The cut k is chosen by the best mean silhouette over k = 2…K; the
 *    silhouette is reported so a weak grouping is never dressed up as a
 *    strong one.
 */

import { median, percentile, rankWithTies } from './stats';
import type {
  FieldAnalysisReport,
  MetricDirection,
  MetricFamily,
  MetricReport,
} from './types';

/** Below this many clusterable pilots no clustering is attempted. */
export const MIN_CLUSTER_PILOTS = 8;

/** A pilot must have values for at least this fraction of the usable metrics. */
export const MIN_COVERAGE = 0.6;

/** Any pilot pair must share at least this many observed metrics. */
const MIN_SHARED_METRICS = 3;

/** The largest k the silhouette search examines. */
const MAX_K = 6;

/** A signature must deviate at least this many percentile points from P50. */
const SIGNATURE_MIN_DEVIATION = 15;

/** At most this many signature metrics are reported per cluster. */
const MAX_SIGNATURES = 4;

/** One metric on which a cluster's members collectively sit far from the
 * field's middle — the cluster's style, stated as data. */
export interface StyleSignature {
  metricId: string;
  label: string;
  shortLabel?: string;
  unit: string;
  family: MetricFamily;
  direction: MetricDirection;
  /** Cluster median of the within-field value percentile (0–100, ascending
   * by raw value — NOT direction-adjusted; renderers phrase per direction). */
  medianPercentile: number;
  /** Cluster median of the raw metric values, for display beside the
   * percentile. */
  medianValue: number;
  /** medianPercentile − 50: positive = the group runs high on this metric. */
  deviation: number;
}

export interface StyleClusterMember {
  trackFile: string;
  pilotName: string;
  rank: number;
  /** Fraction of the usable metrics this pilot had a value for. */
  coverage: number;
  /** Mean Gower distance to the other members (0 for a singleton) — the
   * smallest value marks the group's most typical pilot. */
  meanDistanceToCluster: number;
}

export interface StyleCluster {
  /** 'A', 'B', … in order of median rank (best group first). */
  id: string;
  /** Sorted by rank ascending. */
  members: StyleClusterMember[];
  /** The member with the smallest mean style distance to the rest — "this
   * group flies like <exemplar>". */
  exemplarTrackFile: string;
  /** The rank spread — the annotation that makes a style cluster a finding. */
  rankBest: number;
  rankMedian: number;
  rankWorst: number;
  /** The middle half of the members' ranks. */
  rankP25: number;
  rankP75: number;
  /** Strongest deviations from the field's middle, |deviation| descending.
   * Empty = the group is near field-typical on every metric. */
  signatures: StyleSignature[];
  /** Mean pairwise Gower distance within the cluster (0 for a singleton). */
  cohesion: number;
}

export interface UnclusteredPilot {
  trackFile: string;
  pilotName: string;
  rank: number;
  reason: string;
}

export interface StyleClusterReport {
  /** 1–2 sentence method description (the explainability rule). */
  explanation: string;
  /** Behavioural metrics that entered the distance. */
  metricCount: number;
  /** Pilots that were clustered. */
  pilotCount: number;
  /** The chosen number of groups, and the range the silhouette searched. */
  k: number;
  kMin: number;
  kMax: number;
  /** Mean silhouette at the chosen k: ≈0 = arbitrary boundaries, →1 = tight
   * well-separated groups. Reported so a weak grouping reads as weak. */
  meanSilhouette: number;
  clusters: StyleCluster[];
  /** Pilots left out for lack of data — never silently dropped. */
  unclustered: UnclusteredPilot[];
}

const EXPLANATION =
  'Pilots are grouped by flying style, not by score: every behavioural metric is rank-transformed ' +
  'to a within-field percentile, pilots are compared by the mean percentile gap over the metrics ' +
  'both have (missing values are never imputed), and Ward-linkage agglomeration forms the groups, ' +
  'with the number of groups chosen by the best mean silhouette. Each group is annotated with the ' +
  'GAP-rank spread of its members — where a style did and did not pay.';

/** Behavioural metrics with enough data to shape a distance. */
function usableMetrics(report: FieldAnalysisReport): MetricReport[] {
  return report.metrics.filter((m) => {
    if (m.outcome || m.error) return false;
    const values = m.perPilot.flatMap((p) =>
      p.value !== null && isFinite(p.value) ? [p.value] : [],
    );
    if (values.length < 2) return false;
    return Math.min(...values) < Math.max(...values); // zero-variance metrics say nothing
  });
}

/**
 * Per-metric within-field percentiles (0–100, ties averaged), aligned to
 * report.pilots; null where the pilot has no value.
 */
function percentileColumns(report: FieldAnalysisReport, metrics: MetricReport[]): (number | null)[][] {
  return metrics.map((m) => {
    const idx: number[] = [];
    const values: number[] = [];
    m.perPilot.forEach((p, i) => {
      if (p.value !== null && isFinite(p.value)) {
        idx.push(i);
        values.push(p.value);
      }
    });
    const ranks = rankWithTies(values);
    const col: (number | null)[] = new Array(report.pilots.length).fill(null);
    const n = values.length;
    idx.forEach((pilotIndex, j) => {
      col[pilotIndex] = n === 1 ? 50 : ((ranks[j] - 1) / (n - 1)) * 100;
    });
    return col;
  });
}

/** Gower distance in [0, 1]: mean |percentile gap|/100 over shared metrics;
 * null when the pair shares fewer than MIN_SHARED_METRICS. */
function gower(cols: (number | null)[][], a: number, b: number): number | null {
  let sum = 0;
  let shared = 0;
  for (const col of cols) {
    const va = col[a];
    const vb = col[b];
    if (va === null || vb === null) continue;
    sum += Math.abs(va - vb) / 100;
    shared++;
  }
  return shared >= MIN_SHARED_METRICS ? sum / shared : null;
}

/** One agglomeration step, recorded as the two clusters' representative
 * original indices (the smallest member index of each side). */
interface MergeStep {
  a: number;
  b: number;
}

/**
 * Ward-linkage agglomeration (Lance–Williams update on squared distances,
 * the ward.D2 convention). Deterministic: the pair scan runs in ascending
 * index order and only a strictly smaller distance displaces the incumbent.
 */
function wardMerges(dist: number[][]): MergeStep[] {
  const n = dist.length;
  const size = new Array<number>(n).fill(1);
  const rep = Array.from({ length: n }, (_, i) => i);
  const alive = new Array<boolean>(n).fill(true);
  const d2 = dist.map((row) => row.map((v) => v * v));
  const merges: MergeStep[] = [];

  for (let step = 0; step < n - 1; step++) {
    let bi = -1;
    let bj = -1;
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      if (!alive[i]) continue;
      for (let j = i + 1; j < n; j++) {
        if (!alive[j]) continue;
        if (d2[i][j] < best) {
          best = d2[i][j];
          bi = i;
          bj = j;
        }
      }
    }
    const ni = size[bi];
    const nj = size[bj];
    for (let k = 0; k < n; k++) {
      if (!alive[k] || k === bi || k === bj) continue;
      const nk = size[k];
      const v = ((ni + nk) * d2[bi][k] + (nj + nk) * d2[bj][k] - nk * d2[bi][bj]) / (ni + nj + nk);
      d2[bi][k] = v;
      d2[k][bi] = v;
    }
    merges.push({ a: rep[bi], b: rep[bj] });
    size[bi] = ni + nj;
    rep[bi] = Math.min(rep[bi], rep[bj]);
    alive[bj] = false;
  }
  return merges;
}

/** Cluster labels (0-based, first-appearance order) after applying the first
 * n − k merges — i.e. the tree cut at k clusters. */
function labelsAtK(n: number, merges: MergeStep[], k: number): number[] {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  for (let m = 0; m < n - k; m++) {
    const ra = find(merges[m].a);
    const rb = find(merges[m].b);
    parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
  const labelOf = new Map<number, number>();
  const labels: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let l = labelOf.get(r);
    if (l === undefined) {
      l = labelOf.size;
      labelOf.set(r, l);
    }
    labels.push(l);
  }
  return labels;
}

/** Mean silhouette over all points; singletons contribute 0 (the standard
 * convention — a lone point neither confirms nor refutes the partition). */
function meanSilhouette(labels: number[], dist: number[][]): number {
  const n = labels.length;
  const k = Math.max(...labels) + 1;
  const counts = new Array<number>(k).fill(0);
  for (const l of labels) counts[l]++;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    if (counts[labels[i]] === 1) continue; // s(i) = 0
    const meanTo = new Array<number>(k).fill(0);
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      meanTo[labels[j]] += dist[i][j];
    }
    const a = meanTo[labels[i]] / (counts[labels[i]] - 1);
    let b = Infinity;
    for (let c = 0; c < k; c++) {
      if (c === labels[i] || counts[c] === 0) continue;
      b = Math.min(b, meanTo[c] / counts[c]);
    }
    const denom = Math.max(a, b);
    sum += denom > 0 ? (b - a) / denom : 0;
  }
  return sum / n;
}

/**
 * Cluster the report's pilots by flying style. Null when fewer than
 * {@link MIN_CLUSTER_PILOTS} pilots have enough metric coverage to compare —
 * the renderers say so rather than showing a grouping made of noise.
 *
 * Pure and deterministic: the same report always produces the same clusters.
 */
export function clusterPilotStyles(report: FieldAnalysisReport): StyleClusterReport | null {
  const metrics = usableMetrics(report);
  if (metrics.length < MIN_SHARED_METRICS) return null;
  const cols = percentileColumns(report, metrics);
  const nPilots = report.pilots.length;

  // Coverage gate: pilots missing too many metrics are reported, not forced.
  const coverage = report.pilots.map((_p, i) => {
    let have = 0;
    for (const col of cols) if (col[i] !== null) have++;
    return have / metrics.length;
  });
  const unclustered: UnclusteredPilot[] = [];
  let candidates: number[] = [];
  for (let i = 0; i < nPilots; i++) {
    if (coverage[i] >= MIN_COVERAGE) {
      candidates.push(i);
    } else {
      const p = report.pilots[i];
      unclustered.push({
        trackFile: p.trackFile,
        pilotName: p.pilotName,
        rank: p.rank,
        reason: `only ${Math.round(coverage[i] * metrics.length)} of ${metrics.length} metrics available (needs ≥ ${Math.round(MIN_COVERAGE * 100)}%)`,
      });
    }
  }

  // Every remaining pair must share enough metrics for a meaningful distance;
  // while one doesn't, drop the lowest-coverage pilot involved.
  for (;;) {
    let worst = -1;
    outer: for (let x = 0; x < candidates.length; x++) {
      for (let y = x + 1; y < candidates.length; y++) {
        if (gower(cols, candidates[x], candidates[y]) === null) {
          worst =
            coverage[candidates[x]] <= coverage[candidates[y]] ? candidates[x] : candidates[y];
          break outer;
        }
      }
    }
    if (worst === -1) break;
    candidates = candidates.filter((i) => i !== worst);
    const p = report.pilots[worst];
    unclustered.push({
      trackFile: p.trackFile,
      pilotName: p.pilotName,
      rank: p.rank,
      reason: 'too few metrics in common with the rest of the field',
    });
  }

  if (candidates.length < MIN_CLUSTER_PILOTS) return null;

  const nc = candidates.length;
  const dist: number[][] = Array.from({ length: nc }, () => new Array<number>(nc).fill(0));
  for (let x = 0; x < nc; x++) {
    for (let y = x + 1; y < nc; y++) {
      const d = gower(cols, candidates[x], candidates[y])!;
      dist[x][y] = d;
      dist[y][x] = d;
    }
  }

  const merges = wardMerges(dist);
  const kMin = 2;
  const kMax = Math.max(kMin, Math.min(MAX_K, Math.floor(nc / 3)));
  let bestK = kMin;
  let bestSil = -Infinity;
  let bestLabels: number[] = [];
  for (let k = kMin; k <= kMax; k++) {
    const labels = labelsAtK(nc, merges, k);
    const sil = meanSilhouette(labels, dist);
    // Strictly greater, so ties keep the smaller (simpler) k.
    if (sil > bestSil) {
      bestSil = sil;
      bestK = k;
      bestLabels = labels;
    }
  }

  // Assemble clusters: members with centrality, rank spread, signatures.
  const groups = new Map<number, number[]>(); // label → positions in `candidates`
  bestLabels.forEach((l, pos) => {
    const g = groups.get(l);
    if (g) g.push(pos);
    else groups.set(l, [pos]);
  });

  const clusters: StyleCluster[] = [...groups.values()].map((positions) => {
    const members: StyleClusterMember[] = positions.map((pos) => {
      const i = candidates[pos];
      const p = report.pilots[i];
      let sum = 0;
      for (const other of positions) if (other !== pos) sum += dist[pos][other];
      return {
        trackFile: p.trackFile,
        pilotName: p.pilotName,
        rank: p.rank,
        coverage: coverage[i],
        meanDistanceToCluster: positions.length > 1 ? sum / (positions.length - 1) : 0,
      };
    });
    members.sort((a, b) => a.rank - b.rank);

    const exemplar = members.reduce((best, m) =>
      m.meanDistanceToCluster < best.meanDistanceToCluster ? m : best,
    );

    const ranks = members.map((m) => m.rank).sort((a, b) => a - b);
    let cohesionSum = 0;
    let cohesionN = 0;
    for (let x = 0; x < positions.length; x++) {
      for (let y = x + 1; y < positions.length; y++) {
        cohesionSum += dist[positions[x]][positions[y]];
        cohesionN++;
      }
    }

    const signatures: StyleSignature[] = metrics
      .flatMap((m, mi) => {
        const pcts: number[] = [];
        const values: number[] = [];
        for (const pos of positions) {
          const i = candidates[pos];
          const pct = cols[mi][i];
          if (pct === null) continue;
          pcts.push(pct);
          values.push(m.perPilot[i].value!);
        }
        // A signature must describe most of the group, not a vocal minority.
        if (pcts.length < Math.max(2, Math.ceil(positions.length / 2))) return [];
        const medianPercentile = median(pcts);
        const deviation = medianPercentile - 50;
        if (Math.abs(deviation) < SIGNATURE_MIN_DEVIATION) return [];
        return [
          {
            metricId: m.id,
            label: m.label,
            shortLabel: m.shortLabel,
            unit: m.unit,
            family: m.family,
            direction: m.direction,
            medianPercentile,
            medianValue: median(values),
            deviation,
          } satisfies StyleSignature,
        ];
      })
      .sort(
        (a, b) =>
          Math.abs(b.deviation) - Math.abs(a.deviation) || a.metricId.localeCompare(b.metricId),
      )
      .slice(0, MAX_SIGNATURES);

    return {
      id: '', // assigned after ordering
      members,
      exemplarTrackFile: exemplar.trackFile,
      rankBest: ranks[0],
      rankMedian: median(ranks),
      rankWorst: ranks[ranks.length - 1],
      rankP25: percentile(ranks, 25),
      rankP75: percentile(ranks, 75),
      signatures,
      cohesion: cohesionN > 0 ? cohesionSum / cohesionN : 0,
    };
  });

  // Best-performing group first; letters follow that order so "Group A" is
  // always the one topping the leaderboard.
  clusters.sort((a, b) => a.rankMedian - b.rankMedian || a.rankBest - b.rankBest);
  clusters.forEach((c, i) => (c.id = String.fromCharCode(65 + i)));

  unclustered.sort((a, b) => a.rank - b.rank);

  return {
    explanation: EXPLANATION,
    metricCount: metrics.length,
    pilotCount: nc,
    k: bestK,
    kMin,
    kMax,
    meanSilhouette: bestSil,
    clusters,
    unclustered,
  };
}
