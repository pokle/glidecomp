/**
 * Time points, with the arithmetic that produced them: the speed fraction
 * against the class best time (FAI S7F §12.2), the §13.2 ESS-but-not-goal
 * reduction, and the §13.4.5 stopped-task deduction, each folded into the
 * printed equation so it reconciles with the published points.
 */

import type { GAPParameters } from '../gap-scoring';
import {
  bestTimeFrom,
  calculateSpeedFraction,
  effectiveEssNotGoalFactor,
  qualifyingSpeedSectionTimes,
} from '../gap-scoring';
import type { TurnpointSequenceResult } from '../turnpoint-sequence';
import type {
  ScoreExplanationItem,
  ScoreExplanationSection,
  ScoreEntryInput,
  ClassContextInput,
} from '../score-explanation-types';
import {
  pts,
  fmtPoints,
  duration,
  eqResult,
  reconcileWithAvailable,
  trimZeros,
} from '../score-explanation-format';
import {
  bestTimeCandidate,
  noEssPointsZeroed,
  stoppedTimePointsZeroed,
} from './shared';
import { rankAmong, rankLabel } from './rank';

export function buildTimeSection(
  entry: ScoreEntryInput,
  classContext: ClassContextInput,
  params: GAPParameters,
  result: TurnpointSequenceResult,
  fmt: (d: Date) => string,
): ScoreExplanationSection {
  const ap = classContext.available_points;
  const items: ScoreExplanationItem[] = [];

  // PG requires goal (the spec fixes its ESS-but-not-goal factor at 0); HG
  // requires ESS, and a pilot who lands before goal keeps only the
  // essNotGoalFactor share (§13.2).
  const essNotGoalFactor = effectiveEssNotGoalFactor(params);
  const qualifies =
    params.scoring === 'PG'
      ? entry.made_goal
      : entry.reached_ess && (entry.made_goal || essNotGoalFactor > 0);
  // §13.2 reduction applies: the pilot earns time points, docked below.
  const essReduction =
    params.scoring === 'HG' &&
    entry.reached_ess &&
    !entry.made_goal &&
    essNotGoalFactor > 0;

  // Best time (§9.4.1) — the scorer's own functions over the published class
  // field; only the field names have to be translated.
  const candidates = classContext.pilots.map(bestTimeCandidate);
  const bestTimes = qualifyingSpeedSectionTimes(candidates, params.scoring);
  const bestTime = bestTimeFrom(candidates, params.scoring);
  let rank: string | undefined;

  // FAI S7F §11 (HG): nobody in the class reached ESS, so there were no time
  // points to win — a fact about the whole task, not about this pilot, and the
  // reason the section header shows nothing available.
  const noEssAtAll = noEssPointsZeroed(classContext, params);
  // FAI S7F §13.4.5: the task was stopped with nobody in goal, so it offered
  // no time points — even to the pilots who reached ESS, who would otherwise
  // get a formula multiplying their speed fraction by zero with no reason.
  const stoppedNoGoal = !noEssAtAll && stoppedTimePointsZeroed(classContext);

  if (stoppedNoGoal) {
    items.push({
      id: 'no-time-points',
      text: `The task was stopped with nobody in goal, so it offered no time points to anyone (FAI S7F §13.4.5). ${winnableComponents(ap)} were all that could be won.`,
      emphasis: 'warning',
    });
  } else if (!qualifies || entry.speed_section_time === null || bestTime === null) {
    items.push({
      id: 'no-time-points',
      text: noEssAtAll
        ? 'Nobody in this class reached the end of the speed section, so the task offered no time points to anyone (FAI S7F §11). Distance and leading points were all that could be won.'
        : params.scoring === 'PG'
          ? 'Time points are only awarded to pilots who complete the task.'
          : entry.reached_ess && !entry.made_goal && essNotGoalFactor === 0
            ? 'Reached the end of the speed section but not goal — this competition scores that at 0% of time and arrival points (FAI S7F §13.2).'
            : 'Time points are only awarded to pilots who reach the end of the speed section.',
      emphasis: noEssAtAll ? 'warning' : 'muted',
    });
  } else {
    const sf = calculateSpeedFraction(entry.speed_section_time, bestTime);
    items.push({
      id: 'your-time',
      text: 'Your speed section time',
      value: duration(entry.speed_section_time),
      // In a gated race the clock ran from the gate, not the crossing —
      // spell it out so the time never looks wrong next to the tracklog.
      detail: result.startGate
        ? `Timed from your ${fmt(result.startGate.time)} start gate to the end of the speed section (FAI S7F §9.4)${
            result.sssReaching &&
            result.sssReaching.time.getTime() !== result.startGate.time.getTime()
              ? ` — you crossed the start at ${fmt(result.sssReaching.time)}`
              : ''
          }.`
        : undefined,
    });
    // The header's rank, and the gap behind the fastest pilot: the two
    // facts a reader otherwise has to derive by subtracting the rows above.
    if (bestTimes.length >= 2) {
      rank = `${rankLabel(
        rankAmong(bestTimes, entry.speed_section_time, (a, b) => a < b),
        'fastest',
      )} through the speed section`;
    }
    const behind = entry.speed_section_time - bestTime;
    const fastestPilot =
      behind > 0
        ? classContext.pilots.find(
            (p) =>
              (params.scoring === 'HG' ? p.reached_ess : p.made_goal) &&
              p.speed_section_time === bestTime &&
              p.pilot_name,
          )
        : undefined;
    items.push({
      id: 'best-time',
      // §9.4.1 pins the qualifying set per discipline: HG counts every ESS
      // pilot, PG only pilots who made goal.
      text:
        params.scoring === 'HG'
          ? 'Fastest time in class'
          : 'Fastest time in class (among pilots who made goal)',
      value: duration(bestTime),
      detail:
        behind > 0
          ? `${
              fastestPilot?.pilot_name
                ? `Set by ${fastestPilot.pilot_name} — you`
                : 'You'
            } were ${duration(behind)} behind.`
          : undefined,
      emphasis: 'muted',
    });
    // §13.2 reduction, stated before the formula so its ×factor is explained.
    if (essReduction) {
      items.push({
        id: 'ess-not-goal',
        text: `Reached the end of the speed section but landed before goal — reaching goal "validates" the speed section, so only ${trimZeros((essNotGoalFactor * 100).toFixed(1), 0)}% of time and arrival points are kept (FAI S7F §13.2).`,
        emphasis: 'warning',
      });
    }
    // Stopped tasks (S7F §13.4.5): every goal pilot's time points are docked
    // by a fixed amount — the points a pilot reaching ESS exactly at the end
    // of the scored window would get. Stated before the formula, and folded
    // into the printed equations so they reconcile with the published points.
    const stopReduction =
      entry.made_goal && classContext.stopped
        ? classContext.stopped.time_points_reduction
        : 0;
    if (stopReduction > 0) {
      items.push({
        id: 'stopped-time-reduction',
        text: `The task was stopped: every goal pilot's time points are reduced by ${fmtPoints(stopReduction)} — the time points the best pilot caught between the end of the speed section and goal at the stop would have received — so finishing just before the stop scores no better than being stopped just after ESS. The same amount is added to the day's distance points (FAI S7F §13.4.5).`,
        emphasis: 'warning',
      });
    }
    // Elevated Goal (S7F 2026 §13.1): a goal pilot's time points carry the
    // GoalAltitudeFactor of their crossing altitude — stated with its inputs
    // and its arithmetic, then folded into the equations below.
    const elevated = entry.made_goal ? result.elevatedGoal : undefined;
    const gaf = entry.goal_altitude_factor ?? 1;
    const egItem = elevated ? elevatedGoalItem(elevated, gaf) : null;
    if (egItem) items.push(egItem);
    const gafEq = gaf < 1
      ? ` × ${trimZeros(gaf.toFixed(4), 2)} (elevated goal, §13.1)`
      : '';
    // The ×factor the engine applied (1 when no reduction) — folded into the
    // printed equations so they reconcile with the published points.
    const factor = essReduction ? essNotGoalFactor : 1;
    const factorEq = essReduction
      ? ` × ${trimZeros(essNotGoalFactor.toFixed(2), 1)} (ESS but not goal, §13.2)`
      : '';
    const stopEq = stopReduction > 0
      ? ` − ${fmtPoints(stopReduction)} (task stopped, §13.4.5)`
      : '';
    if (entry.speed_section_time <= bestTime) {
      const { availStr, reconciles } = reconcileWithAvailable(
        ap.time, 0, 0, entry.time_points,
        (_d, avail) => Math.max(0, avail * factor - stopReduction) * gaf,
      );
      items.push({
        id: 'time-formula',
        text: essReduction
          ? 'Fastest through the speed section — full available time points, before the goal-validation reduction'
          : stopReduction > 0
            ? 'Fastest through the speed section — full available time points, before the stopped-task reduction'
            : gaf < 1
              ? 'Fastest through the speed section — full available time points, before the elevated-goal reduction'
              : 'Fastest through the speed section — full available time points.',
        value: pts(entry.time_points),
        detail: essReduction || stopReduction > 0 || gaf < 1
          ? `${withGoalAltitude(`${availStr} available${factorEq}${stopEq}`, stopEq, gafEq)} ${reconciles ? '=' : '≈'} ${fmtPoints(entry.time_points)}`
          : undefined,
      });
    } else {
      // time points = speed fraction × available (× the §13.2 factor, − the
      // §13.4.5 stopped reduction), exactly — print the fraction with enough
      // decimals that the multiplication visibly holds at the 0.1-pt step.
      const { availStr, decimals, reconciles } = reconcileWithAvailable(
        ap.time, 3, 6, entry.time_points,
        (d, avail) => Math.max(0, Number(sf.toFixed(d)) * avail * factor - stopReduction) * gaf,
      );
      items.push({
        id: 'time-formula',
        text: 'Time points fall off with the gap to the fastest time',
        value: pts(entry.time_points),
        detail: `speed fraction = max(0, 1 − ((T − Tbest) ÷ √Tbest)^5⁄6) = ${trimZeros(sf.toFixed(decimals), 3)}; ${withGoalAltitude(`× ${availStr} available${factorEq}${stopEq}`, stopEq, gafEq)} ${eqResult(reconciles, entry.time_points)} (times in hours)`,
      });
    }
  }

  return {
    id: 'time',
    title: 'Time points',
    points: entry.time_points,
    ...(ap.time > 0 ? { pointsAvailable: ap.time } : {}),
    ...(rank ? { rank } : {}),
    docHref: '/scoring/gap#time-points',
    items,
  };
}

/** "Distance, leading and arrival points" — the components a day still offered. */
function winnableComponents(ap: ClassContextInput['available_points']): string {
  const names = [
    'distance',
    ...(ap.leading > 0 ? ['leading'] : []),
    ...(ap.arrival > 0 ? ['arrival'] : []),
  ];
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${list.charAt(0).toUpperCase()}${list.slice(1)} points`;
}

/**
 * Append the §13.1 factor to a printed equation. It applies after the
 * §13.4.5 subtraction, so with one present the rest is bracketed first.
 */
function withGoalAltitude(eq: string, stopEq: string, gafEq: string): string {
  if (!gafEq) return eq;
  return stopEq ? `(${eq.trim()})${gafEq}` : `${eq}${gafEq}`;
}

/** Whole metres with a thousands separator: "1,240 m". */
function metres(m: number): string {
  return `${Math.round(m).toLocaleString('en-AU')} m`;
}

/**
 * The Elevated Goal row (S7F 2026 §13.1): where the pilot crossed goal
 * against the goal's elevation, and — below it — the GoalAltitudeFactor
 * with its substituted arithmetic.
 */
function elevatedGoalItem(
  eg: NonNullable<TurnpointSequenceResult['elevatedGoal']>,
  publishedFactor: number,
): ScoreExplanationItem | null {
  if (eg.crossingAltitude === undefined) return null;
  const top = eg.goalAltitude + eg.elevation;
  const above = eg.crossingAltitude - eg.goalAltitude;
  const where =
    `You crossed the elevated goal at ${metres(eg.crossingAltitude)}; it is set ` +
    `${metres(eg.elevation)} above the ${metres(eg.goalAltitude)} goal, at ${metres(top)}`;
  if (publishedFactor >= 1) {
    return {
      id: 'elevated-goal',
      text: `${where}. Crossing at or above it keeps full time points (FAI S7F §13.1).`,
      emphasis: 'muted',
    };
  }
  const f = trimZeros(publishedFactor.toFixed(4), 2);
  if (above <= 0) {
    return {
      id: 'elevated-goal',
      text: `${where}. At or below the goal's own altitude, only ${f} of time points are kept (FAI S7F §13.1).`,
      emphasis: 'warning',
    };
  }
  const ar = above / eg.elevation;
  const arS = trimZeros(ar.toFixed(4), 2);
  return {
    id: 'elevated-goal',
    text: `${where}. Crossing below it keeps only part of your time points (FAI S7F §13.1).`,
    detail:
      `AR = ${metres(above)} above goal ÷ ${metres(eg.elevation)} = ${arS}; ` +
      `factor = 0.8 + 0.6·AR − 0.6·AR² + 0.2·AR³ = ${f}`,
    emphasis: 'warning',
  };
}
