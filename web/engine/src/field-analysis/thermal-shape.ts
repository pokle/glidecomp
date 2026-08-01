// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Thermal shape extraction — a 3D reconstruction of one physical thermal from
 * every pilot who climbed in it.
 *
 * A shared thermal (see shared-thermals.ts) pools several pilots' climbs
 * through the same column at overlapping times, which multiplies the sample
 * density far beyond what one track gives. This module turns that pool into
 * an altitude-banded shape:
 *
 * - each band's CORE is the lift-weighted centroid of the band's fixes, so
 *   the core axis traces where the lift actually was, band by band — the
 *   axis leaning downwind is the "tethered balloon" distortion Suchanek
 *   describes (Secrets of Champions, fig. 1);
 * - band radii say how wide the working lift was (coreRadius) and how wide
 *   the pilots ranged (extentRadius);
 * - sector statistics are computed AROUND the band core, so the asymmetry
 *   they report (which side lifted best) is already normalised for lean;
 * - sub-cores cluster the strongest samples in a band — several sub-cores
 *   low that merge into one higher up is two feeders coalescing.
 *
 * Everything is measured, never modelled: no fitted lift profile, no
 * assumed symmetry. Where the sampling is too thin the band is dropped
 * rather than invented.
 */

import type { IGCFix } from '../igc-parser';
import { fixAltitude } from '../igc-parser';
import type { ThermalSegment } from '../event-types';
import type { CircleSegment } from '../circle-detector';
import { localEastNorth } from '../geo';
import {
  clusterSharedThermals,
  type SharedThermal,
  type SharedThermalOptions,
  type ThermalUse,
} from './shared-thermals';

// --- Types ---

/** One pilot's inputs: full fix array plus detector output over it. */
export interface ThermalShapePilot {
  fixes: IGCFix[];
  thermals: ThermalSegment[];
  /** Circles from detectCircles, indices into `fixes`. */
  circles: CircleSegment[];
  /** Display label (pilot name). */
  label: string;
}

/** One vario sample inside the thermal, in metres east/north of the origin. */
export interface ThermalSample {
  east: number;
  north: number;
  altitude: number;
  /** Smoothed climb rate at this fix (m/s). */
  vario: number;
  timeMs: number;
  /** Index into ThermalShape.pilots. */
  pilot: number;
}

export interface ThermalSectorStat {
  /** Sector centre bearing (deg from north; 8 sectors → 0, 45, …, 315). */
  bearing: number;
  /** Mean vario of the band's samples in this sector (m/s); null if none. */
  meanVario: number | null;
  samples: number;
}

/** A cluster of the band's strongest samples — a distinct lift maximum. */
export interface ThermalSubCore {
  east: number;
  north: number;
  meanVario: number;
  samples: number;
}

export interface ThermalShapeBand {
  altMin: number;
  altMax: number;
  altMid: number;
  /** Lift-weighted centroid of the band's samples (the measured core). */
  core: { east: number; north: number; lat: number; lon: number };
  /** Lift-weighted RMS distance of positive-vario samples from the core (m). */
  coreRadius: number;
  /** 90th-percentile distance of ALL band samples from the core (m). */
  extentRadius: number;
  meanVario: number;
  maxVario: number;
  sampleCount: number;
  pilotCount: number;
  /** Asymmetry around the band core — already lean-normalised. */
  sectors: ThermalSectorStat[];
  subCores: ThermalSubCore[];
}

export interface ThermalLean {
  /** Direction the column leans TOWARD (deg from north). */
  bearing: number;
  /** Horizontal core displacement per metre of altitude (m/m). */
  metresPerMetre: number;
  /** Tilt from vertical, degrees. */
  tiltDeg: number;
  /**
   * Pearson r between sample altitude and time. Near ±1 the field climbed
   * through the thermal as one wave, so lean over altitude cannot be told
   * apart from drift over time — treat the lean as apparent, not structural.
   */
  timeAltCorrelation: number;
  confounded: boolean;
}

export interface ThermalWindEstimate {
  /** Median magnitude of the per-circle estimates (m/s) — see
   * averageCircleWinds for why speed is not the vector mean's length. */
  speed: number;
  /** Direction the wind blows FROM (deg), from the vector mean. */
  direction: number;
  samples: number;
}

export interface ThermalShape {
  /** SharedThermal id within the task (chronological). */
  id: number;
  /** ENU origin for east/north coordinates. */
  origin: { lat: number; lon: number };
  startMs: number;
  endMs: number;
  pilotCount: number;
  useCount: number;
  /** Labels of the pilots that contributed samples, ThermalSample.pilot order. */
  pilots: string[];
  bands: ThermalShapeBand[];
  /** null when fewer than 3 bands (no meaningful axis). */
  lean: ThermalLean | null;
  /** Vector-averaged per-circle wind estimates; null when none. */
  wind: ThermalWindEstimate | null;
  /**
   * The sector (relative to band cores) with the best sample-weighted mean
   * vario across all bands, and its diametric opposite for contrast.
   */
  strongestSide: {
    bearing: number;
    meanVario: number;
    oppositeMeanVario: number | null;
  } | null;
  samples: ThermalSample[];
}

export interface ThermalShapeOptions {
  /** Altitude band height (m). */
  bandHeightMeters: number;
  /** Half-width of the symmetric vario smoothing window (s). */
  varioHalfWindowSeconds: number;
  /** Bands with fewer samples than this are dropped. */
  minSamplesPerBand: number;
  /** Number of bearing sectors per band. */
  sectorCount: number;
  /** Union-find link distance for sub-core clustering (m). */
  subCoreLinkMeters: number;
  /** Minimum samples for a sub-core to be reported. */
  minSubCoreSamples: number;
  /** Reject |vario| beyond this as a GPS/baro spike (m/s). */
  maxPlausibleVario: number;
  /**
   * Split a shared thermal whose uses span more than this along their
   * principal axis (m). The union-find linking is transitive, so a ridge
   * being soared end-to-end chains into one "thermal" a kilometre long;
   * shape extraction needs the individual columns back.
   */
  maxClusterExtentMeters: number;
  /**
   * Split a shared thermal used for longer than this (s) into episodes. A
   * house thermal worked continuously all afternoon is many cycles of the
   * same trigger — averaging them into one shape smears every cycle's
   * structure.
   */
  maxClusterDurationSeconds: number;
  /** Passed through to clusterSharedThermals. */
  sharedThermal?: Partial<SharedThermalOptions>;
}

export const DEFAULT_THERMAL_SHAPE_OPTIONS: ThermalShapeOptions = {
  bandHeightMeters: 100,
  varioHalfWindowSeconds: 2.5,
  minSamplesPerBand: 15,
  sectorCount: 8,
  subCoreLinkMeters: 75,
  minSubCoreSamples: 8,
  maxPlausibleVario: 15,
  maxClusterExtentMeters: 1000,
  maxClusterDurationSeconds: 1800,
};

/**
 * A ThermalShape without its sample point cloud — what gets persisted and
 * shipped to UIs. The cloud exists only inside the extraction pass (and the
 * research CLI); every rendered surface draws from these summaries, and the
 * 3D replay supplies its own "cloud" — the pilots' actual trails.
 */
export type ThermalShapeSummary = Omit<ThermalShape, 'samples'>;

/** Strip the point cloud from a shape. */
export function summariseThermalShape(shape: ThermalShape): ThermalShapeSummary {
  const { samples, ...summary } = shape;
  return summary;
}

// --- Main entry points ---

/**
 * Cluster every pilot's thermals into shared thermals and extract a shape for
 * each. Shapes come back in the shared thermals' chronological order; shapes
 * with zero usable bands are dropped.
 */
export function extractThermalShapes(
  pilots: ThermalShapePilot[],
  opts?: Partial<ThermalShapeOptions>,
): ThermalShape[] {
  const options = { ...DEFAULT_THERMAL_SHAPE_OPTIONS, ...opts };
  const shared = clusterSharedThermals(pilots, options.sharedThermal)
    .flatMap((s) => splitOversizedCluster(s, options));
  shared.sort((a, b) => a.startMs - b.startMs);
  shared.forEach((s, i) => (s.id = i));
  const shapes: ThermalShape[] = [];
  for (const s of shared) {
    const shape = extractThermalShape(s, pilots, options);
    if (shape && shape.bands.length > 0) shapes.push(shape);
  }
  return shapes;
}

// --- Oversized-cluster splitting ---

/**
 * Recursively split a shared thermal that is too elongated (a chained ridge
 * line) or too long-lived (a house thermal cycling all afternoon) into
 * physically coherent columns/episodes. Splits happen at the widest gap in
 * the middle half of the offending axis, so genuine columns are never cut
 * through their core.
 */
function splitOversizedCluster(
  shared: SharedThermal,
  options: ThermalShapeOptions,
): SharedThermal[] {
  const groups = splitUses(shared.uses, options, 0);
  if (groups.length === 1) return [shared];
  return groups.map((uses) => rebuildSharedThermal(shared.id, uses));
}

function splitUses(uses: ThermalUse[], options: ThermalShapeOptions, depth: number): ThermalUse[][] {
  if (uses.length < 2 || depth > 12) return [uses];

  // Spatial extent along the principal axis of the use positions.
  let mLat = 0;
  let mLon = 0;
  for (const u of uses) {
    mLat += u.lat;
    mLon += u.lon;
  }
  mLat /= uses.length;
  mLon /= uses.length;
  const pos = uses.map((u) => localEastNorth(mLat, mLon, u.lat, u.lon));

  let see = 0;
  let snn = 0;
  let sen = 0;
  for (const p of pos) {
    see += p.east * p.east;
    snn += p.north * p.north;
    sen += p.east * p.north;
  }
  // Principal axis of the 2x2 covariance matrix.
  const theta = 0.5 * Math.atan2(2 * sen, see - snn);
  const axis = { e: Math.cos(theta), n: Math.sin(theta) };
  const proj = pos.map((p) => p.east * axis.e + p.north * axis.n);
  const minP = Math.min(...proj);
  const maxP = Math.max(...proj);

  if (maxP - minP > options.maxClusterExtentMeters) {
    const parts = splitAtWidestGap(uses, proj);
    if (parts) {
      return parts.flatMap((part) => splitUses(part, options, depth + 1));
    }
  }

  // Temporal extent: split a long-lived cluster into episodes.
  const t0 = Math.min(...uses.map((u) => u.startMs));
  const t1 = Math.max(...uses.map((u) => u.endMs));
  if ((t1 - t0) / 1000 > options.maxClusterDurationSeconds) {
    const mids = uses.map((u) => (u.startMs + u.endMs) / 2);
    const parts = splitAtWidestGap(uses, mids);
    if (parts) {
      return parts.flatMap((part) => splitUses(part, options, depth + 1));
    }
  }

  return [uses];
}

/**
 * Split `uses` in two at the widest gap between consecutive projected
 * values, considering only split points in the middle half so a stray
 * outlier at one end doesn't become its own "thermal". Returns null when
 * every candidate gap is zero (all values identical).
 */
function splitAtWidestGap(uses: ThermalUse[], projection: number[]): [ThermalUse[], ThermalUse[]] | null {
  const order = projection.map((_, i) => i).sort((a, b) => projection[a] - projection[b]);
  const n = order.length;
  const lo = Math.max(1, Math.floor(n * 0.25));
  const hi = Math.min(n - 1, Math.ceil(n * 0.75));
  let bestGap = 0;
  let bestAt = -1;
  for (let k = lo; k <= hi - 1; k++) {
    const gap = projection[order[k]] - projection[order[k - 1]];
    if (gap > bestGap) {
      bestGap = gap;
      bestAt = k;
    }
  }
  if (bestAt < 0) {
    if (n < 2) return null;
    bestAt = Math.floor(n / 2); // uniform spread: cut at the median
  }
  const a = order.slice(0, bestAt).map((i) => uses[i]);
  const b = order.slice(bestAt).map((i) => uses[i]);
  if (a.length === 0 || b.length === 0) return null;
  return [a, b];
}

function rebuildSharedThermal(id: number, uses: ThermalUse[]): SharedThermal {
  let lat = 0;
  let lon = 0;
  let startMs = Infinity;
  let endMs = -Infinity;
  const pilotSet = new Set<number>();
  for (const u of uses) {
    lat += u.lat;
    lon += u.lon;
    startMs = Math.min(startMs, u.startMs);
    endMs = Math.max(endMs, u.endMs);
    pilotSet.add(u.pilotIndex);
  }
  const sorted = [...uses].sort((a, b) => a.startMs - b.startMs);
  return {
    id,
    uses: sorted,
    lat: lat / uses.length,
    lon: lon / uses.length,
    startMs,
    endMs,
    pilotCount: pilotSet.size,
  };
}

/**
 * Extract the shape of ONE shared thermal. Returns null when no use produced
 * a single valid sample.
 */
export function extractThermalShape(
  shared: SharedThermal,
  pilots: ThermalShapePilot[],
  opts?: Partial<ThermalShapeOptions>,
): ThermalShape | null {
  const options = { ...DEFAULT_THERMAL_SHAPE_OPTIONS, ...opts };
  const origin = { lat: shared.lat, lon: shared.lon };

  // --- collect samples + associated circles across the uses ---
  const samples: ThermalSample[] = [];
  const pilotLabels: string[] = [];
  const pilotShapeIndex = new Map<number, number>();
  const circles: CircleSegment[] = [];

  for (const use of shared.uses) {
    const pilot = pilots[use.pilotIndex];
    if (!pilot) continue;
    const seg = pilot.thermals[use.thermalIndex];
    if (!seg) continue;

    let shapePilot = pilotShapeIndex.get(use.pilotIndex);
    if (shapePilot === undefined) {
      shapePilot = pilotLabels.length;
      pilotShapeIndex.set(use.pilotIndex, shapePilot);
      pilotLabels.push(pilot.label);
    }

    collectUseSamples(pilot.fixes, seg, origin, shapePilot, options, samples);

    for (const c of pilot.circles) {
      const mid = (c.startIndex + c.endIndex) >> 1;
      if (mid >= seg.startIndex && mid <= seg.endIndex) circles.push(c);
    }
  }
  if (samples.length === 0) return null;

  const bands = buildBands(samples, origin, options);
  const lean = fitLean(bands, samples);
  const wind = averageCircleWinds(circles);
  const strongestSide = summariseStrongestSide(bands, options.sectorCount);

  return {
    id: shared.id,
    origin,
    startMs: shared.startMs,
    endMs: shared.endMs,
    pilotCount: shared.pilotCount,
    useCount: shared.uses.length,
    pilots: pilotLabels,
    bands,
    lean,
    wind,
    strongestSide,
    samples,
  };
}

// --- Sample collection ---

/**
 * Turn one use's fixes into vario samples. Vario is smoothed over a symmetric
 * time window (two-pointer, O(n)) because a 1 s GPS-altitude difference is
 * mostly noise.
 */
function collectUseSamples(
  fixes: IGCFix[],
  seg: ThermalSegment,
  origin: { lat: number; lon: number },
  shapePilot: number,
  options: ThermalShapeOptions,
  out: ThermalSample[],
): void {
  const start = Math.max(0, seg.startIndex);
  const end = Math.min(fixes.length - 1, seg.endIndex);
  if (end <= start) return;

  const halfMs = options.varioHalfWindowSeconds * 1000;
  let lo = start;
  let hi = start;

  for (let i = start; i <= end; i++) {
    const t = fixes[i].time.getTime();
    while (lo < i && fixes[lo].time.getTime() < t - halfMs) lo++;
    while (hi < end && fixes[hi + 1].time.getTime() <= t + halfMs) hi++;
    if (hi <= lo) continue;

    const dt = (fixes[hi].time.getTime() - fixes[lo].time.getTime()) / 1000;
    if (dt <= 0) continue;
    const vario = (fixAltitude(fixes[hi]) - fixAltitude(fixes[lo])) / dt;
    if (!Number.isFinite(vario) || Math.abs(vario) > options.maxPlausibleVario) continue;

    const { east, north } = localEastNorth(
      origin.lat, origin.lon,
      fixes[i].latitude, fixes[i].longitude,
    );
    out.push({
      east,
      north,
      altitude: fixAltitude(fixes[i]),
      vario,
      timeMs: t,
      pilot: shapePilot,
    });
  }
}

// --- Band assembly ---

function buildBands(
  samples: ThermalSample[],
  origin: { lat: number; lon: number },
  options: ThermalShapeOptions,
): ThermalShapeBand[] {
  const { bandHeightMeters: bandH } = options;
  let minAlt = Infinity;
  let maxAlt = -Infinity;
  for (const s of samples) {
    if (s.altitude < minAlt) minAlt = s.altitude;
    if (s.altitude > maxAlt) maxAlt = s.altitude;
  }
  const firstBand = Math.floor(minAlt / bandH);
  const lastBand = Math.floor(maxAlt / bandH);

  const byBand = new Map<number, ThermalSample[]>();
  for (const s of samples) {
    const b = Math.floor(s.altitude / bandH);
    let g = byBand.get(b);
    if (!g) byBand.set(b, (g = []));
    g.push(s);
  }

  const bands: ThermalShapeBand[] = [];
  for (let b = firstBand; b <= lastBand; b++) {
    const group = byBand.get(b);
    if (!group || group.length < options.minSamplesPerBand) continue;
    bands.push(buildBand(b * bandH, (b + 1) * bandH, group, origin, options));
  }
  return bands;
}

function buildBand(
  altMin: number,
  altMax: number,
  group: ThermalSample[],
  origin: { lat: number; lon: number },
  options: ThermalShapeOptions,
): ThermalShapeBand {
  // Lift-weighted centroid; uniform fallback when the band carries no lift.
  let wSum = 0;
  let eW = 0;
  let nW = 0;
  for (const s of group) {
    const w = Math.max(s.vario, 0);
    wSum += w;
    eW += s.east * w;
    nW += s.north * w;
  }
  let coreEast: number;
  let coreNorth: number;
  if (wSum > 1e-6) {
    coreEast = eW / wSum;
    coreNorth = nW / wSum;
  } else {
    let e = 0;
    let n = 0;
    for (const s of group) {
      e += s.east;
      n += s.north;
    }
    coreEast = e / group.length;
    coreNorth = n / group.length;
  }

  // Radii + climb stats + sectors, all about the core.
  const allDistances: number[] = [];
  let liftR2W = 0;
  let liftW = 0;
  let varioSum = 0;
  let maxVario = -Infinity;
  const pilotSet = new Set<number>();
  const sectorSum = new Array<number>(options.sectorCount).fill(0);
  const sectorN = new Array<number>(options.sectorCount).fill(0);
  const sectorWidth = 360 / options.sectorCount;

  for (const s of group) {
    const de = s.east - coreEast;
    const dn = s.north - coreNorth;
    const r = Math.hypot(de, dn);
    allDistances.push(r);
    if (s.vario > 0) {
      liftR2W += r * r * s.vario;
      liftW += s.vario;
    }
    varioSum += s.vario;
    if (s.vario > maxVario) maxVario = s.vario;
    pilotSet.add(s.pilot);

    // Sector centred on its bearing: sector 0 spans [-22.5°, 22.5°).
    const bearing = ((Math.atan2(de, dn) * 180) / Math.PI + 360) % 360;
    const sector = Math.round(bearing / sectorWidth) % options.sectorCount;
    sectorSum[sector] += s.vario;
    sectorN[sector]++;
  }

  allDistances.sort((a, b) => a - b);
  const extentRadius = quantileSorted(allDistances, 0.9);
  const coreRadius = liftW > 1e-6 ? Math.sqrt(liftR2W / liftW) : extentRadius;

  const sectors: ThermalSectorStat[] = [];
  for (let i = 0; i < options.sectorCount; i++) {
    sectors.push({
      bearing: i * sectorWidth,
      meanVario: sectorN[i] > 0 ? sectorSum[i] / sectorN[i] : null,
      samples: sectorN[i],
    });
  }

  const { lat, lon } = offsetToLatLon(origin, coreEast, coreNorth);

  return {
    altMin,
    altMax,
    altMid: (altMin + altMax) / 2,
    core: { east: coreEast, north: coreNorth, lat, lon },
    coreRadius,
    extentRadius,
    meanVario: varioSum / group.length,
    maxVario,
    sampleCount: group.length,
    pilotCount: pilotSet.size,
    sectors,
    subCores: findSubCores(group, options),
  };
}

/**
 * Cluster the band's strongest samples (upper quartile of positive varios,
 * floor 0.5 m/s) with union-find over a fixed link distance. Two or more
 * sub-cores in one band are distinct lift maxima — feeders that haven't
 * merged yet.
 */
function findSubCores(group: ThermalSample[], options: ThermalShapeOptions): ThermalSubCore[] {
  const positive = group.filter((s) => s.vario > 0).map((s) => s.vario).sort((a, b) => a - b);
  if (positive.length === 0) return [];
  const threshold = Math.max(0.5, quantileSorted(positive, 0.75));
  const strong = group.filter((s) => s.vario >= threshold);
  if (strong.length < options.minSubCoreSamples) return [];

  const parent = strong.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const link = options.subCoreLinkMeters;
  for (let i = 0; i < strong.length; i++) {
    for (let j = i + 1; j < strong.length; j++) {
      if (find(i) === find(j)) continue;
      const de = strong[i].east - strong[j].east;
      const dn = strong[i].north - strong[j].north;
      if (de * de + dn * dn <= link * link) parent[find(i)] = find(j);
    }
  }

  const byRoot = new Map<number, ThermalSample[]>();
  for (let i = 0; i < strong.length; i++) {
    const r = find(i);
    let g = byRoot.get(r);
    if (!g) byRoot.set(r, (g = []));
    g.push(strong[i]);
  }

  const cores: ThermalSubCore[] = [];
  for (const cluster of byRoot.values()) {
    if (cluster.length < options.minSubCoreSamples) continue;
    let e = 0;
    let n = 0;
    let v = 0;
    for (const s of cluster) {
      e += s.east;
      n += s.north;
      v += s.vario;
    }
    cores.push({
      east: e / cluster.length,
      north: n / cluster.length,
      meanVario: v / cluster.length,
      samples: cluster.length,
    });
  }
  cores.sort((a, b) => b.meanVario - a.meanVario);
  return cores;
}

// --- Aggregates ---

/**
 * Weighted linear fit of band cores against altitude — the core axis. The
 * time/altitude correlation over the raw samples says whether the apparent
 * lean could instead be the whole column drifting while the field climbed.
 */
function fitLean(bands: ThermalShapeBand[], samples: ThermalSample[]): ThermalLean | null {
  if (bands.length < 3) return null;

  let wSum = 0;
  let aMean = 0;
  let eMean = 0;
  let nMean = 0;
  for (const b of bands) {
    wSum += b.sampleCount;
    aMean += b.altMid * b.sampleCount;
    eMean += b.core.east * b.sampleCount;
    nMean += b.core.north * b.sampleCount;
  }
  aMean /= wSum;
  eMean /= wSum;
  nMean /= wSum;

  let saa = 0;
  let sae = 0;
  let san = 0;
  for (const b of bands) {
    const da = b.altMid - aMean;
    saa += da * da * b.sampleCount;
    sae += da * (b.core.east - eMean) * b.sampleCount;
    san += da * (b.core.north - nMean) * b.sampleCount;
  }
  if (saa < 1e-6) return null;

  const slopeEast = sae / saa;
  const slopeNorth = san / saa;
  const metresPerMetre = Math.hypot(slopeEast, slopeNorth);
  const bearing = ((Math.atan2(slopeEast, slopeNorth) * 180) / Math.PI + 360) % 360;

  const timeAltCorrelation = pearson(
    samples.map((s) => s.altitude),
    samples.map((s) => s.timeMs),
  );

  return {
    bearing,
    metresPerMetre,
    tiltDeg: (Math.atan(metresPerMetre) * 180) / Math.PI,
    timeAltCorrelation,
    confounded: Math.abs(timeAltCorrelation) > 0.85,
  };
}

/**
 * Combine the circles' wind estimates (both estimator methods).
 *
 * Direction comes from the VECTOR mean, where the scatter of individual
 * estimates cancels. Speed comes from the MEDIAN of the estimate magnitudes:
 * a vector mean's length collapses toward zero as directions scatter, so it
 * answers "how consistent were the estimates", not "how strong was the wind"
 * — measured 5 km/h against a modelled 20 km/h on a day the directions
 * agreed to a degree was this bias, not a calm.
 */
function averageCircleWinds(circles: CircleSegment[]): ThermalWindEstimate | null {
  let u = 0;
  let v = 0;
  const speeds: number[] = [];
  for (const c of circles) {
    for (const w of [c.windFromGroundSpeed, c.windFromCenterDrift]) {
      if (!w) continue;
      const rad = (w.direction * Math.PI) / 180;
      u += w.speed * Math.sin(rad);
      v += w.speed * Math.cos(rad);
      speeds.push(w.speed);
    }
  }
  if (speeds.length === 0) return null;
  speeds.sort((a, b) => a - b);
  const direction = ((Math.atan2(u / speeds.length, v / speeds.length) * 180) / Math.PI + 360) % 360;
  return {
    speed: quantileSorted(speeds, 0.5),
    direction,
    samples: speeds.length,
  };
}

/**
 * Sample-weighted mean vario per sector across all bands; the winner is the
 * thermal's strongest side (in core-relative, lean-normalised terms).
 */
function summariseStrongestSide(
  bands: ThermalShapeBand[],
  sectorCount: number,
): ThermalShape['strongestSide'] {
  const sum = new Array<number>(sectorCount).fill(0);
  const n = new Array<number>(sectorCount).fill(0);
  for (const b of bands) {
    for (let i = 0; i < sectorCount; i++) {
      const s = b.sectors[i];
      if (s.meanVario === null) continue;
      sum[i] += s.meanVario * s.samples;
      n[i] += s.samples;
    }
  }
  let best = -1;
  let bestVario = -Infinity;
  for (let i = 0; i < sectorCount; i++) {
    if (n[i] === 0) continue;
    const mean = sum[i] / n[i];
    if (mean > bestVario) {
      bestVario = mean;
      best = i;
    }
  }
  if (best < 0) return null;
  const opposite = (best + sectorCount / 2) % sectorCount;
  return {
    bearing: (best * 360) / sectorCount,
    meanVario: bestVario,
    oppositeMeanVario: n[opposite] > 0 ? sum[opposite] / n[opposite] : null,
  };
}

// --- Small helpers ---

/** Quantile of an ascending-sorted array with linear interpolation. */
function quantileSorted(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  if (n < 2) return 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    sab += da * db;
    saa += da * da;
    sbb += db * db;
  }
  if (saa < 1e-9 || sbb < 1e-9) return 0;
  return sab / Math.sqrt(saa * sbb);
}

/** Invert localEastNorth for small offsets (same series expansion). */
function offsetToLatLon(
  origin: { lat: number; lon: number },
  east: number,
  north: number,
): { lat: number; lon: number } {
  const refLatRad = (origin.lat * Math.PI) / 180;
  const mPerDegLat =
    111132.92 - 559.82 * Math.cos(2 * refLatRad) + 1.175 * Math.cos(4 * refLatRad);
  const mPerDegLon =
    111412.84 * Math.cos(refLatRad) - 93.5 * Math.cos(3 * refLatRad) +
    0.118 * Math.cos(5 * refLatRad);
  return {
    lat: origin.lat + north / mPerDegLat,
    lon: origin.lon + east / mPerDegLon,
  };
}
