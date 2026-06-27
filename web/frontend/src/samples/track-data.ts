// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Loads the gzipped binary track asset produced by `bun run build-3dvis` and
 * de-interleaves it into the typed arrays the Three.js viewer needs.
 *
 * The binary is `[x, y, z, tRel] × vertexCount` (pilots concatenated in
 * `manifest.pilots[]` order). Decompression uses the native
 * `DecompressionStream("gzip")` — no unzip library, near zero-copy into a
 * `Float32Array`.
 */

import type { TrackManifest } from '@glidecomp/engine';

export interface LoadedTracks {
  manifest: TrackManifest;
  /** Positions, 3 floats per vertex (x, y, z) in ENU metres. */
  pos: Float32Array;
  /** Per-vertex time, seconds since manifest.t0. */
  time: Float32Array;
  /** Per-vertex pilot index (matches manifest.pilots[]). */
  pilotIndex: Float32Array;
  /** LINES index buffer: consecutive pairs within each pilot, seams skipped. */
  index: Uint32Array;
}

/** Result of sampling one pilot's interpolated position at a given time. */
export interface Sample {
  /** True if `time` falls within the pilot's flown window. */
  active: boolean;
  x: number;
  y: number;
  z: number;
  /** Climb rate in m/s (from the bracketing fixes). */
  climb: number;
  /** Horizontal heading, radians, atan2(east, north). */
  heading: number;
  /** Altitude in metres MSL (y + alt0). */
  altMsl: number;
}

export async function loadTracks(manifestUrl: string, binUrl: string): Promise<LoadedTracks> {
  const [manifest, buf] = await Promise.all([
    fetch(manifestUrl).then((r) => r.json() as Promise<TrackManifest>),
    fetchGzipped(binUrl),
  ]);

  const fpv = manifest.floatsPerVertex;
  const data = new Float32Array(buf);
  const N = data.length / fpv;

  const pos = new Float32Array(N * 3);
  const time = new Float32Array(N);
  const pilotIndex = new Float32Array(N);

  for (let i = 0; i < N; i++) {
    pos[i * 3 + 0] = data[i * fpv + 0];
    pos[i * 3 + 1] = data[i * fpv + 1];
    pos[i * 3 + 2] = data[i * fpv + 2];
    time[i] = data[i * fpv + 3];
  }

  // aPilot + index buffer (one segment between consecutive fixes; skip seams).
  let segCount = 0;
  for (const p of manifest.pilots) segCount += Math.max(0, p.vertexCount - 1);
  const index = new Uint32Array(segCount * 2);
  let k = 0;
  for (let pi = 0; pi < manifest.pilots.length; pi++) {
    const p = manifest.pilots[pi];
    const end = p.vertexOffset + p.vertexCount;
    for (let v = p.vertexOffset; v < end; v++) pilotIndex[v] = pi;
    for (let v = p.vertexOffset; v < end - 1; v++) {
      index[k++] = v;
      index[k++] = v + 1;
    }
  }

  return { manifest, pos, time, pilotIndex, index };
}

async function fetchGzipped(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  // Some dev servers / proxies transparently gunzip; fall back to raw bytes.
  if (!res.body || typeof DecompressionStream === 'undefined') {
    return res.arrayBuffer();
  }
  try {
    const stream = res.body.pipeThrough(new DecompressionStream('gzip'));
    return await new Response(stream).arrayBuffer();
  } catch {
    return (await fetch(url)).arrayBuffer();
  }
}

/**
 * Binary-search a pilot's fixes for `t` (seconds since t0) and linearly
 * interpolate position + climb + heading. ~free at 100 pilots/frame.
 */
export function samplePilot(
  tracks: LoadedTracks,
  pilotIdx: number,
  t: number,
  alt0: number,
): Sample {
  const p = tracks.manifest.pilots[pilotIdx];
  const { pos, time } = tracks;
  const lo = p.vertexOffset;
  const hi = p.vertexOffset + p.vertexCount - 1;

  const inactive: Sample = { active: false, x: 0, y: 0, z: 0, climb: 0, heading: 0, altMsl: 0 };
  if (p.vertexCount === 0) return inactive;
  if (t < time[lo] || t > time[hi]) return inactive;

  // Find the last index with time <= t.
  let a = lo;
  let b = hi;
  while (a < b) {
    const mid = (a + b + 1) >> 1;
    if (time[mid] <= t) a = mid;
    else b = mid - 1;
  }
  const i = a;
  const j = Math.min(i + 1, hi);
  const t0 = time[i];
  const t1 = time[j];
  const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;

  const xi = pos[i * 3],
    yi = pos[i * 3 + 1],
    zi = pos[i * 3 + 2];
  const xj = pos[j * 3],
    yj = pos[j * 3 + 1],
    zj = pos[j * 3 + 2];

  const x = xi + (xj - xi) * f;
  const y = yi + (yj - yi) * f;
  const z = zi + (zj - zi) * f;
  const dt = t1 - t0;
  const climb = dt > 0 ? (yj - yi) / dt : 0;
  const heading = Math.atan2(xj - xi, zj - zi); // east, north
  return { active: true, x, y, z, climb, heading, altMsl: y + alt0 };
}
