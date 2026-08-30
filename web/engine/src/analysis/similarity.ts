// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Pilot-to-pilot behavioural similarity — cosine over a chosen set of
 * behaviours.
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
 *  - Pure derivation at read time from a finished TaskAnalysisReport, like
 *    clusterPilotStyles: nothing is stored and no recompute is triggered.
 *  - Two pilots are compared by the TANIMOTO coefficient (extended Jaccard)
 *    over their z-score vectors:
 *
 *        T(a, b) = (a · b) / (‖a‖² + ‖b‖² − a · b)
 *
 *    Cosine was the first cut and is wrong for the question. Cosine divides by
 *    ‖a‖‖b‖, and that division IS the discarding of magnitude — it compares
 *    direction only, so a pilot who is mildly below average and one who is
 *    catastrophically below average on the same behaviours score as near-
 *    identical. That is not hypothetical: on Corryong 2026 open T2 the highest
 *    cosine in the entire field (0.916, #1 of 666 pairs) was John Harriott
 *    against Todd Wisewould, who sat at −4.60 SD and −0.21 SD on out-climb
 *    respectively. Same direction, nothing alike.
 *
 *    Tanimoto keeps the same numerator but divides by how much ground the two
 *    vectors cover TOGETHER, so a magnitude mismatch is charged for. It agrees
 *    with cosine when the two magnitudes match, and diverges as they separate:
 *    that pair drops to 0.056 (#210 of 666), while every healthy neighbour
 *    list on that task keeps its cosine order. Both numbers are reported so
 *    the difference is legible — see {@link SimilarPilot.shapeOnly}.
 *
 *    Range is [−1/3, 1], not [−1, 1]: two exactly opposed vectors of equal
 *    length score −1/3, because they still cover ground together. Asymmetric,
 *    and the one wart of the measure.
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
 *  - ONE behaviour is a special case, not an error. Cosine compares the
 *    DIRECTION of two vectors, and in one dimension there are only two
 *    directions — so every pilot on the subject's side of the average scores
 *    exactly +1 and everyone else exactly −1, with no ordering in between
 *    (measured: 2 distinct values over 4000 random pairs, against ~3989 at
 *    two behaviours). "Who is closest on this one behaviour" is still a good
 *    question; cosine is simply the wrong instrument for it, so a
 *    single-behaviour sheet is ranked by {@link SimilarPilot.typicalGap}
 *    instead — which in one dimension is just |Δz|, the distance between the
 *    two pilots on that behaviour. See {@link SimilarityRanking}. (Tanimoto
 *    is not degenerate in one dimension the way cosine is, but the gap is the
 *    plainer statement of the same thing there, and needs no explaining.)
 *  - Missing values are never imputed (the drop-don't-fill convention
 *    everywhere else in task analysis): the mean and standard deviation are
 *    taken over the pilots that HAVE the behaviour, each pair is compared
 *    over the behaviours BOTH pilots have, and a pair sharing too few to rank
 *    is reported skipped rather than scored.
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

import { usableMetrics } from './clustering';
import { similarityNoiseFloor } from './similarity-noise-floor';
import type { TaskAnalysisReport, MetricFamily, MetricReport } from './types';

/**
 * Below two behaviours there is no shape to compare — cosine can only return
 * ±1 in one dimension, and the score reduces to a statement about a single
 * number that {@link SimilarityRanking} `'gap'` makes more plainly. Two is the
 * floor for the comparison being meaningful, not for it being reliable: a pair
 * compared on two behaviours is thin evidence, which is why every row reports
 * its own `sharedMetrics`.
 */
export const MIN_COSINE_METRICS = 2;

/**
 * How a sheet was ranked, decided by the behaviour count rather than by the
 * reader — there is no basis control, and this is not one.
 *
 * - `cosine` — two or more behaviours: the angle between the two pilots'
 *   z-score vectors. Compares the SHAPE of their flying and ignores how far
 *   from average either flew.
 * - `gap` — exactly one behaviour: |Δz| on that behaviour, smallest first.
 *   Cosine is degenerate here (see the file comment), so the sheet answers the
 *   question that one behaviour can actually answer.
 */
export type SimilarityRanking = 'cosine' | 'gap';

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
   * This behaviour's share of the similarity: (a_i · b_i) / (‖a‖² + ‖b‖² − a·b).
   * Positive = the two pilots sit on the same side of the field's average here
   * and it pushed them together; negative = opposite sides, and it pushed them
   * apart. Summing this field over every entry reproduces `similarity`
   * exactly — the denominator is one scalar, so the decomposition survives the
   * move from cosine to Tanimoto.
   */
  contribution: number;
}

export interface SimilarPilot {
  trackFile: string;
  pilotName: string;
  /**
   * Tanimoto over the two z-vectors, −1/3 … 1. Direction AND magnitude both
   * count. This is what `neighbours` is sorted by on a cosine-ranked sheet.
   *
   * On a single-behaviour sheet (`ranking: 'gap'`) it carries no ordering —
   * read `typicalGap` there instead.
   */
  similarity: number;
  /**
   * Plain cosine over the same two vectors, −1 … 1: the SHAPE alone, with
   * magnitude divided out. Reported beside `similarity` rather than dropped,
   * because the two disagreeing is the finding — a high `shapeOnly` against a
   * low `similarity` says "these two did the same things by very different
   * amounts", which is exactly the case cosine alone got wrong.
   */
  shapeOnly: number;
  /** How many of the selected behaviours both pilots actually had. */
  sharedMetrics: number;
  /**
   * The similarity two UNRELATED pilots exceed 5% of the time at this
   * `sharedMetrics` — see ./similarity-noise-floor.ts. A row whose
   * `similarity` does not clear its own floor carries no information, however
   * confident the three decimal places look, and a surface must say so rather
   * than rank it as though it did.
   *
   * Per-row rather than per-report because a dropped value is never imputed,
   * so one sheet can hold a pair compared over 22 behaviours beside a pair
   * compared over 3. NaN on a gap-ranked sheet, where the score is unused.
   */
  noiseFloor: number;
  /** Whether `similarity` clears {@link noiseFloor}. False on a gap sheet. */
  aboveNoiseFloor: boolean;
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
  /** What `neighbours` is sorted by, and which column a reader should trust. */
  ranking: SimilarityRanking;
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

const EXPLANATION_GAP =
  'You picked one behaviour, so this sheet is not a cosine similarity. GlideComp converts the ' +
  'behaviour to a z-score inside this field: how many standard deviations above or below the ' +
  'field average each pilot sat. It then lists the pilots by how close their z-score is to ' +
  'yours, closest first. An angle between two lists needs at least two behaviours to mean ' +
  'anything, so with one behaviour the honest answer is simply who sat nearest to you on it. ' +
  'No score and no ranking is used.';

const EXPLANATION_COSINE_TAIL =
  ' Two pilots are then compared by how much their two lists overlap, measured against how much ' +
  'ground the two of them cover between them. Both the direction and the size of a departure ' +
  'count: two pilots who did the same things by very different amounts score low, where a measure ' +
  'of shape alone would call them near-identical. A missing value is never filled in. The score ' +
  'runs from 1 for two pilots who flew alike down to about −0.33 for two who did the opposite. No ' +
  'score and no ranking is used.';

const EXPLANATION =
  'GlideComp converts each selected behaviour to a z-score inside this field: how many standard ' +
  'deviations above or below the field average the pilot sat. That removes the unit, so a speed ' +
  'in kilometres per hour and a glide ratio can sit in one list without the larger numbers taking ' +
  'over, and it keeps the size of a gap rather than only the order. Each pilot becomes a list of ' +
  'those numbers, over the behaviours that both pilots have.' + EXPLANATION_COSINE_TAIL;

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
  report: TaskAnalysisReport,
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
 * Two or more behaviours are ranked by cosine; exactly one is ranked by the
 * gap on that behaviour, because cosine cannot order a single dimension (see
 * the file comment). Returns null only when the subject isn't in the report or
 * no requested behaviour is usable at all.
 *
 * Pure and deterministic: the same report and options always give the same
 * ordering (ties broken by name, so it never hinges on array order).
 */
export function findSimilarPilots(
  report: TaskAnalysisReport,
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
  if (metrics.length === 0) return null;

  // The behaviour count picks the ranking; the reader never does.
  const ranking: SimilarityRanking =
    metrics.length >= MIN_COSINE_METRICS ? 'cosine' : 'gap';
  // A pair needs enough SHARED behaviours for whichever measure is in play —
  // two for an angle, one for a gap.
  const requiredShared = ranking === 'cosine' ? MIN_COSINE_METRICS : 1;

  const cols = zScoreColumns(report, metrics);
  const neighbours: SimilarPilot[] = [];
  const skipped: SkippedPilot[] = [];

  for (let i = 0; i < report.pilots.length; i++) {
    if (i === subjectIndex) continue;
    const pilot = report.pilots[i];

    // Shared support first: the vectors are built over the behaviours BOTH
    // pilots have, so the norms below are the norms of the compared vectors
    // and the contributions really do sum to the score.
    //
    // A missing value is DROPPED here, never filled in. Note that zero would
    // not be a neutral filler: these are z-scores, so 0 means "exactly at the
    // field average" — imputing it would assert that a pilot we have no
    // reading for was perfectly ordinary, and would pull every sparse pilot
    // toward the middle of the field. The median is no better; in z-space it
    // sits near 0 too. The honest cost of dropping instead is that different
    // pairs are compared over different subsets, which is why every row
    // reports its own `sharedMetrics`.
    const shared: number[] = [];
    for (let mi = 0; mi < metrics.length; mi++) {
      if (cols[mi][subjectIndex] !== null && cols[mi][i] !== null) shared.push(mi);
    }
    if (shared.length < requiredShared) {
      skipped.push({
        trackFile: pilot.trackFile,
        pilotName: pilot.pilotName,
        reason:
          shared.length === 0
            ? 'no value recorded for the selected behaviours'
            : `only ${shared.length} of the ${metrics.length} selected behaviours in common (needs ≥ ${requiredShared})`,
      });
      continue;
    }

    // ONE FUSED PASS, deliberately. Splitting these four accumulations into a
    // loop each measured 68% SLOWER on a 400-pilot field (42 ms -> 71 ms):
    // four passes over memory, four `cols[mi]` indirections per behaviour
    // instead of one, and four times the loop overhead. It buys nothing in
    // exchange, because no JS engine auto-vectorises this — floating-point
    // addition is not associative, so splitting a reduction across SIMD lanes
    // changes the result, and neither V8 nor JSC will do it (a C compiler
    // refuses too, absent -ffast-math). `** 2` is already compiled to a
    // multiply; writing `d * d` measured identically.
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
    // Only a shape comparison needs a direction. On a gap sheet a pilot sitting
    // exactly at the field average is a fine answer — possibly the closest.
    if (ranking === 'cosine' && (normA === 0 || normB === 0)) {
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

    // Tanimoto's denominator: how much ground the two vectors cover together.
    // Zero only when both are the zero vector, which the guard above has
    // already skipped on a cosine sheet; on a gap sheet the score is unused.
    const tanimotoDenom = sumA + sumB - dot;
    // Cosine's denominator, for the shape-only figure reported alongside.
    const cosineDenom = normA * normB;
    const similarityValue = tanimotoDenom === 0 ? 0 : dot / tanimotoDenom;
    // How high two unrelated pilots reach over THIS pair's behaviour count.
    // Meaningless on a gap sheet, which ranks by distance rather than score.
    const floor = ranking === 'cosine' ? similarityNoiseFloor(shared.length) : NaN;
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
          contribution:
            tanimotoDenom === 0 ? 0 : (subjectZ * neighbourZ) / tanimotoDenom,
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
      similarity: similarityValue,
      noiseFloor: floor,
      aboveNoiseFloor: ranking === 'cosine' && similarityValue > floor,
      shapeOnly: cosineDenom === 0 ? 0 : dot / cosineDenom,
      sharedMetrics: shared.length,
      typicalGap: Math.sqrt(sqGap / shared.length),
      contributions,
    });
  }

  neighbours.sort((a, b) =>
    ranking === 'cosine'
      ? b.similarity - a.similarity || a.pilotName.localeCompare(b.pilotName)
      : a.typicalGap - b.typicalGap || a.pilotName.localeCompare(b.pilotName),
  );
  skipped.sort((a, b) => a.pilotName.localeCompare(b.pilotName));

  return {
    explanation: ranking === 'cosine' ? EXPLANATION : EXPLANATION_GAP,
    ranking,
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
