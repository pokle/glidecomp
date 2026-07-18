// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Three-way flight-phase partition: climb / glide / search.
 *
 * `detectThermals` + `detectGlides` deliberately do NOT partition a flight —
 * glides only exist between thermals past minimum gaps, so time falls through
 * the cracks. Field analysis needs the whole flight accounted for, because
 * the leftover — "searching", neither climbing nor making course progress —
 * is exactly the time better pilots minimise.
 *
 * Rules (simple and explainable):
 *   1. Every ThermalSegment is `climb`.
 *   2. Gaps are chopped into ≤ windowSeconds windows: a window whose net
 *      displacement speed ≥ minGlideNetSpeedMps AND that doesn't overlap a
 *      circling segment is `glide`; anything else is `search` (circling
 *      without sustained climb, wandering, sink-dodging).
 *   3. Adjacent same-phase intervals merge.
 *
 * The output covers [takeoffIndex, landingIndex] exactly, with consecutive
 * intervals sharing their boundary fix (an interval spans the TIME between
 * its first and last fix, so shared endpoints mean gap-free coverage, not
 * double counting).
 */

import type { IGCFix } from '../igc-parser';
import type { ThermalSegment } from '../event-types';
import type { CircleDetectionResult } from '../circle-detector';
import { andoyerDistance } from '../geo';

export type FlightPhase = 'climb' | 'glide' | 'search';

export interface PhaseInterval {
  phase: FlightPhase;
  /** Inclusive fix indices; consecutive intervals share their boundary fix. */
  startIndex: number;
  endIndex: number;
  startMs: number;
  endMs: number;
  durationSeconds: number;
}

export interface PhasePartitionOptions {
  /** Net displacement speed (m/s) a window needs to count as a glide. */
  minGlideNetSpeedMps: number;
  /** Non-thermal stretches are classified in windows of at most this many seconds. */
  windowSeconds: number;
}

export const DEFAULT_PHASE_OPTIONS: PhasePartitionOptions = {
  minGlideNetSpeedMps: 8,
  windowSeconds: 60,
};

export function partitionPhases(
  fixes: IGCFix[],
  thermals: ThermalSegment[],
  circles: CircleDetectionResult,
  takeoffIndex: number,
  landingIndex: number,
  opts?: Partial<PhasePartitionOptions>,
): PhaseInterval[] {
  const { minGlideNetSpeedMps, windowSeconds } = { ...DEFAULT_PHASE_OPTIONS, ...opts };
  if (fixes.length === 0 || landingIndex <= takeoffIndex) return [];

  // Thermals clamped to the flight, in order, non-overlapping (detectThermals
  // guarantees no overlap; clamping can't introduce one).
  const climbs = thermals
    .map((t) => ({
      start: Math.max(t.startIndex, takeoffIndex),
      end: Math.min(t.endIndex, landingIndex),
    }))
    .filter((t) => t.end > t.start)
    .sort((a, b) => a.start - b.start);

  const raw: PhaseInterval[] = [];
  let cursor = takeoffIndex;
  for (const c of climbs) {
    if (c.start > cursor) classifyGap(raw, fixes, circles, cursor, c.start, minGlideNetSpeedMps, windowSeconds);
    raw.push(makeInterval(fixes, 'climb', c.start, c.end));
    cursor = c.end;
  }
  if (cursor < landingIndex) {
    classifyGap(raw, fixes, circles, cursor, landingIndex, minGlideNetSpeedMps, windowSeconds);
  }

  // Merge adjacent same-phase intervals (they share their boundary fix).
  const merged: PhaseInterval[] = [];
  for (const iv of raw) {
    const prev = merged[merged.length - 1];
    if (prev && prev.phase === iv.phase && prev.endIndex === iv.startIndex) {
      prev.endIndex = iv.endIndex;
      prev.endMs = iv.endMs;
      prev.durationSeconds = (prev.endMs - prev.startMs) / 1000;
    } else {
      merged.push({ ...iv });
    }
  }
  return merged;
}

function makeInterval(
  fixes: IGCFix[],
  phase: FlightPhase,
  startIndex: number,
  endIndex: number,
): PhaseInterval {
  const startMs = fixes[startIndex].time.getTime();
  const endMs = fixes[endIndex].time.getTime();
  return { phase, startIndex, endIndex, startMs, endMs, durationSeconds: (endMs - startMs) / 1000 };
}

/** Chop [start, end] into ≤ windowSeconds windows and classify each glide/search. */
function classifyGap(
  out: PhaseInterval[],
  fixes: IGCFix[],
  circles: CircleDetectionResult,
  start: number,
  end: number,
  minGlideNetSpeedMps: number,
  windowSeconds: number,
): void {
  let w0 = start;
  while (w0 < end) {
    const windowEndMs = fixes[w0].time.getTime() + windowSeconds * 1000;
    let w1 = w0 + 1;
    while (w1 < end && fixes[w1].time.getTime() < windowEndMs) w1++;
    const dt = (fixes[w1].time.getTime() - fixes[w0].time.getTime()) / 1000;
    const dist = andoyerDistance(
      fixes[w0].latitude,
      fixes[w0].longitude,
      fixes[w1].latitude,
      fixes[w1].longitude,
    );
    const netSpeed = dt > 0 ? dist / dt : 0;
    const isGlide = netSpeed >= minGlideNetSpeedMps && !overlapsCircling(circles, w0, w1);
    out.push(makeInterval(fixes, isGlide ? 'glide' : 'search', w0, w1));
    w0 = w1;
  }
}

/** Whether [w0, w1] overlaps any circling segment's interior. */
function overlapsCircling(circles: CircleDetectionResult, w0: number, w1: number): boolean {
  for (const cs of circles.circlingSegments) {
    if (cs.startIndex < w1 && cs.endIndex > w0) return true;
  }
  return false;
}
