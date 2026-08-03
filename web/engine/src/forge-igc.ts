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
 */

import {
  andoyerDistance,
  calculateBearingRadians,
  destinationPoint,
} from './geo';
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
   * Injectable so a test can be deterministic. The randomness only jitters the
   * fixes on the ground, which is what stops the takeoff detector seeing a
   * perfectly stationary point — but a test that cannot predict its own
   * fixture is a test that can only assert vagueness.
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
    pos = towards(pos, heading, 8 * step);
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
  /** How far along the optimised course the pilot actually got, metres. */
  courseMeters: number;
  /** The whole task, metres — the top of the land-out range. */
  taskMeters: number;
}

/**
 * Forge a flight over `task`'s optimised line, returning the IGC text.
 *
 * Takes the task rather than turnpoints so the course is derived here: a
 * caller that passed centre-to-centre turnpoints would silently get a flight
 * whose distance does not match what the scorer will credit.
 */
export function forgeIgc(
  task: XCTask,
  opts: ForgeOptions & { sabotage?: ForgeSabotage }
): ForgeResult {
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

  let fixes = buildFlight(flown, {
    ...opts,
    groundAlt: tps[0].alt,
    landAlt,
  });
  const headerDate = new Date(opts.headerDate.getTime());

  if (opts.sabotage === 'place') {
    // Far enough to clear the 100 km the wrong-place check allows, and in
    // longitude so the latitude-dependent maths stays honest.
    fixes = fixes.map((f) => ({ ...f, lon: f.lon + 16 }));
  }
  if (opts.sabotage === 'day') {
    // A fortnight, not a day: a one-day offset is SOFT (a logger with its date
    // set wrong), and only a bigger gap is a hard "different flight".
    headerDate.setUTCDate(headerDate.getUTCDate() - 14);
  }

  return {
    text: toIgcText(fixes, headerDate, opts, tps[0].name),
    fixCount: fixes.length,
    courseMeters: target,
    taskMeters: totalMeters,
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
