/**
 * Per-component score charts: the scoring function, with the field on it.
 *
 * The report card explains each component by printing its formula with this
 * pilot's numbers substituted. That answers "how was my score computed" but
 * not "how bad is twenty minutes" — the shape of the falloff, and where the
 * field sits along it, are things prose cannot carry. These builders supply
 * them as data (the UI draws).
 *
 * Three rules make these different from the task-analysis charts, and they
 * are the whole design:
 *
 *  1. **The curve is the formula, not a fit.** Every sample comes from the
 *     scorer's own function (calculateSpeedFraction, calculateLeadingPoints,
 *     calculateArrivalPoints, calculateDistanceDifficulty) — never a
 *     regression through the dots. The
 *     task-analysis scatter draws a LOESS trend and withholds it below a
 *     noise floor because there a curve is a claim about data; here it is the
 *     definition, so it is always drawn and never gated.
 *
 *  2. **A dot is plotted only if the curve provably explains it.** Each
 *     pilot's published points are checked against the function at their x
 *     ({@link EXPLAINED_TOLERANCE}); anyone who fails — an ESS-but-not-goal
 *     pilot carrying the §13.2 reduction, a goal pilot docked by a stopped
 *     task (§13.4.5) — is counted and left off. Without this the caption's
 *     "every dot sits exactly on it" would be false precisely for the pilots
 *     with the most surprising scores. Checking rather than special-casing
 *     also means a future reduction we have not thought of degrades to an
 *     honest omission instead of a wrong picture.
 *
 *  3. **These are emphasis charts, not field charts.** One pilot is the
 *     subject; the rest are context. If the viewing pilot is one of the
 *     omitted, the chart is suppressed entirely rather than shown without
 *     them — a chart whose whole job is to locate you is worse than no chart
 *     when it cannot.
 */

import type { GAPParameters } from './gap-scoring';
import {
  bestTimeFrom,
  calculateArrivalPoints,
  calculateDistanceDifficulty,
  calculateLaunchValidity,
  calculateLeadingPoints,
  calculateSpeedFraction,
  calculateTimeValidity,
  NOMINAL_LAUNCH,
  usesDistanceDifficulty,
} from './gap-scoring';
import { duration, fmtPoints, km, trimZeros } from './score-explanation-format';
import { bestTimeCandidate, pilotsAtEss, scoredPilots } from './sections/shared';
import type {
  ClassContextInput,
  ClassPilotInput,
  ScoreChart,
  ScoreChartPilot,
  ScoreChartPoint,
  ScoreDistributionMarker,
  ScoreDistributionPoint,
  ScoreEntryInput,
} from './score-explanation-types';

/**
 * How far a published point value may sit from the function before we stop
 * claiming the function explains it.
 *
 * Points are published rounded to 0.1 (S7F §12), so an exact match can be a
 * full 0.05 away, and the components are summed and re-rounded downstream.
 * 0.15 absorbs that without being loose enough to swallow a real reduction —
 * the smallest of those (§12.1 at 0.8 of a component) moves points by whole
 * numbers, not tenths.
 */
const EXPLAINED_TOLERANCE = 0.15;

/** Samples along a drawn curve. Enough that the eye reads a smooth line at
 *  full-screen width; small enough to stay cheap in an SSR payload. */
const CURVE_SAMPLES = 64;

/** Sample `f` at `count` evenly spaced points across [x0, x1]. */
function sampleCurve(
  x0: number,
  x1: number,
  count: number,
  f: (x: number) => number,
): ScoreChartPoint[] {
  if (!(x1 > x0)) return [{ x: x0, y: f(x0) }];
  const out: ScoreChartPoint[] = [];
  for (let i = 0; i < count; i++) {
    const x = x0 + ((x1 - x0) * i) / (count - 1);
    out.push({ x, y: f(x) });
  }
  return out;
}

/** A pilot's identity for the chart. Falls back to the name when the payload
 *  predates comp_pilot_id, and to the index so keys stay unique regardless. */
function pilotKey(p: ClassPilotInput, index: number): string {
  return p.comp_pilot_id ?? `${index}-${p.pilot_name ?? ''}`;
}

/** Is this row the pilot whose card this is? Only ever true on an id match —
 *  a payload without ids never guesses on a name. */
function isYou(entry: ScoreEntryInput, p: ClassPilotInput): boolean {
  return entry.comp_pilot_id !== undefined && p.comp_pilot_id === entry.comp_pilot_id;
}

/**
 * Place the field on `f`, keeping only pilots it explains.
 *
 * `xOf` returns null for a pilot the component does not apply to at all (no
 * speed-section time, no leading coefficient) — those are not "omitted", they
 * were never candidates, so they do not inflate the caption's count.
 */
function placeField(
  classContext: ClassContextInput,
  entry: ScoreEntryInput,
  xOf: (p: ClassPilotInput) => number | null,
  yOf: (p: ClassPilotInput) => number | undefined,
  f: (x: number) => number,
): { pilots: ScoreChartPilot[]; omitted: number; youPlotted: boolean } | null {
  const pilots: ScoreChartPilot[] = [];
  let omitted = 0;
  let youPlotted = false;
  classContext.pilots.forEach((p, i) => {
    if (p.track_excluded) return;
    const x = xOf(p);
    const y = yOf(p);
    if (x === null || !Number.isFinite(x) || y === undefined) return;
    if (Math.abs(f(x) - y) > EXPLAINED_TOLERANCE) {
      omitted++;
      return;
    }
    const you = isYou(entry, p);
    if (you) youPlotted = true;
    pilots.push({ key: pilotKey(p, i), name: p.pilot_name ?? 'Pilot', x, y, you });
  });
  // Two dots is not a distribution, and one of them is you.
  if (pilots.length < 3 || !youPlotted) return null;
  return { pilots, omitted, youPlotted };
}

/** "…and 3 pilots are not plotted: the curve does not explain their points." */
function omittedSentence(omitted: number): string {
  if (omitted === 0) return '';
  return ` ${omitted} pilot${omitted === 1 ? ' is' : 's are'} not shown — their points carry a reduction this curve does not include.`;
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/**
 * Time points against speed-section time.
 *
 * The flagship chart: the report card can tell a pilot that twenty minutes
 * cost them 195 points, but only the curve shows that the first two minutes
 * cost far more than the last two, and only the dots show whether the field
 * was bunched or strung out behind the leader.
 */
export function buildTimeChart(
  entry: ScoreEntryInput,
  classContext: ClassContextInput,
  params: GAPParameters,
): ScoreChart | null {
  const available = classContext.available_points.time;
  if (available <= 0) return null;

  // Best time (§9.4.1) from the scorer's own function, so the curve's
  // denominator is the one the field was scored against.
  const bestTime = bestTimeFrom(
    classContext.pilots.map(bestTimeCandidate),
    params.scoring,
  );
  if (bestTime === null) return null;

  const f = (t: number) => calculateSpeedFraction(t, bestTime) * available;

  const placed = placeField(
    classContext,
    entry,
    (p) => (p.speed_section_time !== null && p.speed_section_time > 0
      ? p.speed_section_time
      : null),
    (p) => p.time_points,
    f,
  );
  if (!placed) return null;

  // Draw from the fastest time to the slowest pilot shown, with a little room
  // past them so the curve does not appear to stop at the last dot.
  const maxX = Math.max(...placed.pilots.map((p) => p.x));
  const curve = sampleCurve(bestTime, bestTime + (maxX - bestTime) * 1.08, CURVE_SAMPLES, f);

  const you = placed.pilots.find((p) => p.you)!;
  const behind = you.x - bestTime;
  return {
    kind: 'curve' as const,
    xLabel: 'Speed section time',
    xUnit: 'duration',
    curve,
    pilots: placed.pilots,
    omitted: placed.omitted,
    caption:
      `The curve is the time-points formula — every dot is a pilot, sitting exactly on it. ` +
      (behind <= 0
        ? `You set the fastest time, at the top of the curve.`
        : `You were ${duration(behind)} behind the fastest time, which cost ${fmtPoints(
            available - you.y,
          )} of the ${fmtPoints(available)} time points on offer.`) +
      omittedSentence(placed.omitted),
  };
}

// ---------------------------------------------------------------------------
// Leading
// ---------------------------------------------------------------------------

/**
 * Leading points against the leading coefficient.
 *
 * The coefficient is an area under a distance-over-time curve — a number with
 * no intuition attached, which is most of why leading is the least understood
 * component. Seeing the field spread along the falloff gives it a scale that
 * no single value can.
 */
export function buildLeadingChart(
  entry: ScoreEntryInput,
  classContext: ClassContextInput,
): ScoreChart | null {
  const available = classContext.available_points.leading;
  if (available <= 0) return null;

  const lcs = classContext.pilots
    .map((p) => p.leading_coefficient)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);
  if (lcs.length === 0) return null;
  const minLC = Math.min(...lcs);

  const f = (lc: number) => calculateLeadingPoints(lc, minLC, available);
  const placed = placeField(
    classContext,
    entry,
    (p) =>
      typeof p.leading_coefficient === 'number' && Number.isFinite(p.leading_coefficient)
        ? p.leading_coefficient
        : null,
    (p) => p.leading_points,
    f,
  );
  if (!placed) return null;

  const maxX = Math.max(...placed.pilots.map((p) => p.x));
  const curve = sampleCurve(minLC, maxX + (maxX - minLC) * 0.08, CURVE_SAMPLES, f);
  const you = placed.pilots.find((p) => p.you)!;

  return {
    kind: 'curve' as const,
    xLabel: 'Leading coefficient (lower is better)',
    xUnit: 'coefficient',
    curve,
    pilots: placed.pilots,
    omitted: placed.omitted,
    caption:
      `The curve is the leading-points formula — every dot is a pilot, sitting exactly on it. ` +
      (you.x <= minLC
        ? `You hold the best coefficient in the class, so you take all ${fmtPoints(
            available,
          )} leading points.`
        : `Your coefficient of ${trimZeros(you.x.toFixed(3), 1)} against the class best of ${trimZeros(
            minLC.toFixed(3),
            1,
          )} puts you at ${fmtPoints(you.y)} of ${fmtPoints(available)}.`) +
      omittedSentence(placed.omitted),
  };
}

// ---------------------------------------------------------------------------
// Arrival
// ---------------------------------------------------------------------------

/**
 * Arrival points against position at the end of the speed section.
 *
 * Positions are integers, but the §13.5 factor is continuous in the arrival
 * ratio and the integers merely sample it — so the curve is honest here, and
 * it carries the component's defining shape: steep at the front, flat into a
 * floor at the back.
 *
 * This chart earns its place on a fact the tables hide. The order is by the
 * CLOCK at ESS, not by speed, so the class winner can sit mid-curve while
 * slower pilots on an earlier gate sit above them. On the page that is two
 * numbers in different sections; here it is a dot visibly out of place.
 */
export function buildArrivalChart(
  entry: ScoreEntryInput,
  classContext: ClassContextInput,
): ScoreChart | null {
  const available = classContext.available_points.arrival;
  if (available <= 0) return null;
  const atEss = pilotsAtEss(classContext);
  if (atEss <= 0) return null;

  const f = (pos: number) => calculateArrivalPoints(pos, atEss, available);
  const placed = placeField(
    classContext,
    entry,
    (p) => (p.arrival_position != null && p.arrival_position > 0 ? p.arrival_position : null),
    (p) => p.arrival_points,
    f,
  );
  if (!placed) return null;

  const curve = sampleCurve(1, atEss, Math.min(CURVE_SAMPLES, Math.max(2, atEss * 4)), f);
  const you = placed.pilots.find((p) => p.you)!;
  const onePlace = you.x > 1 ? f(you.x - 1) - f(you.x) : 0;

  return {
    kind: 'curve' as const,
    xLabel: 'Arrival order at the end of the speed section',
    xUnit: 'position',
    curve,
    pilots: placed.pilots,
    omitted: placed.omitted,
    caption:
      `The curve is the arrival-points formula — every dot is a pilot, sitting exactly on it. ` +
      (you.x <= 1
        ? `You arrived first, taking all ${fmtPoints(available)} arrival points.`
        : `You arrived ${you.x} of ${atEss}, worth ${fmtPoints(you.y)} of ${fmtPoints(
            available,
          )} — one place earlier would have been ${fmtPoints(onePlace)} more.`) +
      ` The order is by the clock at the end of the speed section, not by speed.` +
      omittedSentence(placed.omitted),
  };
}

// ---------------------------------------------------------------------------
// Distance
// ---------------------------------------------------------------------------

/**
 * Distance points against scored distance.
 *
 * Two shapes, because the spec has two.
 *
 * Without difficulty (PG, or HG with it switched off) the function is a
 * straight line from nothing to the best distance flown. The line carries no
 * surprise, but the DOTS do: where the field bunched, and how far into the
 * tail this pilot sits.
 *
 * With HG distance difficulty (S7F §12.1.1) the total is a linear half plus a
 * difficulty half built from where the whole field landed out — and that is
 * the chart worth having, because the difficulty half is close to
 * unexplainable in a sentence and completely obvious as a shape. Its steep
 * sections are the stretches many pilots did not get past; flying through one
 * is worth more than the same kilometres somewhere easy, and the curve simply
 * shows you that.
 *
 * Reconstructing it needs the whole field, which is exactly what the class
 * context is: `calculateDistanceDifficulty` is handed the same scored
 * distances, goal flags and minimum distance the scorer gave it, and the
 * `fractionFor` it returns is a genuine function of distance. Excluded
 * tracklogs are filtered out, because they were never in the field the engine
 * scored — they are appended afterwards at zero.
 *
 * The reconstruction is not taken on trust. placeField checks every pilot's
 * published points against this curve, so getting it wrong cannot draw a
 * plausible-looking wrong picture: the dots stop matching and the chart
 * suppresses itself.
 */
export function buildDistanceChart(
  entry: ScoreEntryInput,
  classContext: ClassContextInput,
  params: GAPParameters,
): ScoreChart | null {
  const available = classContext.available_points.distance;
  if (available <= 0) return null;

  // The field as the scorer saw it: withheld tracklogs are seated at 0 after
  // scoring and were not part of the distribution the difficulty is built on.
  const scored = scoredPilots(classContext);
  const best = Math.max(...scored.map((p) => p.flown_distance), 0);
  if (best <= 0) return null;

  const useDifficulty = usesDistanceDifficulty(params);
  let f: (d: number) => number;
  if (useDifficulty) {
    const difficulty = calculateDistanceDifficulty(
      scored.map((p) => p.flown_distance),
      scored.map((p) => p.made_goal),
      params.minimumDistance,
    );
    f = (d: number) =>
      ((0.5 * d) / best) * available + difficulty.fractionFor(d) * available;
  } else {
    f = (d: number) => (d / best) * available;
  }

  const placed = placeField(
    classContext,
    entry,
    (p) => p.flown_distance,
    (p) => p.distance_points,
    f,
  );
  if (!placed) return null;

  // The difficulty curve is a step function over 100 m slots, so it needs real
  // samples; the plain linear case is a line and two points draw it exactly.
  const curve = useDifficulty
    ? sampleCurve(0, best, CURVE_SAMPLES * 2, f)
    : sampleCurve(0, best, 2, f);
  const you = placed.pilots.find((p) => p.you)!;

  return {
    kind: 'curve' as const,
    xLabel: 'Scored distance',
    xUnit: 'distance',
    curve,
    pilots: placed.pilots,
    omitted: placed.omitted,
    caption:
      (useDifficulty
        ? `The curve is the distance-points formula, half of it built from where the field landed out (FAI S7F §12.1.1) — every dot is a pilot, sitting exactly on it. Its steepest stretches are the ones fewest pilots got past, so flying through one is worth more than the same distance somewhere easy. `
        : `Distance points are a straight line from nothing to the best distance flown — every dot is a pilot, sitting exactly on it. `) +
      `You flew ${km(you.x)} of the class best ${km(best)}, worth ${fmtPoints(
        you.y,
      )} of ${fmtPoints(available)}.` +
      omittedSentence(placed.omitted),
  };
}

// ---------------------------------------------------------------------------
// Validity — day facts, not pilot facts
// ---------------------------------------------------------------------------

/**
 * Samples along a validity curve. Fewer than a component curve: these are
 * drawn sparkline-sized beside a table row, not at figure scale.
 */
const VALIDITY_SAMPLES = 40;

/** Sample a validity cubic over its whole [0, 1] ratio domain. */
function validityCurve(f: (ratio: number) => number): ScoreChartPoint[] {
  return sampleCurve(0, 1, VALIDITY_SAMPLES, f);
}

/**
 * Launch validity's curve, with this day's point on it.
 *
 * Reads: "the field cleared the threshold, so the day is worth its full
 * value" — or, on a day much of the field sat out, exactly how far down the
 * curve that put it. One point, because launch validity is a property of the
 * task and not of any pilot.
 */
export function buildLaunchValidityChart(
  classContext: ClassContextInput,
): ScoreChart | null {
  const vi = classContext.validity_inputs;
  if (!vi || vi.num_present <= 0) return null;
  const ratio = Math.min(1, vi.num_flying / (vi.num_present * NOMINAL_LAUNCH));
  return {
    kind: 'validity',
    // The curve is sampled in the launch-validity ratio r; feeding
    // r·NOMINAL_LAUNCH flying pilots of 1 present makes the clamp inside
    // calculateLaunchValidity resolve to exactly r.
    curve: validityCurve((r) => calculateLaunchValidity(r * NOMINAL_LAUNCH, 1)),
    point: { x: ratio, y: classContext.task_validity.launch },
    xLabel: 'share of the launch threshold met',
    caption:
      `Launch validity against how much of the field flew. ` +
      `This day sat at ${pctOf(ratio)} of the threshold, worth ${pctOf(
        classContext.task_validity.launch,
      )}.`,
  };
}

/**
 * Time validity's curve, with this day's point on it.
 *
 * The curve is the answer to "how much does a short winning time cost?" — a
 * question the percentage alone cannot settle, because the relationship is
 * neither linear nor intuitive: a day run in three-quarters of the nominal
 * time is still worth over 90%, while half nominal costs nearly a third.
 */
export function buildTimeValidityChart(
  classContext: ClassContextInput,
  params: GAPParameters,
): ScoreChart | null {
  const vi = classContext.validity_inputs;
  if (!vi || params.nominalTime <= 0) return null;
  // The spec falls back to a distance ratio when nobody completed the speed
  // section. That is a different comparison on a different axis, so the chart
  // would be labelling one thing and plotting another — draw nothing.
  if (vi.best_time === null || vi.best_time <= 0) return null;
  const ratio = Math.min(1, vi.best_time / params.nominalTime);
  return {
    kind: 'validity',
    curve: validityCurve((r) => calculateTimeValidity(r, 0, 1, 1)),
    point: { x: ratio, y: classContext.task_validity.time },
    xLabel: 'share of the nominal task time',
    caption:
      `Time validity against how long the winning flight took. ` +
      `This day ran to ${pctOf(ratio)} of the nominal time, worth ${pctOf(
        classContext.task_validity.time,
      )}.`,
  };
}

/** A 0–1 factor as a whole-ish percentage, for a caption. */
function pctOf(fraction: number): string {
  return `${trimZeros((fraction * 100).toFixed(1), 0)}%`;
}

// ---------------------------------------------------------------------------
// Distance validity — a distribution, not a curve
// ---------------------------------------------------------------------------

/**
 * How far the field actually got, with the thresholds that judge it.
 *
 * Distance validity is the one factor whose curve says nothing: the S7F ratio
 * is used as-is (clamped to 1), so plotting it would draw the identity
 * function and call it an explanation. What the reader needs is the shape the
 * ratio is computed FROM — how far each pilot got — against the minimum
 * distance below which a flight scores the minimum anyway, the nominal
 * distance the day is measured against, and their own.
 *
 * A strip of one dot per pilot, not a histogram. Bars force a bucket width,
 * and at this size the buckets read as an arbitrary grid laid over the data
 * rather than as the shape of it. Dots have no such parameter: overlap is the
 * density, which is the same encoding the task-analysis day profile uses for
 * its takeoff lane.
 *
 * Every flying pilot gets a dot, including those the component charts leave
 * off: this is a picture of the field, not a claim that a formula explains
 * each of them.
 */
export function buildDistanceValidityChart(
  entry: ScoreEntryInput,
  classContext: ClassContextInput,
  params: GAPParameters,
): ScoreChart | null {
  const vi = classContext.validity_inputs;
  const scored = scoredPilots(classContext);
  if (scored.length < 4) return null;

  const points: ScoreDistributionPoint[] = [];
  scored.forEach((p, i) => {
    if (!Number.isFinite(p.flown_distance)) return;
    points.push({
      key: pilotKey(p, i),
      name: p.pilot_name ?? 'Pilot',
      x: p.flown_distance,
      you: isYou(entry, p),
    });
  });
  if (points.length === 0) return null;

  // The reader's own distance is folded into the axis extent, not just the
  // field's. It should already be inside it — the entry is one of these
  // pilots — but the "you" marker is the one mark that must never be dropped
  // for falling off the end, so the axis is defined to contain it.
  const best = Math.max(
    ...points.map((p) => p.x),
    params.nominalDistance,
    entry.flown_distance,
  );
  if (best <= 0) return null;

  const markers: ScoreDistributionMarker[] = [
    { x: params.minimumDistance, label: 'minimum' },
    { x: params.nominalDistance, label: 'nominal' },
    { x: entry.flown_distance, label: 'you', you: true },
  ].filter((m) => m.x > 0 && m.x <= best);

  const beat = points.filter((p) => p.x < entry.flown_distance).length;
  return {
    kind: 'distribution',
    xLabel: 'Distance flown',
    xUnit: 'distance',
    points,
    markers,
    caption:
      `How far the field got — the spread distance validity is computed from, ` +
      `one dot per pilot. ` +
      `${points.length} pilots flew; you flew ${km(entry.flown_distance)}, ` +
      `further than ${beat} of them.` +
      (vi
        ? ` The day averaged ${km(vi.mean_distance_over_minimum)} past the ${km(
            params.minimumDistance,
          )} minimum, against a ${km(params.nominalDistance)} nominal distance.`
        : ''),
  };
}
