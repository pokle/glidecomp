/**
 * Segment data builders
 *
 * Builds structured glide, climb, and sink data for the analysis UI directly
 * from the typed ThermalSegment/GlideSegment results of flight-phase
 * detection, at the moment the boundary events are created. The data used to
 * be reconstructed later by re-pairing the flattened FlightEvent array; now
 * detectFlight() assembles it once, while the segments still exist.
 */

import type { IGCFix } from './igc-parser';
import type { FlightEvent, TrackSegment, GlideSegment, ThermalSegment } from './event-types';
import { DEFAULT_THRESHOLDS } from './thresholds';

// Re-export detail types for consumers that imported from here
export type { GlideEventDetails } from './event-types';

// ── Segment data interfaces ───────────────────────────────────────────────

/** A glide segment with computed performance metrics */
export interface GlideData {
  id: string;
  startTime: Date;
  endTime: Date;
  startAltitude: number;
  endAltitude: number;
  distance: number;
  duration: number;
  averageSpeed: number;
  /** L/D ratio; undefined when the pilot gained altitude (consumers display this as ∞) */
  glideRatio?: number;
  altitudeLost: number;
  startLat: number;
  startLon: number;
  endLat: number;
  endLon: number;
  segment: TrackSegment;
  sourceEvent: FlightEvent;
}

/** A thermal/climb segment with computed performance metrics */
export interface ClimbData {
  id: string;
  startTime: Date;
  endTime: Date;
  startAltitude: number;
  endAltitude: number;
  altitudeGain: number;
  duration: number;
  avgClimbRate: number;
  startLat: number;
  startLon: number;
  endLat: number;
  endLon: number;
  segment: TrackSegment;
  sourceEvent: FlightEvent;
}

/** A sink (poor glide) segment with computed performance metrics */
export interface SinkData extends Omit<GlideData, 'glideRatio'> {
  /** Always defined: a glide that lost no altitude can never be a sink */
  glideRatio: number;
  avgSinkRate: number;
}

/** The typed segment data detectFlight() returns alongside the event list */
export interface FlightSegments {
  /** Glides sorted by distance (longest first) */
  glides: GlideData[];
  /** Thermal climbs sorted by altitude gain (strongest first) */
  climbs: ClimbData[];
}

// ── Builders ──────────────────────────────────────────────────────────────

/**
 * Build GlideData from a detected glide segment. Indices are shifted by
 * `indexOffset` back into the original (pre-takeoff-slice) fix array.
 * `sourceEvent` is the glide_start event built from the same segment.
 */
export function glideDataFromSegment(
  glide: GlideSegment,
  indexOffset: number,
  fixes: IGCFix[],
  sourceEvent: FlightEvent,
): GlideData {
  const startFix = fixes[glide.startIndex + indexOffset];
  const endFix = fixes[glide.endIndex + indexOffset];
  return {
    id: sourceEvent.id,
    startTime: startFix.time,
    endTime: endFix.time,
    startAltitude: glide.startAltitude,
    endAltitude: glide.endAltitude,
    distance: glide.distance,
    duration: glide.duration,
    averageSpeed: glide.duration > 0 ? glide.distance / glide.duration : 0,
    glideRatio: glide.glideRatio,
    altitudeLost: glide.startAltitude - glide.endAltitude,
    startLat: startFix.latitude,
    startLon: startFix.longitude,
    endLat: endFix.latitude,
    endLon: endFix.longitude,
    segment: { startIndex: glide.startIndex + indexOffset, endIndex: glide.endIndex + indexOffset },
    sourceEvent,
  };
}

/**
 * Build ClimbData from a detected thermal segment. Indices are shifted by
 * `indexOffset` back into the original (pre-takeoff-slice) fix array.
 * `sourceEvent` is the thermal_entry event built from the same segment.
 */
export function climbDataFromSegment(
  thermal: ThermalSegment,
  indexOffset: number,
  fixes: IGCFix[],
  sourceEvent: FlightEvent,
): ClimbData {
  const startFix = fixes[thermal.startIndex + indexOffset];
  const endFix = fixes[thermal.endIndex + indexOffset];
  return {
    id: sourceEvent.id,
    startTime: startFix.time,
    endTime: endFix.time,
    startAltitude: thermal.startAltitude,
    endAltitude: thermal.endAltitude,
    altitudeGain: thermal.endAltitude - thermal.startAltitude,
    duration: thermal.duration,
    avgClimbRate: thermal.avgClimbRate,
    startLat: startFix.latitude,
    startLon: startFix.longitude,
    endLat: endFix.latitude,
    endLon: endFix.longitude,
    segment: { startIndex: thermal.startIndex + indexOffset, endIndex: thermal.endIndex + indexOffset },
    sourceEvent,
  };
}

/**
 * Filter sink segments out of the glides — glides with poor glide ratios
 * (at or below threshold). A low glide ratio means steep descent relative to
 * distance covered.
 * @returns Sinks sorted by altitude lost (steepest first)
 */
export function sinksFromGlides(glides: GlideData[], maxGlideRatioForSink?: number): SinkData[] {
  const maxRatio = maxGlideRatioForSink ?? DEFAULT_THRESHOLDS.glide.maxGlideRatioForSink;
  const sinks: SinkData[] = [];

  for (const glide of glides) {
    // An undefined ratio means the pilot gained altitude — never a sink
    if (glide.glideRatio === undefined || glide.glideRatio > maxRatio) continue;

    sinks.push({
      ...glide,
      glideRatio: glide.glideRatio,
      avgSinkRate: glide.duration > 0 ? glide.altitudeLost / glide.duration : 0,
    });
  }

  sinks.sort((a, b) => b.altitudeLost - a.altitudeLost);
  return sinks;
}
