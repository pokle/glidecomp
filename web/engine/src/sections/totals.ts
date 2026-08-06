/**
 * The total section: the component sum, the penalties inside the FAI S7F
 * §12.4 rounding, and the §12.2 / §12.4 floors that make the printed
 * arithmetic differ from the published total.
 */

import type {
  ScoreExplanationSection,
  ScoreEntryInput,
} from '../score-explanation-types';
import { fmtPoints } from '../score-explanation-format';

export function buildTotalSection(
  entry: ScoreEntryInput,
  /** The day's points on offer (available_points.total), when the caller has
   * a class context — lets the header read "952.4 of 999.3 pts". */
  availableTotal?: number,
): ScoreExplanationSection {
  const components = [
    entry.distance_points,
    entry.time_points,
    entry.leading_points,
    entry.arrival_points,
  ];
  const shownComponents = components
    .filter((c, i) => c > 0 || i < 2) // always show distance + time, others only when earned
    .map((c) => Number(c.toFixed(1)));
  const parts = shownComponents.map((c) => c.toFixed(1)).join(' + ');
  // FAI S7F §11 rounds the total to one decimal place; §12.4 does that
  // rounding *after* penalties, so the penalties sit inside the round().
  const jtg = entry.jump_the_gun_penalty ?? 0;
  const jtgShown = Number(fmtPoints(jtg));
  const penaltySteps: string[] = [];
  if (jtg !== 0) {
    penaltySteps.push(`− ${fmtPoints(jtg)} jump-the-gun`);
  }
  if (entry.penalty_points !== 0) {
    penaltySteps.push(
      `${entry.penalty_points > 0 ? '−' : '+'} ${Math.abs(entry.penalty_points)} penalty`,
    );
  }
  const equation = [parts, ...penaltySteps].join(' ');
  const total = fmtPoints(entry.total_score);
  // What the printed figures come to, in tenths (exact in integer space).
  // Evaluate from the figures the reader sees, not the engine's full
  // precision: hidden components that each round down while their exact sum
  // rounds up would otherwise print an "=" between figures that don't
  // equate. And when a floor engaged (§12.2 minimum-distance score, §12.4
  // zero) the printed arithmetic isn't the operation performed at all.
  const evaluatedTenths = Math.round(
    (shownComponents.reduce((s, c) => s + c, 0) - jtgShown - entry.penalty_points) * 10,
  );
  const totalTenths = Math.round(entry.total_score * 10);
  const evaluated =
    evaluatedTenths < 0
      ? `−${fmtPoints(-evaluatedTenths / 10)}`
      : fmtPoints(evaluatedTenths / 10);
  let detail: string;
  if (evaluatedTenths === totalTenths) {
    detail = `round(${equation}, 1 dp) = ${total}`;
  } else if (entry.penalty_points > 0 && totalTenths === 0 && evaluatedTenths < 0) {
    // §12.4 zero floor: the penalty took the score below zero.
    detail = `${equation} would come to ${evaluated}, but scores never go below 0 (FAI S7F §12.4) — so the total is 0.`;
  } else if (jtg > 0 && totalTenths - evaluatedTenths > 3) {
    // §12.2 floor: more than display-rounding drift above the printed sum
    // means the jump-the-gun deduction was floored.
    detail = `${equation} would come to ${evaluated}, but the jump-the-gun penalty never drops a pilot below the minimum-distance score (FAI S7F §12.2) — so the total is ${total}.`;
  } else {
    detail = `${equation} ≈ ${total} — the points above are shown rounded to 0.1; the total is rounded from their exact sum.`;
  }
  return {
    id: 'total',
    title: 'Total',
    points: entry.total_score,
    ...(availableTotal !== undefined && availableTotal > 0
      ? { pointsAvailable: availableTotal }
      : {}),
    docHref: '/scoring/gap#total-score',
    items: [
      {
        id: 'total-sum',
        text: 'Distance + time + leading + arrival, minus penalties',
        value: `${total} pts`,
        detail,
      },
    ],
  };
}
