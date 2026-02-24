/**
 * Segment extractors
 *
 * Extracts structured glide, climb, and sink data from raw FlightEvent arrays
 * by pairing start/end events and computing performance metrics.
 */

import type { FlightEvent, TrackSegment } from './event-detector';

// ── Detail types for the untyped `event.details` bag ──────────────────────

/** Details attached to glide_start and glide_end events */
export interface GlideEventDetails {
  distance?: number;
  averageSpeed?: number;
  glideRatio?: number;
  duration?: number;
  altitudeLost?: number;
}

/** Details attached to thermal_entry and thermal_exit events */
export interface ClimbEventDetails {
  avgClimbRate?: number;
  duration?: number;
  altitudeGain?: number;
}

// ── Extracted data interfaces ─────────────────────────────────────────────

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
  glideRatio: number;
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
export interface SinkData extends GlideData {
  avgSinkRate: number;
}

// ── Shared helpers ────────────────────────────────────────────────────────

/**
 * Finds the matching end event for a paired start event.
 * Matches by event type and identical segment bounds.
 */
function findEndEvent(
  startEvent: FlightEvent,
  events: FlightEvent[],
  endType: FlightEvent['type'],
): FlightEvent | undefined {
  return events.find(
    e =>
      e.type === endType &&
      e.segment?.startIndex === startEvent.segment?.startIndex &&
      e.segment?.endIndex === startEvent.segment?.endIndex,
  );
}

// ── Extractors ────────────────────────────────────────────────────────────

/**
 * Maximum glide ratio to classify a glide as a "sink".
 * Glides with a ratio at or below this threshold are considered poor/sinky.
 */
const MAX_GLIDE_RATIO_FOR_SINK = 5;

/**
 * Extracts glide segments by pairing glide_start/glide_end events.
 * @returns Glides sorted by distance (longest first)
 */
export function extractGlides(events: FlightEvent[]): GlideData[] {
  const glides: GlideData[] = [];

  for (const event of events) {
    if (event.type !== 'glide_start' || !event.segment || !event.details) continue;

    const details = event.details as GlideEventDetails;
    const endEvent = findEndEvent(event, events, 'glide_end');
    if (!endEvent) continue;

    glides.push({
      id: event.id,
      startTime: event.time,
      endTime: endEvent.time,
      startAltitude: event.altitude,
      endAltitude: endEvent.altitude,
      distance: details.distance ?? 0,
      duration: details.duration ?? 0,
      averageSpeed: details.averageSpeed ?? 0,
      glideRatio: details.glideRatio ?? 0,
      altitudeLost: event.altitude - endEvent.altitude,
      startLat: event.latitude,
      startLon: event.longitude,
      endLat: endEvent.latitude,
      endLon: endEvent.longitude,
      segment: event.segment,
      sourceEvent: event,
    });
  }

  glides.sort((a, b) => b.distance - a.distance);
  return glides;
}

/**
 * Extracts thermal/climb segments by pairing thermal_entry/thermal_exit events.
 * @returns Climbs sorted by altitude gain (strongest first)
 */
export function extractClimbs(events: FlightEvent[]): ClimbData[] {
  const climbs: ClimbData[] = [];

  for (const event of events) {
    if (event.type !== 'thermal_entry' || !event.segment || !event.details) continue;

    const details = event.details as ClimbEventDetails;
    const exitEvent = findEndEvent(event, events, 'thermal_exit');
    if (!exitEvent) continue;

    climbs.push({
      id: event.id,
      startTime: event.time,
      endTime: exitEvent.time,
      startAltitude: event.altitude,
      endAltitude: exitEvent.altitude,
      altitudeGain: details.altitudeGain ?? (exitEvent.altitude - event.altitude),
      duration: details.duration ?? 0,
      avgClimbRate: details.avgClimbRate ?? 0,
      startLat: event.latitude,
      startLon: event.longitude,
      endLat: exitEvent.latitude,
      endLon: exitEvent.longitude,
      segment: event.segment,
      sourceEvent: event,
    });
  }

  climbs.sort((a, b) => b.altitudeGain - a.altitudeGain);
  return climbs;
}

/**
 * Extracts sink segments — glides with poor glide ratios (at or below threshold).
 * A low glide ratio means steep descent relative to distance covered.
 * @returns Sinks sorted by altitude lost (steepest first)
 */
export function extractSinks(events: FlightEvent[]): SinkData[] {
  const sinks: SinkData[] = [];

  for (const event of events) {
    if (event.type !== 'glide_start' || !event.segment || !event.details) continue;

    const details = event.details as GlideEventDetails;
    const glideRatio = details.glideRatio ?? 0;
    if (glideRatio > MAX_GLIDE_RATIO_FOR_SINK) continue;

    const endEvent = findEndEvent(event, events, 'glide_end');
    if (!endEvent) continue;

    const altitudeLost = event.altitude - endEvent.altitude;
    const duration = details.duration ?? 0;

    sinks.push({
      id: event.id,
      startTime: event.time,
      endTime: endEvent.time,
      startAltitude: event.altitude,
      endAltitude: endEvent.altitude,
      altitudeLost,
      distance: details.distance ?? 0,
      duration,
      averageSpeed: details.averageSpeed ?? 0,
      avgSinkRate: duration > 0 ? altitudeLost / duration : 0,
      glideRatio,
      startLat: event.latitude,
      startLon: event.longitude,
      endLat: endEvent.latitude,
      endLon: endEvent.longitude,
      segment: event.segment,
      sourceEvent: event,
    });
  }

  sinks.sort((a, b) => b.altitudeLost - a.altitudeLost);
  return sinks;
}
