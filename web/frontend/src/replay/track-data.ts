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
  /** Per-vertex smoothed climb rate, m/s (for the vertical-speed colour mode). */
  vario: Float32Array;
}

/** Result of sampling one pilot's interpolated position at a given time. */
export interface Sample {
  /**
   * True if the pilot has a position at `time`: either mid-flight, or landed
   * (held at the final fix). Only false before launch / with no data.
   */
  active: boolean;
  /** True once `time` is past the pilot's last fix — the sample is the landing spot. */
  landed: boolean;
  x: number;
  y: number;
  z: number;
  /** Climb rate in m/s, smoothed over a ±3-fix window. */
  climb: number;
  /** Ground speed in m/s (path length over the same smoothing window). */
  speed: number;
  /** Horizontal heading, radians, atan2(east, north). */
  heading: number;
  /** Altitude in metres MSL (y + alt0). */
  altMsl: number;
}

/**
 * Two-file load (static sample asset): a JSON manifest URL + a gzipped binary
 * URL. Retained for the offline-built asset; the live path uses
 * `loadTracksBundle`.
 */
export async function loadTracks(manifestUrl: string, binUrl: string): Promise<LoadedTracks> {
  const [manifest, buf] = await Promise.all([
    fetch(manifestUrl).then((r) => r.json() as Promise<TrackManifest>),
    fetchGzipped(binUrl),
  ]);
  return assembleTracks(manifest, new Float32Array(buf));
}

/**
 * Single-bundle load (Worker path): one fetch returns
 * `[uint32 manifestLen][manifest JSON][gzipped Float32 data]`. The frontend
 * reads the length, parses the manifest, and gunzips the rest.
 */
export async function loadTracksBundle(url: string): Promise<LoadedTracks> {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength < 4) throw new Error('3dvis bundle truncated');
  const manifestLen = new DataView(buf).getUint32(0, true);
  const manifest = JSON.parse(
    new TextDecoder().decode(new Uint8Array(buf, 4, manifestLen)),
  ) as TrackManifest;
  const data = new Float32Array(await gunzip(buf.slice(4 + manifestLen)));
  return assembleTracks(manifest, data);
}

/** De-interleave the packed `[x,y,z,tRel]` floats into the viewer's buffers. */
function assembleTracks(manifest: TrackManifest, data: Float32Array): LoadedTracks {
  const fpv = manifest.floatsPerVertex;
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
  const vario = new Float32Array(N);
  let k = 0;
  const HW = 3; // ±3-fix window (~6s) — smooths 1–2s-cadence noise
  for (let pi = 0; pi < manifest.pilots.length; pi++) {
    const p = manifest.pilots[pi];
    const start = p.vertexOffset;
    const end = start + p.vertexCount;
    for (let v = start; v < end; v++) {
      pilotIndex[v] = pi;
      const a = Math.max(start, v - HW);
      const b = Math.min(end - 1, v + HW);
      const dt = time[b] - time[a];
      vario[v] = dt > 0 ? (pos[b * 3 + 1] - pos[a * 3 + 1]) / dt : 0;
    }
    for (let v = start; v < end - 1; v++) {
      index[k++] = v;
      index[k++] = v + 1;
    }
  }

  return { manifest, pos, time, pilotIndex, index, vario };
}

/** Gunzip an ArrayBuffer via the platform DecompressionStream. */
async function gunzip(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const stream = new Response(buf).body!.pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
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
 * interpolate position + heading. Climb and ground speed are smoothed over a
 * ±3-fix window (~6 s at typical cadence): climb is the window's net altitude
 * change over its duration; speed is the horizontal *path length* over the
 * window (so circling in a thermal still reads the true airspeed-ish value,
 * not the near-zero straight-line drift). ~free at 100 pilots/frame.
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

  const inactive: Sample = {
    active: false,
    landed: false,
    x: 0,
    y: 0,
    z: 0,
    climb: 0,
    speed: 0,
    heading: 0,
    altMsl: 0,
  };
  if (p.vertexCount === 0) return inactive;
  if (t < time[lo]) return inactive;

  // Past the last fix: the pilot has landed — hold the final position so the
  // viewer keeps showing where they came down. Heading follows the last
  // segment; climb and speed are zero on the ground.
  if (t > time[hi]) {
    const x = pos[hi * 3];
    const y = pos[hi * 3 + 1];
    const z = pos[hi * 3 + 2];
    const heading =
      hi > lo ? Math.atan2(x - pos[(hi - 1) * 3], z - pos[(hi - 1) * 3 + 2]) : 0;
    return { active: true, landed: true, x, y, z, climb: 0, speed: 0, heading, altMsl: y + alt0 };
  }

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
  const heading = Math.atan2(xj - xi, zj - zi); // east, north

  // Smoothed climb + ground speed over a ±HW-fix window around the bracket.
  const HW = 3; // matches the per-vertex vario smoothing in assembleTracks
  const a0 = Math.max(lo, i - HW);
  const b0 = Math.min(hi, j + HW);
  const wdt = time[b0] - time[a0];
  let climb = 0;
  let speed = 0;
  if (wdt > 0) {
    climb = (pos[b0 * 3 + 1] - pos[a0 * 3 + 1]) / wdt;
    let path = 0;
    for (let v = a0; v < b0; v++) {
      path += Math.hypot(pos[(v + 1) * 3] - pos[v * 3], pos[(v + 1) * 3 + 2] - pos[v * 3 + 2]);
    }
    speed = path / wdt;
  } else {
    const dt = t1 - t0;
    climb = dt > 0 ? (yj - yi) / dt : 0;
    speed = dt > 0 ? Math.hypot(xj - xi, zj - zi) / dt : 0;
  }
  return { active: true, landed: false, x, y, z, climb, speed, heading, altMsl: y + alt0 };
}
