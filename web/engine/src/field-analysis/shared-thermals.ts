// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Cross-pilot thermal clustering — the "shared thermal" primitive.
 *
 * A competition task is a natural experiment: many pilots climb in the SAME
 * thermal, so ranking their climb rates within one cluster isolates centering
 * skill from thermal selection (and marker-usage needs to know who was already
 * established in a climb). This clusters every pilot's ThermalSegments by
 * space + time overlap with union-find, the same pattern as
 * `clusterFrame` in cluster-detector.ts.
 */

import type { IGCFix } from '../igc-parser';
import type { ThermalSegment } from '../event-types';
import { andoyerDistance } from '../geo';

/** One pilot's use of one thermal (a flattened ThermalSegment). */
export interface ThermalUse {
  /** Caller's pilot index (FieldContext.pilots order). */
  pilotIndex: number;
  /** Index into that pilot's thermals array. */
  thermalIndex: number;
  startMs: number;
  endMs: number;
  /** Mean position over the segment (ThermalSegment.location). */
  lat: number;
  lon: number;
  avgClimbRate: number;
  gainMeters: number;
  entryAltitude: number;
  exitAltitude: number;
}

/** A cluster of thermal uses — one physical thermal as the field flew it. */
export interface SharedThermal {
  id: number;
  /** ≥ 1 use, ascending by startMs. Singletons are kept (only one pilot found it). */
  uses: ThermalUse[];
  /** Centroid of the uses. */
  lat: number;
  lon: number;
  /** Union time extent across uses. */
  startMs: number;
  endMs: number;
  /** Distinct pilots among the uses. */
  pilotCount: number;
}

export interface SharedThermalOptions {
  /**
   * Max separation (m) between two uses' mean positions to link them.
   * Generous because a thermal drifts with the wind and `location` is the
   * segment's mean position, not the (moving) core.
   */
  maxDistanceMeters: number;
  /**
   * Max gap (s) between two uses' time intervals to still count as the same
   * thermal (it cycles; a pilot may join just after another left).
   */
  maxGapSeconds: number;
}

export const DEFAULT_SHARED_THERMAL_OPTIONS: SharedThermalOptions = {
  maxDistanceMeters: 800,
  maxGapSeconds: 120,
};

interface PilotThermalsSpec {
  thermals: ThermalSegment[];
  fixes: IGCFix[];
}

/**
 * Cluster every pilot's thermals into shared thermals.
 *
 * Union-find over the flattened uses: two uses link when within
 * `maxDistanceMeters` AND their time intervals overlap or gap by at most
 * `maxGapSeconds`. Uses are sorted by start time so the pairwise scan can
 * stop once past the time horizon — effectively O(N·k) for the ≲1,000 uses a
 * full field produces.
 */
export function clusterSharedThermals(
  pilots: PilotThermalsSpec[],
  opts?: Partial<SharedThermalOptions>,
): SharedThermal[] {
  const { maxDistanceMeters, maxGapSeconds } = { ...DEFAULT_SHARED_THERMAL_OPTIONS, ...opts };

  const uses: ThermalUse[] = [];
  for (let pi = 0; pi < pilots.length; pi++) {
    const { thermals, fixes } = pilots[pi];
    for (let ti = 0; ti < thermals.length; ti++) {
      const t = thermals[ti];
      const start = fixes[t.startIndex];
      const end = fixes[t.endIndex];
      if (!start || !end) continue;
      uses.push({
        pilotIndex: pi,
        thermalIndex: ti,
        startMs: start.time.getTime(),
        endMs: end.time.getTime(),
        lat: t.location.lat,
        lon: t.location.lon,
        avgClimbRate: t.avgClimbRate,
        gainMeters: t.endAltitude - t.startAltitude,
        entryAltitude: t.startAltitude,
        exitAltitude: t.endAltitude,
      });
    }
  }
  uses.sort((a, b) => a.startMs - b.startMs);

  // Union-find (path-halving, same shape as clusterFrame).
  const parent = uses.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };

  const gapMs = maxGapSeconds * 1000;
  for (let i = 0; i < uses.length; i++) {
    const a = uses[i];
    for (let j = i + 1; j < uses.length; j++) {
      const b = uses[j];
      // Sorted by startMs, so once b starts after a's window no later b can link to a.
      if (b.startMs > a.endMs + gapMs) break;
      if (find(i) === find(j)) continue;
      if (andoyerDistance(a.lat, a.lon, b.lat, b.lon) <= maxDistanceMeters) {
        parent[find(i)] = find(j);
      }
    }
  }

  const byRoot = new Map<number, ThermalUse[]>();
  for (let i = 0; i < uses.length; i++) {
    const r = find(i);
    let g = byRoot.get(r);
    if (!g) byRoot.set(r, (g = []));
    g.push(uses[i]);
  }

  const shared: SharedThermal[] = [];
  for (const group of byRoot.values()) {
    let lat = 0;
    let lon = 0;
    let startMs = Infinity;
    let endMs = -Infinity;
    const pilotSet = new Set<number>();
    for (const u of group) {
      lat += u.lat;
      lon += u.lon;
      startMs = Math.min(startMs, u.startMs);
      endMs = Math.max(endMs, u.endMs);
      pilotSet.add(u.pilotIndex);
    }
    shared.push({
      id: 0, // assigned after the chronological sort below
      uses: group,
      lat: lat / group.length,
      lon: lon / group.length,
      startMs,
      endMs,
      pilotCount: pilotSet.size,
    });
  }
  shared.sort((a, b) => a.startMs - b.startMs);
  shared.forEach((s, i) => (s.id = i));
  return shared;
}
