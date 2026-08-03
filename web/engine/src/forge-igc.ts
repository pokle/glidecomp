/**
 * Forge a tracklog that flies a real task.
 *
 * It exists so track submission can be exercised end to end without anybody
 * going flying. Making a file that PARSES is easy; making one that is ACCEPTED
 * is not. The upload path checks the file's shape (SEC-04), and then
 * track-quality.ts asks whether the flight happened on the task's day and at
 * the task's place. A tracklog that fails either is stored and then withheld
 * from scoring — useless for testing the happy path, and indistinguishable
 * from a bug while you are looking at it.
 *
 * So this synthesises a flight that actually flies the route, on the day, at
 * plausible speeds. It can also deliberately break either check, because the
 * warning paths need testing too and they are the hard ones to reach.
 *
 * Pure and DOM-free, like the rest of the engine: the CLI (`bun run
 * forge-igc`) and the super-admin dialog on the task page both drive it, and
 * both verify the result with `parseIGC` + `assessTrackQuality` — the same
 * code the worker runs. A clean verdict here means the file will be accepted,
 * not that it looks plausible.
 *
 * An OPEN-DISTANCE task has no route to follow — one take-off cylinder, no
 * goal, and therefore no optimised line to measure a land-out along. Those
 * tasks get their own course, invented here: off in a random direction, as far
 * as was asked for. See {@link openDistanceCourse}.
 */

import {
  andoyerDistance,
  calculateBearingRadians,
  destinationPoint,
} from './geo';
import {
  isOpenDistanceTask,
  openDistanceGeometryForFlight,
} from './open-distance-scoring';
import { calculateOptimizedTaskLine } from './task-optimizer';
import type { XCTask } from './xctsk-parser';

/** A turnpoint reduced to what flying it needs. */
export interface ForgeTurnpoint {
  lat: number;
  lon: number;
  /** Metres. The flight aims to get comfortably inside. */
  radius: number;
  /** Ground elevation, metres. Drives launch height and the landing. */
  alt: number;
  name: string;
}

export interface ForgeOptions {
  pilot: string;
  glider: string;
  /** Seconds past the header date's UTC midnight for the first fix. */
  startSec: number;
  /** Seconds between fixes. */
  rate: number;
  /** Cruise speed on glide. */
  speedKmh: number;
  /** The date stamped into HFDTE, and the base for every B record's clock. */
  headerDate: Date;
  /**
   * Land out after this many metres ALONG THE COURSE, instead of flying it
   * all. Null or undefined flies the lot.
   *
   * Measured along the optimised task line, which is the same geometry the
   * scorer measures — so the number chosen here is the distance the pilot
   * will be scored for, not merely a distance they travelled. That is the
   * whole point: a land-out is only a useful fixture if you can say in advance
   * what it should score.
   */
  stopAfterMeters?: number | null;
  /**
   * Injectable so a test can be deterministic. The randomness jitters the
   * fixes on the ground, which is what stops the takeoff detector seeing a
   * perfectly stationary point, and on an open-distance task it also picks the
   * direction flown — but a test that cannot predict its own fixture is a test
   * that can only assert vagueness.
   */
  random?: () => number;
}

/** What a forged flight is judged on, so a caller can show it. */
export interface ForgedTrack {
  text: string;
  fixCount: number;
}

interface Pt {
  lat: number;
  lon: number;
}

interface Fix extends Pt {
  t: number;
  alt: number;
}

/** Pull the flyable turnpoints out of a task's own route. */
export function turnpointsFromTask(task: XCTask): ForgeTurnpoint[] {
  return task.turnpoints.map((tp) => ({
    lat: tp.waypoint.lat,
    lon: tp.waypoint.lon,
    radius: tp.radius || 400,
    alt: tp.waypoint.altSmoothed ?? 500,
    name: tp.waypoint.name,
  }));
}

/**
 * A point `metres` along the great circle from `p` towards `q`.
 *
 * Ellipsoid maths from geo.ts rather than the lat/lon interpolation this
 * started life as: a linear blend is wrong away from the equator, and the
 * whole value of a forged track is that the engine agrees it flew the route.
 */
function towards(p: Pt, q: Pt, metres: number): Pt {
  if (andoyerDistance(p.lat, p.lon, q.lat, q.lon) < 1) return { lat: p.lat, lon: p.lon };
  const bearing = calculateBearingRadians(p.lat, p.lon, q.lat, q.lon);
  return destinationPoint(p.lat, p.lon, metres, bearing);
}

function gap(a: Pt, b: Pt): number {
  return andoyerDistance(a.lat, a.lon, b.lat, b.lon);
}

// ── IGC encoding (must satisfy the engine's own B_RECORD_RE) ───────────────

function encLat(v: number): string {
  const h = v < 0 ? 'S' : 'N';
  const abs = Math.abs(v);
  const d = Math.floor(abs);
  return (
    String(d).padStart(2, '0') +
    String(Math.round((abs - d) * 60 * 1000)).padStart(5, '0') +
    h
  );
}

function encLon(v: number): string {
  const h = v < 0 ? 'W' : 'E';
  const abs = Math.abs(v);
  const d = Math.floor(abs);
  return (
    String(d).padStart(3, '0') +
    String(Math.round((abs - d) * 60 * 1000)).padStart(5, '0') +
    h
  );
}

function encAlt(a: number): string {
  return String(Math.min(Math.max(0, Math.round(a)), 99999)).padStart(5, '0');
}

function hhmmss(seconds: number): string {
  const s = ((seconds % 86400) + 86400) % 86400;
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), Math.floor(s % 60)]
    .map((n) => String(n).padStart(2, '0'))
    .join('');
}

// ── the flight ─────────────────────────────────────────────────────────────

/**
 * The optimised task line, and how long it is.
 *
 * This is the geometry the SCORER measures — the shortest legal way through
 * the cylinders — so a flight that follows it covers scored distance at the
 * same rate it covers ground. Flying waypoint centre to waypoint centre, as
 * this used to, is both longer and not what anybody is credited with, which
 * makes "land out after 40 km" unanswerable.
 */
export function courseFor(task: XCTask): { points: Pt[]; totalMeters: number } {
  const points = calculateOptimizedTaskLine(task);
  let totalMeters = 0;
  for (let i = 1; i < points.length; i++) {
    totalMeters += gap(points[i - 1], points[i]);
  }
  return { points, totalMeters };
}

// ── open distance: there is no route, so invent one ────────────────────────

/**
 * The furthest an open-distance forge will fly, metres.
 *
 * An open-distance task has no goal, so nothing in the data says how far is
 * far enough — the range has to be picked rather than derived. 250 km is past
 * any Australian flat-land record on a hang glider and well past what a
 * fabricated fixture needs, so it bounds the slider without bounding what
 * anyone would actually test.
 */
export const OPEN_DISTANCE_MAX_METERS = 250_000;

/** What an open-distance forge flies when nothing is asked for, metres. */
export const OPEN_DISTANCE_DEFAULT_METERS = 80_000;

/**
 * How far this task's forge may be asked to fly, and what to ask for by
 * default — the slider's range on the dialog, and the CLI's default.
 *
 * A GAP task answers both from its own geometry: the optimised line is the
 * whole task, and flying all of it is making goal. An open-distance task has
 * neither, and asking `courseFor` gives a one-point line of zero length — a
 * slider whose minimum, maximum and value are all zero, which is where the NaN
 * came from. So it is answered here instead, once, for every caller.
 */
export function forgeRange(task: XCTask): {
  maxMeters: number;
  defaultMeters: number;
  openDistance: boolean;
} {
  if (isOpenDistanceTask(task)) {
    return {
      maxMeters: OPEN_DISTANCE_MAX_METERS,
      defaultMeters: OPEN_DISTANCE_DEFAULT_METERS,
      openDistance: true,
    };
  }
  const { totalMeters } = courseFor(task);
  return { maxMeters: totalMeters, defaultMeters: totalMeters, openDistance: false };
}

/**
 * Invent a course for an open-distance task: out from the take-off cylinder on
 * a random bearing, wandering the way a pilot hunting thermals does, landing
 * `meters` beyond the cylinder edge.
 *
 * That last distance is the point. Open-distance scoring credits the FURTHEST
 * fix's distance from the take-off centre, minus the radius
 * (`openDistanceForFlight`), so a course whose landing is its furthest point,
 * placed at `radius + meters` from the centre, scores exactly what was asked
 * for — the same contract the land-out slider has on a GAP task.
 *
 * Which is why the wander is bounded rather than free: each intermediate point
 * is kept provably nearer the centre than the landing is, or a mid-flight
 * detour would quietly become the scored distance instead.
 */
export function openDistanceCourse(
  task: XCTask,
  meters: number,
  rnd: () => number
): { points: Pt[]; bearing: number } {
  const tp = task.turnpoints[0];
  if (!tp) throw new Error('An open-distance task needs a take-off turnpoint');
  const centre = { lat: tp.waypoint.lat, lon: tp.waypoint.lon };
  const radius = tp.radius || 400;

  const bearing = rnd() * 2 * Math.PI;
  // Launched somewhere in the paddock rather than on the exact centre mark.
  const start = destinationPoint(
    centre.lat,
    centre.lon,
    Math.min(radius * 0.2, 900) * rnd(),
    rnd() * 2 * Math.PI
  );
  // At zero the pilot never leaves the cylinder — land INSIDE the edge, so the
  // file is the "landed in the launch paddock, scored nothing" fixture rather
  // than one that scores a stray metre of GPS noise.
  const landingRadius = meters > 0 ? radius + meters : Math.max(radius * 0.5, radius - 200);
  const finish = destinationPoint(centre.lat, centre.lon, landingRadius, bearing);

  const startRadius = gap(centre, start);
  const span = landingRadius - startRadius;
  // A leg every ~12 km, which is about one glide between thermals — enough for
  // the search to look like one, not so many that the track is a scribble.
  const legs = Math.max(1, Math.min(24, Math.round(span / 12_000)));
  const points: Pt[] = [start];
  for (let i = 1; i < legs; i++) {
    const along = startRadius + (span * i) / legs;
    // The furthest this point may sit off the axis and still be at least 250 m
    // nearer the centre than the landing: √(r² − along²) by Pythagoras, which
    // is exact enough at these distances.
    const headroom = Math.sqrt(
      Math.max(0, (landingRadius - 250) ** 2 - along * along)
    );
    const off = (rnd() - 0.5) * 2 * Math.min(2_500, span * 0.12, headroom);
    const axis = destinationPoint(centre.lat, centre.lon, along, bearing);
    points.push(
      Math.abs(off) < 1
        ? axis
        : destinationPoint(
            axis.lat,
            axis.lon,
            Math.abs(off),
            bearing + (off >= 0 ? Math.PI / 2 : -Math.PI / 2)
          )
    );
  }
  points.push(finish);
  return { points, bearing };
}

/**
 * Cut the course short at `meters`, landing wherever that falls.
 *
 * Returns the points actually to be flown, so a land-out ends in mid-leg at
 * the right place rather than at the nearest turnpoint.
 */
function truncateCourse(points: Pt[], meters: number): Pt[] {
  if (points.length < 2) return points;
  const flown: Pt[] = [points[0]];
  let left = meters;
  for (let i = 1; i < points.length; i++) {
    const leg = gap(points[i - 1], points[i]);
    if (left >= leg) {
      flown.push(points[i]);
      left -= leg;
      continue;
    }
    if (left > 0) flown.push(towards(points[i - 1], points[i], left));
    return flown;
  }
  return flown;
}

/**
 * Launch, climb out, then follow the course: glide towards the next point,
 * thermal back up when it gets low. Finishes with a descent and a stint on
 * the ground, which is what makes the landing detectable — without it the
 * flight summary has no duration to report.
 */
export function buildFlight(
  course: Pt[],
  opts: Pick<ForgeOptions, 'rate' | 'speedKmh' | 'startSec'> & {
    /** Ground elevation at launch, and at the landing. */
    groundAlt: number;
    landAlt: number;
    random?: () => number;
  }
): Fix[] {
  if (course.length < 2) throw new Error('A task needs at least two turnpoints');

  const rnd = opts.random ?? Math.random;
  const step = opts.rate;
  const cruise = opts.speedKmh / 3.6;
  const climbRate = 2.2; // m/s, an ordinary thermal
  const sink = -1.15; // m/s on glide
  const groundAlt = opts.groundAlt || 500;
  const floor = groundAlt + 350;
  // Clamped absolutely, not just relative to launch: a task whose waypoints
  // carry odd altitudes would otherwise produce a flight topping out in the
  // flight levels, and a fabricated track nobody believes is no use for
  // testing what a pilot sees.
  const ceiling = Math.min(groundAlt + 1900, 4200);

  const fixes: Fix[] = [];
  let t = opts.startSec;
  let alt = groundAlt;
  let pos: Pt = { lat: course[0].lat, lon: course[0].lon };
  const push = () => fixes.push({ t, lat: pos.lat, lon: pos.lon, alt });

  // On the hill. The takeoff detector averages the first ten fixes for its
  // ground altitude, so there has to be a ground to start from.
  for (let i = 0; i < Math.ceil(120 / step); i++) {
    pos = {
      lat: course[0].lat + (rnd() - 0.5) * 2e-5,
      lon: course[0].lon + (rnd() - 0.5) * 2e-5,
    };
    push();
    t += step;
  }

  // Climb-out: clears minAltitudeGain (50 m) and minGroundSpeed (5 m/s), so
  // takeoff is unambiguous. Even a pilot who lands at launch has to leave it
  // first, or there is no flight to detect at all.
  const heading = course.find((p) => gap(p, course[0]) > 50) ?? course[1];
  while (alt < groundAlt + 600) {
    alt += climbRate * step;
    // Never past the point being flown to. On a long course the climb-out is a
    // couple of kilometres of nothing; on a short one — a pilot asked to land
    // just outside the take-off cylinder — flying through the landing would
    // hand them kilometres they were not asked to fly, and on open distance
    // that is scored distance.
    pos = towards(pos, heading, Math.min(8 * step, gap(pos, heading)));
    push();
    t += step;
    if (t - opts.startSec > 8 * 3600) break;
  }

  let climbing = false;
  for (let i = 1; i < course.length; i++) {
    const to = course[i];
    if (gap(pos, to) < 30) continue;
    // Following a line rather than aiming at cylinder centres, so the
    // tolerance is one cruise step — enough not to oscillate around a vertex.
    const reach = Math.max(30, cruise * step);
    let guard = 0;
    while (gap(pos, to) > reach && guard++ < 20000) {
      if (climbing) {
        alt += climbRate * step;
        pos = towards(pos, to, 1.5 * step); // circling drifts, barely advances
        if (alt >= ceiling) climbing = false;
      } else {
        alt += sink * step;
        pos = towards(pos, to, cruise * step);
        if (alt <= floor) climbing = true;
      }
      push();
      t += step;
    }
  }

  // Down, where they got to. A land-out lands mid-leg; a completed task lands
  // at goal. Descending in place keeps the landing at the distance flown
  // rather than adding free kilometres on the way down.
  const landAlt = (opts.landAlt || groundAlt) + 5;
  while (alt > landAlt) {
    alt = Math.max(landAlt, alt + sink * 1.3 * step);
    pos = {
      lat: pos.lat + (rnd() - 0.5) * 1e-5,
      lon: pos.lon + (rnd() - 0.5) * 1e-5,
    };
    push();
    t += step;
  }
  for (let i = 0; i < Math.ceil(90 / step); i++) {
    pos = {
      lat: pos.lat + (rnd() - 0.5) * 1.5e-5,
      lon: pos.lon + (rnd() - 0.5) * 1.5e-5,
    };
    push();
    t += step;
  }

  return fixes;
}

function toIgcText(
  fixes: Fix[],
  headerDate: Date,
  o: Pick<ForgeOptions, 'pilot' | 'glider'>,
  site: string
): string {
  const dd = String(headerDate.getUTCDate()).padStart(2, '0');
  const mm = String(headerDate.getUTCMonth() + 1).padStart(2, '0');
  const yy = String(headerDate.getUTCFullYear() % 100).padStart(2, '0');
  const lines = [
    // Must begin with an A record and contain "HFDTE" — the worker's SEC-04
    // content check rejects anything else before it reaches R2.
    'AXGCFRG GlideComp IGC Forge',
    `HFDTE${dd}${mm}${yy}`,
    `HFPLTPILOTINCHARGE:${o.pilot}`,
    `HFGTYGLIDERTYPE:${o.glider}`,
    'HFGIDGLIDERID:FORGE',
    'HFDTMGPSDATUM:WGS-84',
    `HFSITSITE:${site}`,
  ];
  for (const f of fixes) {
    lines.push(
      `B${hhmmss(f.t)}${encLat(f.lat)}${encLon(f.lon)}A${encAlt(f.alt)}${encAlt(f.alt)}`
    );
  }
  return lines.join('\r\n') + '\r\n';
}

/**
 * Which data-quality check to deliberately fail, if any.
 *
 * These are not "invalid files" — they parse and upload fine. They are files
 * that track-quality.ts will withhold from scoring, which is the state worth
 * being able to reach on demand.
 */
export type ForgeSabotage = 'none' | 'day' | 'place';

/** What a forged flight is judged on, so a caller can show it. */
export interface ForgeResult extends ForgedTrack {
  /**
   * The distance the pilot should be credited with, metres: how far along the
   * optimised line they got on a GAP task, and how far beyond the take-off
   * cylinder they landed on an open-distance one.
   */
  courseMeters: number;
  /** The top of that range — the whole task, or the open-distance maximum. */
  taskMeters: number;
  /** True when the task had no route and the course was invented. */
  openDistance: boolean;
}

/**
 * Apply the sabotage, if any, and write the file. Shared by both courses, so
 * the deliberate failures behave the same whichever kind of task was flown.
 */
function deliver(
  fixes: Fix[],
  opts: ForgeOptions & { sabotage?: ForgeSabotage },
  site: string
): ForgedTrack {
  let out = fixes;
  const headerDate = new Date(opts.headerDate.getTime());

  if (opts.sabotage === 'place') {
    // Far enough to clear the 100 km the wrong-place check allows, and in
    // longitude so the latitude-dependent maths stays honest.
    out = out.map((f) => ({ ...f, lon: f.lon + 16 }));
  }
  if (opts.sabotage === 'day') {
    // A fortnight, not a day: a one-day offset is SOFT (a logger with its date
    // set wrong), and only a bigger gap is a hard "different flight".
    headerDate.setUTCDate(headerDate.getUTCDate() - 14);
  }

  return { text: toIgcText(out, headerDate, opts, site), fixCount: out.length };
}

/**
 * Forge a flight for a task with no route: off in a random direction from the
 * take-off cylinder, landing `stopAfterMeters` beyond its edge.
 *
 * The reported distance is not the number that was asked for — it is measured
 * back off the finished fixes with `openDistanceGeometryForFlight`, the very
 * routine the scorer uses. The two agree to a metre or so, and having them
 * come from different places is what makes the agreement worth anything.
 */
function forgeOpenDistance(
  task: XCTask,
  opts: ForgeOptions & { sabotage?: ForgeSabotage }
): ForgeResult {
  const rnd = opts.random ?? Math.random;
  const tps = turnpointsFromTask(task);
  const target = Math.max(
    0,
    Math.min(opts.stopAfterMeters ?? OPEN_DISTANCE_DEFAULT_METERS, OPEN_DISTANCE_MAX_METERS)
  );
  const { points } = openDistanceCourse(task, target, rnd);

  const fixes = buildFlight(points, {
    ...opts,
    random: rnd,
    groundAlt: tps[0].alt,
    // Flat country by definition — an open-distance day is flown to a paddock
    // somewhere downwind, and the launch elevation is the only honest guess
    // for how high that paddock is.
    landAlt: tps[0].alt,
  });

  const geometry = openDistanceGeometryForFlight(task, {
    pilotName: opts.pilot,
    trackFile: 'forge.igc',
    fixes: fixes.map((f) => ({
      latitude: f.lat,
      longitude: f.lon,
      pressureAltitude: f.alt,
      gnssAltitude: f.alt,
      time: new Date(f.t * 1000),
      valid: true,
    })),
  });

  return {
    ...deliver(fixes, opts, tps[0].name),
    courseMeters: geometry?.distance ?? 0,
    taskMeters: OPEN_DISTANCE_MAX_METERS,
    openDistance: true,
  };
}

/**
 * Forge a flight over `task`'s optimised line, returning the IGC text.
 *
 * Takes the task rather than turnpoints so the course is derived here: a
 * caller that passed centre-to-centre turnpoints would silently get a flight
 * whose distance does not match what the scorer will credit. A task with no
 * route to optimise — open distance — is flown by {@link forgeOpenDistance}
 * instead.
 */
export function forgeIgc(
  task: XCTask,
  opts: ForgeOptions & { sabotage?: ForgeSabotage }
): ForgeResult {
  if (isOpenDistanceTask(task)) return forgeOpenDistance(task, opts);

  const tps = turnpointsFromTask(task);
  const { points, totalMeters } = courseFor(task);
  if (points.length < 2) throw new Error('A task needs at least two turnpoints');

  const target =
    opts.stopAfterMeters == null
      ? totalMeters
      : Math.max(0, Math.min(opts.stopAfterMeters, totalMeters));
  let flown = target >= totalMeters ? points : truncateCourse(points, target);
  if (flown.length < 2) {
    // Zero distance is a real outcome — launched, never connected, landed on
    // the hill — so it has to FLY, not throw. Out a little way and back, which
    // is what sinking out looks like; landing at the launch point is what
    // makes the distance nothing.
    flown = [points[0], towards(points[0], points[1], 800), points[0]];
  }

  // Where they came down: goal's ground when the task was completed, else the
  // launch elevation, which is the only honest guess for a paddock mid-course.
  const landAlt =
    target >= totalMeters ? tps[tps.length - 1].alt : tps[0].alt;

  const fixes = buildFlight(flown, {
    ...opts,
    groundAlt: tps[0].alt,
    landAlt,
  });

  return {
    ...deliver(fixes, opts, tps[0].name),
    courseMeters: target,
    taskMeters: totalMeters,
    openDistance: false,
  };
}

/**
 * The competition's UTC offset on a given date, to the nearest half hour.
 *
 * Take-off is chosen as a local wall clock, but the wrong-day check judges the
 * fixes against the task's day IN THE COMPETITION'S ZONE — so a forged flight
 * has to be placed using that same zone or it lands on the wrong side of
 * midnight for half the world.
 */
export function zoneOffsetHours(isoDate: string, timeZone: string): number {
  const probe = new Date(`${isoDate}T12:00:00Z`);
  const asUtc = new Date(probe.toLocaleString('en-US', { timeZone: 'UTC' }));
  const asZone = new Date(probe.toLocaleString('en-US', { timeZone }));
  return Math.round(((asZone.getTime() - asUtc.getTime()) / 3600000) * 2) / 2;
}

/** Seconds past the header date's UTC midnight for a local "HH:MM" take-off. */
export function startSecondsFor(
  localHHMM: string,
  isoDate: string,
  timeZone: string
): number {
  const [h, m] = localHHMM.split(':').map(Number);
  const offset = zoneOffsetHours(isoDate, timeZone);
  return (h || 0) * 3600 + (m || 0) * 60 - offset * 3600;
}
