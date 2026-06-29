// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Gaggle detection — Phase 0 spike.
 *
 * Finds clusters of pilots flying together during a task and tracks them over
 * time into "episodes" (a gaggle that keeps an identity as it drifts and its
 * membership changes). Runs at load time in the browser off the already-loaded
 * tracks (via `samplePilot`), so tuning a threshold is just a page reload.
 *
 * This logic is intentionally framework-free and operates on the metric ENU
 * frame the packer produces (x = East m, y = Up m, z = South m), so proximity is
 * plain Euclidean distance in metres — no lat/lon math. In Phase 1 it moves into
 * the pure engine (`web/engine/src/cluster-detector.ts`) with unit tests; see
 * docs/pilot-cluster-detection-plan.md.
 */

import { samplePilot, type LoadedTracks } from './track-data';

export interface GaggleParams {
  /** Time-grid resolution for clustering, seconds. */
  stepSeconds: number;
  /** Max horizontal separation for two pilots to be linked, metres. */
  horizontalRadius: number;
  /** Max altitude separation for two pilots to be linked, metres. */
  verticalBand: number;
  /** Smallest pilot count that counts as a gaggle. */
  minPilots: number;
  /** Episodes shorter than this are dropped (reject brief fly-bys), seconds. */
  minDurationSeconds: number;
  /** Members an episode must share frame-to-frame to keep its identity. */
  trackMinShared: number;
  /** How long a gaggle can vanish before its episode closes, seconds. */
  bridgeSeconds: number;
}

export const DEFAULT_GAGGLE_PARAMS: GaggleParams = {
  stepSeconds: 10,
  horizontalRadius: 400,
  verticalBand: 300,
  minPilots: 3,
  minDurationSeconds: 60,
  trackMinShared: 2,
  bridgeSeconds: 20,
};

/** A persistent gaggle over time. */
export interface GaggleEpisode {
  id: number;
  /** tRel seconds (seconds since manifest.t0). */
  tStart: number;
  tEnd: number;
  /** Union of every pilot index that was ever in the gaggle. */
  members: number[];
  /** Per-grid-step membership snapshots, ascending in t. */
  timeline: { t: number; members: number[] }[];
  peakSize: number;
}

export interface GaggleResult {
  params: GaggleParams;
  episodes: GaggleEpisode[];
}

/** One pilot's state at a grid time, in ENU metres (un-exaggerated). */
interface PilotState {
  pilot: number;
  x: number;
  y: number;
  z: number;
}

/**
 * Single-linkage connected components: link two pilots when they are close in
 * BOTH horizontal distance and altitude, then return components of size
 * >= minPilots as arrays of pilot indices (each sorted ascending).
 */
function clusterFrame(states: PilotState[], p: GaggleParams): number[][] {
  const n = states.length;
  const parent = new Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const h2 = p.horizontalRadius * p.horizontalRadius;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(states[i].y - states[j].y) > p.verticalBand) continue;
      const dx = states[i].x - states[j].x;
      const dz = states[i].z - states[j].z;
      if (dx * dx + dz * dz <= h2) {
        parent[find(i)] = find(j);
      }
    }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = []));
    g.push(states[i].pilot);
  }
  const out: number[][] = [];
  for (const g of groups.values()) {
    if (g.length >= p.minPilots) out.push(g.sort((a, b) => a - b));
  }
  return out;
}

function overlapCount(a: number[], b: number[]): number {
  // both sorted ascending
  let i = 0;
  let j = 0;
  let n = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      n++;
      i++;
      j++;
    } else if (a[i] < b[j]) i++;
    else j++;
  }
  return n;
}

interface OpenEpisode {
  id: number;
  tStart: number;
  lastT: number;
  lastMembers: number[];
  timeline: { t: number; members: number[] }[];
  union: Set<number>;
  peak: number;
}

/**
 * Detect gaggles across the whole task: sample a time grid, cluster each frame,
 * then stitch frames into episodes by membership overlap (bridging short gaps),
 * and drop episodes shorter than minDurationSeconds.
 */
export function detectGaggles(
  tracks: LoadedTracks,
  params: GaggleParams = DEFAULT_GAGGLE_PARAMS,
): GaggleResult {
  const { manifest } = tracks;
  const alt0 = manifest.origin.alt0;
  const duration = manifest.t1 - manifest.t0;
  const nPilots = manifest.pilots.length;

  const open: OpenEpisode[] = [];
  const done: GaggleEpisode[] = [];
  let nextId = 0;

  const finalize = (o: OpenEpisode): GaggleEpisode => ({
    id: o.id,
    tStart: o.tStart,
    tEnd: o.lastT,
    members: [...o.union].sort((a, b) => a - b),
    timeline: o.timeline,
    peakSize: o.peak,
  });

  const states: PilotState[] = [];
  for (let t = 0; t <= duration + 1e-6; t += params.stepSeconds) {
    // --- sample active pilots at this grid time ---
    states.length = 0;
    for (let i = 0; i < nPilots; i++) {
      const s = samplePilot(tracks, i, t, alt0);
      if (s.active) states.push({ pilot: i, x: s.x, y: s.y, z: s.z });
    }
    const clusters = clusterFrame(states, params);

    // --- match clusters to open episodes (greedy by overlap) ---
    const pairs: { oi: number; ci: number; ov: number }[] = [];
    for (let oi = 0; oi < open.length; oi++) {
      for (let ci = 0; ci < clusters.length; ci++) {
        const ov = overlapCount(open[oi].lastMembers, clusters[ci]);
        if (ov >= params.trackMinShared) pairs.push({ oi, ci, ov });
      }
    }
    pairs.sort((a, b) => b.ov - a.ov);
    const usedOpen = new Set<number>();
    const usedCluster = new Set<number>();
    for (const { oi, ci } of pairs) {
      if (usedOpen.has(oi) || usedCluster.has(ci)) continue;
      usedOpen.add(oi);
      usedCluster.add(ci);
      const o = open[oi];
      const c = clusters[ci];
      o.lastT = t;
      o.lastMembers = c;
      o.timeline.push({ t, members: c });
      for (const m of c) o.union.add(m);
      o.peak = Math.max(o.peak, c.length);
    }

    // --- unmatched clusters open new episodes ---
    for (let ci = 0; ci < clusters.length; ci++) {
      if (usedCluster.has(ci)) continue;
      const c = clusters[ci];
      open.push({
        id: nextId++,
        tStart: t,
        lastT: t,
        lastMembers: c,
        timeline: [{ t, members: c }],
        union: new Set(c),
        peak: c.length,
      });
    }

    // --- close episodes that have been gone longer than the bridge ---
    for (let i = open.length - 1; i >= 0; i--) {
      if (t - open[i].lastT > params.bridgeSeconds) {
        done.push(finalize(open[i]));
        open.splice(i, 1);
      }
    }
  }
  for (const o of open) done.push(finalize(o));

  const episodes = done
    .filter((e) => e.tEnd - e.tStart >= params.minDurationSeconds)
    .sort((a, b) => a.tStart - b.tStart);

  return { params, episodes };
}

/** A gaggle that is active at a given time, with its members right then. */
export interface ActiveGaggle {
  id: number;
  members: number[];
}

/**
 * Gaggles active at time `t` (tRel seconds) with their membership at the nearest
 * grid snapshot. Cheap linear scan — there are only a handful of episodes.
 */
export function gagglesAt(result: GaggleResult, t: number): ActiveGaggle[] {
  const tol = result.params.stepSeconds;
  const out: ActiveGaggle[] = [];
  for (const ep of result.episodes) {
    if (t < ep.tStart - tol || t > ep.tEnd + tol) continue;
    let best = ep.timeline[0];
    let bd = Infinity;
    for (const s of ep.timeline) {
      const d = Math.abs(s.t - t);
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    if (best && bd <= tol) out.push({ id: ep.id, members: best.members });
  }
  return out;
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
