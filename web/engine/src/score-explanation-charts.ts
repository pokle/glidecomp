/**
 * Per-component score charts: the scoring function, with the field on it.
 *
 * The report card explains each component by printing its formula with this
 * pilot's numbers substituted. That answers "how was my score computed" but
 * not "how bad is twenty minutes" — the shape of the falloff, and where the
 * field sits along it, are things prose cannot carry. These builders supply
 * them as data (the UI draws).
 *
 * Three rules make these different from the field-analysis charts, and they
 * are the whole design:
 *
 *  1. **The curve is the formula, not a fit.** Every sample comes from the
 *     scorer's own function (calculateSpeedFraction, calculateLeadingPoints,
 *     calculateArrivalPoints) — never a regression through the dots. The
 *     field-analysis scatter draws a LOESS trend and withholds it below a
 *     noise floor because there a curve is a claim about data; here it is the
 *     definition, so it is always drawn and never gated.
 *
 *  2. **A dot is plotted only if the curve provably explains it.** Each
 *     pilot's published points are checked against the function at their x
 *     ({@link EXPLAINED_TOLERANCE}); anyone who fails — an ESS-but-not-goal
 *     pilot carrying the §12.1 reduction, a goal pilot docked by a stopped
 *     task (§12.3.5) — is counted and left off. Without this the caption's
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
  calculateArrivalPoints,
  calculateLeadingPoints,
  calculateSpeedFraction,
  resolveTimePointsExponent,
  speedExponentValue,
} from './gap-scoring';
import { duration, fmtPoints, km, trimZeros } from './score-explanation-format';
import type {
  ClassContextInput,
  ClassPilotInput,
  ScoreChart,
  ScoreChartPilot,
  ScoreChartPoint,
  ScoreEntryInput,
} from './score-explanation-types';

/**
 * How far a published point value may sit from the function before we stop
 * claiming the function explains it.
 *
 * Points are published rounded to 0.1 (S7F §11), so an exact match can be a
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
    const you =
      entry.comp_pilot_id !== undefined && p.comp_pilot_id === entry.comp_pilot_id;
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
  return ` ${omitted} pilot${omitted === 1 ? ' is' : 's are'} not shown — ${
    omitted === 1 ? 'their' : 'their'
  } points carry a reduction this curve does not include.`;
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

  // The same best-time source scoreFlights used (see buildTimeSection).
  const essNotGoalFactor = params.scoring === 'PG' ? 0 : params.essNotGoalFactor;
  const times = classContext.pilots
    .filter((p) => (essNotGoalFactor > 0 ? p.reached_ess : p.made_goal))
    .map((p) => p.speed_section_time)
    .filter((t): t is number => t !== null && t > 0);
  if (times.length === 0) return null;
  const bestTime = Math.min(...times);

  const exponent = speedExponentValue(resolveTimePointsExponent(params));
  const f = (t: number) => calculateSpeedFraction(t, bestTime, exponent) * available;

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
 * Positions are integers, but the §11.4 factor is continuous in the arrival
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
  const atEss =
    classContext.validity_inputs?.num_reached_ess ??
    classContext.pilots.filter((p) => p.reached_ess).length;
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
 * Only drawn when distance points are the plain linear share (PG, or HG with
 * difficulty off). With HG distance difficulty on, the total is a linear half
 * plus a difficulty half built from where the whole field landed out — a step
 * function this module cannot evaluate, because the engine does not expose
 * it as a function of distance. Rather than draw the linear half and label it
 * "distance points", the chart is withheld; the section's prose still names
 * both halves. (Exposing the difficulty curve would make this the most
 * interesting chart of the four — its kinks are where the field landed.)
 */
export function buildDistanceChart(
  entry: ScoreEntryInput,
  classContext: ClassContextInput,
  params: GAPParameters,
): ScoreChart | null {
  const available = classContext.available_points.distance;
  if (available <= 0) return null;
  if (params.scoring === 'HG' && params.useDistanceDifficulty) return null;

  const best = Math.max(...classContext.pilots.map((p) => p.flown_distance), 0);
  if (best <= 0) return null;

  const f = (d: number) => (d / best) * available;
  const placed = placeField(
    classContext,
    entry,
    (p) => p.flown_distance,
    (p) => p.distance_points,
    f,
  );
  if (!placed) return null;

  const curve = sampleCurve(0, best, 2, f);
  const you = placed.pilots.find((p) => p.you)!;
  return {
    xLabel: 'Scored distance',
    xUnit: 'distance',
    curve,
    pilots: placed.pilots,
    omitted: placed.omitted,
    caption:
      `Distance points are a straight line from nothing to the best distance flown — every dot is a pilot, sitting exactly on it. ` +
      `You flew ${km(you.x)} of the class best ${km(best)}, worth ${fmtPoints(
        you.y,
      )} of ${fmtPoints(available)}.` +
      omittedSentence(placed.omitted),
  };
}
