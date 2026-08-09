/**
 * Day quality — the validity factors and the points they put on offer.
 *
 * Each factor row states its rule, names its inputs and prints the
 * substituted arithmetic; the numbers come from the published
 * `validity_inputs`, and every detail degrades to the bare percentage when a
 * cached payload predates them.
 */

import type { GAPParameters } from '../gap-scoring';
import { NOMINAL_LAUNCH, NOMINAL_GOAL } from '../gap-scoring';
import type {
  ScoreExplanationItem,
  ScoreExplanationSection,
  ClassContextInput,
} from '../score-explanation-types';
import {
  km,
  pts,
  fmtPoints,
  duration,
  validityFactorDecimals,
  trimZeros,
  pctValidity,
  pctWeight,
  availableTotalDetail,
} from '../score-explanation-format';
import { leadingWeightDetail, noEssPointsZeroed } from './shared';

/**
 * The inputs behind each validity factor, as a detail sentence.
 *
 * Every other section on the page states a rule, names its inputs, and prints
 * the arithmetic; before these existed the validity section stated a rule and
 * asserted a percentage, which is the one thing a reader cannot check. The
 * numbers come from the published `validity_inputs`; when a payload predates
 * them (the stale-first store still serves those) each returns undefined and
 * the row falls back to the bare percentage it always showed.
 *
 * The ratio is printed, not the cubic: the S7F curves have no intuition to
 * offer in coefficient form, and the ratio — "the winner got round in 71% of
 * the nominal time" — is the fact the reader can act on. The curve itself is
 * one click away on /scoring/gap.
 */
function launchValidityDetail(
  vi: ClassContextInput['validity_inputs'],
  params: GAPParameters | undefined,
): string | undefined {
  if (!vi || !params) return undefined;
  // Whole pilots: the threshold is fractional (96% of 32 is 30.72) and
  // "30.7 pilots" reads like a unit error. Ceil, because 30 would not clear it.
  const target = Math.ceil(vi.num_present * NOMINAL_LAUNCH);
  const pilots = (n: number) => `${n} pilot${n === 1 ? '' : 's'}`;
  return (
    `${pilots(vi.num_flying)} flew out of ${vi.num_present} present. ` +
    `Nominal launch is ${trimZeros((NOMINAL_LAUNCH * 100).toFixed(1), 0)}%, ` +
    `so launch validity is full once ${pilots(target)} are in the air.`
  );
}

function distanceValidityDetail(
  vi: ClassContextInput['validity_inputs'],
  params: GAPParameters | undefined,
): string | undefined {
  if (!vi || !params) return undefined;
  return (
    `Measured against a ${km(params.nominalDistance)} nominal distance, ` +
    `a ${trimZeros((NOMINAL_GOAL * 100).toFixed(1), 0)}% nominal goal ` +
    `and a ${km(params.minimumDistance)} minimum distance. ` +
    `The field flew ${km(vi.mean_distance_over_minimum)} past the minimum on average, ` +
    `with a best of ${km(vi.best_distance)}.`
  );
}

function timeValidityDetail(
  vi: ClassContextInput['validity_inputs'],
  params: GAPParameters | undefined,
): string | undefined {
  if (!vi || !params) return undefined;
  // No best time means nobody completed the speed section, and the spec falls
  // back to the distance ratio — a different comparison, so it must not be
  // described as a time one.
  if (vi.best_time === null || vi.best_time <= 0) {
    return (
      `Nobody completed the speed section, so the spec compares distance instead: ` +
      `the best distance of ${km(vi.best_distance)} against the ` +
      `${km(params.nominalDistance)} nominal distance.`
    );
  }
  const ratio = vi.best_time / params.nominalTime;
  const against =
    `The fastest pilot took ${duration(vi.best_time)} against a nominal task time of ` +
    `${duration(params.nominalTime)}`;
  // The spec's ratio is min(1, best ÷ nominal), so a winning time at or over
  // nominal is simply a full day. Printing the clamped "100% of nominal" beside
  // a time visibly LONGER than nominal reads as an arithmetic error.
  return ratio >= 1
    ? `${against} — the task took as long as it was meant to, so no time devaluation applies.`
    : `${against} — ${trimZeros((ratio * 100).toFixed(1), 0)}% of nominal.`;
}

/** "12 of 41 pilots made goal → goal ratio 0.29", the input to the weights. */
function goalRatioPhrase(vi: NonNullable<ClassContextInput['validity_inputs']>): string {
  return (
    `${vi.num_in_goal} of ${vi.num_flying} pilot${vi.num_flying === 1 ? '' : 's'} made goal ` +
    `— a goal ratio of ${trimZeros(vi.goal_ratio.toFixed(2), 2)}`
  );
}

export function buildValiditySection(
  classContext: ClassContextInput,
  params?: GAPParameters,
): ScoreExplanationSection {
  const v = classContext.task_validity;
  const ap = classContext.available_points;
  const vi = classContext.validity_inputs;
  // One precision for the whole section, so the three factor rows, the task
  // validity in the summary and the equation all visibly agree.
  const decimals = validityFactorDecimals(v, ap.total);
  const items: ScoreExplanationItem[] = [
    {
      id: 'launch-validity',
      text: 'Launch validity — the day counts for less if much of the field never got into the air.',
      value: pctValidity(v.launch, decimals),
      detail: launchValidityDetail(vi, params),
    },
    {
      id: 'distance-validity',
      text: 'Distance validity — the day counts for less if the field as a whole did not get far.',
      value: pctValidity(v.distance, decimals),
      detail: distanceValidityDetail(vi, params),
    },
    {
      // Deliberately not "was the winning time long enough": pilots read that
      // as a long winning time being the problem. The rule is that a day
      // nobody could stretch out was not a full day's task.
      id: 'time-validity',
      text: 'Time validity — the day counts for less if the fastest pilot got round much quicker than the task was meant to take.',
      value: pctValidity(v.time, decimals),
      detail: timeValidityDetail(vi, params),
    },
    // Stopped tasks (S7F §12.3.3): the fourth validity factor.
    ...(v.stopped !== undefined
      ? [{
          id: 'stopped-validity',
          text:
            classContext.stopped && !classContext.stopped.requirement_met
              ? 'Stopped-task validity — the task was stopped before running the minimum time (min(1 h, half the nominal time) after the start), so it cannot be scored (FAI S7F §12.3.2).'
              : 'Stopped-task validity — the task was stopped; when nobody has reached the end of the speed section, the day is devalued by how settled the field already was (FAI S7F §12.3.3).',
          value: pctValidity(v.stopped, decimals),
          emphasis: (v.stopped < 1 ? 'warning' : 'muted') as 'warning' | 'muted',
        }]
      : []),
    {
      id: 'available-total',
      text: 'Points on offer for the day',
      value: pts(ap.total),
      detail: availableTotalDetail(v, ap.total, decimals),
    },
    // FAI S7F §10, HG: nobody reached ESS, so time and arrival points were
    // never on offer. Stated here, where the day's points are decided, because
    // it caps what ANY pilot could have scored — the time section below can
    // only speak for the pilot whose card this is.
    ...(params && noEssPointsZeroed(classContext, params)
      ? [{
          id: 'no-ess-available',
          text: 'Nobody reached the end of the speed section, so this task offered no time or arrival points at all (FAI S7F §10).',
          // The bare figure, so it sits under the day's total in the same
          // column rather than overflowing it with a phrase.
          value: pts(ap.distance + ap.leading),
          detail:
            `Only distance and leading points could be won: ` +
            `${fmtPoints(ap.distance)} + ${fmtPoints(ap.leading)} = ` +
            `${fmtPoints(ap.distance + ap.leading)} of the ${fmtPoints(ap.total)} the day was worth. ` +
            `The rest is not shared out to the other components — the specification leaves it unawarded.`,
          emphasis: 'warning' as const,
        }]
      : []),
    {
      id: 'available-split',
      // How many pilots got there decides the split, so say so — "the goal
      // ratio" alone names a term the reader has met nowhere else and gives
      // them no value to attach to it.
      text: vi
        ? `Split between the components: ${goalRatioPhrase(vi)}`
        : 'Split between the components by the goal ratio',
      // 0.1 precision like the total above, so the split visibly sums to it
      // ("distance 855.9 · time 143.4" for a 999.3 day, not "856 · 144").
      detail: [
        `distance ${fmtPoints(ap.distance)}`,
        `time ${fmtPoints(ap.time)}`,
        ...(ap.leading > 0 ? [`leading ${fmtPoints(ap.leading)}`] : []),
        ...(ap.arrival > 0 ? [`arrival ${fmtPoints(ap.arrival)}`] : []),
      ].join(' · '),
      emphasis: 'muted',
    },
    // The weights are the actual mechanism, and they explain why two pilots
    // with the same distance and different times separate the way they do.
    ...(vi
      ? [{
          id: 'available-weights',
          text: 'The share each component takes of the day',
          detail: [
            `distance ${pctWeight(vi.weights.distance)}`,
            `time ${pctWeight(vi.weights.time)}`,
            ...(vi.weights.leading > 0 ? [`leading ${pctWeight(vi.weights.leading)}`] : []),
            ...(vi.weights.arrival > 0 ? [`arrival ${pctWeight(vi.weights.arrival)}`] : []),
          ].join(' · '),
          emphasis: 'muted' as const,
        }]
      : []),
    // The PG leading-weight generation belongs HERE, where the weights are
    // decided, not down in the leading section where it used to sit.
    ...(params && leadingWeightDetail(params)
      ? [{
          id: 'weight-formula',
          text: leadingWeightDetail(params)!,
          emphasis: 'muted' as const,
        }]
      : []),
  ];
  return {
    id: 'validity',
    title: 'Day quality — points on offer',
    summary: `Task validity ${pctValidity(v.task, decimals)} of a perfect day, so ${fmtPoints(ap.total)} of 1000 points were available.`,
    docHref: '/scoring/gap#task-validity',
    items,
  };
}
