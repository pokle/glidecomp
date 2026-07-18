// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Shared time-grid resampler — the engine's canonical way to put a field of
 * pilots' (irregularly sampled) tracks onto one time grid so cross-pilot
 * questions become array lookups: gaggle clustering (`detectGaggles` Frames),
 * "who was where when pilot X started", proximity, and per-step vario.
 *
 * ENU convention matches `cluster-detector.ts` / `track-packer.ts`:
 * x = East, y = Up (altitude), z = South = −north.
 */

import type { IGCFix } from '../igc-parser';
import type { Frame, PilotState } from '../cluster-detector';
import { localEastNorth } from '../geo';

/** One pilot's interpolated state at a grid step. */
export interface ResampledSample {
  lat: number;
  lon: number;
  /** GNSS altitude (pressure fallback when GNSS is 0), metres. */
  alt: number;
  /** Metres east of the grid origin. */
  east: number;
  /** Metres north of the grid origin (note: Frame z = −north). */
  north: number;
  /** Climb rate over the previous grid step, m/s (0 at the first sample). */
  vario: number;
}

/** One pilot on the shared grid. `samples[i]` is null when not airborne or in a logger gap. */
export interface ResampledTrack {
  /** First grid step with a sample, -1 when the pilot never sampled. */
  startStep: number;
  /** Last grid step with a sample, -1 when the pilot never sampled. */
  endStep: number;
  /** Length `grid.count`, indexed by grid step. */
  samples: (ResampledSample | null)[];
}

/** The shared grid plus per-step cluster-detector Frames. */
export interface TimeGrid {
  /** Epoch ms of grid step 0 (min takeoff time, floored to the step). */
  t0Ms: number;
  stepSeconds: number;
  /** Number of grid steps. */
  count: number;
  /**
   * One Frame per grid step, ready for `detectGaggles`. `Frame.t` is relative
   * seconds (`i * stepSeconds`); `states[].pilot` is the caller's pilot index.
   */
  frames: Frame[];
}

/** Longest fix gap (s) interpolated across; longer gaps yield null samples. */
const MAX_INTERPOLATION_GAP_SECONDS = 60;

/** Grid length cap — no competition task runs 14 h; a corrupt track shouldn't OOM us. */
const MAX_GRID_HOURS = 14;

interface PilotTrackSpec {
  fixes: IGCFix[];
  takeoffIndex: number;
  landingIndex: number;
}

/** GNSS altitude with the same pressure fallback the track packer uses. */
function altOf(fix: IGCFix): number {
  return fix.gnssAltitude !== 0 ? fix.gnssAltitude : fix.pressureAltitude;
}

/**
 * Sample every pilot's track onto one shared time grid.
 *
 * Linear interpolation between the bracketing fixes; samples exist only
 * between each pilot's takeoff and landing fixes, and a fix gap longer than
 * {@link MAX_INTERPOLATION_GAP_SECONDS} yields nulls rather than inventing a
 * straight line across a logger dropout. One two-pointer sweep per pilot —
 * O(fixes + steps).
 */
export function buildTimeGrid(
  pilots: PilotTrackSpec[],
  origin: { lat: number; lon: number },
  stepSeconds = 10,
): { grid: TimeGrid; tracks: ResampledTrack[] } {
  const stepMs = stepSeconds * 1000;

  // Grid extent: earliest takeoff → latest landing across the field.
  let minMs = Infinity;
  let maxMs = -Infinity;
  for (const p of pilots) {
    if (p.fixes.length === 0 || p.landingIndex <= p.takeoffIndex) continue;
    minMs = Math.min(minMs, p.fixes[p.takeoffIndex].time.getTime());
    maxMs = Math.max(maxMs, p.fixes[p.landingIndex].time.getTime());
  }
  if (!isFinite(minMs)) {
    const grid: TimeGrid = { t0Ms: 0, stepSeconds, count: 0, frames: [] };
    return { grid, tracks: pilots.map(() => ({ startStep: -1, endStep: -1, samples: [] })) };
  }

  const t0Ms = Math.floor(minMs / stepMs) * stepMs;
  const maxCount = Math.ceil((MAX_GRID_HOURS * 3600) / stepSeconds) + 1;
  const count = Math.min(Math.ceil((maxMs - t0Ms) / stepMs) + 1, maxCount);

  const tracks: ResampledTrack[] = [];
  for (const p of pilots) {
    tracks.push(resamplePilot(p, t0Ms, stepMs, count, origin));
  }

  const frames: Frame[] = [];
  for (let i = 0; i < count; i++) {
    const states: PilotState[] = [];
    for (let pi = 0; pi < tracks.length; pi++) {
      const s = tracks[pi].samples[i];
      if (s) states.push({ pilot: pi, x: s.east, y: s.alt, z: -s.north });
    }
    frames.push({ t: i * stepSeconds, states });
  }

  return { grid: { t0Ms, stepSeconds, count, frames }, tracks };
}

function resamplePilot(
  p: PilotTrackSpec,
  t0Ms: number,
  stepMs: number,
  count: number,
  origin: { lat: number; lon: number },
): ResampledTrack {
  const samples: (ResampledSample | null)[] = new Array(count).fill(null);
  if (p.fixes.length === 0 || p.landingIndex <= p.takeoffIndex) {
    return { startStep: -1, endStep: -1, samples };
  }

  const takeoffMs = p.fixes[p.takeoffIndex].time.getTime();
  const landingMs = p.fixes[p.landingIndex].time.getTime();
  const firstStep = Math.max(0, Math.ceil((takeoffMs - t0Ms) / stepMs));
  const lastStep = Math.min(count - 1, Math.floor((landingMs - t0Ms) / stepMs));

  let j = p.takeoffIndex; // bracketing fix: fixes[j].time <= t < fixes[j+1].time
  let startStep = -1;
  let endStep = -1;
  let prevAlt: number | null = null;

  for (let i = firstStep; i <= lastStep; i++) {
    const t = t0Ms + i * stepMs;
    while (j + 1 <= p.landingIndex && p.fixes[j + 1].time.getTime() <= t) j++;
    const a = p.fixes[j];
    const b = j + 1 <= p.landingIndex ? p.fixes[j + 1] : a;
    const aMs = a.time.getTime();
    const bMs = b.time.getTime();

    // Logger dropout: don't invent a straight line across a long fix gap.
    if (bMs - aMs > MAX_INTERPOLATION_GAP_SECONDS * 1000 && t > aMs && t < bMs) {
      prevAlt = null;
      continue;
    }

    const f = bMs > aMs ? (t - aMs) / (bMs - aMs) : 0;
    const lat = a.latitude + (b.latitude - a.latitude) * f;
    const lon = a.longitude + (b.longitude - a.longitude) * f;
    const alt = altOf(a) + (altOf(b) - altOf(a)) * f;
    const { east, north } = localEastNorth(origin.lat, origin.lon, lat, lon);
    const vario = prevAlt !== null ? (alt - prevAlt) / (stepMs / 1000) : 0;
    samples[i] = { lat, lon, alt, east, north, vario };
    prevAlt = alt;
    if (startStep === -1) startStep = i;
    endStep = i;
  }

  return { startStep, endStep, samples };
}

/** The sample at the grid step nearest an absolute time, or null. */
export function sampleAt(
  grid: TimeGrid,
  track: ResampledTrack,
  tMs: number,
): ResampledSample | null {
  if (grid.count === 0) return null;
  const i = Math.round((tMs - grid.t0Ms) / (grid.stepSeconds * 1000));
  if (i < 0 || i >= grid.count) return null;
  return track.samples[i];
}

/** Grid step index for an absolute time (clamped into range; -1 for an empty grid). */
export function stepFor(grid: TimeGrid, tMs: number): number {
  if (grid.count === 0) return -1;
  const i = Math.round((tMs - grid.t0Ms) / (grid.stepSeconds * 1000));
  return Math.min(grid.count - 1, Math.max(0, i));
}
