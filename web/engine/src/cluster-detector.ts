// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Gaggle detection — finding clusters of pilots flying together during a task
 * and tracking them over time into "episodes" (a gaggle that keeps an identity
 * as it drifts and its membership changes).
 *
 * Pure and DOM/fs-free: it operates on pre-sampled frames in a metric ENU frame
 * (x = East m, y = Up m, z = South m), so proximity is plain Euclidean distance
 * in metres — no lat/lon math. The caller samples the tracks onto a time grid
 * (e.g. the 3dvis viewer via `samplePilot`); this module does the clustering,
 * temporal tracking, start-cylinder exclusion and explainable output. That keeps
 * it portable to build-time / a Worker later, like `track-packer.ts`.
 *
 * Two layers:
 *   1. per-frame spatial clustering — single-linkage union-find over a
 *      horizontal AND a vertical proximity gate (`clusterFrame`);
 *   2. temporal tracking — stitch per-frame clusters into persistent episodes by
 *      membership overlap, bridging short dropouts, dropping brief fly-bys
 *      (`detectGaggles`).
 *
 * See docs/pilot-cluster-detection-plan.md.
 */

export interface GaggleParams {
  /** Time-grid resolution the frames were sampled at, seconds. */
  stepSeconds: number;
  /** Max horizontal separation for two pilots to be linked, metres. */
  horizontalRadius: number;
  /** Max altitude separation for two pilots to be linked, metres. */
  verticalBand: number;
  /** Smallest pilot count that counts as a gaggle (2 = "flying together"). */
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
  // 2 rather than 3: some of the most instructive gaggles are a pair working
  // together. Safe to go this low because the pre-start loiter (where everyone
  // is bunched in the start cylinder) is excluded separately — see the
  // `startCylinder` option on `detectGaggles`.
  minPilots: 2,
  minDurationSeconds: 60,
  trackMinShared: 2,
  bridgeSeconds: 20,
};

/** One pilot's state at a grid time, in ENU metres (un-exaggerated). */
export interface PilotState {
  /** Stable pilot index (the caller's id; preserved through to episode members). */
  pilot: number;
  x: number;
  y: number;
  z: number;
}

/** All active pilots sampled at one grid time. */
export interface Frame {
  /** tRel seconds (seconds since the caller's epoch, e.g. manifest.t0). */
  t: number;
  states: PilotState[];
}

/** Start-of-speed-section cylinder in the same ENU frame, for exclusion. */
export interface StartCylinder {
  x: number;
  z: number;
  /** Radius in metres. */
  radius: number;
}

/** A turnpoint position in ENU metres, used to annotate `nearTurnpoint`. */
export interface TurnpointXZ {
  x: number;
  z: number;
}

export interface DetectOptions {
  /**
   * If set, a pilot is excluded from clustering on any frame where they are
   * inside this cylinder — that drops the uninteresting pre-start gaggle, where
   * everyone loiters in the speed-section start cylinder waiting for the gate.
   * Once a pilot is outside it they count as racing, whether they just crossed
   * out or were never seen inside (so a logger that started outside the cylinder
   * isn't silently excluded).
   */
  startCylinder?: StartCylinder | null;
  /** Task turnpoints (ENU), used to fill `episode.nearTurnpoint`. */
  turnpoints?: TurnpointXZ[];
}

/** A persistent gaggle over time. */
export interface GaggleEpisode {
  id: number;
  /** tRel seconds. */
  tStart: number;
  tEnd: number;
  /** Union of every pilot index that was ever in the gaggle. */
  members: number[];
  /** Per-grid-step membership snapshots, ascending in t. */
  timeline: { t: number; members: number[] }[];
  peakSize: number;
  /** Index into the supplied `turnpoints` nearest the gaggle at its midpoint. */
  nearTurnpoint?: number;
}

export interface GaggleResult {
  params: GaggleParams;
  episodes: GaggleEpisode[];
}

/**
 * Single-linkage connected components: link two pilots when they are close in
 * BOTH horizontal distance and altitude, then return components of size
 * >= minPilots as arrays of pilot indices (each sorted ascending).
 *
 * Separate horizontal + vertical gates (rather than one scaled 3D distance)
 * because they mean different, independently-explainable things — "within X m
 * laterally and Y m vertically." A thermal is a tall column, so `verticalBand`
 * is deliberately generous.
 */
export function clusterFrame(states: PilotState[], params: GaggleParams): number[][] {
  const n = states.length;
  const parent = new Array<number>(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const h2 = params.horizontalRadius * params.horizontalRadius;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(states[i].y - states[j].y) > params.verticalBand) continue;
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
    if (g.length >= params.minPilots) out.push(g.sort((a, b) => a - b));
  }
  return out;
}

/** Number of shared elements between two ascending-sorted arrays. */
function overlapCount(a: number[], b: number[]): number {
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
  /** Cluster centroid per snapshot (ENU x/z), parallel to `timeline`. */
  centroids: { t: number; x: number; z: number }[];
  union: Set<number>;
  peak: number;
}

/**
 * Detect gaggles across a task: cluster each pre-sampled frame, then stitch
 * frames into episodes by membership overlap (bridging short gaps), and drop
 * episodes shorter than `minDurationSeconds`.
 *
 * `frames` are sorted ascending in t internally, so callers needn't pre-sort.
 */
export function detectGaggles(
  frames: Frame[],
  params: GaggleParams = DEFAULT_GAGGLE_PARAMS,
  opts: DetectOptions = {},
): GaggleResult {
  const { startCylinder, turnpoints } = opts;
  const startR2 = startCylinder ? startCylinder.radius * startCylinder.radius : 0;

  const open: OpenEpisode[] = [];
  const done: GaggleEpisode[] = [];
  let nextId = 0;

  const finalize = (o: OpenEpisode): GaggleEpisode => {
    const ep: GaggleEpisode = {
      id: o.id,
      tStart: o.tStart,
      tEnd: o.lastT,
      members: [...o.union].sort((a, b) => a - b),
      timeline: o.timeline,
      peakSize: o.peak,
    };
    const near = nearestTurnpoint(o, turnpoints);
    if (near >= 0) ep.nearTurnpoint = near;
    return ep;
  };

  const sorted = frames.slice().sort((a, b) => a.t - b.t);
  for (const frame of sorted) {
    const t = frame.t;

    // --- start-cylinder exclusion: skip pilots still in the start cylinder ---
    let states = frame.states;
    if (startCylinder) {
      states = frame.states.filter((s) => {
        const dx = s.x - startCylinder.x;
        const dz = s.z - startCylinder.z;
        return dx * dx + dz * dz > startR2; // outside → racing
      });
    }

    const clusters = clusterFrame(states, params);
    const posByPilot = new Map<number, PilotState>();
    for (const s of states) posByPilot.set(s.pilot, s);
    const centroidOf = (members: number[]): { x: number; z: number } => {
      let x = 0;
      let z = 0;
      let n = 0;
      for (const m of members) {
        const s = posByPilot.get(m);
        if (!s) continue;
        x += s.x;
        z += s.z;
        n++;
      }
      return n > 0 ? { x: x / n, z: z / n } : { x: 0, z: 0 };
    };

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
      o.centroids.push({ t, ...centroidOf(c) });
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
        centroids: [{ t, ...centroidOf(c) }],
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

/** Index of the turnpoint nearest the episode's centroid at its midpoint. */
function nearestTurnpoint(o: OpenEpisode, turnpoints?: TurnpointXZ[]): number {
  if (!turnpoints?.length || o.centroids.length === 0) return -1;
  const mid = (o.tStart + o.lastT) / 2;
  let c = o.centroids[0];
  let bd = Infinity;
  for (const s of o.centroids) {
    const d = Math.abs(s.t - mid);
    if (d < bd) {
      bd = d;
      c = s;
    }
  }
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < turnpoints.length; i++) {
    const dx = turnpoints[i].x - c.x;
    const dz = turnpoints[i].z - c.z;
    const d = dx * dx + dz * dz;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
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
