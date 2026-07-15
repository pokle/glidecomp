#!/usr/bin/env bun
// Copyright (c) 2026, Tushar Pokle.  All rights reserved.
/**
 * Generate the synthetic "Kosciuszko Loop" out-and-return sample competition.
 *
 * A fabricated GAP race-to-goal comp centred on Mount Kosciuszko (NSW, 2228 m),
 * built to demonstrate — and exercise the scoring of — OUT-AND-RETURN tasks with
 * EXIT turnpoints (issue #347). In an out-and-return the field launches at the
 * centre, flies OUT across one or more big cylinders (reached by crossing their
 * boundary outward — "exit" turnpoints), turns, and flies back IN to a goal at
 * the centre. The direction of each cylinder is inferred from the geometry, so
 * these tasks light up the Direction column and the map arrowheads, and their
 * scores show the fix in action (a pilot who never flies out of the big ring
 * scores their outbound distance, NOT a near-goal result).
 *
 * Three tasks, one shared 44-pilot field (so the comp standings aggregate):
 *   Task 1 "Grand Loop"  — one 10 km exit ring. The classic #347 shape.
 *   Task 2 "Double Ring" — two concentric exit rings (5 km + 11 km) in sequence.
 *   Task 3 "Ridge Run"   — a point-to-point control: all ENTER turnpoints, no
 *                          exit ring, to show the contrast and guard regressions.
 *
 * Each field spans the edge cases on purpose: pilots who make goal, who tag the
 * ring then land on the way home, who never fly out of the ring (land out), and
 * who never even cross the start.
 *
 * Deterministic: a seeded PRNG makes re-running produce byte-identical files, so
 * the generator is safe to re-run and commit. Regenerate with:
 *   bun web/scripts/generate-kosci-loop.ts
 *
 * Load it with the seed script:
 *   bun run seed:sample kosci-loop
 */

import { mkdirSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  destinationPoint,
  andoyerDistance,
  calculateBearingRadians,
  parseXCTask,
  resolveTurnpointSequence,
  computeTurnpointDirections,
  type XCTask,
} from '@glidecomp/engine';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const COMPS_ROOT = join(REPO_ROOT, 'web/samples/comps');

// Mount Kosciuszko — the shared centre of every out-and-return. Alpine summit
// at 2228 m; pilots launch here, loop out over the surrounding ranges and
// return to a goal on the summit.
const KOSCI = { name: 'KOSCI', description: 'Mount Kosciuszko', lat: -36.455825, lon: 148.263502, alt: 2228 };

// Named alpine points for the point-to-point control task (real peaks/lakes
// near Kosciuszko, approximate coordinates).
const POINTS = {
  TOWNSD: { name: 'TOWNSD', description: 'Mount Townsend', lat: -36.4250, lon: 148.2450, alt: 2209 },
  BLULAK: { name: 'BLULAK', description: 'Blue Lake', lat: -36.4083, lon: 148.2917, alt: 1890 },
  RAMSHD: { name: 'RAMSHD', description: 'Rams Head', lat: -36.5083, lon: 148.2967, alt: 2190 },
  THREDB: { name: 'THREDB', description: 'Thredbo Top', lat: -36.5010, lon: 148.3020, alt: 1930 },
};

const DEG = Math.PI / 180;

// --- deterministic PRNG ----------------------------------------------------

/** mulberry32 — small, fast, seedable PRNG for reproducible sample data. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Inverse standard-normal CDF (probit) — Acklam's rational approximation. Lays
 * the field out on a bell curve deterministically (no RNG needed for the shape).
 */
function probit(p: number): number {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239e0];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0, -2.549732539343734e0, 4.374664141464968e0, 2.938163982698783e0];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0, 3.754408661907416e0];
  const plow = 0.02425;
  const phigh = 1 - plow;
  if (p < plow) {
    const qq = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * qq + c[1]) * qq + c[2]) * qq + c[3]) * qq + c[4]) * qq + c[5]) / ((((d[0] * qq + d[1]) * qq + d[2]) * qq + d[3]) * qq + 1);
  }
  if (p <= phigh) {
    const qq = p - 0.5;
    const r = qq * qq;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * qq / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  const qq = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * qq + c[1]) * qq + c[2]) * qq + c[3]) * qq + c[4]) * qq + c[5]) / ((((d[0] * qq + d[1]) * qq + d[2]) * qq + d[3]) * qq + 1);
}

// --- pilots ----------------------------------------------------------------

const FIRST_NAMES = [
  'James', 'Sarah', 'Liam', 'Olivia', 'Noah', 'Emma', 'Jack', 'Ava', 'William', 'Mia',
  'Ethan', 'Grace', 'Lucas', 'Chloe', 'Henry', 'Zoe', 'Oliver', 'Ruby', 'Thomas', 'Isla',
  'Charlie', 'Ella', 'Max', 'Lily', 'Leo', 'Amelia', 'Hugo', 'Poppy', 'Finn', 'Scarlett',
  'Archie', 'Freya', 'George', 'Willow', 'Harry', 'Evie', 'Oscar', 'Matilda', 'Jasper', 'Harper',
  'Toby', 'Georgia', 'Angus', 'Maya',
];
const LAST_NAMES = [
  'Abbott', 'Baker', 'Chen', 'Dixon', 'Evans', 'Fraser', 'Grant', 'Hughes', 'Irwin', 'Jensen',
  'Kelly', 'Lowe', 'Murphy', 'Nolan', 'OConnor', 'Patel', 'Quinn', 'Reid', 'Singh', 'Turner',
  'Underwood', 'Vaughan', 'Walker', 'Xu', 'Young', 'Zammit', 'Armstrong', 'Boyle', 'Carter', 'Doyle',
  'Ellison', 'Foster', 'Gibson', 'Harding', 'Ingram', 'Jarvis', 'Knight', 'Larsen', 'Mercer', 'Newton',
  'Osborne', 'Palmer', 'Rankin', 'Sutton',
];
const N_PILOTS = 44;

// Paragliders — Kosciuszko is a foot-launch alpine site.
const GLIDERS = [
  'Ozone Zeno 2', 'Advance Omega ULS', 'Gin Leopard', 'Niviuk Icepeak Evox',
  'Ozone Enzo 3', 'Advance Sigma 11', 'Gin Bonanza 3', 'Niviuk Artik 6',
  'Ozone Delta 4', 'Advance Iota 2', 'Gin Explorer 2', 'Niviuk Ikuma 3',
];

interface Pilot {
  name: string;
  surname: string;
  civl: number;
  email: string;
  glider: string;
}

function buildPilots(): Pilot[] {
  const pilots: Pilot[] = [];
  for (let i = 0; i < N_PILOTS; i++) {
    const first = FIRST_NAMES[i];
    const last = LAST_NAMES[i];
    pilots.push({
      name: `${first} ${last}`,
      surname: last,
      civl: 200201 + i,
      email: `${first}.${last}`.toLowerCase().replace(/[^a-z.]/g, '') + '@example.com',
      glider: GLIDERS[i % GLIDERS.length],
    });
  }
  return pilots;
}

// --- IGC encoding ----------------------------------------------------------

function pad(n: number, width: number): string {
  return String(Math.trunc(n)).padStart(width, '0');
}
function encLat(lat: number): string {
  const hemi = lat < 0 ? 'S' : 'N';
  const a = Math.abs(lat);
  let deg = Math.floor(a);
  const min = (a - deg) * 60;
  let mm = Math.floor(min);
  let mmm = Math.round((min - mm) * 1000);
  if (mmm >= 1000) { mmm -= 1000; mm += 1; }
  if (mm >= 60) { mm -= 60; deg += 1; }
  return pad(deg, 2) + pad(mm, 2) + pad(mmm, 3) + hemi;
}
function encLon(lon: number): string {
  const hemi = lon < 0 ? 'W' : 'E';
  const a = Math.abs(lon);
  let deg = Math.floor(a);
  const min = (a - deg) * 60;
  let mm = Math.floor(min);
  let mmm = Math.round((min - mm) * 1000);
  if (mmm >= 1000) { mmm -= 1000; mm += 1; }
  if (mm >= 60) { mm -= 60; deg += 1; }
  return pad(deg, 3) + pad(mm, 2) + pad(mmm, 3) + hemi;
}
function encTime(sec: number): string {
  const s = Math.trunc(sec) % 86400;
  return pad(s / 3600, 2) + pad((s % 3600) / 60, 2) + pad(s % 60, 2);
}
function bRecord(sec: number, lat: number, lon: number, altM: number): string {
  const alt = Math.max(0, Math.round(altM));
  return `B${encTime(sec)}${encLat(lat)}${encLon(lon)}A${pad(0, 5)}${pad(alt, 5)}`;
}

// --- flight synthesis ------------------------------------------------------

interface Fix { sec: number; lat: number; lon: number; alt: number }
interface LatLon { lat: number; lon: number }

// Terrain floor a pilot can descend to before landing (alpine valleys) and the
// working band above it. Altitude follows a triangle wave along the track —
// climb, then a long glide — so the tracklog has thermal/glide structure; it is
// not what scores the task (GAP scores position + time), only what makes the
// flights read as flights.
const GROUND = 1500;

/**
 * Fly a polyline `route` from route[0] through each subsequent point, covering
 * at most `rangeM` metres of track before landing. Ground speed is roughly
 * constant, altitude sawtooths within a working band, and a small sinusoidal
 * cross-track wander keeps the outbound and return legs from being a single
 * ruled line. A pilot whose range exceeds the whole route flies it to the end
 * (makes goal); a shorter range lands them partway — which, on an out-and-return,
 * is exactly the "turned for home early" or "never reached the ring" case.
 */
function flyRoute(route: LatLon[], rangeM: number, startSec: number, rng: () => number): Fix[] {
  const speed = 9.5 + rng() * 3;      // m/s ground speed
  const dt = 9;                       // fix interval (s)
  const ceiling = KOSCI.alt + 900 + rng() * 500;
  const floor = GROUND + 150 + rng() * 200;
  const band = ceiling - floor;
  const period = 3200 + rng() * 1400; // along-track distance per climb/glide cycle
  const wanderAmp = 120 + rng() * 160;
  const wanderPeriod = 800 + rng() * 700;
  let alt = KOSCI.alt + 250 + rng() * 250; // launch/soar-up height

  const fixes: Fix[] = [];
  let sec = startSec;
  let traveled = 0;

  const altAt = (d: number): number => {
    // Triangle wave: climb for the first 30% of each cycle, glide for the rest.
    const phase = (d % period) / period;
    return phase < 0.3 ? floor + band * (phase / 0.3) : ceiling - band * ((phase - 0.3) / 0.7);
  };
  const emit = (base: LatLon, bearing: number, remaining: boolean): void => {
    // Lateral wander perpendicular to the current heading.
    const w = Math.sin(traveled / wanderPeriod) * wanderAmp;
    const p = Math.abs(w) > 0.5 ? destinationPoint(base.lat, base.lon, Math.abs(w), bearing + (w >= 0 ? Math.PI / 2 : -Math.PI / 2)) : base;
    alt = remaining ? altAt(traveled) : GROUND;
    fixes.push({ sec, lat: p.lat, lon: p.lon, alt: Math.max(GROUND, alt) });
  };

  let landed = false;
  for (let i = 0; i < route.length - 1 && !landed; i++) {
    const a = route[i];
    const b = route[i + 1];
    const segLen = andoyerDistance(a.lat, a.lon, b.lat, b.lon);
    if (segLen < 1) continue;
    const bearing = calculateBearingRadians(a.lat, a.lon, b.lat, b.lon);
    const step = speed * dt;
    for (let d = 0; d < segLen; d += step) {
      if (traveled >= rangeM) {
        // Land here: place the final fix on the ground at this point.
        const here = destinationPoint(a.lat, a.lon, d, bearing);
        emit(here, bearing, false);
        landed = true;
        break;
      }
      const here = destinationPoint(a.lat, a.lon, d, bearing);
      emit(here, bearing, true);
      traveled += step;
      sec += dt;
    }
  }
  if (!landed) {
    // Completed the route (made goal): land at the final point.
    const end = route[route.length - 1];
    const prev = route[route.length - 2] ?? end;
    emit(end, calculateBearingRadians(prev.lat, prev.lon, end.lat, end.lon), false);
  }
  return fixes;
}

/** Assemble a full IGC file for one pilot's flight. */
function igcFile(pilot: Pilot, dateDDMMYY: string, fixes: Fix[]): string {
  const lines = [
    'AXXXKOSCI',
    `HFDTE${dateDDMMYY}`,
    `HFPLTPILOTINCHARGE:${pilot.name}`,
    'HFDTM100GPSDATUM:WGS-1984',
    `HFGTYGLIDERTYPE:${pilot.glider}`,
    `HFCIDCOMPETITIONID:${pilot.civl}`,
  ];
  for (const f of fixes) lines.push(bRecord(f.sec, f.lat, f.lon, f.alt));
  return lines.join('\r\n') + '\r\n';
}

// --- tasks -----------------------------------------------------------------

interface Tp { type?: 'TAKEOFF' | 'SSS' | 'ESS'; radius: number; waypoint: typeof KOSCI }

/** A cylinder concentric with Kosciuszko — reuses the KOSCI centre waypoint. */
function ring(radius: number, type?: Tp['type']): Tp {
  return { ...(type ? { type } : {}), radius, waypoint: KOSCI };
}
/** A cylinder at a named alpine point. */
function at(p: typeof KOSCI, radius: number, type?: Tp['type']): Tp {
  return { ...(type ? { type } : {}), radius, waypoint: p };
}

function xctsk(turnpoints: Tp[], gates: string[]): string {
  return JSON.stringify(
    {
      taskType: 'CLASSIC',
      version: 1,
      earthModel: 'WGS84',
      turnpoints: turnpoints.map((t) => ({
        ...(t.type ? { type: t.type } : {}),
        radius: t.radius,
        waypoint: {
          name: t.waypoint.name,
          description: t.waypoint.description,
          lat: t.waypoint.lat,
          lon: t.waypoint.lon,
          altSmoothed: t.waypoint.alt,
        },
      })),
      sss: { type: 'RACE', direction: 'EXIT', timeGates: gates },
      goal: { type: 'CYLINDER' },
    },
    null,
    2,
  ) + '\n';
}

interface TaskSpec {
  dir: string;
  name: string;
  date: string;
  dateDDMMYY: string;
  gateSec: number;          // first start gate, seconds-of-day UTC
  turnpoints: Tp[];
  /** Build one pilot's route + range for this task. */
  route: (start: LatLon, i: number, rng: () => number) => { route: LatLon[]; rangeM: number };
}

// Grand Loop (Task 1) and Double Ring (Task 2) send pilots radially out to an
// apex, then back to the KOSCI goal; the point-to-point Ridge Run (Task 3) sends
// them around a course of named peaks. In every case the per-pilot `rangeM`
// (how much track they cover before landing) is drawn from a bell curve so the
// field spans every outcome; a few short-range pilots never even cross the start.
function radialOutAndReturn(apexKm: number) {
  return (start: LatLon, i: number, rng: () => number): { route: LatLon[]; rangeM: number } => {
    const bearing = (i * 360) / N_PILOTS + (rng() - 0.5) * 8; // fan out around the compass
    const apex = destinationPoint(KOSCI.lat, KOSCI.lon, apexKm * 1000, bearing * DEG);
    // Out-and-back route: launch → apex → back to the summit goal.
    const route = [start, { lat: apex.lat, lon: apex.lon }, { lat: KOSCI.lat, lon: KOSCI.lon }];
    // Range on a bell curve over [1.2 km, 2·apex + 2 km] so the top of the field
    // completes the ~2·apex round trip (makes goal) and the bottom barely starts.
    const maxRange = apexKm * 2000 + 2000;
    const p = (i + 0.5) / N_PILOTS;
    const mean = maxRange * 0.52;
    const std = maxRange * 0.3;
    const rangeM = Math.max(1200, Math.min(maxRange, mean + probit(p) * std + (rng() - 0.5) * 1500));
    return { route, rangeM };
  };
}

const TASKS: TaskSpec[] = [
  {
    // The classic #347 shape: one big exit ring around launch. Fly out across
    // the 10 km cylinder, turn, come back to a 400 m goal on the summit.
    dir: 'kosci-loop-t1',
    name: 'Grand Loop',
    date: '2026-03-01',
    dateDDMMYY: '010326',
    gateSec: 3 * 3600,
    turnpoints: [ring(400, 'TAKEOFF'), ring(2000, 'SSS'), ring(10000), ring(3000, 'ESS'), ring(400)],
    route: radialOutAndReturn(13),
  },
  {
    // Two concentric exit rings in sequence: cross the 5 km AND the 11 km
    // cylinder outward, then return through the 3 km ESS to goal.
    dir: 'kosci-loop-t2',
    name: 'Double Ring',
    date: '2026-03-02',
    dateDDMMYY: '020326',
    gateSec: 3 * 3600,
    turnpoints: [ring(400, 'TAKEOFF'), ring(1500, 'SSS'), ring(5000), ring(11000), ring(3000, 'ESS'), ring(400)],
    route: radialOutAndReturn(14),
  },
  {
    // Point-to-point control: a course around named peaks. Every turnpoint is
    // an ENTER cylinder (the route reaches each from outside), so this task has
    // no exit rings — the contrast case, and a guard against regressions.
    dir: 'kosci-loop-t3',
    name: 'Ridge Run',
    date: '2026-03-03',
    dateDDMMYY: '030326',
    gateSec: 3 * 3600,
    turnpoints: [
      at(KOSCI, 400, 'TAKEOFF'),
      at(KOSCI, 1000, 'SSS'),
      at(POINTS.TOWNSD, 400),
      at(POINTS.BLULAK, 400),
      at(POINTS.RAMSHD, 1000, 'ESS'),
      at(POINTS.THREDB, 400),
    ],
    route: (start, i, rng) => {
      const legs = [start, POINTS.TOWNSD, POINTS.BLULAK, POINTS.RAMSHD, POINTS.THREDB].map((p) => ({ lat: p.lat, lon: p.lon }));
      let total = 0;
      for (let k = 1; k < legs.length; k++) total += andoyerDistance(legs[k - 1].lat, legs[k - 1].lon, legs[k].lat, legs[k].lon);
      const maxRange = total + 2000;
      const p = (i + 0.5) / N_PILOTS;
      const rangeM = Math.max(1000, Math.min(maxRange, maxRange * 0.55 + probit(p) * maxRange * 0.28 + (rng() - 0.5) * 1500));
      return { route: legs, rangeM };
    },
  },
];

// --- main ------------------------------------------------------------------

function cleanTaskDir(dir: string): void {
  const full = join(COMPS_ROOT, dir);
  if (existsSync(full)) {
    for (const f of readdirSync(full)) {
      if (f.endsWith('.igc') || f.endsWith('.xctsk')) unlinkSync(join(full, f));
    }
  } else {
    mkdirSync(full, { recursive: true });
  }
}

const GATES = ['03:00:00', '03:15:00', '03:30:00', '03:45:00'];

/** Short per-turnpoint label for the console summary (type, else "TP"). */
function tpLabel(t: Tp, i: number, n: number): string {
  if (t.type) return t.type;
  return i === n - 1 ? 'GOAL' : 'TP';
}

function main(): void {
  const pilots = buildPilots();

  // 1) Meta folder: manifest + paste-ready pilot list.
  const metaDir = join(COMPS_ROOT, 'kosci-loop');
  mkdirSync(metaDir, { recursive: true });
  const manifest = {
    name: 'Kosciuszko Loop',
    slug: 'kosci-loop',
    comp_name: 'Kosciuszko Loop (Sample)',
    category: 'pg',
    scoring_format: 'gap',
    filename_id_field: 'civl_id',
    classes: ['open'],
    location: KOSCI,
    synthetic: true,
    tasks: TASKS.map((t) => ({ pilot_class: 'open', name: t.name, date: t.date, dir: t.dir })),
  };
  writeFileSync(join(metaDir, 'comp.json'), JSON.stringify(manifest, null, 2) + '\n');

  const header = ['name', 'email', 'civl_id', 'safa_id', 'ushpa_id', 'bhpa_id', 'dhv_id', 'ffvl_id', 'fai_id', 'class', 'team', 'driver', 'glider'].join('\t');
  const rows = pilots.map((p) => [p.name, p.email, p.civl, '', '', '', '', '', '', 'open', '', '', p.glider].join('\t'));
  writeFileSync(join(metaDir, 'pilots.tsv'), [header, ...rows].join('\n') + '\n');

  // 2) Per task: task file + one track per pilot, with a scoring sanity check.
  for (const task of TASKS) {
    cleanTaskDir(task.dir);
    const taskDir = join(COMPS_ROOT, task.dir);
    const taskXctsk = xctsk(task.turnpoints, GATES);
    writeFileSync(join(taskDir, 'task.xctsk'), taskXctsk);

    const parsed: XCTask = parseXCTask(taskXctsk);
    const directions = computeTurnpointDirections(parsed);

    let goal = 0;
    let ess = 0;
    let started = 0;
    let noStart = 0;
    let maxFlown = 0;
    const taskNo = task.dir.endsWith('t1') ? 1 : task.dir.endsWith('t2') ? 2 : 3;

    for (let i = 0; i < pilots.length; i++) {
      const pilot = pilots[i];
      const rng = mulberry32(pilot.civl * 131 + taskNo * 977);
      // Launch scatter within the 400 m take-off cylinder (well inside the
      // 2 km / 1.5 km / 1 km start), so everyone starts legally at the centre.
      const scatterR = 40 + rng() * 300;
      const scatterB = rng() * Math.PI * 2;
      const s = destinationPoint(KOSCI.lat, KOSCI.lon, scatterR, scatterB);
      const start = { lat: s.lat, lon: s.lon };

      const { route, rangeM } = task.route(start, i, rng);
      // Stagger launches across the gate window so start times (and speed-section
      // times) differ; everyone is airborne before the first gate opens.
      const startSec = task.gateSec - 300 + Math.floor(i * 12 + rng() * 90);
      const fixes = flyRoute(route, rangeM, startSec, rng);

      const fname = `${pilot.surname.toLowerCase()}_${pilot.civl}_kl${taskNo}.igc`;
      writeFileSync(join(taskDir, fname), igcFile(pilot, task.dateDDMMYY, fixes));

      // Sanity: resolve the sequence with the same engine the app uses.
      const r = resolveTurnpointSequence(parsed, fixes.map((f) => ({
        latitude: f.lat, longitude: f.lon, pressureAltitude: 0, gnssAltitude: f.alt,
        time: new Date(f.sec * 1000), valid: true,
      })));
      if (r.sssReaching) started++; else noStart++;
      if (r.essReaching) ess++;
      if (r.madeGoal) goal++;
      maxFlown = Math.max(maxFlown, r.flownDistance);
    }

    const dirStr = directions
      .map((d, i) => `${tpLabel(task.turnpoints[i], i, task.turnpoints.length)}:${d}`)
      .join(' ');
    console.log(
      `${task.name} (${task.date}): ${N_PILOTS} tracks — ${goal} goal, ${ess} ESS, ${started} started, ` +
      `${noStart} never started; ${(maxFlown / 1000).toFixed(1)} km max flown`,
    );
    console.log(`    directions: ${dirStr}`);
  }

  console.log(`\nWrote kosci-loop sample under ${COMPS_ROOT}`);
  console.log('  Seed:  bun run seed:sample kosci-loop');
}

main();
