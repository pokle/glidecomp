// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Track quality: decide whether a submitted tracklog is plausibly THIS
 * pilot's flight of THIS task, before it is scored or analysed.
 *
 * Why: FAI Sporting Code S7A §4.4.2 puts this obligation on the verification
 * software, not on a human scorer — the track log must show that "all points
 * used to verify the flight occurred at reasonable times (e.g. on the day in
 * question)". Nothing enforced that here, and the scoring path cannot notice
 * on its own: time-gates.ts deliberately resolves the task's gates NEAR a
 * reference instant taken from the flight (so a task spanning UTC midnight
 * scores correctly), which means a tracklog from another day silently
 * relocates the whole task onto its own calendar day and scores normally. A
 * real example, Corryong Cup 2025 task 4: one entry was a New Zealand flight
 * from ten days later. It scored the S7F §5.3 minimum distance, and its hour
 * buckets stretched the task-analysis day-profile axis from 5 hours to 262.
 *
 * What this module is NOT: it is not a scoring rule. S7F §5.3 and §9.3
 * award minimum distance to EVERY pilot who takes off, with no start-validity
 * predicate — a pilot who launches and sinks out is correctly scored, and
 * this module must never turn that into a zero. S7A §4.4.6 (Rejection of
 * Track Log) is the only route to zero and is explicitly the organiser's
 * judgement, so a HARD verdict here is a default a scorekeeper can override,
 * never a silent, unappealable zero.
 *
 * Hence two severities:
 *
 *   HARD — the file is not this flight. `wrong-day` and `wrong-place` are
 *          statements about identity, not airmanship, and both are decided
 *          with margins so large (days, thousands of kilometres) that no
 *          honest entry can reach them. The caller withholds the track from
 *          scoring and from task analysis.
 *   SOFT — the file is plausibly this flight but something about it deserves
 *          a human's eye. Never changes a score. These fire routinely on
 *          legitimate 0-scoring tracks (blown launches, top-landings), so
 *          their wording is information, not accusation.
 *
 * Structure follows altitude-cleaning.ts: pure, allocates nothing on the
 * fixes, and returns a report whose findings carry the numbers already
 * rendered, so every surface can disclose exactly what was decided and why.
 * Unlike cleaning, these checks need the task and the task date, so this runs
 * from the backend rather than from parseIGC — putting it in the parser would
 * make igc-parser depend on xctsk-parser, and would tax the parser's other
 * callers (the 3D packer, the CLI, the browser analysis page), none of which
 * have a competition.
 */

import { ellipsoidDistance, getBoundingBox, isInsideCylinder } from './geo';
import { fixAltitude, type IGCFix, type IGCHeader } from './igc-parser';
import { detectTakeoffLandingIndices } from './takeoff-landing-detector';
import { km, type KmOptions } from './format-distance';
import { DEFAULT_THRESHOLDS } from './thresholds';
import type { XCTask } from './xctsk-parser';
import { nextDayISO, zonedDayStartMs } from './zone-offset';

const HOUR_MS = 3_600_000;

/** How a finding prints a distance — see {@link KmOptions.wholeAbove100}. */
const FINDING_KM: KmOptions = { wholeAbove100: true };

export type TrackQualityCheckId =
  | 'wrong-day'
  | 'wrong-place'
  | 'never-left-takeoff'
  | 'never-airborne'
  | 'implausible-speed';

export type TrackQualitySeverity = 'hard' | 'soft';

// ---------------------------------------------------------------------------
// Thresholds — every one carries the physical or empirical reason for its
// value, because re-tuning any of them changes published scores.
// ---------------------------------------------------------------------------

/**
 * How far outside the task's LOCAL calendar day a fix may lie and still count
 * as "on the day".
 *
 * The check fires only when EVERY fix is outside the padded window, so this
 * pad matters only for a flight that shares no instant at all with the task's
 * day. It must stay well under 12 h: at 12 h the padded windows of adjacent
 * days touch, and a genuinely wrong-by-one-day track — yesterday's task's
 * file, the likeliest real mistake — would pass. 4 h widens the accepted span
 * to 20:00 local the day before through 04:00 local the day after.
 */
const TASK_DAY_TOLERANCE_MS = 4 * HOUR_MS;

/**
 * The pad used when no competition time zone is known and the task's day is
 * taken as UTC. Wide enough to cover every civil offset (UTC−12 … UTC+14), so
 * a missing zone can only weaken this check, never produce a false HARD
 * failure on a pilot.
 */
const TASK_DAY_NO_ZONE_TOLERANCE_MS = 14 * HOUR_MS;

/**
 * How far beyond the padded task day a track must fall before "wrong day"
 * becomes HARD rather than a soft flag.
 *
 * A logger with its date set one day out is a REAL AND RECURRING FAULT, not a
 * misfiled track: across the 5,112-track archive, Bright Open 2020 task 1 has
 * three pilots whose files are stamped the following day while the other 77
 * are correct. Those three launched inside the field's own launch window, at
 * the task's site, flew the task, and AirScore scored them normally — one of
 * them came 4th, in goal, with 675 points. Hard-failing a one-day offset
 * would have zeroed him.
 *
 * Two days or more cannot be a date-entry slip in the same way, and is the
 * signature of a file from another flight entirely (the New Zealand track
 * that prompted this module is ten days out). So: ≤ 1 day beyond the window
 * is reported for a human to check; more than that is withheld.
 *
 * The cost of this line is that a pilot who uploads YESTERDAY's task file
 * gets a soft flag, not an exclusion. That is accepted deliberately — from
 * the tracklog alone it is indistinguishable from the Bright case, the wrong
 * route scores badly on its own, and a genuinely different site is caught by
 * `wrong-place` regardless of the date.
 */
const TASK_DAY_HARD_MS = 24 * HOUR_MS;

/**
 * No fix within this distance of ANY task turnpoint centre ⇒ the track is not
 * this task's flight.
 *
 * Calibrated over 4,762 archive tracks spanning every bundled and archived
 * task that carries a route: the median track passes within 70 m of a
 * turnpoint, p99 within 1.0 km, and the furthest ANY honest track stayed from
 * every turnpoint is 45.4 km (a Forbes flatlands pilot who landed a long way
 * off course). A long task does not push this up — turnpoints spread along
 * the course, so a pilot far from the first is near a later one, and the
 * quantity is the MINIMUM over all of them, which is ~0 at launch for anyone
 * who actually launched. 100 km is 2.2x the worst honest case and 1/22nd of
 * the New Zealand outlier that prompted this module (2,186 km), so no
 * threshold anywhere in that range changes a verdict.
 */
const WRONG_PLACE_MAX_APPROACH_M = 100_000;

/**
 * Below this many fixes, "the track never left the take-off cylinder" says
 * nothing — a handful of fixes is a broken file, not a pilot who stayed on
 * launch. Matches cleanAltitudes' own n < 10 bail-out.
 */
const NEVER_LEFT_TAKEOFF_MIN_FIXES = 10;

/**
 * Signature 1 of "this thing flew": a sustained thermal climb.
 *
 * A vehicle would have to gain 180 m of elevation in two minutes. On a launch
 * road at a realistic 25 km/h that is 830 m of road and a 21% sustained
 * gradient; even at an implausible 60 km/h it needs 9% sustained. No
 * vehicular road holds either. Gliders do 1.5 m/s for two minutes on every
 * soarable day.
 */
const AIRBORNE_CLIMB_MS = 1.5;
const AIRBORNE_CLIMB_SECONDS = 120;

/**
 * Signature 2: a sustained free glide. All three conditions must hold
 * TOGETHER over the window — a descending vehicle can match any one of them,
 * but none can match all three for a minute and a half.
 *
 * 90 s rather than 120 so a genuine 3-minute sled ride off a 400 m hill
 * (~2.2 m/s mean descent) clears it with margin. The minimum instantaneous
 * ground speed is the discriminator that pure gradient cannot supply: a
 * vehicle on switchbacks drops below 14 km/h somewhere in any 90-second
 * stretch, while a wing cannot go slower than its flight speed relative to
 * the air — 4 m/s is set low enough that a paraglider penetrating into wind
 * still clears it. Straightness (great-circle displacement over path length)
 * catches the doubling-back a switchback road cannot avoid.
 */
const AIRBORNE_GLIDE_SECONDS = 90;
const AIRBORNE_GLIDE_SINK_MS = 0.8;
const AIRBORNE_GLIDE_MIN_SPEED_MS = 4;
const AIRBORNE_GLIDE_STRAIGHTNESS = 0.55;

/**
 * The sustained-speed window. Long enough that GNSS jitter on the two
 * endpoints contributes under 1 m/s, short enough that a genuinely fast glide
 * leg sits wholly inside it.
 */
const SPEED_WINDOW_SECONDS = 60;

/** A logger too coarse to support the measurement reports skipped rather than
 * a number nobody should trust. */
const SPEED_MIN_WINDOW_SECONDS = 45;

/**
 * Ceilings on ground speed sustained for a full minute, per FAI class.
 *
 * PG (Class 3): a comp wing on full bar holds ~19 m/s airspeed; with a
 * 40 km/h tailwind that is ~30 m/s over the ground, which Australian flatland
 * days do produce. 33 m/s (119 km/h) sits just above the demonstrated
 * maximum. HG (Classes 1/2/5): a rigid wing at ~25 m/s airspeed with a
 * 60 km/h tailwind reaches ~42 m/s; 45 m/s (162 km/h) sits just above that.
 *
 * Deliberately generous. This check exists to find a NON-GLIDER in the file —
 * an airliner home, a tow plane, a track spliced from two flights — not to
 * litigate a fast glide. It will NOT catch a road vehicle at the HG ceiling
 * and only marginally at the PG one; `never-airborne` is the vehicle
 * detector. Do not lower these to chase vehicles: that trades a check nobody
 * disputes for false positives on honest Forbes glides.
 */
const MAX_SUSTAINED_SPEED_PG_MS = 33;
const MAX_SUSTAINED_SPEED_HG_MS = 45;

// ---------------------------------------------------------------------------
// Report shape
// ---------------------------------------------------------------------------

/**
 * Machine-readable backing for a finding, discriminated by check id. `detail`
 * is the sentence a reader sees; this is what lets a scorekeeper diagnose the
 * fault (a logger writing local time as UTC, say) rather than merely be told
 * the track was rejected.
 */
export type TrackQualityEvidence =
  | {
      id: 'wrong-day';
      firstFixMs: number;
      lastFixMs: number;
      headerDateMs: number | null;
      /** True when the file carried no parseable HFDTE, so the fix times are
       * the PARSE day (see igc-parser's baseDate fallback) and the finding is
       * downgraded to soft. */
      headerDateMissing: boolean;
      windowStartMs: number;
      windowEndMs: number;
      timeZone: string | null;
      toleranceHours: number;
      /** Signed hours from the first fix to the nearest window edge. Near
       * ±11/±13 is the signature of a logger writing local time as UTC. */
      offsetHours: number;
    }
  | {
      id: 'wrong-place';
      nearestApproachMeters: number;
      nearestTurnpointName: string;
      nearestTurnpointIndex: number;
      nearestFixIndex: number;
      thresholdMeters: number;
    }
  | {
      id: 'never-left-takeoff';
      takeoffTurnpointName: string;
      radiusMeters: number;
      maxDistanceFromCentreMeters: number;
      fixCount: number;
      durationSeconds: number;
    }
  | {
      id: 'never-airborne';
      /** Recorded as corroboration only. detectTakeoffLanding is deliberately
       * permissive and DOES report a take-off for a car, so it is never the
       * gate — see the check's comment. */
      takeoffDetected: boolean;
      bestSustainedClimbMs: number;
      bestGlideSinkMs: number;
      bestGlideMinSpeedMs: number;
      bestGlideStraightness: number;
      maxAltitudeGainAboveStartMeters: number;
    }
  | {
      id: 'implausible-speed';
      maxSustainedSpeedMs: number;
      thresholdMs: number;
      category: 'hg' | 'pg';
      windowSeconds: number;
      startMs: number;
      endMs: number;
      startFixIndex: number;
      endFixIndex: number;
    };

export interface TrackQualityFinding {
  id: TrackQualityCheckId;
  severity: TrackQualitySeverity;
  /** Short label, e.g. "Track is from a different day". */
  title: string;
  /** The reader's sentence, numbers already rendered. Produced here rather
   * than in a view so the SSR and client renders are byte-identical. */
  detail: string;
  evidence: TrackQualityEvidence;
}

export interface TrackQualityReport {
  findings: TrackQualityFinding[];
  /** Any finding of severity 'hard': the caller must withhold this track from
   * scoring AND from task analysis (subject to a scorekeeper override). */
  hardFailed: boolean;
  /** Checks that actually ran. */
  checked: TrackQualityCheckId[];
  /** Checks that could not run, and why. Disclosed rather than dropped: a
   * silently skipped check reads to a user exactly like a passed one. */
  skipped: { id: TrackQualityCheckId; reason: string }[];
  totalFixCount: number;
  firstFixMs: number | null;
  lastFixMs: number | null;
}

export interface TrackQualityContext {
  /** The task, untrimmed by the distance-origin convention. Absent for a
   * caller with no route yet (an upload before the task's xctsk is saved),
   * which skips the two geometry checks. */
  task?: XCTask;
  /** The task's LOCAL calendar day, "YYYY-MM-DD" (D1 `task.task_date`). */
  taskDate?: string;
  /** IANA zone that `taskDate` is expressed in (`comp.timezone`). Absent
   * falls back to the UTC day with a much wider pad. */
  timeZone?: string;
  /** Sport, for the speed ceiling. Defaults to 'pg' — the lower ceiling, so
   * an unknown category can only flag more, never less. */
  category?: 'hg' | 'pg';
}

export const EMPTY_TRACK_QUALITY_REPORT: TrackQualityReport = Object.freeze({
  findings: [],
  hardFailed: false,
  checked: [],
  skipped: [],
  totalFixCount: 0,
  firstFixMs: null,
  lastFixMs: null,
});

const ALL_CHECKS: TrackQualityCheckId[] = [
  'wrong-day',
  'wrong-place',
  'never-left-takeoff',
  'never-airborne',
  'implausible-speed',
];

const SOFT_CHECKS: TrackQualityCheckId[] = [
  'never-left-takeoff',
  'never-airborne',
  'implausible-speed',
];

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Assess one tracklog against one task. Pure — reads the fixes, mutates
 * nothing, and returns the same report for the same inputs every time (the
 * scoring caches depend on that).
 *
 * Ordering is cheapest-first, and the two HARD checks BOTH run even when the
 * first fires: they are independent evidence of the same fault, and "dated 21
 * January; the task's local day is 11 January" plus "closest approach to any
 * turnpoint 2,186 km" reads far better together than either alone. The SOFT
 * checks are then skipped, because they describe flying behaviour, and for a
 * file that is not this flight that behaviour is noise — the New Zealand
 * track that prompted this module IS a perfectly good flight, and reporting
 * "airborne, plausible speed" beside "wrong country" would mislead.
 */
export function assessTrackQuality(
  fixes: IGCFix[],
  header: IGCHeader,
  context: TrackQualityContext
): TrackQualityReport {
  if (fixes.length === 0) {
    return {
      ...EMPTY_TRACK_QUALITY_REPORT,
      skipped: ALL_CHECKS.map((id) => ({ id, reason: 'the track has no fixes' })),
    };
  }

  const findings: TrackQualityFinding[] = [];
  const checked: TrackQualityCheckId[] = [];
  const skipped: { id: TrackQualityCheckId; reason: string }[] = [];
  const run = (
    id: TrackQualityCheckId,
    fn: () => TrackQualityFinding | null | { skip: string }
  ) => {
    const out = fn();
    if (out !== null && 'skip' in out) skipped.push({ id, reason: out.skip });
    else {
      checked.push(id);
      if (out !== null) findings.push(out);
    }
  };

  const times = fixes.map((f) => f.time.getTime());
  const firstFixMs = times[0];
  const lastFixMs = times[times.length - 1];

  run('wrong-day', () => checkWrongDay(times, header, context));
  run('wrong-place', () => checkWrongPlace(fixes, context));

  const hardFailed = findings.some((f) => f.severity === 'hard');
  if (hardFailed) {
    for (const id of SOFT_CHECKS) {
      skipped.push({ id, reason: 'not assessed — the track failed a hard check' });
    }
    return {
      findings,
      hardFailed,
      checked,
      skipped,
      totalFixCount: fixes.length,
      firstFixMs,
      lastFixMs,
    };
  }

  run('never-left-takeoff', () => checkNeverLeftTakeoff(fixes, times, context));
  run('never-airborne', () => checkNeverAirborne(fixes, times));
  run('implausible-speed', () => checkImplausibleSpeed(fixes, times, context));

  return {
    findings,
    hardFailed: false,
    checked,
    skipped,
    totalFixCount: fixes.length,
    firstFixMs,
    lastFixMs,
  };
}

// ---------------------------------------------------------------------------
// wrong-day (HARD) — S7A §4.4.2
// ---------------------------------------------------------------------------

/**
 * Compare the FIX TIMESTAMPS against the task's local calendar day, not the
 * HFDTE header.
 *
 * The header is already the base every fix time is built from (see parseTime
 * in igc-parser), so checking the fixes is strictly stronger: it also sees
 * the parser's no-date fallback, absorbs the 18:00→06:00 midnight-rollover
 * heuristic, and matches S7A §4.4.2, which speaks of POINTS occurring at
 * reasonable times.
 *
 * The window is the task's day in the COMPETITION's zone, padded. Using the
 * local day rather than the UTC day is what makes this safe in Australia,
 * where an honest task flies 00:09–04:13 UTC on its own local day — a naive
 * UTC-date comparison would flag an entire Corryong field.
 *
 * The check fires only when EVERY fix is outside the padded window, so a
 * logger left running overnight, a flight that crosses local midnight, or a
 * dawn launch cannot trip it: one fix inside the day is enough to pass.
 */
function checkWrongDay(
  times: number[],
  header: IGCHeader,
  context: TrackQualityContext
): TrackQualityFinding | null | { skip: string } {
  const { taskDate, timeZone } = context;
  if (!taskDate) return { skip: 'the task has no date' };

  const zone = timeZone ?? null;
  const dayStart = zonedDayStartMs(taskDate, zone);
  if (dayStart === null) return { skip: `unrecognised task date "${taskDate}"` };
  const dayEnd = zonedDayStartMs(nextDayISO(taskDate), zone) ?? dayStart + 24 * HOUR_MS;

  const tolerance = zone === null ? TASK_DAY_NO_ZONE_TOLERANCE_MS : TASK_DAY_TOLERANCE_MS;
  const windowStartMs = dayStart - tolerance;
  const windowEndMs = dayEnd + tolerance;

  for (const t of times) {
    if (t >= windowStartMs && t <= windowEndMs) return null;
  }

  const firstFixMs = times[0];
  const lastFixMs = times[times.length - 1];
  const offsetMs =
    firstFixMs < windowStartMs ? firstFixMs - windowStartMs : firstFixMs - windowEndMs;
  const offsetHours = offsetMs / HOUR_MS;

  // A file with no parseable HFDTE has fix times stamped with the PARSE day
  // (igc-parser's baseDate fallback), so "wrong day" would be a statement
  // about the scoring machine's clock. Report it, never hard-fail on it.
  const headerDateMissing = !(header.date instanceof Date) || Number.isNaN(header.date.getTime());

  // A one-day offset is a logger with its date set wrong — see
  // TASK_DAY_HARD_MS. Only a larger gap is treated as a different flight.
  const beyondWindowMs = Math.abs(offsetMs);
  const severity: TrackQualitySeverity =
    headerDateMissing || beyondWindowMs <= TASK_DAY_HARD_MS ? 'soft' : 'hard';

  const away = describeGap(beyondWindowMs);
  const taskDay = `${taskDate}${zone ? ` (${zone})` : ''}`;
  const detail = headerDateMissing
    ? `The tracklog carries no usable date header, so its fixes were timestamped ` +
      `with the date they were read (${formatUtcDate(firstFixMs)}) rather than the date ` +
      `they were flown. The task's day is ${taskDay}. ` +
      `Check the logger's date before relying on this track.`
    : severity === 'soft'
      ? `The fixes run ${formatUtcDateTime(firstFixMs)} to ${formatUtcDateTime(lastFixMs)} UTC, ` +
        `just outside the task's day of ${taskDay}. That is usually a recorder with its ` +
        `date set a day out rather than the wrong flight, so the track is still scored — ` +
        `check it against the launch marshal's record.`
      : `The fixes run ${formatUtcDateTime(firstFixMs)} to ${formatUtcDateTime(lastFixMs)} UTC, ` +
        `${away} outside the task's day of ${taskDay}. ` +
        `No point in this track was recorded on the day the task was flown.`;

  return {
    id: 'wrong-day',
    severity,
    title: headerDateMissing
      ? 'Track carries no date header'
      : severity === 'soft'
        ? 'Track is dated a day out'
        : 'Track is from a different day',
    detail,
    evidence: {
      id: 'wrong-day',
      firstFixMs,
      lastFixMs,
      headerDateMs: header.date instanceof Date ? header.date.getTime() : null,
      headerDateMissing,
      windowStartMs,
      windowEndMs,
      timeZone: zone,
      toleranceHours: tolerance / HOUR_MS,
      offsetHours,
    },
  };
}

/** "9 days", "6 hours", "40 minutes" — the size of a time gap, for prose. */
function describeGap(ms: number): string {
  const hours = ms / HOUR_MS;
  if (hours >= 48) return `${Math.round(hours / 24)} days`;
  if (hours >= 1.5) return `${Math.round(hours)} hours`;
  return `${Math.max(1, Math.round(ms / 60_000))} minutes`;
}

function formatUtcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function formatUtcDateTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

// ---------------------------------------------------------------------------
// wrong-place (HARD)
// ---------------------------------------------------------------------------

/**
 * The nearest approach from any fix to any turnpoint CENTRE, against a
 * threshold no honest track has ever come near.
 *
 * Evaluated in three tiers so the common cases cost no fix scan at all. Both
 * early exits are exact by the triangle inequality: every fix lies within
 * `boxRadius` of the bounding box's centre, so the true nearest approach is
 * bounded by `dMin ± boxRadius`.
 *
 * Note that a task whose take-off and start share a coordinate (the common
 * shape — Corryong's TAKEOFF and SSS are both at ELLIOT) contributes one
 * distinct centre, not two, so this check has less redundancy than the
 * turnpoint count suggests. That is fine for a minimum-over-turnpoints rule.
 */
function checkWrongPlace(
  fixes: IGCFix[],
  context: TrackQualityContext
): TrackQualityFinding | null | { skip: string } {
  const task = context.task;
  if (!task || task.turnpoints.length === 0) return { skip: 'no task geometry available' };

  const box = getBoundingBox(fixes);
  const centreLat = (box.minLat + box.maxLat) / 2;
  const centreLon = (box.minLon + box.maxLon) / 2;
  const boxRadius = ellipsoidDistance(centreLat, centreLon, box.maxLat, box.maxLon);

  let dMin = Infinity;
  for (const tp of task.turnpoints) {
    const d = ellipsoidDistance(centreLat, centreLon, tp.waypoint.lat, tp.waypoint.lon);
    if (d < dMin) dMin = d;
  }

  // Tier 2: the whole track is comfortably close to a turnpoint.
  if (dMin + boxRadius <= WRONG_PLACE_MAX_APPROACH_M) return null;

  // Tier 3: the box straddles the threshold — scan, exiting on the first fix
  // that proves the track is in the right place.
  if (dMin - boxRadius <= WRONG_PLACE_MAX_APPROACH_M) {
    for (const fix of fixes) {
      for (const tp of task.turnpoints) {
        if (
          ellipsoidDistance(fix.latitude, fix.longitude, tp.waypoint.lat, tp.waypoint.lon) <=
          WRONG_PLACE_MAX_APPROACH_M
        ) {
          return null;
        }
      }
    }
  }

  // Firing: one full scan, so the reported nearest approach is the exact one.
  let best = { meters: Infinity, fixIndex: 0, tpIndex: 0 };
  for (let i = 0; i < fixes.length; i++) {
    for (let t = 0; t < task.turnpoints.length; t++) {
      const tp = task.turnpoints[t];
      const d = ellipsoidDistance(
        fixes[i].latitude,
        fixes[i].longitude,
        tp.waypoint.lat,
        tp.waypoint.lon
      );
      if (d < best.meters) best = { meters: d, fixIndex: i, tpIndex: t };
    }
  }
  const tpName = task.turnpoints[best.tpIndex].waypoint.name || `turnpoint ${best.tpIndex + 1}`;

  return {
    id: 'wrong-place',
    severity: 'hard',
    title: 'Track is not at the task location',
    detail:
      `The closest this track comes to any task turnpoint is ${km(best.meters, 1, FINDING_KM)} ` +
      `(to ${tpName}). A track this far from the whole course cannot be a flight of ` +
      `this task.`,
    evidence: {
      id: 'wrong-place',
      nearestApproachMeters: best.meters,
      nearestTurnpointName: tpName,
      nearestTurnpointIndex: best.tpIndex,
      nearestFixIndex: best.fixIndex,
      thresholdMeters: WRONG_PLACE_MAX_APPROACH_M,
    },
  };
}

// ---------------------------------------------------------------------------
// never-left-takeoff (SOFT)
// ---------------------------------------------------------------------------

/**
 * Every fix inside the declared take-off cylinder.
 *
 * SOFT by design: at Corryong the bomb-out landing field is INSIDE the 1 km
 * take-off cylinder, so a pilot who launches, sinks and lands never leaves
 * it — and S7F §5.3 / §9.3 award that pilot minimum distance, correctly.
 * This is a prompt for a scorekeeper to check whether the pilot flew at all,
 * not a scoring input.
 *
 * Two traps, both deliberate:
 *  - Skipped, not fired, when the task declares no TAKEOFF turnpoint. Falling
 *    back to turnpoint 0 would test the SSS cylinder instead, which on such
 *    tasks is 5 km and where "never left" means something else entirely.
 *  - The radius is read from the turnpoint directly, never through the task
 *    optimizer, which deliberately reports a TAKEOFF's effective radius as 0
 *    (the optimised route starts at the centre). Using that would make every
 *    track "leave" at the second fix.
 */
function checkNeverLeftTakeoff(
  fixes: IGCFix[],
  times: number[],
  context: TrackQualityContext
): TrackQualityFinding | null | { skip: string } {
  const task = context.task;
  if (!task) return { skip: 'no task geometry available' };
  const takeoff = task.turnpoints.find((tp) => tp.type === 'TAKEOFF');
  if (!takeoff) return { skip: 'the task declares no take-off turnpoint' };
  if (fixes.length < NEVER_LEFT_TAKEOFF_MIN_FIXES) {
    return { skip: `only ${fixes.length} fixes — too short to judge` };
  }

  const { lat, lon } = takeoff.waypoint;
  let maxDistance = 0;
  for (const fix of fixes) {
    if (!isInsideCylinder(fix.latitude, fix.longitude, lat, lon, takeoff.radius)) return null;
    const d = ellipsoidDistance(fix.latitude, fix.longitude, lat, lon);
    if (d > maxDistance) maxDistance = d;
  }

  const durationSeconds = (times[times.length - 1] - times[0]) / 1000;
  const name = takeoff.waypoint.name || 'the take-off';
  return {
    id: 'never-left-takeoff',
    severity: 'soft',
    title: 'Track never left the take-off cylinder',
    detail:
      `Every fix is inside the ${km(takeoff.radius, 1, FINDING_KM)} ${name} take-off cylinder ` +
      `(furthest ${km(maxDistance, 1, FINDING_KM)} from the centre over ` +
      `${Math.round(durationSeconds / 60)} minutes). That is what a pilot who launched ` +
      `and landed straight back looks like — and it is also what a logger left running ` +
      `on launch looks like.`,
    evidence: {
      id: 'never-left-takeoff',
      takeoffTurnpointName: name,
      radiusMeters: takeoff.radius,
      maxDistanceFromCentreMeters: maxDistance,
      fixCount: fixes.length,
      durationSeconds,
    },
  };
}

// ---------------------------------------------------------------------------
// never-airborne (SOFT) — the drive-to-launch case
// ---------------------------------------------------------------------------

/**
 * Fires when the track shows NEITHER signature of flight: no sustained thermal
 * climb, and no sustained free glide.
 *
 * This is the check that catches a vario left running for the drive up to
 * launch. Every simpler rule fails, and it is worth recording why:
 *
 *  - "No take-off event" fails. detectTakeoffLanding is deliberately
 *    permissive — it passes on any ONE of three criteria — so a vehicle on a
 *    launch road clears its 5 m/s ground-speed bar for two consecutive
 *    intervals with real net displacement, and driving up a 400 m hill clears
 *    its 50 m altitude-gain bar. It reports a take-off for a car. Its verdict
 *    is recorded as evidence here, but it is not the gate.
 *  - Speed alone fails, which is the point the whole check exists for: a
 *    retrieve at 80 km/h beats a paraglider.
 *  - Descent gradient alone fails: a hang glider at trim glides ~8:1, a 12%
 *    gradient, and a mountain road runs 10–15%.
 *  - "It stops" alone fails: a paraglider in a 25 km/h headwind is stationary
 *    over the ground.
 *
 * What separates them is sustained VERTICAL performance plus the geometry of
 * a road. See AIRBORNE_CLIMB_MS and the AIRBORNE_GLIDE_* constants.
 *
 * Known failure modes, both accepted because this is SOFT:
 *  - Missed: a vehicle descending a long straight sealed highway fast enough
 *    to hold 0.8 m/s down with no sub-4 m/s moment for 90 s.
 *  - Flagged: an honest flight shorter than 90 s that never climbed (a blown
 *    launch, a top-landing, a re-launch fragment). Arguably the right answer
 *    to "did this pilot fly?", and it costs only a line of report.
 */
function checkNeverAirborne(fixes: IGCFix[], times: number[]): TrackQualityFinding | null {
  const n = fixes.length;
  const altitudes = fixes.map(fixAltitude);

  // Prefix sum of path length, so a window's straightness is O(1).
  const pathLength = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    pathLength[i] =
      pathLength[i - 1] +
      ellipsoidDistance(
        fixes[i - 1].latitude,
        fixes[i - 1].longitude,
        fixes[i].latitude,
        fixes[i].longitude
      );
  }

  // Instantaneous ground speed into each fix (fix 0 inherits fix 1's).
  const speed = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const dt = (times[i] - times[i - 1]) / 1000;
    speed[i] = dt > 0 ? (pathLength[i] - pathLength[i - 1]) / dt : 0;
  }
  if (n > 1) speed[0] = speed[1];

  let bestClimb = -Infinity;
  let bestGlideSink = -Infinity;
  let bestGlideMinSpeed = 0;
  let bestGlideStraightness = 0;
  let climbFound = false;
  let glideFound = false;

  // S1 — sustained climb. Two-pointer over the climb window.
  let lo = 0;
  for (let i = 0; i < n; i++) {
    while (lo < i && (times[i] - times[lo]) / 1000 > AIRBORNE_CLIMB_SECONDS) lo++;
    if (lo === 0 && (times[i] - times[0]) / 1000 < AIRBORNE_CLIMB_SECONDS) continue;
    const seconds = (times[i] - times[lo]) / 1000;
    if (seconds < AIRBORNE_CLIMB_SECONDS) continue;
    const rate = (altitudes[i] - altitudes[lo]) / seconds;
    if (rate > bestClimb) bestClimb = rate;
    if (rate >= AIRBORNE_CLIMB_MS) climbFound = true;
  }

  // S2 — sustained free glide. The minimum instantaneous speed inside the
  // window is the discriminator; it comes from a monotone deque (indices of
  // increasing speed) so each fix is pushed and evicted at most once — O(N).
  // Rescanning the window per fix was quadratic when dense duplicate
  // timestamps packed tens of thousands of fixes into one 90 s window
  // (issue #471, SEC-33). The deque's front is the exact minimum over
  // (lo, i], so the finding is unchanged on every input.
  lo = 0;
  const glideDeque = new Int32Array(n);
  let dequeHead = 0;
  let dequeTail = 0;
  for (let i = 0; i < n; i++) {
    while (lo < i && (times[i] - times[lo]) / 1000 > AIRBORNE_GLIDE_SECONDS) lo++;
    // Every fix enters the deque, even when this window is still too short —
    // it may sit inside a later window.
    while (dequeTail > dequeHead && speed[glideDeque[dequeTail - 1]] >= speed[i]) dequeTail--;
    glideDeque[dequeTail++] = i;
    const seconds = (times[i] - times[lo]) / 1000;
    if (seconds < AIRBORNE_GLIDE_SECONDS) continue;

    const sink = (altitudes[lo] - altitudes[i]) / seconds;
    while (glideDeque[dequeHead] <= lo) dequeHead++; // the window is (lo, i]
    const minSpeed = speed[glideDeque[dequeHead]];
    const path = pathLength[i] - pathLength[lo];
    const displacement = ellipsoidDistance(
      fixes[lo].latitude,
      fixes[lo].longitude,
      fixes[i].latitude,
      fixes[i].longitude
    );
    const straightness = path > 0 ? displacement / path : 0;

    if (sink > bestGlideSink) {
      bestGlideSink = sink;
      bestGlideMinSpeed = minSpeed === Infinity ? 0 : minSpeed;
      bestGlideStraightness = straightness;
    }
    if (
      sink >= AIRBORNE_GLIDE_SINK_MS &&
      minSpeed >= AIRBORNE_GLIDE_MIN_SPEED_MS &&
      straightness >= AIRBORNE_GLIDE_STRAIGHTNESS
    ) {
      glideFound = true;
      break;
    }
  }

  if (climbFound || glideFound) return null;

  let maxGain = 0;
  for (const a of altitudes) if (a - altitudes[0] > maxGain) maxGain = a - altitudes[0];
  const takeoffDetected =
    detectTakeoffLandingIndices(fixes, DEFAULT_THRESHOLDS).takeoff !== null;

  return {
    id: 'never-airborne',
    severity: 'soft',
    title: 'Track shows no sign of flight',
    detail:
      `Nothing in this track looks like flying: the best sustained climb is ` +
      `${finiteOrDash(bestClimb, 2)} m/s over ${AIRBORNE_CLIMB_SECONDS} s (a glider does ` +
      `${AIRBORNE_CLIMB_MS} m/s), and the best sustained glide sinks ` +
      `${finiteOrDash(bestGlideSink, 2)} m/s at a minimum ground speed of ` +
      `${finiteOrDash(bestGlideMinSpeed, 1)} m/s with ` +
      `${(bestGlideStraightness * 100).toFixed(0)}% straightness. That is the profile of a ` +
      `vehicle — a vario left recording the drive to launch — rather than a flight.`,
    evidence: {
      id: 'never-airborne',
      takeoffDetected,
      bestSustainedClimbMs: Number.isFinite(bestClimb) ? bestClimb : 0,
      bestGlideSinkMs: Number.isFinite(bestGlideSink) ? bestGlideSink : 0,
      bestGlideMinSpeedMs: bestGlideMinSpeed,
      bestGlideStraightness,
      maxAltitudeGainAboveStartMeters: maxGain,
    },
  };
}

function finiteOrDash(value: number, digits: number): string {
  return Number.isFinite(value) ? value.toFixed(digits) : '—';
}

// ---------------------------------------------------------------------------
// implausible-speed (SOFT)
// ---------------------------------------------------------------------------

/**
 * Ground speed sustained over a full minute, measured as STRAIGHT-LINE
 * DISPLACEMENT over elapsed time.
 *
 * An instantaneous rule is useless here and would be actively harmful: at
 * 1 Hz, ±20 m of GNSS horizontal jitter produces 20 m/s "speeds" between
 * adjacent fixes, and one bad fix produces two such intervals (out and back).
 * altitude-cleaning.ts repairs the VERTICAL channel only — nothing upstream
 * has touched the horizontal one. takeoff-landing-detector.ts documents the
 * same failure and defends against it the same way.
 *
 * Displacement rather than path length is the second half of that defence:
 * endpoint jitter is a bounded error divided by 60 s (under 0.7 m/s), whereas
 * path length ACCUMULATES jitter across every fix in the window and would
 * inflate every track. Displacement also cannot be inflated by circling,
 * which is correct — the question is whether the thing in the file TRAVELLED
 * implausibly fast.
 *
 * Runs over the whole track, not the airborne slice: a drive spliced onto a
 * flight is exactly what this should see.
 */
function checkImplausibleSpeed(
  fixes: IGCFix[],
  times: number[],
  context: TrackQualityContext
): TrackQualityFinding | null | { skip: string } {
  const n = fixes.length;
  const spanSeconds = (times[n - 1] - times[0]) / 1000;
  if (spanSeconds < SPEED_MIN_WINDOW_SECONDS) {
    return { skip: `the track spans only ${Math.round(spanSeconds)} s` };
  }

  const category = context.category ?? 'pg';
  const threshold = category === 'hg' ? MAX_SUSTAINED_SPEED_HG_MS : MAX_SUSTAINED_SPEED_PG_MS;

  let best = { speed: 0, lo: 0, hi: 0 };
  let lo = 0;
  let measured = false;
  for (let i = 0; i < n; i++) {
    while (lo < i && (times[i] - times[lo]) / 1000 > SPEED_WINDOW_SECONDS) lo++;
    const seconds = (times[i] - times[lo]) / 1000;
    if (seconds < SPEED_MIN_WINDOW_SECONDS) continue;
    measured = true;
    const displacement = ellipsoidDistance(
      fixes[lo].latitude,
      fixes[lo].longitude,
      fixes[i].latitude,
      fixes[i].longitude
    );
    const speed = displacement / seconds;
    if (speed > best.speed) best = { speed, lo, hi: i };
  }
  if (!measured) return { skip: 'the logger records too coarsely to measure sustained speed' };
  if (best.speed <= threshold) return null;

  return {
    id: 'implausible-speed',
    severity: 'soft',
    title: 'Track reaches a speed no glider sustains',
    detail:
      `The track covers ground at ${(best.speed * 3.6).toFixed(0)} km/h sustained over ` +
      `${SPEED_WINDOW_SECONDS} s (${formatUtcDateTime(times[best.lo])} to ` +
      `${formatUtcDateTime(times[best.hi])} UTC). The fastest a ` +
      `${category === 'hg' ? 'hang glider' : 'paraglider'} holds over the ground for a ` +
      `full minute, tailwind included, is about ${(threshold * 3.6).toFixed(0)} km/h. ` +
      `This section of the file may not have been flown.`,
    evidence: {
      id: 'implausible-speed',
      maxSustainedSpeedMs: best.speed,
      thresholdMs: threshold,
      category,
      windowSeconds: SPEED_WINDOW_SECONDS,
      startMs: times[best.lo],
      endMs: times[best.hi],
      startFixIndex: best.lo,
      endFixIndex: best.hi,
    },
  };
}
