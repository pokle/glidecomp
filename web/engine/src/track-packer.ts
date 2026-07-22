// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Track packer — turns parsed IGC tracks into a compact binary asset for the
 * 3D flight-replay viewer (see docs/flight-replay-3d-brief.md).
 *
 * This module is **pure** (no fs, no DOM, no gzip) so the exact same code can run
 * in an offline build step *or* inside a Cloudflare Worker. The caller is
 * responsible for I/O and compression:
 *   - offline:  zlib.gzipSync(packed.data.buffer)  → write to disk
 *   - worker:   new Response(stream.pipeThrough(new CompressionStream('gzip')))
 *
 * Output is two artefacts:
 *   - `manifest`  — tiny JSON describing the origin, palette, pilots and task.
 *   - `data`      — one interleaved Float32Array, `FLOATS_PER_VERTEX` per fix,
 *                   pilots concatenated in `manifest.pilots[]` order.
 *
 * Coordinate convention (right-handed, Three.js Y-up) — geographically correct
 * ENU so a plain camera facing north shows East on the right:
 *   X = East, Y = Up, Z = South  (North = -Z).
 * Latitude/longitude/altitude are projected onto an equirectangular tangent
 * plane at the origin — accurate to well under a metre over a ~100 km task area.
 */

import { getEffectiveSSSIndex, type XCTask } from './xctsk-parser';
import { calculateOptimizedTaskLine } from './task-optimizer';
import { computeGoalLine } from './goal-line';

/** Floats stored per vertex in `tracks.bin`: [x, y, z, tRel]. */
export const FLOATS_PER_VERTEX = 4;

/** A single GPS fix for one pilot, already reduced to what the packer needs. */
export interface TrackFix {
  /** WGS84 latitude in degrees. */
  lat: number;
  /** WGS84 longitude in degrees. */
  lon: number;
  /** Altitude in metres (caller decides GPS vs pressure). */
  alt: number;
  /** Absolute fix time, UTC seconds. */
  t: number;
}

/** One pilot's track to be packed. Fixes must be sorted ascending by time. */
export interface PilotTrackInput {
  /** Stable identifier (e.g. CIVL id or filename stem). */
  id: string;
  /** Human-readable pilot name. */
  name: string;
  fixes: TrackFix[];
  /** GAP total score, if computed (drives legend ordering). */
  score?: number;
  /** 1-based finishing rank, if computed. */
  rank?: number;
  /**
   * Turnpoints this pilot reached, in task order: taskIndex + absolute UTC
   * seconds of the crossing. The packer rebases times onto the manifest's
   * tRel clock. Lets the viewer know which turnpoint is "next" at any time.
   */
  reached?: { tp: number; t: number }[];
}

export interface PackInput {
  pilots: PilotTrackInput[];
  /** Optional task geometry, projected into the same ENU frame for context. */
  task?: XCTask;
  /**
   * IANA timezone for the comp location (e.g. "Australia/Melbourne"), if the
   * caller can resolve it — the comp's stored `timezone` setting, or a
   * lookup via `src/timezone.ts` (tz-lookup, pure JS). Stored on the
   * manifest so the viewer shows the comp's local time regardless of who's
   * watching.
   */
  timezone?: string;
}

/** Per-pilot metadata: where this pilot's vertices live in the buffer. */
export interface TrackPilotMeta {
  id: string;
  name: string;
  /** Index into `manifest.colors`. */
  colorIdx: number;
  /** First vertex index (not byte/float offset) for this pilot. */
  vertexOffset: number;
  /** Number of vertices (fixes) for this pilot. */
  vertexCount: number;
  /** GAP total score, if computed. */
  score?: number;
  /** 1-based finishing rank, if computed. */
  rank?: number;
  /**
   * Turnpoints this pilot reached, in task order: index into
   * `task.turnpoints` + crossing time in tRel seconds (same clock as the
   * vertex data). Absent when the task wasn't scored for this pilot.
   */
  reached?: { tp: number; t: number }[];
}

/** A task turnpoint projected into the viewer's ENU frame. */
export interface TrackTaskPoint {
  name: string;
  type?: string;
  /** Cylinder radius in metres. */
  radius: number;
  /** East metres from origin. */
  x: number;
  /** North metres from origin. */
  z: number;
  lat: number;
  lon: number;
  /** Waypoint altitude in metres MSL (altSmoothed), when the task has one. */
  alt?: number;
}

export interface TrackManifest {
  /** Local tangent-plane origin. */
  origin: { lat0: number; lon0: number; alt0: number };
  /** Metres per degree of latitude at the origin. */
  mPerDegLat: number;
  /** Metres per degree of longitude at the origin. */
  mPerDegLon: number;
  /** UTC seconds of the first fix across all pilots. */
  t0: number;
  /** UTC seconds of the last fix across all pilots. */
  t1: number;
  /** Total vertices across all pilots. */
  vertexCount: number;
  /** Floats per vertex in the binary (always `FLOATS_PER_VERTEX`). */
  floatsPerVertex: number;
  /** Min/max altitude (metres, relative to alt0 → equals Y in the scene). */
  altMin: number;
  altMax: number;
  /** IANA timezone at the task location (e.g. "Australia/Melbourne"), if resolved. */
  timezone?: string;
  /** Categorical RGB palette, components in 0..1. */
  colors: [number, number, number][];
  pilots: TrackPilotMeta[];
  /** Optional task geometry in ENU metres. */
  task?: {
    turnpoints: TrackTaskPoint[];
    /**
     * Effective start-of-speed-section index (the "next turnpoint" for a
     * pilot who hasn't reached anything yet — see getEffectiveSSSIndex).
     */
    sssIndex?: number;
    /**
     * The optimised (shortest) task path tagging each cylinder edge, in ENU
     * metres (x = East, z = North). Matches `calculateOptimizedTaskLine`, the
     * same line the 2D analysis view draws. Absent for 0/1-turnpoint tasks.
     */
    optimizedPath?: { x: number; z: number }[];
    /**
     * Present when the task ends at a goal LINE (S7F §6.3.1) instead of a
     * cylinder: the line's endpoints in ENU metres, perpendicular to the
     * final leg and centred on the last turnpoint. The viewer draws the
     * goal as this line (with its control semicircle behind it) rather
     * than the last turnpoint's cylinder.
     */
    goalLine?: { x1: number; z1: number; x2: number; z2: number };
  };
}

export interface PackedTracks {
  manifest: TrackManifest;
  /** Interleaved [x, y, z, tRel] × vertexCount. */
  data: Float32Array;
}

/**
 * Metres per degree of latitude/longitude at a given latitude (WGS84 series).
 * Same formula the brief specifies; good to sub-metre over a competition area.
 */
export function metresPerDegree(lat0: number): { mPerDegLat: number; mPerDegLon: number } {
  const lat0r = (lat0 * Math.PI) / 180;
  const mPerDegLat = 111132.92 - 559.82 * Math.cos(2 * lat0r) + 1.175 * Math.cos(4 * lat0r);
  const mPerDegLon =
    111412.84 * Math.cos(lat0r) - 93.5 * Math.cos(3 * lat0r) + 0.118 * Math.cos(5 * lat0r);
  return { mPerDegLat, mPerDegLon };
}

/**
 * Build a categorical palette of `n` visually distinct RGB triples (0..1) by
 * walking the hue circle with the golden-angle increment and alternating
 * lightness/saturation so neighbours stay distinguishable.
 */
export function buildPalette(n: number): [number, number, number][] {
  const colors: [number, number, number][] = [];
  const golden = 137.508; // golden angle in degrees
  for (let i = 0; i < n; i++) {
    const h = (i * golden) % 360;
    const s = 0.62 + 0.18 * (i % 2); // 0.62 / 0.80
    const l = 0.55 - 0.08 * (i % 3); // 0.55 / 0.47 / 0.39
    colors.push(hslToRgb(h / 360, s, l));
  }
  return colors;
}

/**
 * Deterministic RGB triple (0..1) for a pilot name, so each pilot keeps the same
 * colour across builds regardless of roster order. The name is hashed (FNV-1a)
 * and the bits drive hue plus the same saturation/lightness bands as
 * `buildPalette`, so colours look consistent with the categorical palette.
 */
export function colorForName(name: string): [number, number, number] {
  let h = 0x811c9dc5; // FNV-1a 32-bit offset basis
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h >>>= 0;
  const hue = (h % 360) / 360;
  const s = 0.62 + 0.18 * ((h >>> 9) & 1); // 0.62 / 0.80
  const l = 0.55 - 0.08 * ((h >>> 10) % 3); // 0.55 / 0.47 / 0.39
  return hslToRgb(hue, s, l);
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l, l, l];
  const hue2rgb = (p: number, q: number, t: number): number => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue2rgb(p, q, h + 1 / 3), hue2rgb(p, q, h), hue2rgb(p, q, h - 1 / 3)];
}

/**
 * Pack a set of pilot tracks into the binary + manifest described in the brief.
 *
 * Origin: mean of every pilot's first fix (takeoffs) for lat/lon; `alt0` is the
 * minimum altitude across all fixes, so the lowest point of the scene sits at
 * Y = 0 and altitude numbers stay small.
 *
 * Pilots with no fixes are dropped (e.g. a track that failed its security check).
 */
export function packTracks(input: PackInput): PackedTracks {
  const pilots = input.pilots.filter((p) => p.fixes.length > 0);
  if (pilots.length === 0) {
    throw new Error('packTracks: no pilots with fixes');
  }

  // --- Origin: mean takeoff lat/lon, min alt ---
  let sumLat = 0;
  let sumLon = 0;
  let alt0 = Infinity;
  let t0 = Infinity;
  let t1 = -Infinity;
  for (const p of pilots) {
    sumLat += p.fixes[0].lat;
    sumLon += p.fixes[0].lon;
    for (const f of p.fixes) {
      if (f.alt < alt0) alt0 = f.alt;
      if (f.t < t0) t0 = f.t;
      if (f.t > t1) t1 = f.t;
    }
  }
  const lat0 = sumLat / pilots.length;
  const lon0 = sumLon / pilots.length;
  const { mPerDegLat, mPerDegLon } = metresPerDegree(lat0);

  // Project lat/lon → local ENU metres. One place for the convention:
  // East → +X, North → -Z (right-handed, so a north-facing camera shows East right).
  const projX = (lon: number): number => (lon - lon0) * mPerDegLon;
  const projZ = (lat: number): number => (lat0 - lat) * mPerDegLat;

  // --- Pack vertices ---
  const vertexCount = pilots.reduce((n, p) => n + p.fixes.length, 0);
  const data = new Float32Array(vertexCount * FLOATS_PER_VERTEX);
  const pilotsMeta: TrackPilotMeta[] = [];
  // Per-pilot colour derived from the name hash, so a pilot keeps the same
  // colour across builds even if the roster order changes.
  const palette = pilots.map((p) => colorForName(p.name));

  let altMin = Infinity;
  let altMax = -Infinity;
  let vi = 0; // running vertex index
  pilots.forEach((p, pilotIdx) => {
    const vertexOffset = vi;
    for (const f of p.fixes) {
      const y = f.alt - alt0; // Up → +Y
      if (y < altMin) altMin = y;
      if (y > altMax) altMax = y;
      const o = vi * FLOATS_PER_VERTEX;
      data[o + 0] = projX(f.lon);
      data[o + 1] = y;
      data[o + 2] = projZ(f.lat);
      data[o + 3] = f.t - t0; // tRel seconds
      vi++;
    }
    pilotsMeta.push({
      id: p.id,
      name: p.name,
      colorIdx: pilotIdx,
      vertexOffset,
      vertexCount: p.fixes.length,
      score: p.score,
      rank: p.rank,
      // Rebase reach times from UTC seconds onto the manifest's tRel clock.
      reached: p.reached?.map((r) => ({ tp: r.tp, t: Math.round(r.t - t0) })),
    });
  });

  // --- Task geometry (optional) ---
  let task: TrackManifest['task'];
  if (input.task) {
    const turnpoints: TrackTaskPoint[] = input.task.turnpoints.map((tp) => ({
      name: tp.waypoint.name,
      type: tp.type,
      radius: tp.radius,
      x: projX(tp.waypoint.lon),
      z: projZ(tp.waypoint.lat),
      lat: tp.waypoint.lat,
      lon: tp.waypoint.lon,
      alt: tp.waypoint.altSmoothed,
    }));
    // Project the optimised shortest path (lat/lon tagging cylinder edges) into
    // the same ENU frame so the viewer can draw it without re-running the
    // optimiser (and without the original lat/lon task) at runtime.
    const opt = calculateOptimizedTaskLine(input.task);
    const optimizedPath =
      opt.length >= 2 ? opt.map((p) => ({ x: projX(p.lon), z: projZ(p.lat) })) : undefined;
    // Goal line endpoints (when the goal is a LINE), projected like the rest
    // of the task so the viewer needs no lat/lon geometry at runtime.
    const gl = computeGoalLine(input.task);
    const goalLine = gl
      ? {
          x1: projX(gl.end1.lon),
          z1: projZ(gl.end1.lat),
          x2: projX(gl.end2.lon),
          z2: projZ(gl.end2.lat),
        }
      : undefined;
    const sss = getEffectiveSSSIndex(input.task);
    task = { turnpoints, sssIndex: sss >= 0 ? sss : undefined, optimizedPath, goalLine };
  }

  const manifest: TrackManifest = {
    origin: { lat0, lon0, alt0 },
    mPerDegLat,
    mPerDegLon,
    t0,
    t1,
    vertexCount,
    floatsPerVertex: FLOATS_PER_VERTEX,
    altMin,
    altMax,
    timezone: input.timezone,
    colors: palette,
    pilots: pilotsMeta,
    task,
  };

  return { manifest, data };
}
