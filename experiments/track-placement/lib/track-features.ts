// Copyright (c) 2026, Tushar Pokle.  All rights reserved.
/**
 * Single-track features for the track-placement experiment.
 *
 * Every number here is computable from ONE IGC file plus the task. That is
 * the whole point of the experiment (issue #692): the model must never see
 * the field, so this module deliberately does not go anywhere near the
 * engine's `FieldContext` — no `gaggle.*`, no `climb.shared_percentile`, no
 * `glide.ld_vs_field`, no `race.time_behind`, none of the `day.*` family.
 * `day.*` HERE means the day as one pilot's own track reports it (their
 * circles' wind estimates, their ceiling, their climb trend), which is a
 * different quantity that happens to share a word.
 *
 * Features are grouped by prefix so the ablation can switch whole blocks off:
 * `climb.`, `glide.`, `route.`, `day.`, `start.`, `quality.`.
 */

import {
  calculateTrackDistance,
  detectCircles,
  detectFlight,
  ellipsoidDistance,
  fixAltitude,
  combineWindEstimates,
  mean,
  median,
  partitionPhases,
  percentile,
  type CircleDetectionResult,
  type ClimbData,
  type FlightDetectionResult,
  type GlideData,
  type IGCFix,
  type PhaseInterval,
  type ThermalSegment,
  type TrackQualityReport,
  type TurnpointSequenceResult,
  type WindSample,
  type XCTask,
} from '@glidecomp/engine';
import { distanceToCourseLine, windComponents, type TaskGeometry } from './geometry';

/** A feature row: flat, numeric, and null where the track cannot answer. */
export type FeatureBlock = Record<string, number | null>;

/** The window a feature block is computed over, with its detectors run. */
export interface TrackWindow {
  /** fixes[0 .. endIndex] of the original track — never a later slice, so a
   * fix index here is a fix index there. */
  fixes: IGCFix[];
  detection: FlightDetectionResult;
  circles: CircleDetectionResult;
  takeoffIndex: number;
  /** Last fix of the window (the landing, or the truncation point). */
  landingIndex: number;
  phases: PhaseInterval[];
}

const SUSTAINED_CLIMB_SECONDS = 600;
/** Shortest glide whose L/D and speed are read as a glide rather than noise. */
const MIN_SCORED_GLIDE_METERS = 1000;

/**
 * Run the single-track detectors over `fixes`.
 *
 * The caller truncates BEFORE calling, never after: a detector's own window
 * (thermal entry hysteresis, the circling state machine's t1/t2 delays) would
 * otherwise let a post-start fix decide something the prospective model is
 * not allowed to know.
 */
export function buildWindow(fixes: IGCFix[], task: XCTask): TrackWindow | null {
  if (fixes.length < 2) return null;
  const detection = detectFlight(fixes, task);
  const takeoff = detection.events.find((e) => e.type === 'takeoff');
  const takeoffIndex = takeoff?.segment?.startIndex ?? takeoffFixIndex(detection);
  if (takeoffIndex === null) return null;
  const landingIndex = fixes.length - 1;
  if (landingIndex <= takeoffIndex) return null;

  // detectCircles over the takeoff→end slice, indices offset back to
  // absolute — the same treatment PilotAnalysisContext gives them, so the
  // circle features and the phase partition agree about where a circle is.
  const sliced = detectCircles(fixes.slice(takeoffIndex));
  const circles: CircleDetectionResult = {
    circlingSegments: sliced.circlingSegments.map((s) => ({
      ...s,
      startIndex: s.startIndex + takeoffIndex,
      endIndex: s.endIndex + takeoffIndex,
    })),
    circles: sliced.circles.map((c) => ({
      ...c,
      startIndex: c.startIndex + takeoffIndex,
      endIndex: c.endIndex + takeoffIndex,
      strongestLiftFixIndex: c.strongestLiftFixIndex + takeoffIndex,
    })),
    bearingRates: sliced.bearingRates,
  };

  const thermals: ThermalSegment[] = detection.segments.climbs.map(climbToThermal);
  const phases = partitionPhases(fixes, thermals, circles, takeoffIndex, landingIndex);
  return { fixes, detection, circles, takeoffIndex, landingIndex, phases };
}

function takeoffFixIndex(detection: FlightDetectionResult): number | null {
  const takeoff = detection.events.find((e) => e.type === 'takeoff');
  const details = takeoff?.details as { fixIndex?: number } | undefined;
  return typeof details?.fixIndex === 'number' ? details.fixIndex : null;
}

function climbToThermal(c: ClimbData): ThermalSegment {
  return {
    startIndex: c.segment.startIndex,
    endIndex: c.segment.endIndex,
    startAltitude: c.startAltitude,
    endAltitude: c.endAltitude,
    avgClimbRate: c.avgClimbRate,
    duration: c.duration,
    location: { lat: c.startLat, lon: c.startLon },
  };
}

// ---------------------------------------------------------------------------
// Small helpers. Every one returns null rather than NaN for "the track cannot
// answer this", because a NaN written to JSONL becomes the string `null`
// anyway and a silent coercion is exactly the kind of thing that ends up
// standardised into a fake zero downstream.
// ---------------------------------------------------------------------------

function num(v: number | undefined | null): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function quantiles(values: number[], ps: number[]): (number | null)[] {
  if (values.length === 0) return ps.map(() => null);
  const sorted = [...values].sort((a, b) => a - b);
  return ps.map((p) => num(percentile(sorted, p)));
}

/** Coefficient of variation — spread with the scale divided out. */
function cv(values: number[]): number | null {
  if (values.length < 2) return null;
  const m = mean(values);
  if (!Number.isFinite(m) || m === 0) return null;
  const variance = mean(values.map((v) => (v - m) ** 2));
  return num(Math.sqrt(variance) / Math.abs(m));
}

function seconds(fixes: IGCFix[], a: number, b: number): number {
  return (fixes[b].time.getTime() - fixes[a].time.getTime()) / 1000;
}

/** Altitude at the fix nearest `atMs`, searching backwards from `fromIndex`. */
function altitudeAt(fixes: IGCFix[], fromIndex: number, atMs: number): number | null {
  for (let i = fromIndex; i >= 0; i--) {
    if (fixes[i].time.getTime() <= atMs) return fixAltitude(fixes[i]);
  }
  return null;
}

/** Ordinary-least-squares slope of y against x. */
function slope(xs: number[], ys: number[]): number | null {
  if (xs.length < 3) return null;
  const mx = mean(xs);
  const my = mean(ys);
  let num_ = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num_ += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return den === 0 ? null : num(num_ / den);
}

// ---------------------------------------------------------------------------
// Climb
// ---------------------------------------------------------------------------

export function climbFeatures(w: TrackWindow): FeatureBlock {
  const climbs = w.detection.segments.climbs;
  const rates = climbs.map((c) => c.avgClimbRate).filter(Number.isFinite);
  const gains = climbs.map((c) => c.altitudeGain).filter(Number.isFinite);
  const [p50, p75, p90] = quantiles(rates, [50, 75, 90]);

  const circles = w.circles.circles;
  const left = circles.filter((c) => c.turnDirection === 'left').length;
  const right = circles.length - left;

  const entries = climbs.map((c) => c.startAltitude);
  const exits = climbs.map((c) => c.endAltitude);
  const band = climbs.map((c) => (c.startAltitude + c.endAltitude) / 2);

  return {
    'climb.n_thermals': climbs.length,
    'climb.rate_mean_mps': num(mean(rates)),
    'climb.rate_median_mps': p50,
    'climb.rate_p75_mps': p75,
    'climb.rate_p90_mps': p90,
    'climb.best_sustained_600s_mps': bestSustainedClimb(w),
    'climb.gain_mean_m': num(mean(gains)),
    'climb.gain_total_m': gains.length > 0 ? gains.reduce((s, g) => s + g, 0) : null,
    'climb.duration_mean_s': num(mean(climbs.map((c) => c.duration))),
    'climb.time_to_establish_median_s': timeToEstablish(w),
    'climb.n_circles': circles.length,
    'climb.circle_radius_median_m': num(median(circles.map((c) => c.fittedCircle.radiusMeters))),
    'climb.circle_quality_mean': num(mean(circles.map((c) => c.quality))),
    'climb.circle_climb_median_mps': num(median(circles.map((c) => c.climbRate))),
    'climb.circle_duration_median_s': num(median(circles.map((c) => c.duration))),
    // 0 = turns both ways equally, 1 = every circle the same way. A pilot who
    // only ever turns one way is a real, single-track-visible habit.
    'climb.turn_consistency':
      circles.length === 0 ? null : Math.abs(left - right) / circles.length,
    'climb.working_floor_m': entries.length > 0 ? Math.min(...entries) : null,
    'climb.working_ceiling_m': exits.length > 0 ? Math.max(...exits) : null,
    'climb.working_median_m': num(median(band)),
    'climb.top_third_time_frac': topThirdFraction(w),
  };
}

/**
 * The best mean climb rate over any 10-minute stretch of the window.
 *
 * Measured over the tightest window ending at each fix rather than any window
 * ≥ 10 min, so a long flat stretch can't dilute a strong climb into the mean
 * and read as "sustained".
 */
function bestSustainedClimb(w: TrackWindow): number | null {
  const { fixes, takeoffIndex, landingIndex } = w;
  let best: number | null = null;
  let i = takeoffIndex;
  for (let j = takeoffIndex; j <= landingIndex; j++) {
    while (i < j && seconds(fixes, i + 1, j) >= SUSTAINED_CLIMB_SECONDS) i++;
    const dt = seconds(fixes, i, j);
    if (dt < SUSTAINED_CLIMB_SECONDS) continue;
    const rate = (fixAltitude(fixes[j]) - fixAltitude(fixes[i])) / dt;
    if (best === null || rate > best) best = rate;
  }
  return num(best);
}

/**
 * Median seconds from entering a thermal to closing the first full circle in
 * it — how long the pilot takes to find the core and commit to it.
 */
function timeToEstablish(w: TrackWindow): number | null {
  const deltas: number[] = [];
  for (const climb of w.detection.segments.climbs) {
    const first = w.circles.circles.find(
      (c) => c.startIndex >= climb.segment.startIndex && c.endIndex <= climb.segment.endIndex,
    );
    if (!first) continue;
    deltas.push(seconds(w.fixes, climb.segment.startIndex, first.endIndex));
  }
  return deltas.length === 0 ? null : num(median(deltas));
}

/**
 * Fraction of airborne time spent in the top third of the height band the
 * pilot actually used. High is a pilot who stays up in the strong air.
 */
function topThirdFraction(w: TrackWindow): number | null {
  const { fixes, takeoffIndex, landingIndex } = w;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = takeoffIndex; i <= landingIndex; i++) {
    const alt = fixAltitude(fixes[i]);
    if (alt < lo) lo = alt;
    if (alt > hi) hi = alt;
  }
  if (!Number.isFinite(lo) || hi <= lo) return null;
  const threshold = lo + (2 / 3) * (hi - lo);
  let total = 0;
  let above = 0;
  for (let i = takeoffIndex; i < landingIndex; i++) {
    const dt = seconds(fixes, i, i + 1);
    if (dt <= 0) continue;
    total += dt;
    if (fixAltitude(fixes[i]) >= threshold) above += dt;
  }
  return total === 0 ? null : above / total;
}

// ---------------------------------------------------------------------------
// Glide
// ---------------------------------------------------------------------------

export function glideFeatures(w: TrackWindow): FeatureBlock {
  const glides: GlideData[] = w.detection.segments.glides;
  // L/D and glide speed are read over glides of at least a kilometre. A
  // 200-metre hop that happened to end level reports an L/D in the hundreds,
  // and one of those in a flight moves the "best glide" feature more than any
  // real glide in it does.
  const scored = glides.filter((g) => g.distance >= MIN_SCORED_GLIDE_METERS);
  const ratios = scored.map((g) => g.glideRatio).filter((r): r is number => num(r) !== null);
  const speeds = scored.map((g) => g.averageSpeed).filter(Number.isFinite);
  const [ld50, ld75] = quantiles(ratios, [50, 75]);

  const phaseSeconds = { climb: 0, glide: 0, search: 0 };
  for (const p of w.phases) phaseSeconds[p.phase] += p.durationSeconds;
  const airborne = phaseSeconds.climb + phaseSeconds.glide + phaseSeconds.search;

  return {
    'glide.n_glides': glides.length,
    'glide.n_glides_over_1km': scored.length,
    'glide.ld_median': ld50,
    'glide.ld_p75': ld75,
    'glide.ld_best': ratios.length > 0 ? Math.max(...ratios) : null,
    'glide.speed_mean_mps': num(mean(speeds)),
    'glide.speed_best_mps': speeds.length > 0 ? Math.max(...speeds) : null,
    'glide.longest_m': glides.length > 0 ? Math.max(...glides.map((g) => g.distance)) : null,
    'glide.distance_total_m':
      glides.length > 0 ? glides.reduce((s, g) => s + g.distance, 0) : null,
    'glide.dolphin_frac': dolphinFraction(w),
    'glide.time_climb_frac': airborne > 0 ? phaseSeconds.climb / airborne : null,
    'glide.time_glide_frac': airborne > 0 ? phaseSeconds.glide / airborne : null,
    'glide.time_search_frac': airborne > 0 ? phaseSeconds.search / airborne : null,
    'glide.airborne_s': airborne > 0 ? airborne : null,
  };
}

/**
 * Fraction of gliding time with the vario positive — climbing without
 * stopping to circle. Read over the phase partition rather than the glide
 * segments so it covers the whole cruise, not just the detected glides.
 */
function dolphinFraction(w: TrackWindow): number | null {
  let total = 0;
  let lifting = 0;
  for (const p of w.phases) {
    if (p.phase !== 'glide') continue;
    for (let i = p.startIndex; i < p.endIndex; i++) {
      const dt = seconds(w.fixes, i, i + 1);
      if (dt <= 0) continue;
      total += dt;
      if (fixAltitude(w.fixes[i + 1]) > fixAltitude(w.fixes[i])) lifting += dt;
    }
  }
  return total === 0 ? null : lifting / total;
}

// ---------------------------------------------------------------------------
// The day, as this one track reports it
// ---------------------------------------------------------------------------

export function dayFeatures(w: TrackWindow, geom: TaskGeometry): FeatureBlock {
  // Prefer the centre-drift estimate: it reads the air the pilot is in,
  // where the ground-speed estimate needs a clean, round circle to work.
  const samples: WindSample[] = [];
  const drifts: number[] = [];
  for (const c of w.circles.circles) {
    const est = c.windFromCenterDrift ?? c.windFromGroundSpeed;
    if (!est) continue;
    samples.push({ speed: est.speed, direction: est.direction });
    if (c.windFromCenterDrift) drifts.push(c.windFromCenterDrift.speed);
  }
  const wind = combineWindEstimates(samples);

  const alongLegs = wind
    ? geom.legBearings.map((b) => windComponents(wind.speed, wind.direction, b).along)
    : [];
  const course = wind
    ? windComponents(wind.speed, wind.direction, geom.courseBearing)
    : null;

  let ceiling = -Infinity;
  for (let i = w.takeoffIndex; i <= w.landingIndex; i++) {
    ceiling = Math.max(ceiling, fixAltitude(w.fixes[i]));
  }

  const climbs = w.detection.segments.climbs;
  const hours = climbs.map(
    (c) => (c.startTime.getTime() - w.fixes[w.takeoffIndex].time.getTime()) / 3_600_000,
  );

  return {
    'day.wind_speed_mps': num(wind?.speed),
    'day.wind_dir_deg': num(wind?.direction),
    'day.wind_n_circles': wind ? wind.n : 0,
    'day.wind_along_course_mps': num(course?.along),
    'day.wind_cross_course_mps': num(course?.cross),
    'day.wind_along_leg_mean_mps': num(mean(alongLegs)),
    'day.wind_along_leg_min_mps': alongLegs.length > 0 ? Math.min(...alongLegs) : null,
    'day.wind_along_leg_max_mps': alongLegs.length > 0 ? Math.max(...alongLegs) : null,
    'day.drift_median_mps': drifts.length > 0 ? num(median(drifts)) : null,
    'day.ceiling_m': Number.isFinite(ceiling) ? ceiling : null,
    // Positive = the day kept building while this pilot flew it.
    'day.climb_trend_mps_per_hour': slope(hours, climbs.map((c) => c.avgClimbRate)),
  };
}

// ---------------------------------------------------------------------------
// Route — how the pilot flew the course. Retrospective only: every number
// here needs the flight after the start.
// ---------------------------------------------------------------------------

export function routeFeatures(
  w: TrackWindow,
  seq: TurnpointSequenceResult,
  geom: TaskGeometry,
): FeatureBlock {
  const startIndex = seq.sssReaching?.fixIndex ?? w.takeoffIndex;
  const endIndex = seq.sequence.length > 0
    ? seq.sequence[seq.sequence.length - 1].fixIndex
    : w.landingIndex;

  const deviations: number[] = [];
  for (let i = startIndex; i <= Math.min(endIndex, w.landingIndex); i++) {
    const d = distanceToCourseLine(geom.line, w.fixes[i].latitude, w.fixes[i].longitude);
    if (Number.isFinite(d)) deviations.push(d);
  }
  const [dev50, dev90] = quantiles(deviations, [50, 90]);

  // How close to the optimal tag point each reached turnpoint was taken,
  // as a fraction of its radius. 0 = straight over the optimiser's corner.
  const entryEff: number[] = [];
  for (const reaching of seq.sequence) {
    const vertex = geom.line[reaching.taskIndex];
    const radius = geom.task.turnpoints[reaching.taskIndex]?.radius;
    if (!vertex || !radius) continue;
    entryEff.push(
      ellipsoidDistance(reaching.latitude, reaching.longitude, vertex.lat, vertex.lon) / radius,
    );
  }

  const legSpeeds = legSpeedsMps(seq, geom);
  const flownTrack = calculateTrackDistance(
    w.fixes,
    startIndex,
    Math.min(endIndex, w.landingIndex),
  );

  return {
    'route.flown_m': num(seq.flownDistance),
    'route.flown_frac_of_task': geom.totalMeters > 0 ? seq.flownDistance / geom.totalMeters : null,
    'route.track_over_optimised': geom.totalMeters > 0 ? flownTrack / geom.totalMeters : null,
    'route.deviation_median_m': dev50,
    'route.deviation_p90_m': dev90,
    'route.tp_entry_frac_of_radius_mean': num(mean(entryEff)),
    'route.n_turnpoints_reached': seq.lastTurnpointReached,
    'route.made_goal': seq.madeGoal ? 1 : 0,
    'route.speed_section_s': num(seq.speedSectionTime),
    'route.leg_speed_mean_mps': num(mean(legSpeeds)),
    'route.leg_speed_cv': cv(legSpeeds),
    'route.leg_speed_first_frac': fracOfMean(legSpeeds, 0),
    'route.leg_speed_last_frac': fracOfMean(legSpeeds, legSpeeds.length - 1),
  };
}

/**
 * Each completed leg's speed: the leg's OPTIMISED length over the elapsed
 * time between its endpoints. Optimised rather than flown, so a pilot who
 * detoured is slow on that leg rather than fast over a longer distance.
 */
function legSpeedsMps(seq: TurnpointSequenceResult, geom: TaskGeometry): number[] {
  const reachedAt = new Map<number, number>();
  for (const r of seq.sequence) reachedAt.set(r.taskIndex, r.time.getTime());
  const speeds: number[] = [];
  for (let i = 1; i < geom.line.length; i++) {
    const from = reachedAt.get(i - 1);
    const to = reachedAt.get(i);
    if (from === undefined || to === undefined || to <= from) continue;
    speeds.push(geom.legMeters[i - 1] / ((to - from) / 1000));
  }
  return speeds;
}

function fracOfMean(values: number[], index: number): number | null {
  if (values.length === 0 || index < 0 || index >= values.length) return null;
  const m = mean(values);
  return m > 0 ? values[index] / m : null;
}

// ---------------------------------------------------------------------------
// Start — the last thing the prospective model is allowed to see.
// ---------------------------------------------------------------------------

export interface StartContext {
  seq: TurnpointSequenceResult;
  geom: TaskGeometry;
  /** Offset of the comp's zone at the task, for the one local-clock feature. */
  timeZoneOffsetMs: number;
}

export function startFeatures(w: TrackWindow, ctx: StartContext): FeatureBlock {
  const reaching = ctx.seq.sssReaching;
  if (!reaching) {
    return {
      'start.crossed': 0,
      'start.alt_m': null,
      'start.alt_above_launch_m': null,
      'start.alt_below_own_ceiling_m': null,
      'start.seconds_after_gate': null,
      'start.gate_index': null,
      'start.gates_remaining': null,
      'start.climb_last_600s_mps': null,
      'start.dist_to_optimal_exit_m': null,
      'start.airborne_before_s': null,
      'start.local_time_of_day_s': null,
    };
  }

  const crossMs = reaching.time.getTime();
  const crossIndex = Math.min(reaching.fixIndex, w.landingIndex);
  const alt = fixAltitude(w.fixes[crossIndex]);
  const launchAlt = fixAltitude(w.fixes[w.takeoffIndex]);

  let ownCeiling = -Infinity;
  for (let i = w.takeoffIndex; i <= crossIndex; i++) {
    ownCeiling = Math.max(ownCeiling, fixAltitude(w.fixes[i]));
  }

  const gate = ctx.seq.startGate;
  const before = altitudeAt(w.fixes, crossIndex, crossMs - 600_000);

  const vertex = ctx.geom.line[reaching.taskIndex];
  const localSeconds =
    (((crossMs + ctx.timeZoneOffsetMs) % 86_400_000) + 86_400_000) % 86_400_000 / 1000;

  return {
    'start.crossed': 1,
    'start.alt_m': alt,
    'start.alt_above_launch_m': alt - launchAlt,
    // Negative is impossible by construction; 0 means they started at their
    // own high point of the day so far.
    'start.alt_below_own_ceiling_m': Number.isFinite(ownCeiling) ? ownCeiling - alt : null,
    'start.seconds_after_gate': gate ? (crossMs - gate.time.getTime()) / 1000 : null,
    'start.gate_index': gate ? gate.index : null,
    'start.gates_remaining': gate ? gate.gateCount - 1 - gate.index : null,
    'start.climb_last_600s_mps': before === null ? null : (alt - before) / 600,
    'start.dist_to_optimal_exit_m': vertex
      ? ellipsoidDistance(reaching.latitude, reaching.longitude, vertex.lat, vertex.lon)
      : null,
    'start.airborne_before_s': (crossMs - w.fixes[w.takeoffIndex].time.getTime()) / 1000,
    'start.local_time_of_day_s': localSeconds,
  };
}

// ---------------------------------------------------------------------------
// Quality — the SOFT findings as covariates, never as filters. The two HARD
// checks withhold the track upstream and it never reaches here.
//
// Namespaced per window like every other block, because `fix_count` over the
// WHOLE file is flight duration wearing a disguise, and flight duration is
// most of distance flown. Read as a shared feature it would hand the
// prospective model the end of the race it is supposed to be predicting.
// ---------------------------------------------------------------------------

export function qualityFeatures(
  fixes: IGCFix[],
  report: TrackQualityReport,
  droppedFixCount: number,
): FeatureBlock {
  const soft = new Set(
    report.findings.filter((f) => f.severity === 'soft').map((f) => f.id),
  );
  const intervals: number[] = [];
  for (let i = 1; i < fixes.length; i++) {
    intervals.push((fixes[i].time.getTime() - fixes[i - 1].time.getTime()) / 1000);
  }
  return {
    'quality.soft_never_left_takeoff': soft.has('never-left-takeoff') ? 1 : 0,
    'quality.soft_never_airborne': soft.has('never-airborne') ? 1 : 0,
    'quality.soft_implausible_speed': soft.has('implausible-speed') ? 1 : 0,
    'quality.soft_wrong_day': soft.has('wrong-day') ? 1 : 0,
    'quality.fix_interval_median_s': num(median(intervals)),
    'quality.fix_count': fixes.length,
    'quality.dropped_backwards_fixes': droppedFixCount,
  };
}

/** Prefix every key of a block, for the retro/prospective namespaces. */
export function prefixed(prefix: string, block: FeatureBlock): FeatureBlock {
  const out: FeatureBlock = {};
  for (const [k, v] of Object.entries(block)) out[`${prefix}${k}`] = v;
  return out;
}
