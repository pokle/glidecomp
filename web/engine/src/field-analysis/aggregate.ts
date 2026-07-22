// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Whole-comp aggregation: pilots matched ACROSS tasks by a stable key (track
 * filenames embed the task date, so trackFile can't pair between tasks), comp
 * rank = total score descending, and each metric summarised two ways:
 *   - n-weighted mean |ρ| of its per-task correlations, and
 *   - a comp-level ρ of per-pilot cross-task metric means vs comp rank.
 * Classes are never mixed — the caller aggregates one class at a time.
 */

import { mean, spearman, spearmanNoiseFloor } from './stats';
import { correlationVerdict } from './evaluate';
import type {
  CompAggregateReport,
  CompMetricAggregate,
  CompTaskResult,
  MetricCorrelation,
  MetricReport,
  SignConsistency,
  SignSummary,
} from './types';

/**
 * Classify a metric's informative sign counts. 'leaning' needs at least a
 * 2:1 majority (minority ≤ ⅓ of informative tasks); anything closer is a
 * 'split'. With the 3–7 tasks of a typical comp these are descriptions of
 * the evidence, never significance claims — the consumer states counts.
 */
export function signConsistency(s: SignSummary): SignConsistency {
  const informative = s.negative + s.positive;
  if (informative < 2) return 'quiet';
  if (s.negative === 0 || s.positive === 0) return 'consistent';
  return Math.min(s.negative, s.positive) / informative <= 1 / 3 ? 'leaning' : 'split';
}

export function aggregateComp(tasks: CompTaskResult[]): CompAggregateReport {
  const taskLabels = tasks.map((t) => t.label);

  // --- comp standings: total score per pilot key across tasks ---
  const standings = new Map<string, { name: string; taskCount: number; totalScore: number }>();
  for (const task of tasks) {
    for (const t of task.totals) {
      const key = task.pilotKeyByTrackFile[t.trackFile];
      if (key === undefined) continue;
      const s = standings.get(key);
      if (s) {
        s.taskCount++;
        s.totalScore += t.totalScore;
      } else {
        standings.set(key, { name: t.pilotName, taskCount: 1, totalScore: t.totalScore });
      }
    }
  }
  const pilots = [...standings.entries()]
    .map(([key, s]) => ({ key, ...s, rank: 0 }))
    .sort((a, b) => b.totalScore - a.totalScore);
  pilots.forEach((p, i) => (p.rank = i + 1));
  const rankByKey = new Map(pilots.map((p) => [p.key, p.rank]));

  // --- per-metric aggregation, in first-seen (registry) order ---
  const metricOrder: string[] = [];
  const metricMeta = new Map<string, MetricReport>();
  for (const task of tasks) {
    for (const m of task.report.metrics) {
      if (!metricMeta.has(m.id)) {
        metricMeta.set(m.id, m);
        metricOrder.push(m.id);
      }
    }
  }

  const metrics: CompMetricAggregate[] = metricOrder.map((id) => {
    const meta = metricMeta.get(id)!;

    const perTaskRho: (number | null)[] = [];
    const perTaskCorrelation: CompMetricAggregate['perTaskCorrelation'] = [];
    let weightedAbs = 0;
    let weightedSigned = 0;
    let weightSum = 0;
    const signSummary: SignSummary = { negative: 0, positive: 0, quiet: 0 };
    // Per-pilot values across tasks, keyed by comp pilot key.
    const valuesByKey = new Map<string, number[]>();

    for (const task of tasks) {
      const m = task.report.metrics.find((x) => x.id === id);
      perTaskRho.push(m?.correlation?.rho ?? null);
      if (m?.correlation) {
        const c = m.correlation;
        // Reports stored before the noise floor existed lack it; recompute
        // from n so sign-informativeness never depends on report age.
        const noiseFloor = c.noiseFloor ?? spearmanNoiseFloor(c.n);
        perTaskCorrelation.push({ rho: c.rho, n: c.n, noiseFloor });
        weightedAbs += c.absRho * c.n;
        weightedSigned += c.rho * c.n;
        weightSum += c.n;
        // Only informative tasks vote on the sign — a sub-floor coefficient
        // is indistinguishable from luck, and a "split" made of those would
        // be noise wearing a costume.
        if (c.absRho >= noiseFloor && c.rho !== 0) {
          if (c.rho < 0) signSummary.negative++;
          else signSummary.positive++;
        } else {
          signSummary.quiet++;
        }
      } else {
        perTaskCorrelation.push(null);
      }
      if (!m) continue;
      for (let i = 0; i < m.perPilot.length; i++) {
        const v = m.perPilot[i].value;
        if (v === null || !isFinite(v)) continue;
        const key = task.pilotKeyByTrackFile[m.perPilot[i].trackFile];
        if (key === undefined) continue;
        let arr = valuesByKey.get(key);
        if (!arr) valuesByKey.set(key, (arr = []));
        arr.push(v);
      }
    }

    // Comp-level ρ: each pilot's cross-task mean vs their comp rank.
    const means: number[] = [];
    const ranks: number[] = [];
    for (const [key, values] of valuesByKey) {
      const rank = rankByKey.get(key);
      if (rank === undefined) continue;
      means.push(mean(values));
      ranks.push(rank);
    }
    const rho = spearman(means, ranks);
    let compRho: MetricCorrelation | null = null;
    if (isFinite(rho)) {
      const absRho = Math.abs(rho);
      compRho = {
        metricId: id,
        rho,
        absRho,
        n: means.length,
        noiseFloor: spearmanNoiseFloor(means.length),
        verdict: correlationVerdict(absRho, means.length),
      };
    }

    return {
      id,
      label: meta.label,
      unit: meta.unit,
      direction: meta.direction,
      ...(meta.outcome ? { outcome: true as const } : {}),
      perTaskRho,
      perTaskCorrelation,
      meanSignedRho: weightSum > 0 ? weightedSigned / weightSum : null,
      signSummary,
      consistency: signConsistency(signSummary),
      meanAbsRho: weightSum > 0 ? weightedAbs / weightSum : null,
      compRho,
    };
  });

  return { taskLabels, pilots, metrics };
}
