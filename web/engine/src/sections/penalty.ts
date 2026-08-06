/**
 * The penalty section: the jump-the-gun deduction (FAI S7F §12.2) with its
 * division printed, and any penalty or bonus an official applied after
 * scoring.
 */

import { DEFAULT_GAP_PARAMETERS } from '../gap-scoring';
import type {
  ScoreExplanationItem,
  ScoreExplanationSection,
} from '../score-explanation-types';
import {
  fmtPoints,
  duration,
  trimZeros,
  reconcileDecimals,
} from '../score-explanation-format';

export function buildPenaltySection(
  entry: {
    penalty_points: number;
    penalty_reason: string | null;
    early_start_seconds?: number | null;
    jump_the_gun_penalty?: number | null;
  },
  jumpTheGunFactor = DEFAULT_GAP_PARAMETERS.jumpTheGunFactor,
): ScoreExplanationSection | null {
  const jtg = entry.jump_the_gun_penalty ?? 0;
  if (entry.penalty_points === 0 && jtg === 0) return null;
  const items: ScoreExplanationItem[] = [];
  if (jtg > 0) {
    const secs = entry.early_start_seconds ?? 0;
    // The penalty is exactly secondsEarly ÷ factor — print the seconds with
    // enough decimals that the division visibly holds (73.6 s ÷ 2 = 36.8,
    // never a contradictory "74 s ÷ 2 = 36.8").
    const { decimals, reconciles } = reconcileDecimals(
      0, 2, jtg,
      (d) => Number(secs.toFixed(d)) / jumpTheGunFactor,
    );
    items.push({
      id: 'jump-the-gun',
      text: `Jump the gun (FAI S7F §12.2): started ${duration(secs)} before the first start gate. The complete flight is scored, with 1 penalty point per ${jumpTheGunFactor} seconds early; the total never drops below the minimum-distance score.`,
      value: `−${fmtPoints(jtg)} pts`,
      detail: `${trimZeros(secs.toFixed(decimals), 0)} s early ÷ ${jumpTheGunFactor} s per point ${reconciles ? '=' : '≈'} ${fmtPoints(jtg)} points`,
      emphasis: 'warning',
    });
  }
  if (entry.penalty_points !== 0) {
    const isBonus = entry.penalty_points < 0;
    items.push({
      id: 'penalty',
      text: entry.penalty_reason || (isBonus ? 'Bonus applied by the scorer.' : 'Penalty applied by the scorer.'),
      value: `${isBonus ? '+' : '−'}${Math.abs(entry.penalty_points)} pts`,
      detail: 'Applied after scoring — see the competition audit log for who applied it and when.',
      emphasis: isBonus ? 'normal' : 'warning',
    });
  }
  const isBonusOnly = jtg === 0 && entry.penalty_points < 0;
  return {
    id: 'penalty',
    title: isBonusOnly ? 'Bonus' : 'Penalty',
    points: -(entry.penalty_points + jtg),
    items,
  };
}
