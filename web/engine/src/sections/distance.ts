/**
 * Distance points, with the arithmetic that produced them — including the
 * HG linear/difficulty split (FAI S7F §11.1.1) and the early-start,
 * minimum-distance and stopped-task altitude-bonus caveats that shape the
 * scored distance before it is divided by the best in class.
 */

import type { GAPParameters } from '../gap-scoring';
import { usesDistanceDifficulty } from '../gap-scoring';
import type { TurnpointSequenceResult } from '../turnpoint-sequence';
import type {
  ScoreExplanationItem,
  ScoreExplanationSection,
  ScoreEntryInput,
  ClassContextInput,
} from '../score-explanation-types';
import {
  km,
  pts,
  fmtPoints,
  duration,
  reconcileWithAvailable,
  kmNum,
  kmEq,
} from '../score-explanation-format';
import { rankAmong, rankLabel } from './rank';

export function buildDistanceSection(
  entry: ScoreEntryInput,
  classContext: ClassContextInput,
  result: TurnpointSequenceResult,
  params: GAPParameters,
): ScoreExplanationSection {
  const ap = classContext.available_points;
  const best = Math.max(...classContext.pilots.map((p) => p.flown_distance), 0);
  // The engine applies the linear/difficulty split for every HG pilot when
  // useDistanceDifficulty is on, including one whose difficulty half is
  // legitimately 0. Gating on the point value would drop such a pilot into
  // the pure-linear branch, whose printed equation omits the 0.5 factor the
  // engine actually applied.
  const useDifficulty = usesDistanceDifficulty(params);

  const items: ScoreExplanationItem[] = [];

  if (entry.early_start_outcome === 'pg_launch_to_sss') {
    // The scored distance IS the launch→start leg (§12.2 awards it as a fixed
    // value), so print it here against what the pilot actually flew — that
    // difference is the whole effect of the rule on their card. Two caveats:
    // a launch→start leg shorter than the minimum distance is floored by
    // §11.1, so the figure is then the minimum and must not be labelled the
    // leg; and an older cached payload may not carry the flown figure, in
    // which case the rule is stated without the comparison.
    const actuallyFlew = result.flownDistance;
    const atMinimum = entry.flown_distance <= params.minimumDistance;
    items.push({
      id: 'early-start-distance',
      text: 'Early start (FAI S7F §12.2): paraglider pilots who start before the first start gate are scored only for the distance from launch to the start cylinder — a fixed distance, whatever the rest of the flight covered.',
      value: km(entry.flown_distance),
      detail: atMinimum
        ? `The launch→start leg is shorter than the ${km(params.minimumDistance)} minimum, so the minimum distance is scored instead (FAI S7F §11.1).`
        : `The launch→start leg of the task line, as measured for the complete task distance (FAI S7F §6.4.1)${
            Number.isFinite(actuallyFlew) && actuallyFlew > 0
              ? ` — not what you actually flew (${km(actuallyFlew)})`
              : ''
          }.`,
      emphasis: 'warning',
    });
  } else if (entry.early_start_outcome === 'hg_min_distance') {
    items.push({
      id: 'early-start-distance',
      text: `Early start of ${duration(entry.early_start_seconds ?? 0)} — more than the ${params.jumpTheGunMaxSeconds} s jump-the-gun limit (FAI S7F §12.2), so the flight is scored as the minimum distance.`,
      emphasis: 'warning',
    });
  } else if (result.flownDistance < params.minimumDistance) {
    items.push({
      id: 'minimum-distance',
      text: `Flew ${km(result.flownDistance)}, less than the ${km(params.minimumDistance)} minimum — scored as the minimum distance.`,
      emphasis: 'warning',
    });
  }

  // Stopped tasks (S7F §12.3.6): a pilot still flying at the stop gets a
  // bonus distance for their height above goal — it is already inside the
  // scored distance, so state it before the figure it explains.
  const altBonus = entry.stopped_altitude_bonus ?? result.stopInfo?.altitudeBonus ?? 0;
  if (altBonus > 0 && result.stopInfo) {
    items.push({
      id: 'stopped-altitude-bonus',
      text: `Still flying when the task was stopped — an altitude bonus of ${km(altBonus)} is included in the scored distance: height above goal glides out at a fixed ${result.stopInfo.glideRatio}:1 ratio (FAI S7F §12.3.6).`,
      // Print the arithmetic only when it reconciles — the bonus is clamped
      // at goal distance, and a clamped figure would contradict the equation.
      detail: result.stopInfo.bestPointAltitude !== undefined &&
        Math.abs(
          result.stopInfo.glideRatio *
            Math.max(0, result.stopInfo.bestPointAltitude - result.stopInfo.goalAltitude) -
            altBonus,
        ) < 0.5
        ? `${Math.round(result.stopInfo.bestPointAltitude)} m GNSS at the scored point vs a ${Math.round(result.stopInfo.goalAltitude)} m goal → ${result.stopInfo.glideRatio} × ${Math.round(Math.max(0, result.stopInfo.bestPointAltitude - result.stopInfo.goalAltitude))} m = ${km(altBonus)}.`
        : 'The bonus is capped at the remaining distance to goal.',
    });
  }

  // The scale everything else in this section is a fraction of. Without it a
  // goal pilot has to infer the task length from their own scored distance,
  // and a landed-out pilot is told they were "12.3 km short" of nothing.
  if (classContext.validity_inputs && classContext.validity_inputs.task_distance > 0) {
    items.push({
      id: 'task-distance',
      text: 'Task distance',
      value: km(classContext.validity_inputs.task_distance),
      detail: 'The optimized task line — the shortest legal way round the turnpoints.',
      emphasis: 'muted',
    });
  }
  items.push({
    id: 'scored-distance',
    text: 'Scored distance',
    value: km(entry.flown_distance),
    detail: 'Measured along the optimized task line, up to the furthest point on course.',
  });
  items.push({
    id: 'best-distance',
    text: 'Best distance in class',
    value: km(best),
    emphasis: 'muted',
  });

  if (entry.made_goal) {
    items.push({
      id: 'distance-formula',
      text: 'Made goal — full available distance points.',
      value: pts(entry.distance_points),
    });
  } else if (useDifficulty) {
    // The engine computed linear = 0.5 × (flown ÷ best) × available at full
    // precision; print the km figures precisely enough that the equation
    // visibly multiplies out (4 decimals nearly always suffices).
    const { availStr, decimals, reconciles } = reconcileWithAvailable(
      ap.distance, 1, 5, entry.distance_linear_points,
      (d, avail) => 0.5 * (kmNum(entry.flown_distance, d) / kmNum(best, d)) * avail,
    );
    items.push({
      id: 'distance-linear',
      text: 'Linear half — half the available points scale with your share of the best distance',
      value: pts(entry.distance_linear_points),
      detail: `0.5 × (${kmEq(entry.flown_distance, decimals)} ÷ ${kmEq(best, decimals)}) × ${availStr} ${
        reconciles
          ? `= ${fmtPoints(entry.distance_linear_points)}`
          : `≈ ${fmtPoints(entry.distance_linear_points)} — the figures are shown rounded; the points come from their full precision.`
      }`,
    });
    items.push({
      id: 'distance-difficulty',
      text: 'Difficulty half — rewards flying past stretches where many pilots landed',
      value: pts(entry.distance_difficulty_points),
      detail:
        'The difficulty curve is built from where the whole field landed out (FAI S7F §11.1.1).',
    });
  } else {
    const { availStr, decimals, reconciles } = reconcileWithAvailable(
      ap.distance, 1, 5, entry.distance_points,
      (d, avail) => (kmNum(entry.flown_distance, d) / kmNum(best, d)) * avail,
    );
    items.push({
      id: 'distance-formula',
      text: 'Distance points scale linearly with your share of the best distance',
      value: pts(entry.distance_points),
      detail: `(${kmEq(entry.flown_distance, decimals)} ÷ ${kmEq(best, decimals)}) × ${availStr} available ${
        reconciles
          ? `= ${fmtPoints(entry.distance_points)}`
          : `≈ ${fmtPoints(entry.distance_points)} — the figures are shown rounded; the points come from their full precision.`
      }`,
    });
  }

  // Where this pilot placed on the section's own input. A goal day is
  // degenerate — every goal pilot ties at full distance — so say that rather
  // than a meaningless "equal 1st of 30".
  const scoredPilots = classContext.pilots.filter((p) => !p.track_excluded);
  const goalCount = scoredPilots.filter((p) => p.made_goal).length;
  let rank: string | undefined;
  if (entry.made_goal) {
    rank =
      goalCount > 1
        ? `Full distance — one of ${goalCount} pilots in goal`
        : 'Full distance — the only pilot in goal';
  } else if (scoredPilots.length >= 2) {
    rank = rankLabel(
      rankAmong(
        scoredPilots.map((p) => p.flown_distance),
        entry.flown_distance,
        (a, b) => a > b,
      ),
      'furthest',
    );
  }

  return {
    id: 'distance',
    title: 'Distance points',
    points: entry.distance_points,
    ...(ap.distance > 0 ? { pointsAvailable: ap.distance } : {}),
    ...(rank ? { rank } : {}),
    docHref: useDifficulty
      ? '/scoring/gap#distance-difficulty'
      : '/scoring/gap#distance-points',
    items,
  };
}
