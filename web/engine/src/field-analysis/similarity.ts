// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Pilot-to-pilot behavioural similarity — cosine over a chosen set of
 * behaviours. PROTOTYPE (issue: "explore cosine similarity"), so read the
 * caveats at the bottom before trusting a number off it.
 *
 * The question this answers is deliberately NOT the one the rest of field
 * analysis answers. The correlation tables ask which behaviours separated the
 * leaderboard, and style clustering asks which groups the field falls into.
 * This asks only: given the behaviours I picked, who flew most like this
 * pilot? No score, no GAP rank and no outcome metric enters anywhere — not in
 * the vector, not in the ordering, not in the output. `outcome` metrics are
 * excluded by {@link usableMetrics}, which is the same gate clustering uses.
 *
 * Method:
 *  - Pure derivation at read time from a finished FieldAnalysisReport, like
 *    clusterPilotStyles: nothing is stored and no recompute is triggered.
 *  - Each selected metric is rank-transformed to a within-field percentile
 *    (0–100) by {@link percentileColumns} — the same transform clustering
 *    uses, so metrics in m/s, km and minutes can share one vector without the
 *    largest unit dominating the geometry.
 *  - CENTRING IS THE WHOLE BALL GAME, so it is a parameter, not a constant.
 *    Percentiles are all ≥ 0, so raw-percentile vectors sit in the positive
 *    orthant and no pair can score below 0 — "flies the opposite way" and
 *    "unrelated" collapse to the same number, and in practice the pairs bunch
 *    high. Centring on the field's middle (percentile − 50) makes each
 *    component a SIGNED deviation, so the full [−1, 1] range opens up and
 *    cosine reads as "do these two depart from field-typical in the same
 *    pattern". That is the interesting question and the default. Raw is
 *    offered anyway, because seeing the collapse is how you come to trust
 *    the centred number.
 *  - Missing values are never imputed (the drop-don't-fill convention
 *    everywhere else in field analysis): each pair is compared over the
 *    metrics BOTH pilots have, and pairs sharing fewer than
 *    {@link MIN_SHARED_METRICS} are reported skipped rather than scored.
 *  - Every neighbour carries its per-metric contributions, which sum exactly
 *    to the cosine — so "why are these two similar" is answerable from the
 *    output alone (the explainability rule).
 */

import {
  MIN_SHARED_METRICS,
  gower,
  percentileColumns,
  usableMetrics,
} from './clustering';
import type { FieldAnalysisReport, MetricFamily, MetricReport } from './types';

/**
 * What a vector component means.
 *
 * - `centred` — percentile − 50. A signed deviation from the field's middle;
 *   cosine reads as "same pattern of departures from typical".
 * - `raw` — the percentile itself. Kept so the prototype can SHOW why it is
 *   the wrong basis: all-positive components crush every pair towards 1.
 */
export type SimilarityBasis = 'centred' | 'raw';

/** One metric's share of a pair's cosine. Contributions sum to the cosine. */
export interface SimilarityContribution {
  metricId: string;
  label: string;
  shortLabel?: string;
  unit: string;
  family: MetricFamily;
  /** Within-field percentile (0–100) of each pilot's raw value. */
  subjectPercentile: number;
  neighbourPercentile: number;
  /** The raw metric values behind those percentiles, for display. */
  subjectValue: number;
  neighbourValue: number;
  /**
   * (a_i · b_i) / (‖a‖ ‖b‖) for this component. Positive = the two pilots sit
   * on the same side of the field's middle on this behaviour and it pushed
   * them together; negative = opposite sides, and it pushed them apart.
   * Summing this field over every entry reproduces `cosine` exactly.
   */
  contribution: number;
}

export interface SimilarPilot {
  trackFile: string;
  pilotName: string;
  /** −1 … 1. */
  cosine: number;
  /** How many of the selected metrics both pilots actually had. */
  sharedMetrics: number;
  /**
   * Mean |percentile gap| / 100 over the same shared metrics — the distance
   * style clustering uses. Carried as a foil, not a ranking: cosine ignores
   * how FAR from typical a pilot is and Gower does not, so a pair that is
   * close on one and not the other is the finding worth looking at.
   */
  gowerDistance: number | null;
  /** |contribution| descending — what made the pair similar, and what fought it. */
  contributions: SimilarityContribution[];
}

export interface SkippedPilot {
  trackFile: string;
  pilotName: string;
  reason: string;
}

export interface PilotSimilarityReport {
  /** Method description in plain words (the explainability rule). */
  explanation: string;
  basis: SimilarityBasis;
  subject: { trackFile: string; pilotName: string };
  /** The metrics that actually entered the vectors, in report order. */
  metrics: { id: string; label: string; shortLabel?: string; family: MetricFamily; unit: string }[];
  /** Every comparable pilot, most similar first. */
  neighbours: SimilarPilot[];
  /** Pilots that could not be compared — never silently dropped. */
  skipped: SkippedPilot[];
}

export interface FindSimilarPilotsOptions {
  /** Which pilot the sheet is centred on. */
  subjectTrackFile: string;
  /**
   * Metric ids to build the vectors from. Omitted = every usable behavioural
   * metric. Ids that aren't usable metrics are ignored rather than erroring:
   * a saved link outlives a metric-registry change.
   */
  metricIds?: string[];
  /** Defaults to 'centred' — see {@link SimilarityBasis}. */
  basis?: SimilarityBasis;
}

const EXPLANATION_CENTRED =
  'GlideComp converts each selected behaviour to a percentile inside this field, then subtracts ' +
  '50 so the number says how far above or below the middle of the field the pilot sat. Each pilot ' +
  'becomes a vector of those deviations, and two pilots are compared by the cosine of the angle ' +
  'between their vectors over the behaviours that both pilots have. A missing value is never ' +
  'filled in. The result says whether two pilots depart from the typical pilot in the same ' +
  'pattern. It ignores how large the departure was, so a mildly unusual pilot and a very unusual ' +
  'one can score 1.00 together. No score and no ranking is used.';

const EXPLANATION_RAW =
  'GlideComp converts each selected behaviour to a percentile inside this field and compares two ' +
  'pilots by the cosine of the angle between the percentile vectors, over the behaviours that ' +
  'both pilots have. Every percentile is at least zero, so no pair can score below zero: a pilot ' +
  'who flies the opposite way and a pilot who is simply unrelated get the same answer, and the ' +
  'scores bunch towards the top of the range. Use the centred basis to read a real difference. ' +
  'No score and no ranking is used.';

/**
 * Rank the field by behavioural similarity to one pilot.
 *
 * Returns null when the subject isn't in the report, or when fewer than
 * {@link MIN_SHARED_METRICS} of the requested metrics are usable at all —
 * the caller says so rather than showing a cosine over one behaviour, which
 * can only ever be +1 or −1.
 *
 * Pure and deterministic: the same report and options always give the same
 * ordering (ties broken by name, so it never hinges on array order).
 */
export function findSimilarPilots(
  report: FieldAnalysisReport,
  options: FindSimilarPilotsOptions,
): PilotSimilarityReport | null {
  const basis: SimilarityBasis = options.basis ?? 'centred';
  const subjectIndex = report.pilots.findIndex(
    (p) => p.trackFile === options.subjectTrackFile,
  );
  if (subjectIndex === -1) return null;

  const wanted = options.metricIds ? new Set(options.metricIds) : null;
  const metrics: MetricReport[] = usableMetrics(report).filter(
    (m) => wanted === null || wanted.has(m.id),
  );
  if (metrics.length < MIN_SHARED_METRICS) return null;

  const cols = percentileColumns(report, metrics);
  /** Percentile → vector component under the chosen basis. */
  const component = (pct: number): number => (basis === 'centred' ? pct - 50 : pct);

  const neighbours: SimilarPilot[] = [];
  const skipped: SkippedPilot[] = [];

  for (let i = 0; i < report.pilots.length; i++) {
    if (i === subjectIndex) continue;
    const pilot = report.pilots[i];

    // Shared support first: the vectors are built over the metrics BOTH
    // pilots have, so the norms below are the norms of the compared vectors
    // and the contributions really do sum to the cosine.
    const shared: number[] = [];
    for (let mi = 0; mi < metrics.length; mi++) {
      if (cols[mi][subjectIndex] !== null && cols[mi][i] !== null) shared.push(mi);
    }
    if (shared.length < MIN_SHARED_METRICS) {
      skipped.push({
        trackFile: pilot.trackFile,
        pilotName: pilot.pilotName,
        reason: `only ${shared.length} of the ${metrics.length} selected behaviours in common (needs ≥ ${MIN_SHARED_METRICS})`,
      });
      continue;
    }

    let dot = 0;
    let sumA = 0;
    let sumB = 0;
    for (const mi of shared) {
      const a = component(cols[mi][subjectIndex]!);
      const b = component(cols[mi][i]!);
      dot += a * b;
      sumA += a * a;
      sumB += b * b;
    }
    const normA = Math.sqrt(sumA);
    const normB = Math.sqrt(sumB);
    if (normA === 0 || normB === 0) {
      // Only reachable on the centred basis: a pilot sitting exactly at the
      // field's median on every shared behaviour has no direction at all, so
      // the angle to them is undefined. Saying so beats inventing a 0.
      skipped.push({
        trackFile: pilot.trackFile,
        pilotName: pilot.pilotName,
        reason:
          normA === 0
            ? 'the selected pilot sits exactly at the middle of the field on every shared behaviour, so their vector has no direction'
            : 'this pilot sits exactly at the middle of the field on every shared behaviour, so their vector has no direction',
      });
      continue;
    }

    const denom = normA * normB;
    const contributions: SimilarityContribution[] = shared
      .map((mi) => {
        const m = metrics[mi];
        const subjectPercentile = cols[mi][subjectIndex]!;
        const neighbourPercentile = cols[mi][i]!;
        return {
          metricId: m.id,
          label: m.label,
          ...(m.shortLabel !== undefined ? { shortLabel: m.shortLabel } : {}),
          unit: m.unit,
          family: m.family,
          subjectPercentile,
          neighbourPercentile,
          subjectValue: m.perPilot[subjectIndex].value!,
          neighbourValue: m.perPilot[i].value!,
          contribution:
            (component(subjectPercentile) * component(neighbourPercentile)) / denom,
        } satisfies SimilarityContribution;
      })
      // Ties broken by metric id so the "what made them similar" list can
      // never depend on registry order drifting.
      .sort((x, y) => {
        const d = Math.abs(y.contribution) - Math.abs(x.contribution);
        return Math.abs(d) > 1e-12 ? d : x.metricId.localeCompare(y.metricId);
      });

    neighbours.push({
      trackFile: pilot.trackFile,
      pilotName: pilot.pilotName,
      cosine: dot / denom,
      sharedMetrics: shared.length,
      gowerDistance: gower(cols, subjectIndex, i),
      contributions,
    });
  }

  neighbours.sort(
    (a, b) => b.cosine - a.cosine || a.pilotName.localeCompare(b.pilotName),
  );
  skipped.sort((a, b) => a.pilotName.localeCompare(b.pilotName));

  return {
    explanation: basis === 'centred' ? EXPLANATION_CENTRED : EXPLANATION_RAW,
    basis,
    subject: {
      trackFile: report.pilots[subjectIndex].trackFile,
      pilotName: report.pilots[subjectIndex].pilotName,
    },
    metrics: metrics.map((m) => ({
      id: m.id,
      label: m.label,
      ...(m.shortLabel !== undefined ? { shortLabel: m.shortLabel } : {}),
      family: m.family,
      unit: m.unit,
    })),
    neighbours,
    skipped,
  };
}
