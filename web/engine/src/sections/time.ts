/**
 * Time points, with the arithmetic that produced them: the speed fraction
 * against the class best time (FAI S7F §11.2), the §12.1 ESS-but-not-goal
 * reduction, and the §12.3.5 stopped-task deduction, each folded into the
 * printed equation so it reconciles with the published points.
 */

import type { GAPParameters } from '../gap-scoring';
import {
  bestTimeFrom,
  calculateSpeedFraction,
  effectiveEssNotGoalFactor,
  qualifyingSpeedSectionTimes,
  resolveTimePointsExponent,
  speedExponentValue,
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
  reconcileWithAvailable,
  trimZeros,
} from '../score-explanation-format';
import { bestTimeCandidate } from './shared';
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
  // essNotGoalFactor share (§12.1).
  const essNotGoalFactor = effectiveEssNotGoalFactor(params);
  const qualifies =
    params.scoring === 'PG'
      ? entry.made_goal
      : entry.reached_ess && (entry.made_goal || essNotGoalFactor > 0);
  // §12.1 reduction applies: the pilot earns time points, docked below.
  const essReduction =
    params.scoring === 'HG' &&
    entry.reached_ess &&
    !entry.made_goal &&
    essNotGoalFactor > 0;

  // Best time (§11.2.1) — the scorer's own functions over the published class
  // field; only the field names have to be translated.
  const candidates = classContext.pilots.map(bestTimeCandidate);
  const bestTimes = qualifyingSpeedSectionTimes(candidates, essNotGoalFactor);
  const bestTime = bestTimeFrom(candidates, essNotGoalFactor);
  let rank: string | undefined;

  if (!qualifies || entry.speed_section_time === null || bestTime === null) {
    items.push({
      id: 'no-time-points',
      text:
        params.scoring === 'PG'
          ? 'Time points are only awarded to pilots who complete the task.'
          : entry.reached_ess && !entry.made_goal && essNotGoalFactor === 0
            ? 'Reached the end of the speed section but not goal — this competition scores that at 0% of time and arrival points (FAI S7F §12.1).'
            : 'Time points are only awarded to pilots who reach the end of the speed section.',
      emphasis: 'muted',
    });
  } else {
    // Time-points exponent (S7F §11.2) actually used for this comp, decoupled
    // from the leading-coefficient variant (issue #258).
    const exp = resolveTimePointsExponent(params);
    const exponentLabel = exp === '2/3' ? '2⁄3' : '5⁄6';
    const exponentName =
      exp === '2/3' ? 'the older GAP2016/2018 curve' : 'the current FAI S7F';
    const sf = calculateSpeedFraction(
      entry.speed_section_time,
      bestTime,
      speedExponentValue(exp),
    );
    items.push({
      id: 'time-exponent',
      text: `Time points use the ${exponentLabel} speed-fraction exponent (${exponentName}, S7F §11.2).`,
      emphasis: 'muted',
    });
    items.push({
      id: 'your-time',
      text: 'Your speed section time',
      value: duration(entry.speed_section_time),
      // In a gated race the clock ran from the gate, not the crossing —
      // spell it out so the time never looks wrong next to the tracklog.
      detail: result.startGate
        ? `Timed from your ${fmt(result.startGate.time)} start gate to the end of the speed section (FAI S7F §8.7)${
            result.sssReaching &&
            result.sssReaching.time.getTime() !== result.startGate.time.getTime()
              ? ` — you crossed the start at ${fmt(result.sssReaching.time)}`
              : ''
          }.`
        : undefined,
    });
    // The header's standing, and the gap behind the fastest pilot: the two
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
              (essNotGoalFactor > 0 ? p.reached_ess : p.made_goal) &&
              p.speed_section_time === bestTime &&
              p.pilot_name,
          )
        : undefined;
    items.push({
      id: 'best-time',
      text:
        essNotGoalFactor > 0
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
    // §12.1 reduction, stated before the formula so its ×factor is explained.
    if (essReduction) {
      items.push({
        id: 'ess-not-goal',
        text: `Reached the end of the speed section but landed before goal — reaching goal "validates" the speed section, so only ${trimZeros((essNotGoalFactor * 100).toFixed(1), 0)}% of time and arrival points are kept (FAI S7F §12.1).`,
        emphasis: 'warning',
      });
    }
    // Stopped tasks (S7F §12.3.5): every goal pilot's time points are docked
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
        text: `The task was stopped: every goal pilot's time points are reduced by ${fmtPoints(stopReduction)} — the points a pilot reaching the end of the speed section exactly at the task stop would get — so finishing just before the stop scores no better than being stopped just after ESS (FAI S7F §12.3.5).`,
        emphasis: 'warning',
      });
    }
    // The ×factor the engine applied (1 when no reduction) — folded into the
    // printed equations so they reconcile with the published points.
    const factor = essReduction ? essNotGoalFactor : 1;
    const factorEq = essReduction
      ? ` × ${trimZeros(essNotGoalFactor.toFixed(2), 1)} (ESS but not goal, §12.1)`
      : '';
    const stopEq = stopReduction > 0
      ? ` − ${fmtPoints(stopReduction)} (task stopped, §12.3.5)`
      : '';
    if (entry.speed_section_time <= bestTime) {
      const { availStr, reconciles } = reconcileWithAvailable(
        ap.time, 0, 0, entry.time_points,
        (_d, avail) => Math.max(0, avail * factor - stopReduction),
      );
      items.push({
        id: 'time-formula',
        text: essReduction
          ? 'Fastest through the speed section — full available time points, before the goal-validation reduction'
          : stopReduction > 0
            ? 'Fastest through the speed section — full available time points, before the stopped-task reduction'
            : 'Fastest through the speed section — full available time points.',
        value: pts(entry.time_points),
        detail: essReduction || stopReduction > 0
          ? `${availStr} available${factorEq}${stopEq} ${reconciles ? '=' : '≈'} ${fmtPoints(entry.time_points)}`
          : undefined,
      });
    } else {
      // time points = speed fraction × available (× the §12.1 factor, − the
      // §12.3.5 stopped reduction), exactly — print the fraction with enough
      // decimals that the multiplication visibly holds at the 0.1-pt step.
      // exponentLabel is the decoupled time-points exponent (issue #258).
      const { availStr, decimals, reconciles } = reconcileWithAvailable(
        ap.time, 3, 6, entry.time_points,
        (d, avail) => Math.max(0, Number(sf.toFixed(d)) * avail * factor - stopReduction),
      );
      items.push({
        id: 'time-formula',
        text: 'Time points fall off with the gap to the fastest time',
        value: pts(entry.time_points),
        detail: `speed fraction = max(0, 1 − ((T − Tbest) ÷ √Tbest)^${exponentLabel}) = ${trimZeros(sf.toFixed(decimals), 3)}; × ${availStr} available${factorEq}${stopEq} ${
          reconciles
            ? `= ${fmtPoints(entry.time_points)}`
            : `≈ ${fmtPoints(entry.time_points)} — the figures are shown rounded; the points come from their full precision`
        } (times in hours)`,
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
