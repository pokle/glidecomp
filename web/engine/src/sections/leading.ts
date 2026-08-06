/**
 * Leading points, with the arithmetic that produced them, and the sentence
 * naming which leading-coefficient variant (FAI S7F §11.3.1) measured them.
 */

import type { GAPParameters } from '../gap-scoring';
import type {
  ScoreExplanationItem,
  ScoreExplanationSection,
  ScoreEntryInput,
  ClassContextInput,
} from '../score-explanation-types';
import {
  pts,
  fmtPoints,
  reconcileWithAvailable,
  trimZeros,
} from '../score-explanation-format';
import { rankAmong, rankLabel } from './rank';

/**
 * Name the leading-coefficient variant actually used (S7F §11.3.1), decoupled
 * from the time-points exponent since issue #258.
 */
export function leadingVariantSentence(formula: GAPParameters['leadingFormula']): string {
  return formula === 'classic'
    ? 'Measured with the classic squared-distance leading coefficient (S7F §11.3.1, the hang-gliding / GAP2016–2018 variant).'
    : 'Measured with the weighted-area leading coefficient (S7F §11.3.1, the paragliding / GAP2020+ variant).';
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
      // Mirrors calculateLeadingPoints exactly, including its degenerate
      // guard: a non-positive best coefficient has no defined normalisation
      // and the engine scores 0 rather than dividing by it.
      const factor =
        minLC > 0 ? Math.max(0, 1 - Math.cbrt(((lc - minLC) * (lc - minLC)) / minLC)) : 0;
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
        )}; × ${availStr} available ${
          reconciles
            ? `= ${fmtPoints(entry.leading_points)}`
            : `≈ ${fmtPoints(entry.leading_points)} — the figures are shown rounded; the points come from their full precision`
        }`,
      });
    }
  }

  items.push({
    id: 'leading-variant',
    text: leadingVariantSentence(params.leadingFormula),
    emphasis: 'muted',
  });

  // Standing on the section's input: the coefficient itself (lower is
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
