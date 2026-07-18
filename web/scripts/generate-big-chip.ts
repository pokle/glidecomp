#!/usr/bin/env bun
// Copyright (c) 2026, Tushar Pokle.  All rights reserved.
/**
 * Generate the synthetic "Big Chip" open-distance sample competition.
 *
 * Unlike the Corryong Cup sample (downloaded from a real AirScore instance by
 * download-airscore-comp.ts), Big Chip is entirely fabricated: a flat-land,
 * ground-tow open-distance comp flown from Jil Jil Farm near Birchip, Victoria.
 * Two tasks, both launching from the same spot, 50 pilots, one glider-like
 * track per pilot per task.
 *
 *   Task 1 — wind SW 5 kt: pilots fly downwind to the NE, 0.5–77 km.
 *   Task 2 — wind NW 10 kt: pilots fly downwind to the SE, 0.7–122 km.
 *
 * Output (all under web/samples/comps/):
 *   big-chip/comp.json     — manifest read by seed-sample-comp.ts
 *   big-chip/pilots.tsv    — paste-ready pilot list for the competition UI
 *   big-chip-t1/task.xctsk — single-TAKEOFF open-distance task + 50 IGC tracks
 *   big-chip-t2/task.xctsk — single-TAKEOFF open-distance task + 50 IGC tracks
 *
 * Deterministic: a seeded PRNG makes re-running produce byte-identical files, so
 * the generator is safe to re-run and commit. Regenerate with:
 *   bun web/scripts/generate-big-chip.ts
 *
 * Load it with the seed script and score it with the CLI:
 *   bun run seed big-chip
 *   bun run score-task -- --open-distance \
 *     web/samples/comps/big-chip-t1/task.xctsk web/samples/comps/big-chip-t1/
 */

import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { destinationPoint, parseXCTask, openDistanceForFlight } from '@glidecomp/engine';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const COMPS_ROOT = join(REPO_ROOT, 'web/samples/comps');

// Jil Jil Farm, near Birchip in the Victorian Mallee — the shared launch for
// both tasks. Flat farmland, ~90 m AMSL; pilots are ground-towed aloft.
const LAUNCH = { name: 'JILJIL', description: 'Jil Jil Farm', lat: -35.86, lon: 142.89, alt: 90 };

// The open-distance take-off ("launch") cylinder. A big 5 km radius: pilots are
// towed up inside it, and open-distance scoring measures from where each pilot
// exits it. Short flights never leave the cylinder and score zero ("landed in
// the launch paddock"); pilots who just cross the boundary barely score.
const TAKEOFF_RADIUS = 5000;

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

// --- pilots ----------------------------------------------------------------

const FIRST_NAMES = [
  'James', 'Sarah', 'Liam', 'Olivia', 'Noah', 'Emma', 'Jack', 'Ava', 'William', 'Mia',
  'Ethan', 'Grace', 'Lucas', 'Chloe', 'Henry', 'Zoe', 'Oliver', 'Ruby', 'Thomas', 'Isla',
  'Charlie', 'Ella', 'Max', 'Lily', 'Leo', 'Amelia', 'Hugo', 'Poppy', 'Finn', 'Scarlett',
  'Archie', 'Freya', 'George', 'Willow', 'Harry', 'Evie', 'Oscar', 'Matilda', 'Jasper', 'Harper',
  'Toby', 'Georgia', 'Angus', 'Maya', 'Fergus', 'Alice', 'Rory', 'Hazel', 'Cody', 'Frankie',
];
const LAST_NAMES = [
  'Abbott', 'Baker', 'Chen', 'Dixon', 'Evans', 'Fraser', 'Grant', 'Hughes', 'Irwin', 'Jensen',
  'Kelly', 'Lowe', 'Murphy', 'Nolan', 'OConnor', 'Patel', 'Quinn', 'Reid', 'Singh', 'Turner',
  'Underwood', 'Vaughan', 'Walker', 'Xu', 'Young', 'Zammit', 'Armstrong', 'Boyle', 'Carter', 'Doyle',
  'Ellison', 'Foster', 'Gibson', 'Harding', 'Ingram', 'Jarvis', 'Knight', 'Larsen', 'Mercer', 'Newton',
  'Osborne', 'Palmer', 'Rankin', 'Sutton', 'Tobin', 'Underhill', 'Voss', 'Whelan', 'Yates', 'Zeller',
];

// A pool of hang-glider models — Big Chip is a class-1 (HG) tow meet.
const GLIDERS = [
  'Moyes Litespeed RX 3.5', 'Wills Wing T3 144', 'Aeros Combat 13', 'Moyes Gecko 155',
  'Icaro Laminar Z9', 'Wills Wing U2 145', 'Moyes RX Pro 4', 'Aeros Combat GT 12.7',
  'Moyes Litesport 4', 'Wills Wing T2C 144', 'Icaro Laminar 14', 'Moyes Malibu 2',
];

interface Pilot {
  name: string;
  surname: string;
  civl: number;
  safa: number;
  email: string;
  glider: string;
}

function buildPilots(): Pilot[] {
  const pilots: Pilot[] = [];
  for (let i = 0; i < 50; i++) {
    const first = FIRST_NAMES[i];
    const last = LAST_NAMES[i];
    const name = `${first} ${last}`;
    pilots.push({
      name,
      surname: last,
      civl: 100201 + i,
      safa: 60500 + i * 7,
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

/** Encode a signed latitude as IGC "DDMMmmmN/S" (8 chars). */
function encLat(lat: number): string {
  const hemi = lat < 0 ? 'S' : 'N';
  let a = Math.abs(lat);
  let deg = Math.floor(a);
  let min = (a - deg) * 60;
  let mm = Math.floor(min);
  let mmm = Math.round((min - mm) * 1000);
  if (mmm >= 1000) { mmm -= 1000; mm += 1; }
  if (mm >= 60) { mm -= 60; deg += 1; }
  return pad(deg, 2) + pad(mm, 2) + pad(mmm, 3) + hemi;
}

/** Encode a signed longitude as IGC "DDDMMmmmE/W" (9 chars). */
function encLon(lon: number): string {
  const hemi = lon < 0 ? 'W' : 'E';
  let a = Math.abs(lon);
  let deg = Math.floor(a);
  let min = (a - deg) * 60;
  let mm = Math.floor(min);
  let mmm = Math.round((min - mm) * 1000);
  if (mmm >= 1000) { mmm -= 1000; mm += 1; }
  if (mm >= 60) { mm -= 60; deg += 1; }
  return pad(deg, 3) + pad(mm, 2) + pad(mmm, 3) + hemi;
}

/** HHMMSS from seconds-of-day. */
function encTime(sec: number): string {
  const s = Math.trunc(sec) % 86400;
  return pad(s / 3600, 2) + pad((s % 3600) / 60, 2) + pad(s % 60, 2);
}

/** One IGC B (fix) record. Pressure altitude is left 0; GNSS carries altitude. */
function bRecord(sec: number, lat: number, lon: number, altM: number): string {
  const alt = Math.max(0, Math.round(altM));
  return `B${encTime(sec)}${encLat(lat)}${encLon(lon)}A${pad(0, 5)}${pad(alt, 5)}`;
}

// --- flight synthesis ------------------------------------------------------

interface Fix {
  sec: number;
  lat: number;
  lon: number;
  alt: number;
}

/**
 * Synthesize one glider-like cross-country flight as an emergent soaring model.
 *
 * Everyone flies generally downwind (that's how you get the longest distance),
 * but thermals are hard to find. So a flight is: search — glide downwind
 * deviating to hunt for lift, sinking all the while — until you hit a thermal,
 * then climb (circling, drifting downwind with the wind), then glide off
 * downwind again to the next one. Get low and you search harder; find nothing
 * and you run out of altitude and land.
 *
 * The distance is NOT prescribed — it emerges from how many thermals the pilot
 * connects with (`cycles`). A pilot who never climbs just glides down from tow
 * height and lands a few km out (inside the launch cylinder → scores 0); a
 * pilot who chains many thermals goes a long way. Cross-track wander is bounded
 * and the flight ends with a straight final glide to the landing point, so the
 * landing (furthest downwind) fix is the one open-distance scoring measures to.
 */
function synthFlight(
  start: { lat: number; lon: number; alt: number },
  bearingDeg: number,
  cycles: number,
  startSec: number,
  rng: () => number,
): Fix[] {
  const bearing = bearingDeg * DEG;
  const perpR = bearing + Math.PI / 2;
  const perpL = bearing - Math.PI / 2;
  const dt = 10; // fix interval (s)
  const ground = start.alt;

  // Pilot-/day-specific soaring parameters.
  const ceiling = ground + 1450 + rng() * 500;     // cloudbase
  const floor = ground + 320 + rng() * 160;        // height at which searching turns desperate
  const glideRatio = 8.5 + rng() * 4;              // glide performance (m forward / m down)
  const glideSpeed = 10 + rng() * 3;               // m/s
  const climbRate = 1.3 + rng() * 1.8;             // m/s
  const circleR = 90 + rng() * 90;                 // thermalling circle radius (m)
  const circleSpeed = 8 + rng() * 2;               // m/s
  const maxDev = (35 + rng() * 30) * DEG;          // how far the search heading wanders off downwind
  const wanderCap = 1600;                          // hard cross-track bound (m)

  let along = 0;   // downwind distance from launch (m)
  let cross = 0;   // cross-track offset (m, +right of downwind)
  let alt = ground + 280 + rng() * 170; // tow-release height
  let sec = startSec;
  const fixes: Fix[] = [];

  const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
  const emit = () => {
    const axis = destinationPoint(start.lat, start.lon, Math.max(0, along), bearing);
    let lat = axis.lat;
    let lon = axis.lon;
    if (Math.abs(cross) > 0.5) {
      const off = destinationPoint(axis.lat, axis.lon, Math.abs(cross), cross >= 0 ? perpR : perpL);
      lat = off.lat;
      lon = off.lon;
    }
    fixes.push({ sec, lat, lon, alt: Math.max(ground, alt) });
  };
  emit();

  // Climb in a thermal: circle upward to `top`, the whole circle drifting
  // downwind with the wind.
  const thermalClimb = (top: number): void => {
    const ceil = Math.min(ceiling, top);
    if (ceil - alt < 40) return;
    let theta = rng() * Math.PI * 2;
    let cenA = along - circleR * Math.cos(theta);
    let cenC = cross - circleR * Math.sin(theta);
    const drift = 1.0 + rng() * 1.7; // downwind drift while circling (m/s)
    while (alt < ceil) {
      theta += (circleSpeed * dt) / circleR;
      cenA += drift * dt;
      cenC += (0 - cenC) * 0.03; // gently recentre toward the downwind line
      alt += climbRate * dt;
      along = cenA + circleR * Math.cos(theta);
      cross = clamp(cenC + circleR * Math.sin(theta), -wanderCap, wanderCap);
      sec += dt;
      emit();
    }
    along = cenA;
    cross = cenC;
  };

  // Glide downwind searching for the next thermal, deviating off track as the
  // pilot hunts. Descends until `stopAlt` (found lift) or the ground (landed).
  // Searching gets more frantic (wider heading swings) the lower you get.
  let dev = 0;
  const searchGlide = (stopAlt: number): void => {
    while (alt > stopAlt && alt > ground) {
      const desperation = 1 + 1.5 * clamp((floor - alt) / Math.max(1, floor - ground), 0, 1);
      dev = clamp(dev + (rng() - 0.5) * maxDev * 0.7 * desperation, -maxDev * desperation, maxDev * desperation);
      let heading = dev;
      // Steer back if we've wandered too far off the downwind line.
      if (cross > wanderCap * 0.6 && heading > 0) heading = -Math.abs(heading) * 0.5;
      if (cross < -wanderCap * 0.6 && heading < 0) heading = Math.abs(heading) * 0.5;
      const step = glideSpeed * dt;
      along += step * Math.cos(heading); // cos(±maxDev) > 0 → always net downwind
      cross = clamp(cross + step * Math.sin(heading), -wanderCap, wanderCap);
      alt -= step / glideRatio;
      sec += dt;
      emit();
    }
  };

  // Final glide: the last thermal never came — glide straight downwind to the
  // deck, recentring onto the downwind line so the landing is the furthest fix.
  const finalGlide = (): void => {
    const startAlt = alt;
    const startCross = cross;
    const steps = Math.max(1, Math.round((startAlt - ground) * glideRatio / (glideSpeed * dt)));
    for (let k = 1; k <= steps; k++) {
      const f = k / steps;
      along += glideSpeed * dt;
      cross = startCross * (1 - f);
      alt = startAlt + (ground - startAlt) * f;
      sec += dt;
      emit();
    }
  };

  // Fly the day: hunt out the first thermal, then climb/glide through `cycles`
  // of them; the search after the last one fails and the pilot lands.
  searchGlide(alt - (40 + rng() * 160)); // initial hunt off tow
  for (let c = 0; c < cycles && alt > ground; c++) {
    thermalClimb(floor + 500 + rng() * (ceiling - floor));
    if (c < cycles - 1) searchGlide(floor);
  }
  finalGlide();
  return fixes;
}

/** Assemble a full IGC file for one pilot's flight. */
function igcFile(pilot: Pilot, dateDDMMYY: string, fixes: Fix[]): string {
  const lines = [
    'AXXXBIGCHIP',
    `HFDTE${dateDDMMYY}`,
    `HFPLTPILOTINCHARGE:${pilot.name}`,
    'HFDTM100GPSDATUM:WGS-1984',
    `HFGTYGLIDERTYPE:${pilot.glider}`,
    `HFCIDCOMPETITIONID:${pilot.civl}`,
  ];
  for (const f of fixes) lines.push(bRecord(f.sec, f.lat, f.lon, f.alt));
  return lines.join('\r\n') + '\r\n';
}

// --- task file -------------------------------------------------------------

function openDistanceTask(): string {
  return JSON.stringify(
    {
      taskType: 'OPEN-DISTANCE',
      version: 1,
      earthModel: 'WGS84',
      turnpoints: [
        {
          type: 'TAKEOFF',
          radius: TAKEOFF_RADIUS,
          waypoint: {
            name: LAUNCH.name,
            description: LAUNCH.description,
            lat: LAUNCH.lat,
            lon: LAUNCH.lon,
            altSmoothed: LAUNCH.alt,
          },
        },
      ],
    },
    null,
    2,
  );
}

// --- who connects with how many thermals -----------------------------------

/**
 * Inverse standard-normal CDF (probit) — Acklam's rational approximation.
 * Maps a probability in (0,1) to its z-score. Used to lay the field out on a
 * bell curve deterministically (no RNG needed for the shape).
 */
function probit(p: number): number {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239e0];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0, -2.549732539343734e0, 4.374664141464968e0, 2.938163982698783e0];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0, 3.754408661907416e0];
  const plow = 0.02425;
  const phigh = 1 - plow;
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= phigh) {
    const q = p - 0.5;
    const r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

/**
 * How many thermals each of the 50 pilots connects with, on a bell curve over
 * [0, maxCycles]. This is the only knob on the field: distance emerges from it
 * (each thermal buys roughly one more downwind glide). Centred on half, so the
 * bulk make about half the distance; the low tail (0–1 thermals) barely leaves
 * the launch cylinder, the high tail chains thermals for a long way. A little
 * RNG jitter keeps neighbouring pilots from landing in lockstep.
 */
function cycleCounts(maxCycles: number, rng: () => number): number[] {
  const mean = maxCycles * 0.5;
  const std = maxCycles * 0.3;
  const out: number[] = [];
  for (let i = 0; i < 50; i++) {
    const p = (i + 0.5) / 50; // quantile of the i-th pilot
    const jitter = (rng() - 0.5) * 0.9;
    out.push(Math.round(Math.max(0, Math.min(maxCycles, mean + probit(p) * std + jitter))));
  }
  return out;
}

// --- main ------------------------------------------------------------------

interface TaskSpec {
  dir: string;
  name: string;
  date: string; // ISO yyyy-mm-dd
  dateDDMMYY: string;
  wind: string;
  bearing: number;
  /** Most thermals a lucky pilot connects with — the day's distance potential. */
  maxCycles: number;
  startZ: number; // seconds-of-day UTC for the launch window
}

// Task 2 has a stronger wind and a bigger sky (more thermals on offer), so its
// best pilots go further. Distances are emergent, not prescribed.
const TASKS: TaskSpec[] = [
  { dir: 'big-chip-t1', name: 'Task 1', date: '2026-02-14', dateDDMMYY: '140226', wind: 'SW 5 kt', bearing: 45, maxCycles: 7, startZ: 2 * 3600 },
  { dir: 'big-chip-t2', name: 'Task 2', date: '2026-02-15', dateDDMMYY: '150226', wind: 'NW 10 kt', bearing: 135, maxCycles: 11, startZ: 2 * 3600 },
];

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

function main(): void {
  const pilots = buildPilots();

  // 1) Meta folder: manifest + paste-ready pilot list.
  const metaDir = join(COMPS_ROOT, 'big-chip');
  mkdirSync(metaDir, { recursive: true });

  const manifest = {
    name: 'Big Chip',
    slug: 'big-chip',
    comp_name: 'Big Chip',
    category: 'hg',
    scoring_format: 'open_distance',
    // Fabricated comp, not a real event — seed it hidden (D1 `test` flag) so it
    // stays out of the public comp list and 404s for anonymous visitors.
    hidden: true,
    // Big Chip's IGC filenames carry its fabricated CIVL ids, not SAFA numbers
    // (the default the seed script assumes for the real AirScore comps).
    filename_id_field: 'civl_id',
    classes: ['open'],
    location: LAUNCH,
    synthetic: true,
    tasks: TASKS.map((t) => ({
      pilot_class: 'open',
      name: t.name,
      date: t.date,
      dir: t.dir,
      wind: t.wind,
      downwind_bearing: t.bearing,
    })),
  };
  writeFileSync(join(metaDir, 'comp.json'), JSON.stringify(manifest, null, 2) + '\n');

  // pilots.tsv — columns match the competition UI's paste importer.
  const header = [
    'name', 'email', 'civl_id', 'safa_id', 'ushpa_id', 'bhpa_id', 'dhv_id',
    'ffvl_id', 'fai_id', 'class', 'team', 'driver', 'glider',
  ].join('\t');
  const rows = pilots.map((p) =>
    [p.name, p.email, p.civl, p.safa, '', '', '', '', '', 'open', '', '', p.glider].join('\t'),
  );
  writeFileSync(join(metaDir, 'pilots.tsv'), [header, ...rows].join('\n') + '\n');

  // 2) Per-task: task file + one track per pilot.
  const parsedTask = parseXCTask(openDistanceTask());
  for (const task of TASKS) {
    cleanTaskDir(task.dir);
    const taskDir = join(COMPS_ROOT, task.dir);
    writeFileSync(join(taskDir, 'task.xctsk'), openDistanceTask() + '\n');

    // Deterministic per-task RNG for the field's thermal-luck distribution.
    const taskRng = mulberry32(task.bearing * 1000 + 7);
    const cycles = cycleCounts(task.maxCycles, taskRng);
    const distances: number[] = [];

    for (let i = 0; i < pilots.length; i++) {
      const pilot = pilots[i];
      const rng = mulberry32(pilot.civl * 131 + task.bearing);

      // Launch scatter: 150–950 m from the paddock centre → pilots take off
      // within ~2 km of each other (ground towing), all well inside the 5 km
      // launch cylinder. Scattered 360° around the centre.
      const scatterR = 150 + rng() * 800;
      const scatterB = rng() * Math.PI * 2;
      const p0 = destinationPoint(LAUNCH.lat, LAUNCH.lon, scatterR, scatterB);
      const start = { lat: p0.lat, lon: p0.lon, alt: LAUNCH.alt };

      // Per-pilot heading spread around the downwind bearing (±12°).
      const bearing = task.bearing + (rng() - 0.5) * 24;
      // Stagger launch times across a ~40 min window.
      const startSec = task.startZ + Math.floor(i * 45 + rng() * 60);

      const fixes = synthFlight(start, bearing, cycles[i], startSec, rng);
      const dateCode = task.dateDDMMYY;
      const fname = `${pilot.surname.toLowerCase()}_${pilot.civl}_bc${task.dir.endsWith('t1') ? 1 : 2}.igc`;
      writeFileSync(join(taskDir, fname), igcFile(pilot, dateCode, fixes));

      // Sanity: the real scored open distance (from the 5 km launch-cylinder
      // exit), computed with the same engine routine the CLI/backend use.
      const scoredM = openDistanceForFlight(parsedTask, {
        pilotName: pilot.name,
        trackFile: fname,
        fixes: fixes.map((f) => ({
          latitude: f.lat,
          longitude: f.lon,
          pressureAltitude: 0,
          gnssAltitude: f.alt,
          time: new Date(f.sec * 1000),
          valid: true,
        })),
      });
      distances.push(scoredM);
    }
    const sorted = [...distances].sort((a, b) => b - a);
    const inside = distances.filter((d) => d === 0).length;
    console.log(
      `${task.name} (${task.wind}, downwind ${task.bearing}°): 50 tracks, ` +
        `scored ${(sorted[sorted.length - 1] / 1000).toFixed(1)}–${(sorted[0] / 1000).toFixed(1)} km, ` +
        `${inside} landed inside the ${(TAKEOFF_RADIUS / 1000).toFixed(0)} km cylinder (scored 0)`,
    );
  }

  console.log(`\nWrote big-chip sample under ${COMPS_ROOT}`);
  console.log('  Seed:  bun run seed big-chip');
  console.log('  Score: bun run score-task -- --open-distance web/samples/comps/big-chip-t1/task.xctsk web/samples/comps/big-chip-t1/');
}

main();
