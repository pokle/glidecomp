/**
 * Arrival points (FAI S7F §13.5), with the arithmetic that produced them:
 * the arrival position at the end of the speed section, the factor evaluated
 * by the scorer's own `calculateArrivalPoints`, what one place was worth, and
 * the §13.2 ESS-but-not-goal reduction that can dock the lot.
 */

import type { GAPParameters } from '../gap-scoring';
import { calculateArrivalPoints } from '../gap-scoring';
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
  defaultFormatTime,
} from '../score-explanation-format';
import { ordinal } from './rank';
import { noEssPointsZeroed, pilotsAtEss } from './shared';

/**
 * Arrival points, with the arithmetic that produced them.
 *
 * The §13.5 factor is a function of arrival POSITION at the end of the speed
 * section, which the scorer computed and then discarded — leaving arrival as
 * the one component the page could only assert. With `arrival_position` and
 * `ess_time_ms` published it substitutes like every other component.
 *
 * The factor is evaluated with `calculateArrivalPoints` itself rather than a
 * re-typed cubic, so the printed figure is provably the scorer's own function
 * and the spec's coefficients live in exactly one place.
 *
 * Two things matter more here than the formula:
 *
 *  - **The order is by wall-clock time at ESS, not by speed.** A pilot on an
 *    early start gate can cross ahead of a faster pilot on a later gate and
 *    take more arrival points for it. Nothing on the site said so, and it is
 *    the detail most likely to be disputed.
 *  - **What one rank was worth on this day.** The marginal value of moving up
 *    one is exact, and varies enormously with position — near the front a
 *    rank is worth a lot, at the back almost nothing. That turns a bare
 *    rank into something a pilot can weigh.
 */
export function buildArrivalSection(
  entry: ScoreEntryInput,
  classContext: ClassContextInput,
  params: GAPParameters,
  fmt: (d: Date) => string = defaultFormatTime,
): ScoreExplanationSection {
  const ap = classContext.available_points;
  // Prefer the published field size (it is the divisor the scorer used); fall
  // back to counting, for payloads written before validity_inputs existed.
  const atEss = pilotsAtEss(classContext);
  const position = entry.arrival_position ?? null;
  const items: ScoreExplanationItem[] = [];

  items.push({
    id: 'arrival',
    text: 'Arrival points reward crossing the end of the speed section early relative to the other pilots who reached it.',
    value: pts(entry.arrival_points),
  });

  if (position !== null && position > 0 && atEss > 0) {
    // A tie is real: the order is resolved by array position when two pilots
    // share a timestamp, which is not a fact about the flying. Say so rather
    // than presenting an ordering the data does not support.
    const tied =
      entry.ess_time_ms != null &&
      classContext.pilots.filter((p) => p.ess_time_ms === entry.ess_time_ms).length > 1;
    items.push({
      id: 'arrival-position',
      text: `Reached the end of the speed section ${ordinal(position)} of ${atEss}`,
      value: entry.ess_time_ms != null ? fmt(new Date(entry.ess_time_ms)) : undefined,
      detail:
        'The arrival order is by the clock at the end of the speed section, not by speed — an earlier start gate can put a slower pilot ahead of a faster one here.' +
        (tied
          ? ' Another pilot reached it on the same second; a tie is separated arbitrarily.'
          : ''),
    });

    const factor = calculateArrivalPoints(position, atEss, 1);
    const { availStr, decimals, reconciles } = reconcileWithAvailable(
      ap.arrival, 3, 6, entry.arrival_points,
      (d, avail) => Number(factor.toFixed(d)) * avail,
    );
    // The §13.2 factor is stated by buildArrivalEssNotGoalItems below; when it
    // applies the printed product is the pre-reduction figure, so don't claim
    // an equality the published points won't satisfy.
    const reduced =
      params.scoring === 'HG' && entry.reached_ess && !entry.made_goal &&
      params.essNotGoalFactor < 1;
    items.push({
      id: 'arrival-formula',
      text: 'Arrival points fall off steeply with each rank',
      value: pts(entry.arrival_points),
      detail:
        `arrival ratio = 1 − (${position} − 1) ÷ ${atEss} = ${trimZeros(
          (1 - (position - 1) / atEss).toFixed(3),
          2,
        )}; arrival factor = 0.2 + 0.037·r + 0.13·r² + 0.633·r³ = ${trimZeros(
          factor.toFixed(decimals),
          3,
        )}; × ${availStr} available ${
          reduced || !reconciles ? '≈' : '='
        } ${fmtPoints(entry.arrival_points)}`,
    });

    // What one place was worth here. The coefficients sum to 1, so first place
    // takes everything available and the 0.2 constant floors everyone else —
    // both worth stating, because "20% for last" is the shape of the curve.
    if (position === 1) {
      items.push({
        id: 'arrival-shape',
        text: 'First to the end of the speed section — the full available arrival points.',
        emphasis: 'muted',
      });
    } else {
      const onePlace =
        calculateArrivalPoints(position - 1, atEss, ap.arrival) -
        calculateArrivalPoints(position, atEss, ap.arrival);
      const last = calculateArrivalPoints(atEss, atEss, ap.arrival);
      items.push({
        id: 'arrival-shape',
        text: `One place earlier would have been worth ${fmtPoints(onePlace)} more points`,
        detail: `The curve is front-loaded: first place takes all ${fmtPoints(
          ap.arrival,
        )} available, and everyone else who reaches the end of the speed section keeps at least ${fmtPoints(
          last,
        )} of them.`,
        emphasis: 'muted',
      });
    }
  } else if (atEss > 0) {
    // No position published (an older cached payload) — state the half of the
    // ratio we can stand behind rather than inventing the other.
    items.push({
      id: 'arrival-field',
      text: `${atEss} pilot${atEss === 1 ? '' : 's'} reached the end of the speed section on this task; the points scale with where in that group you crossed it (FAI S7F §13.5).`,
      emphasis: 'muted',
    });
  } else if (noEssPointsZeroed(classContext, params)) {
    // Nobody got there at all, so there was no arrival order to rank anyone
    // in and the specification puts nothing on offer (§11). Said here as well
    // as in the day-quality section because a reader who skipped straight to
    // this section would otherwise see a bare zero with no reason beside it.
    items.push({
      id: 'arrival-no-ess',
      text: 'Nobody reached the end of the speed section on this task, so there was no arrival order to place anyone in and the task offered no arrival points to anyone (FAI S7F §11).',
      emphasis: 'warning',
    });
  }

  items.push(...buildArrivalEssNotGoalItems(entry, params));

  // The header's rank — the arrival POSITION is the section's whole
  // input, so it is the rank, restated scannably.
  const rank =
    position !== null && position > 0 && atEss >= 2
      ? `${position === 1 ? 'First' : ordinal(position)} of ${atEss} to the end of the speed section`
      : undefined;

  return {
    id: 'arrival',
    title: 'Arrival points',
    points: entry.arrival_points,
    ...(ap.arrival > 0 ? { pointsAvailable: ap.arrival } : {}),
    ...(rank ? { rank } : {}),
    docHref: '/scoring/gap#arrival-points',
    items,
  };
}

/**
 * The §13.2 "ESS but not goal" caveat for the arrival section: an HG pilot
 * who reaches ESS but lands before goal keeps only the competition's
 * essNotGoalFactor share of their arrival points (same factor as time).
 */
export function buildArrivalEssNotGoalItems(
  entry: Pick<ScoreEntryInput, 'made_goal' | 'reached_ess'>,
  params: GAPParameters,
): ScoreExplanationItem[] {
  if (
    params.scoring !== 'HG' ||
    !entry.reached_ess ||
    entry.made_goal ||
    params.essNotGoalFactor >= 1
  ) {
    return [];
  }
  return [
    {
      id: 'arrival-ess-not-goal',
      text: `Reached the end of the speed section but landed before goal — only ${trimZeros((params.essNotGoalFactor * 100).toFixed(1), 0)}% of arrival points are kept, the same reduction as time points (FAI S7F §13.2).`,
      emphasis: 'warning',
    },
  ];
}
