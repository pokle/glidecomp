#!/usr/bin/env bun
// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * thermal-shapes CLI — extract 3D thermal shapes from every track in a task.
 *
 * Usage:
 *   bun web/engine/cli/thermal-shapes.ts <task-dir> [--out shapes.json]
 *       [--min-pilots N] [--no-samples] [--json]
 *
 * <task-dir> is a task folder holding one task .xctsk plus the pilots' IGC
 * files — a bundled task under web/samples/comps/ or an archive task from
 * glidecomp-archive/comps/. Scoring is not needed: shapes come purely from
 * the tracks, so no wing or GAP parameters are required.
 *
 * Output (--out): JSON { task, generatedFrom, shapes: ThermalShape[] } for
 * the visualiser. Without --out, prints a per-thermal summary table.
 *
 *   --min-pilots N   Only keep thermals that N or more pilots climbed in
 *                    (default 1; multi-pilot thermals have far better
 *                    sampling for shape work).
 *   --no-samples     Strip the raw sample point cloud from the JSON
 *                    (summary bands only; much smaller file).
 *   --no-weather     Skip the model-wind cross-check fetch (offline runs).
 *
 * Model-wind cross-check: with network access, one provider-neutral
 * `fetchTaskWeather` call covers the task's flying window, and each shape is
 * decorated with the model's wind interpolated to its band altitudes at its
 * mid-time. The model series is a CROSS-CHECK against the track-derived wind
 * and is always labelled with its source and kind — a model run must never
 * be read as an observation (docs/weather.md).
 */

import { writeFileSync } from 'fs';
import { basename, resolve } from 'path';
import { detectTakeoffLanding } from '../src/takeoff-landing-detector';
import { detectThermals } from '../src/flight-phase-detectors';
import { detectCircles } from '../src/circle-detector';
import { DEFAULT_THRESHOLDS } from '../src/thresholds';
import type { FixIndexDetails, ThermalSegment } from '../src/event-types';
import {
  extractThermalShapes,
  type ThermalShape,
  type ThermalShapePilot,
} from '../src/field-analysis';
import {
  fetchTaskWeather,
  taskCentroid,
  taskElevationM,
  windAtHeight,
  type TaskWeather,
  type WeatherFetchFn,
  type WeatherHour,
} from '../src/weather';
import { readTaskDir } from './comp-manifest';

function usage(): never {
  process.stderr.write(
    'Usage: thermal-shapes <task-dir> [--out shapes.json] [--min-pilots N] [--no-samples]\n',
  );
  process.exit(1);
}

const args = process.argv.slice(2);
let taskDir: string | undefined;
let outPath: string | undefined;
let minPilots = 1;
let includeSamples = true;
let includeWeather = true;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--out') outPath = args[++i];
  else if (a === '--min-pilots') minPilots = Number(args[++i]) || 1;
  else if (a === '--no-samples') includeSamples = false;
  else if (a === '--no-weather') includeWeather = false;
  else if (a.startsWith('--')) usage();
  else taskDir = a;
}
if (!taskDir) usage();

const dir = resolve(taskDir);
const { task, pilots: flights } = readTaskDir(dir);
process.stderr.write(`Loaded ${flights.length} tracks from ${dir}\n`);

// Per-pilot detector pass — same slice-to-airborne-then-offset-back dance as
// field-analysis buildFieldContext.analysePilot, minus the scoring.
const pilots: ThermalShapePilot[] = [];
for (const flight of flights) {
  const { fixes } = flight;
  let takeoffIndex = 0;
  let landingIndex = fixes.length - 1;
  for (const ev of detectTakeoffLanding(fixes, DEFAULT_THRESHOLDS)) {
    const fixIndex = (ev.details as FixIndexDetails | undefined)?.fixIndex;
    if (fixIndex === undefined) continue;
    if (ev.type === 'takeoff') takeoffIndex = fixIndex;
    if (ev.type === 'landing') landingIndex = fixIndex;
  }
  if (landingIndex <= takeoffIndex) {
    takeoffIndex = 0;
    landingIndex = fixes.length - 1;
  }

  const flightFixes = fixes.slice(takeoffIndex, landingIndex + 1);
  const thermals: ThermalSegment[] = detectThermals(flightFixes, DEFAULT_THRESHOLDS).map((t) => ({
    ...t,
    startIndex: t.startIndex + takeoffIndex,
    endIndex: t.endIndex + takeoffIndex,
  }));
  const circles = detectCircles(flightFixes).circles.map((c) => ({
    ...c,
    startIndex: c.startIndex + takeoffIndex,
    endIndex: c.endIndex + takeoffIndex,
    strongestLiftFixIndex: c.strongestLiftFixIndex + takeoffIndex,
  }));

  pilots.push({ fixes, thermals, circles, label: flight.pilotName });
}

const allShapes = extractThermalShapes(pilots);
const shapes = allShapes.filter((s) => s.pilotCount >= minPilots);
process.stderr.write(
  `Extracted ${allShapes.length} thermal shapes (${shapes.length} with >= ${minPilots} pilots)\n`,
);

// ---------------------------------------------------------------------------
// Model-wind cross-check (Open-Meteo via the provider-neutral registry)
// ---------------------------------------------------------------------------

/** Model wind interpolated to one shape's band altitudes at its mid-time. */
interface ShapeModelWind {
  /** Start of the model hour the profile was read from (ISO UTC). */
  hourIso: string;
  bands: { altMid: number; directionDeg: number; speedMs: number }[];
}

interface WeatherCredit {
  attribution: string;
  model: string;
  kind: string;
  license: string;
  providerId: string;
}

/** The hour whose start is nearest the instant. */
function nearestHour(hours: WeatherHour[], ms: number): WeatherHour | null {
  let best: WeatherHour | null = null;
  let bestGap = Infinity;
  for (const h of hours) {
    const gap = Math.abs(Date.parse(h.t) + 1_800_000 - ms); // hour midpoint
    if (gap < bestGap) {
      best = h;
      bestGap = gap;
    }
  }
  return best;
}

function modelWindFor(shape: ThermalShape, weather: TaskWeather): ShapeModelWind | null {
  const hour = nearestHour(weather.hours, (shape.startMs + shape.endMs) / 2);
  if (!hour) return null;
  const bands: ShapeModelWind['bands'] = [];
  for (const b of shape.bands) {
    const w = windAtHeight(hour.levels, b.altMid);
    if (w) bands.push({ altMid: b.altMid, directionDeg: w.directionDeg, speedMs: w.speedKmh / 3.6 });
  }
  if (bands.length === 0) return null;
  return { hourIso: hour.t, bands };
}

let weather: TaskWeather | null = null;
let weatherCredit: WeatherCredit | null = null;
if (includeWeather && shapes.length > 0) {
  const centre = taskCentroid(task);
  const fromMs = Math.min(...shapes.map((s) => s.startMs)) - 3_600_000;
  const toMs = Math.max(...shapes.map((s) => s.endMs)) + 3_600_000;
  if (centre) {
    try {
      weather = await fetchTaskWeather(
        { lat: centre.lat, lon: centre.lon, elevationM: taskElevationM(task), fromMs, toMs },
        { fetchImpl: fetch as unknown as WeatherFetchFn, nowMs: Date.now() },
      );
      const s = weather.source;
      weatherCredit = {
        attribution: s.attribution,
        model: s.model,
        kind: s.kind,
        license: s.license,
        providerId: s.providerId,
      };
      process.stderr.write(
        `Model wind: ${s.attribution} (${s.model}, ${s.kind}), ${weather.hours.length} hours\n`,
      );
    } catch (err) {
      process.stderr.write(`Model wind unavailable: ${err instanceof Error ? err.message : err}\n`);
    }
  }
}

type DecoratedShape = ThermalShape & { modelWind?: ShapeModelWind | null };
const decorated: DecoratedShape[] = shapes.map((s) =>
  weather ? { ...s, modelWind: modelWindFor(s, weather) } : s,
);

function stripSamples(shape: DecoratedShape): DecoratedShape {
  return { ...shape, samples: [] };
}

if (outPath) {
  const payload = {
    task: { name: task.name ?? basename(dir), dir: basename(dir) },
    generatedFrom: dir,
    weather: weatherCredit,
    shapes: includeSamples ? decorated : decorated.map(stripSamples),
  };
  writeFileSync(outPath, JSON.stringify(payload));
  process.stderr.write(`Wrote ${decorated.length} shapes to ${outPath}\n`);
} else {
  // Summary table to stdout.
  const fmt = (n: number, d = 1) => n.toFixed(d);
  console.log(
    'id  pilots  uses  alt-range        bands  climb(mean)  lean(deg@brg)   wind(m/s@brg)  model(m/s@brg)  best-side',
  );
  for (const s of decorated) {
    const altLo = s.bands[0].altMin;
    const altHi = s.bands[s.bands.length - 1].altMax;
    const meanClimb =
      s.bands.reduce((acc, b) => acc + b.meanVario * b.sampleCount, 0) /
      s.bands.reduce((acc, b) => acc + b.sampleCount, 0);
    const lean = s.lean
      ? `${fmt(s.lean.tiltDeg, 0)}@${fmt(s.lean.bearing, 0)}${s.lean.confounded ? '*' : ' '}`
      : '-';
    const wind = s.wind ? `${fmt(s.wind.speed)}@${fmt(s.wind.direction, 0)}` : '-';
    // Band-weighted mean of the model profile, for the one-line summary.
    let model = '-';
    if (s.modelWind && s.modelWind.bands.length > 0) {
      let u = 0;
      let v = 0;
      for (const b of s.modelWind.bands) {
        const rad = (b.directionDeg * Math.PI) / 180;
        u += b.speedMs * Math.sin(rad);
        v += b.speedMs * Math.cos(rad);
      }
      u /= s.modelWind.bands.length;
      v /= s.modelWind.bands.length;
      model = `${fmt(Math.hypot(u, v))}@${fmt(((Math.atan2(u, v) * 180) / Math.PI + 360) % 360, 0)}`;
    }
    const side = s.strongestSide
      ? `${fmt(s.strongestSide.meanVario)} m/s @ ${fmt(s.strongestSide.bearing, 0)}deg`
      : '-';
    console.log(
      `${String(s.id).padEnd(3)} ${String(s.pilotCount).padStart(5)} ${String(s.useCount).padStart(5)}  ` +
        `${String(Math.round(altLo)).padStart(4)}-${String(Math.round(altHi)).padEnd(4)}m       ` +
        `${String(s.bands.length).padStart(4)}  ${fmt(meanClimb).padStart(8)} m/s  ` +
        `${lean.padEnd(14)} ${wind.padEnd(14)} ${model.padEnd(15)} ${side}`,
    );
  }
  if (decorated.some((s) => s.lean?.confounded)) {
    console.log('\n* lean confounded with time drift (samples climb as one wave)');
  }
  if (weatherCredit) {
    console.log(
      `\nmodel wind: ${weatherCredit.attribution} (${weatherCredit.model}), ` +
        `${weatherCredit.kind} — a model run, not an observation. Licence ${weatherCredit.license}.`,
    );
  }
}
