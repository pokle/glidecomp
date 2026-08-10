/**
 * Leading points, with the arithmetic that produced them, and the sentence
 * naming which leading-coefficient variant (FAI S7F 2026 §12.3.1) measured
 * them.
 */

import type { GAPParameters, LeadingFormula } from '../gap-scoring';
import { calculateLeadingPoints, leadingFormulaFor } from '../gap-scoring';
import type {
  ScoreExplanationItem,
  ScoreExplanationSection,
  ScoreEntryInput,
  ClassContextInput,
  LeadingTimesInput,
} from '../score-explanation-types';
import {
  pts,
  eqResult,
  reconcileWithAvailable,
  trimZeros,
  defaultFormatTime,
} from '../score-explanation-format';
import { rankAmong, rankLabel } from './rank';

/**
 * Name the leading-coefficient variant actually used (S7F 2026 §12.3.1).
 * The 2026 edition pins the variant per discipline.
 */
export function leadingVariantSentence(formula: LeadingFormula): string {
  return formula === 'classic'
    ? 'Measured with the squared-distance leading coefficient (S7F §12.3.1, the hang-gliding variant).'
    : 'Measured with the weighted-area leading coefficient (S7F §12.3.1, the paragliding variant).';
}

/**
 * Why the land-out tail ended where it did (S7F §12.3.1). One sentence per
 * possible source of `maxTime`, because the reason is a different fact about
 * the day in each case — "the last pilot was still flying" and "the deadline
 * cut it off" are not the same finding.
 */
function maxTimeReason(times: LeadingTimesInput): string {
  switch (times.max_time_source) {
    case 'last_ess':
      return 'maxTime is when the last pilot reached the end of the speed section — later than the last land-out, so it sets the clock for everyone still flying.';
    case 'last_outlanding':
      return 'maxTime is when the last pilot landed out. That was after the last pilot reached the end of the speed section, so the clock kept running.';
    case 'deadline':
      return 'maxTime is the task deadline. Flying went on past it, and the deadline caps how far the graph can be carried.';
    case 'stop':
      return 'maxTime is the task stop time. The task was stopped, and nothing after the stop is scored.';
    case 'fallback':
      return 'No pilot reached the end of the speed section and no landing time was recorded, so the graph is carried for one hour after the first start.';
  }
}

/**
 * The land-out tail (S7F §12.3.1): the row that names where a landed-out
 * pilot's leading graph was carried to, and why it stopped there.
 *
 * `maxTime` is the one input to this pilot's coefficient that comes from
 * outside their own flight — the field decides it, so two pilots who flew
 * identically on different days get different coefficients. Naming it is the
 * difference between a reader being able to check the number and having to
 * take it.
 */
function buildMaxTimeItem(
  times: LeadingTimesInput,
  fmt: (d: Date) => string,
): ScoreExplanationItem {
  return {
    id: 'leading-max-time',
    text: 'Your flight ended before the end of the speed section, so the graph carries on at your best distance until maxTime',
    value: fmt(new Date(times.max_time_ms)),
    detail: maxTimeReason(times),
  };
}

/**
 * Leading points, with the arithmetic that produced them.
 *
 * Before this the section printed a sentence and a number, in a page where
 * every other component substitutes its formula — and leading is both the
 * least intuitive component in GAP and the one pilots most often dispute.
 * The gate is the leading coefficient: without it (leading not scored, or a
 * payload cached before it was published) the section stays as it was rather
 * than asserting arithmetic it cannot show.
 *
 * The coefficient is an area under the pilot's distance-over-time curve, so
 * its absolute value means nothing to a reader — only the comparison does.
 * That is why the best-in-class figure is printed beside it and why the
 * sentence says "lower is better" rather than leaving the reader to infer a
 * direction from two bare numbers.
 */
export function buildLeadingSection(
  entry: ScoreEntryInput,
  classContext: ClassContextInput,
  params: GAPParameters,
  fmt: (d: Date) => string = defaultFormatTime,
): ScoreExplanationSection {
  const ap = classContext.available_points;
  const items: ScoreExplanationItem[] = [
    {
      id: 'leading',
      text: 'Leading points reward flying out front during the speed section — the pilot with the best leading coefficient takes all available leading points, others fall off with the gap.',
      value: pts(entry.leading_points),
    },
  ];

  const lc = entry.leading_coefficient;
  const allLCs = classContext.pilots
    .map((p) => p.leading_coefficient)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);
  const minLC = allLCs.length > 0 ? Math.min(...allLCs) : null;

  if (typeof lc === 'number' && Number.isFinite(lc) && minLC !== null) {
    items.push({
      id: 'leading-coefficient',
      text: 'Your leading coefficient — the area under your distance-over-time curve, so lower means further ahead for longer',
      value: trimZeros(lc.toFixed(3), 1),
      detail:
        lc <= minLC
          ? 'The best in the class — no one spent more of the race out front, so this takes the full available leading points.'
          : `Best in class ${trimZeros(minLC.toFixed(3), 1)}.`,
    });
    if (lc > minLC) {
      // The scorer's own function at unit available points, so the printed
      // factor can never drift from the one the engine applied — including
      // its degenerate guard for a non-positive best coefficient.
      const factor = calculateLeadingPoints(lc, minLC, 1);
      const { availStr, decimals, reconciles } = reconcileWithAvailable(
        ap.leading, 3, 6, entry.leading_points,
        (d, avail) => Number(factor.toFixed(d)) * avail,
      );
      items.push({
        id: 'leading-formula',
        text: 'Leading points fall off with the gap to the best coefficient',
        value: pts(entry.leading_points),
        detail: `leading factor = max(0, 1 − ((LC − LCbest)² ÷ LCbest)^1⁄3) = ${trimZeros(
          factor.toFixed(decimals),
          3,
        )}; × ${availStr} available ${eqResult(reconciles, entry.leading_points)}`,
      });
    }
    // The tail only exists for a pilot who never reached ESS; for everyone
    // else maxTime decided nothing about their own coefficient.
    if (!entry.reached_ess && classContext.leading_times) {
      items.push(buildMaxTimeItem(classContext.leading_times, fmt));
    }
  }

  items.push({
    id: 'leading-variant',
    text: leadingVariantSentence(leadingFormulaFor(params.scoring)),
    emphasis: 'muted',
  });

  // Ranked on the section's input: the coefficient itself (lower is
  // better), never the points — a §12.1 reduction can reorder those. "Of the
  // N measured" on purpose: a coefficient exists for everyone who flew the
  // speed section, so this denominator is the whole field, not the goal/ESS
  // count the time and arrival ranks use — say so or the mismatch reads as
  // a bug.
  const rank =
    typeof lc === 'number' && Number.isFinite(lc) && lc > 0 && allLCs.length >= 2
      ? `${rankLabel(rankAmong(allLCs, lc, (a, b) => a < b), 'best')} measured leading coefficients`
      : undefined;

  return {
    id: 'leading',
    title: 'Leading points',
    points: entry.leading_points,
    ...(ap.leading > 0 ? { pointsAvailable: ap.leading } : {}),
    ...(rank ? { rank } : {}),
    docHref: '/scoring/gap#leading-points',
    items,
  };
}
