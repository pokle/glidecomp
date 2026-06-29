// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Gaggle detection — viewer adapter.
 *
 * The clustering + temporal-tracking algorithm lives in the pure engine
 * (`@glidecomp/engine` → `cluster-detector.ts`), DOM-free and unit-tested. This
 * module is the thin browser glue: it samples the already-loaded tracks onto a
 * time grid (via `samplePilot`), discovers the start cylinder and turnpoints
 * from the manifest, hands those frames to the engine, and adds the viewer-only
 * concern of a stable per-gaggle colour. Runs at load time, so tuning a
 * threshold is just a page reload.
 *
 * See docs/pilot-cluster-detection-plan.md.
 */

import {
  detectGaggles as detectGagglesEngine,
  DEFAULT_GAGGLE_PARAMS,
  type Frame,
  type GaggleParams,
  type GaggleResult,
  type StartCylinder,
  type TurnpointXZ,
} from '@glidecomp/engine';
import { samplePilot, type LoadedTracks } from './track-data';

export {
  DEFAULT_GAGGLE_PARAMS,
  gagglesAt,
  type GaggleParams,
  type GaggleEpisode,
  type GaggleResult,
  type ActiveGaggle,
} from '@glidecomp/engine';

/**
 * Detect gaggles for the loaded tracks: sample every active pilot on a
 * `stepSeconds` grid into frames, then delegate clustering/tracking to the
 * engine. The speed-section start cylinder is passed through so the engine can
 * exclude the pre-start loiter, and the task turnpoints so episodes can be
 * annotated with `nearTurnpoint`.
 */
export function detectGaggles(
  tracks: LoadedTracks,
  params: GaggleParams = DEFAULT_GAGGLE_PARAMS,
): GaggleResult {
  const { manifest } = tracks;
  const alt0 = manifest.origin.alt0;
  const duration = manifest.t1 - manifest.t0;
  const nPilots = manifest.pilots.length;

  const frames: Frame[] = [];
  for (let t = 0; t <= duration + 1e-6; t += params.stepSeconds) {
    const states = [];
    for (let i = 0; i < nPilots; i++) {
      const s = samplePilot(tracks, i, t, alt0);
      if (s.active) states.push({ pilot: i, x: s.x, y: s.y, z: s.z });
    }
    frames.push({ t, states });
  }

  return detectGagglesEngine(frames, params, {
    startCylinder: findStartCylinder(manifest),
    turnpoints: manifest.task?.turnpoints?.map((tp): TurnpointXZ => ({ x: tp.x, z: tp.z })),
  });
}

/** The start-of-speed-section cylinder in ENU metres, if the task has one. */
function findStartCylinder(manifest: LoadedTracks['manifest']): StartCylinder | null {
  const tps = manifest.task?.turnpoints;
  if (!tps?.length) return null;
  // Prefer the explicit speed-section start; fall back to anything that looks
  // like a start turnpoint by type.
  const tp =
    tps.find((t) => t.type === 'SSS') ?? tps.find((t) => /SSS|START/i.test(t.type ?? ''));
  if (!tp) return null;
  return { x: tp.x, z: tp.z, radius: tp.radius };
}

/** Stable, pilot-distinct colour for a gaggle id (bright cyan→violet band). */
export function gaggleColor(id: number): [number, number, number] {
  const hue = ((id * 137.508) % 360) / 360;
  return hslToRgb(hue, 0.85, 0.62);
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
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
