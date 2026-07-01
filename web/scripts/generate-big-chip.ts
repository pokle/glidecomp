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
 *   bun run seed:sample big-chip
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
 * Synthesize one glider-like open-distance flight.
 *
 * The pilot launches at `start` (already airborne, outside the take-off
 * cylinder) and works downwind along `bearingDeg`, alternating glides (losing
 * height, advancing fast) with thermal climbs (gaining height, drifting slowly
 * downwind) — the classic "chase the next thermal" sawtooth. Net along-track
 * progress is monotonic, and cross-track wander is tapered to zero at the end,
 * so the final fix is always the single furthest point: the pilot's open
 * distance ≈ `distanceM`.
 */
function synthFlight(
  start: { lat: number; lon: number; alt: number },
  bearingDeg: number,
  distanceM: number,
  startSec: number,
  rng: () => number,
): Fix[] {
  const bearing = bearingDeg * DEG;
  const perp = bearing + Math.PI / 2; // cross-track axis
  const dt = 10; // fix interval (s)

  // Altitude band (AGL, above the ~90 m launch): thermal up to ~1700, glide to ~500.
  const altBase = start.alt;
  const altHigh = altBase + 1650 + rng() * 200;
  const altLow = altBase + 450 + rng() * 150;

  const glideSpeed = 10 + rng() * 3;   // along-track m/s while gliding (~36–47 km/h)
  const sink = 1.3 + rng() * 0.5;      // m/s
  const drift = 1.5 + rng() * 1.0;     // along-track m/s while thermalling (wind drift)
  const climb = 2.0 + rng() * 1.2;     // m/s

  // Cross-track wander amplitude: bounded so it never rivals along-track, and an
  // envelope (sin over the whole flight) forces it to 0 at both ends.
  const wanderAmp = Math.min(distanceM * 0.05, 1200);
  const wanderTurns = 2 + Math.floor(rng() * 3);
  const wanderPhase = rng() * Math.PI * 2;

  const fixes: Fix[] = [];
  let s = 0;                 // along-track distance flown (m)
  let alt = altBase + 250;   // release height above launch
  let sec = startSec;
  let phase: 'glide' | 'thermal' = 'thermal'; // climb out first
  let guard = 0;

  const emit = (along: number, height: number) => {
    const frac = distanceM > 0 ? Math.min(along / distanceM, 1) : 0;
    const cross = wanderAmp * Math.sin(Math.PI * frac) * Math.sin(wanderPhase + frac * wanderTurns * Math.PI);
    // along-track point, then offset sideways for the thermal-chasing zig-zag.
    const axis = destinationPoint(start.lat, start.lon, along, bearing);
    const pt = cross === 0 ? axis : destinationPoint(axis.lat, axis.lon, Math.abs(cross), cross >= 0 ? perp : perp + Math.PI);
    fixes.push({ sec, lat: pt.lat, lon: pt.lon, alt: height });
  };

  emit(0, alt);
  while (s < distanceM && guard++ < 20000) {
    if (phase === 'thermal') {
      alt += climb * dt;
      s = Math.min(distanceM, s + drift * dt);
      if (alt >= altHigh) phase = 'glide';
    } else {
      alt -= sink * dt;
      s = Math.min(distanceM, s + glideSpeed * dt);
      if (alt <= altLow) phase = 'thermal';
    }
    sec += dt;
    emit(s, alt);
  }
  // Guarantee an exact on-axis furthest fix at the target distance.
  const last = fixes[fixes.length - 1];
  if (last.sec !== sec || Math.abs(s - distanceM) > 1) {
    sec += dt;
    emit(distanceM, Math.max(altBase + 50, last.alt - sink * dt));
  }
  const end = destinationPoint(start.lat, start.lon, distanceM, bearing);
  fixes[fixes.length - 1] = { sec, lat: end.lat, lon: end.lon, alt: Math.max(altBase + 50, last.alt) };
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

// --- distance distribution -------------------------------------------------

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
 * Lay 50 flown-distance targets out on a bell curve across [minKm, maxKm]:
 * the field is centred on ~half the maximum (the bulk make about half the
 * distance), with short symmetric tails — a handful barely get out of the
 * launch cylinder, and a small number reach the long distances. Deterministic
 * (evenly-spaced normal quantiles) with a little RNG jitter for texture.
 */
function distanceTargets(minKm: number, maxKm: number, rng: () => number): number[] {
  const mean = maxKm * 0.5;   // bulk make about half the distance
  const std = maxKm * 0.23;   // spread: tails reach the min/max
  const out: number[] = [];
  for (let i = 0; i < 50; i++) {
    const p = (i + 0.5) / 50; // quantile of the i-th pilot
    const jitter = (rng() - 0.5) * std * 0.15;
    const km = Math.max(minKm, Math.min(maxKm, mean + probit(p) * std + jitter));
    out.push(km * 1000);
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
  minKm: number;
  maxKm: number;
  startZ: number; // seconds-of-day UTC for the launch window
}

const TASKS: TaskSpec[] = [
  { dir: 'big-chip-t1', name: 'Task 1', date: '2026-02-14', dateDDMMYY: '140226', wind: 'SW 5 kt', bearing: 45, minKm: 0.5, maxKm: 77, startZ: 2 * 3600 },
  { dir: 'big-chip-t2', name: 'Task 2', date: '2026-02-15', dateDDMMYY: '150226', wind: 'NW 10 kt', bearing: 135, minKm: 0.7, maxKm: 122, startZ: 2 * 3600 },
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
    comp_name: 'Big Chip (Sample)',
    category: 'hg',
    scoring_format: 'open_distance',
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
      distance_km: [t.minKm, t.maxKm],
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

    // Deterministic per-task RNG for launch scatter + distance targets.
    const taskRng = mulberry32(task.bearing * 1000 + 7);
    const targets = distanceTargets(task.minKm, task.maxKm, taskRng);
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

      const fixes = synthFlight(start, bearing, targets[i], startSec, rng);
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
  console.log('  Seed:  bun run seed:sample big-chip');
  console.log('  Score: bun run score-task -- --open-distance web/samples/comps/big-chip-t1/task.xctsk web/samples/comps/big-chip-t1/');
}

main();
