// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Whole-comp aggregation: pilots matched ACROSS tasks by a stable key (track
 * filenames embed the task date, so trackFile can't pair between tasks), comp
 * rank = the official comp ranking when the caller has it (else total score
 * descending, ties shared), and each metric summarised two ways:
 *   - n-weighted mean |ρ| of its per-task correlations, and
 *   - a comp-level ρ of per-pilot cross-task mean WITHIN-TASK PERCENTILES vs
 *     comp rank.
 * Classes are never mixed — the caller aggregates one class at a time.
 *
 * Why percentiles (engine review 2026-10-20, 5.1): averaging a pilot's RAW
 * values across tasks lets the day-level offset of whichever tasks they flew
 * into their mean, and missing a task also lowers their comp rank — so any
 * metric whose level varies by day correlated with comp rank through
 * participation alone (a metric unrelated to score inside every task cleared
 * the noise floor in 43 % of simulated comps). Ranking within each task first
 * removes the day's level; `participation` reports how much the remaining
 * imbalance could still explain.
 */

import { mean, rankWithTies, spearman, spearmanNoiseFloor } from './stats';
import { correlationVerdict } from './evaluate';
import type {
  CompAnalysisOptions,
  CompAnalysisReport,
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

/**
 * 1-based competition ranks, equal totals sharing a rank (S7A §5.2.5.4) at
 * the one decimal S7F §15 publishes comp scores to.
 */
function sharedRanks<T extends { totalScore: number }>(sorted: T[]): number[] {
  const ranks: number[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const tied =
      i > 0 &&
      Math.round(sorted[i].totalScore * 10) === Math.round(sorted[i - 1].totalScore * 10);
    ranks.push(tied ? ranks[i - 1] : i + 1);
  }
  return ranks;
}

export function aggregateComp(
  tasks: CompTaskResult[],
  options: CompAnalysisOptions = {},
): CompAnalysisReport {
  const taskLabels = tasks.map((t) => t.label);

  // --- comp scores: total score per pilot key across tasks ---
  const scores = new Map<string, { name: string; taskCount: number; totalScore: number }>();
  for (const task of tasks) {
    for (const t of task.totals) {
      const key = task.pilotKeyByTrackFile[t.trackFile];
      if (key === undefined) continue;
      const s = scores.get(key);
      if (s) {
        s.taskCount++;
        s.totalScore += t.totalScore;
      } else {
        scores.set(key, { name: t.pilotName, taskCount: 1, totalScore: t.totalScore });
      }
    }
  }

  // The official ranking, when the caller has it, is what a pilot's comp
  // result IS (FTV, tasks scored from a manual flight, tasks whose track was
  // withheld from the analysis). Pilots it does not rank are left out rather
  // than ranked on a different scale.
  const official = options.compRanking;
  let pilots: CompAnalysisReport['pilots'];
  if (official) {
    pilots = [...scores.entries()]
      .flatMap(([key, s]) => {
        const o = official[key];
        return o ? [{ key, ...s, totalScore: o.totalScore, rank: o.rank }] : [];
      })
      .sort((a, b) => a.rank - b.rank || b.totalScore - a.totalScore);
  } else {
    const sorted = [...scores.entries()]
      .map(([key, s]) => ({ key, ...s, rank: 0 }))
      .sort((a, b) => b.totalScore - a.totalScore);
    const ranks = sharedRanks(sorted);
    sorted.forEach((p, i) => (p.rank = ranks[i]));
    pilots = sorted;
  }
  const rankByKey = new Map(pilots.map((p) => [p.key, p.rank]));

  // How much of comp rank simply follows how many tasks a pilot was
  // analysed in. A strong value means the comp-level ρ of any metric that
  // also tracks participation is suspect, however the metric is averaged.
  const counts = pilots.map((p) => p.taskCount);
  const participationRho = spearman(
    counts,
    pilots.map((p) => p.rank),
  );
  const participation = {
    minTasks: counts.length > 0 ? Math.min(...counts) : 0,
    maxTasks: counts.length > 0 ? Math.max(...counts) : 0,
    rho: isFinite(participationRho) ? participationRho : null,
  };

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
      // Rank within THIS task first — a percentile in [0, 1], ties sharing
      // the average — so a day's level never enters a pilot's comp mean.
      const keyed: { key: string; v: number }[] = [];
      for (const entry of m.perPilot) {
        const v = entry.value;
        if (v === null || !isFinite(v)) continue;
        const key = task.pilotKeyByTrackFile[entry.trackFile];
        if (key === undefined) continue;
        keyed.push({ key, v });
      }
      if (keyed.length < 2) continue; // one value has no position in a field
      const ranks = rankWithTies(keyed.map((k) => k.v));
      for (let i = 0; i < keyed.length; i++) {
        const pct = (ranks[i] - 1) / (keyed.length - 1);
        let arr = valuesByKey.get(keyed[i].key);
        if (!arr) valuesByKey.set(keyed[i].key, (arr = []));
        arr.push(pct);
      }
    }

    // Comp-level ρ: each pilot's mean within-task percentile vs their comp
    // rank.
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

  return {
    taskLabels,
    pilots,
    metrics,
    rankBasis: official ? 'official' : 'analysed-task-totals',
    participation,
  };
}
