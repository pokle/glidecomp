// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Pilot-to-pilot behavioural similarity — cosine over a chosen set of
 * behaviours. PROTOTYPE, so read the caveats at the bottom before trusting a
 * number off it.
 *
 * The question this answers is deliberately NOT the one the rest of field
 * analysis answers. The correlation tables ask which behaviours separated the
 * leaderboard, and style clustering asks which groups the field falls into.
 * This asks only: given the behaviours I picked, who flew most like this
 * pilot? No score, GAP rank or outcome metric enters anywhere — not in the
 * vector, not in the ordering, not in the output. `outcome` metrics are
 * excluded by {@link usableMetrics}, the same gate clustering uses.
 *
 * Method:
 *  - Pure derivation at read time from a finished FieldAnalysisReport, like
 *    clusterPilotStyles: nothing is stored and no recompute is triggered.
 *  - Each selected behaviour is converted to a Z-SCORE within this field:
 *    (value − field mean) / field standard deviation. The unit cancels, so
 *    km/h, metres and ratios can share one vector without the metric that
 *    happens to be measured in big numbers dominating the geometry. On
 *    Corryong 2026 open T2 the raw values are 89% start-delay-and-ESS-margin
 *    by vector length, purely because seconds and metres are large numbers —
 *    without normalising, the "similarity" is almost entirely those two.
 *  - A z-score keeps the SIZE of a gap, not just its order. Two pilots 0.3
 *    km/h apart on glide speed are ~0.03 apart in z, where a rank transform
 *    would have separated them by a full place regardless. That is the
 *    intended reading of "flew alike": the order does not matter, the
 *    distance does.
 *  - Missing values are never imputed (the drop-don't-fill convention
 *    everywhere else in field analysis): the mean and standard deviation are
 *    taken over the pilots that HAVE the behaviour, each pair is compared
 *    over the behaviours BOTH pilots have, and a pair sharing fewer than
 *    {@link MIN_SHARED_METRICS} is reported skipped rather than scored.
 *  - Every neighbour carries its per-behaviour contributions, which sum
 *    exactly to the cosine, so "why are these two similar" is answerable from
 *    the output alone (the explainability rule).
 *
 * KNOWN LIMITATION of the z-score basis, and the price of keeping distances:
 * one pilot with a wild value on one behaviour gets a large |z| there, which
 * can dominate their own vector's direction. Flying metrics are heavy-tailed,
 * so this is not hypothetical. A rank transform is immune to it and is what
 * ./clustering.ts uses; this surface deliberately trades that robustness for
 * a measure that knows the difference between "just ahead" and "miles ahead".
 */

import { MIN_SHARED_METRICS, usableMetrics } from './clustering';
import type { FieldAnalysisReport, MetricFamily, MetricReport } from './types';

/** One behaviour's share of a pair's cosine. Contributions sum to the cosine. */
export interface SimilarityContribution {
  metricId: string;
  label: string;
  shortLabel?: string;
  unit: string;
  family: MetricFamily;
  /** Standard deviations from the field mean on this behaviour (signed). */
  subjectZ: number;
  neighbourZ: number;
  /** The raw metric values behind those z-scores, for display. */
  subjectValue: number;
  neighbourValue: number;
  /**
   * (a_i · b_i) / (‖a‖ ‖b‖) for this component. Positive = the two pilots sit
   * on the same side of the field's average on this behaviour and it pushed
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
  /** How many of the selected behaviours both pilots actually had. */
  sharedMetrics: number;
  /**
   * Root-mean-square difference in z, over the same shared behaviours — "these
   * two differ by about this many standard deviations per behaviour".
   *
   * Carried as a foil, not a ranking. Cosine compares only the DIRECTION of
   * the two vectors, so it cannot tell a mildly unusual pilot from a wildly
   * unusual one with the same shape; this can. A pair that is close on one and
   * far on the other is the interesting case.
   */
  typicalGap: number;
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
  subject: { trackFile: string; pilotName: string };
  /** The behaviours that actually entered the vectors, in report order. */
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
}

const EXPLANATION =
  'GlideComp converts each selected behaviour to a z-score inside this field: how many standard ' +
  'deviations above or below the field average the pilot sat. That removes the unit, so a speed ' +
  'in kilometres per hour and a glide ratio can sit in one list without the larger numbers taking ' +
  'over, and it keeps the size of a gap rather than only the order. Each pilot becomes a list of ' +
  'those numbers, and two pilots are compared by the cosine of the angle between their lists, over ' +
  'the behaviours that both pilots have. A missing value is never filled in. The result says ' +
  'whether two pilots depart from the average pilot in the same pattern. It ignores how large the ' +
  'departure was, so a slightly unusual pilot and a very unusual one can score 1.00 together. No ' +
  'score and no ranking is used.';

/**
 * Per-behaviour z-scores, aligned to report.pilots; null where the pilot has
 * no value. The mean and standard deviation are taken over the pilots that
 * HAVE the value — a missing value is never filled in, and never drags the
 * field's average toward zero.
 *
 * The population (not sample) standard deviation: this is the whole field, not
 * a sample drawn from a larger one.
 */
function zScoreColumns(
  report: FieldAnalysisReport,
  metrics: MetricReport[],
): (number | null)[][] {
  return metrics.map((m) => {
    const values: number[] = [];
    for (const p of m.perPilot) {
      if (p.value !== null && isFinite(p.value)) values.push(p.value);
    }
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    const sd = Math.sqrt(
      values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length,
    );
    return m.perPilot.map((p) => {
      if (p.value === null || !isFinite(p.value)) return null;
      // usableMetrics already drops zero-variance behaviours, so sd > 0 here;
      // the guard keeps a NaN out of the vector if that ever stops holding.
      return sd === 0 ? 0 : (p.value - mean) / sd;
    });
  });
}

/**
 * Rank the field by behavioural similarity to one pilot.
 *
 * Returns null when the subject isn't in the report, or when fewer than
 * {@link MIN_SHARED_METRICS} of the requested behaviours are usable at all —
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
  const subjectIndex = report.pilots.findIndex(
    (p) => p.trackFile === options.subjectTrackFile,
  );
  if (subjectIndex === -1) return null;

  const wanted = options.metricIds ? new Set(options.metricIds) : null;
  const metrics: MetricReport[] = usableMetrics(report).filter(
    (m) => wanted === null || wanted.has(m.id),
  );
  if (metrics.length < MIN_SHARED_METRICS) return null;

  const cols = zScoreColumns(report, metrics);
  const neighbours: SimilarPilot[] = [];
  const skipped: SkippedPilot[] = [];

  for (let i = 0; i < report.pilots.length; i++) {
    if (i === subjectIndex) continue;
    const pilot = report.pilots[i];

    // Shared support first: the vectors are built over the behaviours BOTH
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
    let sqGap = 0;
    for (const mi of shared) {
      const a = cols[mi][subjectIndex]!;
      const b = cols[mi][i]!;
      dot += a * b;
      sumA += a * a;
      sumB += b * b;
      sqGap += (a - b) ** 2;
    }
    const normA = Math.sqrt(sumA);
    const normB = Math.sqrt(sumB);
    if (normA === 0 || normB === 0) {
      // A pilot sitting exactly at the field average on every shared behaviour
      // has no direction at all, so the angle to them is undefined. Saying so
      // beats inventing a 0.
      skipped.push({
        trackFile: pilot.trackFile,
        pilotName: pilot.pilotName,
        reason:
          normA === 0
            ? 'the selected pilot sits exactly at the field average on every shared behaviour, so there is no direction to compare'
            : 'this pilot sits exactly at the field average on every shared behaviour, so there is no direction to compare',
      });
      continue;
    }

    const denom = normA * normB;
    const contributions: SimilarityContribution[] = shared
      .map((mi) => {
        const m = metrics[mi];
        const subjectZ = cols[mi][subjectIndex]!;
        const neighbourZ = cols[mi][i]!;
        return {
          metricId: m.id,
          label: m.label,
          ...(m.shortLabel !== undefined ? { shortLabel: m.shortLabel } : {}),
          unit: m.unit,
          family: m.family,
          subjectZ,
          neighbourZ,
          subjectValue: m.perPilot[subjectIndex].value!,
          neighbourValue: m.perPilot[i].value!,
          contribution: (subjectZ * neighbourZ) / denom,
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
      typicalGap: Math.sqrt(sqGap / shared.length),
      contributions,
    });
  }

  neighbours.sort(
    (a, b) => b.cosine - a.cosine || a.pilotName.localeCompare(b.pilotName),
  );
  skipped.sort((a, b) => a.pilotName.localeCompare(b.pilotName));

  return {
    explanation: EXPLANATION,
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
