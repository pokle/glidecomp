/**
 * Flight Event Detector
 *
 * Analyzes IGC track data to detect meaningful flight events such as:
 * - Thermal entry/exit
 * - Glide segments
 * - Turnpoint cylinder crossings
 * - Start/goal crossing
 * - Max altitude, max climb rate, etc.
 */

import { IGCFix } from './igc-parser';
import { XCTask, getEffectiveSSSIndex, getEffectiveESSIndex, getGoalIndex } from './xctsk-parser';
import { resolveTurnpointSequence } from './turnpoint-sequence';
import { detectCircles, type CircleSegment } from './circle-detector';
import { resolveThresholds, type DetectionThresholds, type PartialThresholds } from './thresholds';
import { detectTakeoffLanding } from './takeoff-landing-detector';
import { detectThermals, detectGlides, thermalToEvents, glideToEvents } from './flight-phase-detectors';
import type { FlightEvent, FlightEventType, FixIndexDetails } from './event-types';

// The flight-event type vocabulary lives in event-types.ts (dependency-free so
// circle-detector can share TrackSegment without an import cycle). Re-exported
// here so the public API and existing deep imports of ./event-detector are
// unchanged.
export type {
  FlightEventType,
  TrackSegment,
  ThermalEventDetails,
  GlideEventDetails,
  FixIndexDetails,
  TurnpointCrossingDetails,
  TurnpointReachingDetails,
  CircleEventDetails,
  EventDetails,
  FlightEvent,
  ThermalSegment,
  GlideSegment,
} from './event-types';

/**
 * Calculate vertical speed between two fixes (m/s)
 */
function calculateVario(fix1: IGCFix, fix2: IGCFix): number {
  const timeDiff = (fix2.time.getTime() - fix1.time.getTime()) / 1000;
  if (timeDiff <= 0) return 0;

  const altDiff = fix2.gnssAltitude - fix1.gnssAltitude;
  return altDiff / timeDiff;
}

/**
 * Detect turnpoint cylinder crossings and scored reachings.
 *
 * Uses the turnpoint-sequence module for interpolated crossings and
 * CIVL GAP sequence resolution, then converts both into FlightEvents:
 * - Crossing events: every raw boundary transition (turnpoint_entry,
 *   turnpoint_exit, start_crossing, goal_crossing)
 * - Reaching events: the scored crossings selected by the algorithm
 *   (start_reaching, turnpoint_reaching, ess_reaching, goal_reaching)
 */
function detectTurnpointEvents(
  fixes: IGCFix[],
  task: XCTask
): FlightEvent[] {
  const events: FlightEvent[] = [];
  const result = resolveTurnpointSequence(task, fixes);

  // Effective indices so a task missing its SSS/ESS types (start/speed-
  // section fallbacks) still labels start and ESS events consistently.
  const sssIdx = getEffectiveSSSIndex(task);
  const essIdx = getEffectiveESSIndex(task);
  const goalIdx = getGoalIndex(task);

  // --- Raw crossings → crossing events ---
  for (const crossing of result.crossings) {
    const tp = task.turnpoints[crossing.taskIndex];

    let eventType: FlightEventType;
    if (crossing.direction === 'exit') {
      eventType = 'turnpoint_exit';
    } else if (crossing.taskIndex === sssIdx) {
      eventType = 'start_crossing';
    } else if (crossing.taskIndex === goalIdx) {
      eventType = 'goal_crossing';
    } else {
      eventType = 'turnpoint_entry';
    }

    events.push({
      id: `tp-${crossing.direction}-${crossing.taskIndex}-${crossing.fixIndex}`,
      type: eventType,
      time: crossing.time,
      latitude: crossing.latitude,
      longitude: crossing.longitude,
      altitude: crossing.altitude,
      description: `${crossing.direction === 'enter' ? 'Entered' : 'Exited'} ${tp.waypoint.name} (${tp.type})`,
      details: {
        fixIndex: crossing.fixIndex,
        turnpointIndex: crossing.taskIndex,
        turnpointName: tp.waypoint.name,
        radius: tp.radius,
        direction: crossing.direction,
        distanceToCenter: crossing.distanceToCenter,
      },
    });
  }

  // --- Scored reachings → reaching events ---
  for (const reaching of result.sequence) {
    const tp = task.turnpoints[reaching.taskIndex];

    let eventType: FlightEventType;
    let description: string;

    if (reaching.taskIndex === sssIdx) {
      eventType = 'start_reaching';
      description = `Start: ${tp.waypoint.name}`;
      if (reaching.candidateCount > 1) {
        description += ` (selected from ${reaching.candidateCount} crossings — last before next TP)`;
      }
    } else if (reaching.taskIndex === goalIdx) {
      eventType = 'goal_reaching';
      description = `Goal: ${tp.waypoint.name}`;
    } else if (reaching.taskIndex === essIdx) {
      eventType = 'ess_reaching';
      description = `ESS: ${tp.waypoint.name}`;
      if (reaching.candidateCount > 1) {
        description += ` (selected from ${reaching.candidateCount} crossings — first crossing)`;
      }
    } else {
      eventType = 'turnpoint_reaching';
      description = `Reached ${tp.waypoint.name}`;
      if (reaching.candidateCount > 1) {
        description += ` (selected from ${reaching.candidateCount} crossings — first after previous TP)`;
      }
    }

    events.push({
      id: `tp-reaching-${reaching.taskIndex}`,
      type: eventType,
      time: reaching.time,
      latitude: reaching.latitude,
      longitude: reaching.longitude,
      altitude: reaching.altitude,
      description,
      details: {
        fixIndex: reaching.fixIndex,
        turnpointIndex: reaching.taskIndex,
        turnpointName: tp.waypoint.name,
        selectionReason: reaching.selectionReason,
        candidateCount: reaching.candidateCount,
        madeGoal: result.madeGoal,
        flownDistance: result.flownDistance,
        taskDistance: result.taskDistance,
        speedSectionTime: result.speedSectionTime,
      },
    });
  }

  return events;
}

/**
 * Detect altitude extremes
 */
function detectAltitudeExtremes(fixes: IGCFix[]): FlightEvent[] {
  const events: FlightEvent[] = [];

  if (fixes.length === 0) return events;

  let maxAlt = fixes[0].gnssAltitude;
  let minAlt = fixes[0].gnssAltitude;
  let maxAltIdx = 0;
  let minAltIdx = 0;

  for (let i = 1; i < fixes.length; i++) {
    if (fixes[i].gnssAltitude > maxAlt) {
      maxAlt = fixes[i].gnssAltitude;
      maxAltIdx = i;
    }
    if (fixes[i].gnssAltitude < minAlt) {
      minAlt = fixes[i].gnssAltitude;
      minAltIdx = i;
    }
  }

  events.push({
    id: 'max-altitude',
    type: 'max_altitude',
    time: fixes[maxAltIdx].time,
    latitude: fixes[maxAltIdx].latitude,
    longitude: fixes[maxAltIdx].longitude,
    altitude: maxAlt,
    description: `Max altitude: ${maxAlt.toFixed(0)}m`,
    details: { fixIndex: maxAltIdx },
  });

  events.push({
    id: 'min-altitude',
    type: 'min_altitude',
    time: fixes[minAltIdx].time,
    latitude: fixes[minAltIdx].latitude,
    longitude: fixes[minAltIdx].longitude,
    altitude: minAlt,
    description: `Min altitude: ${minAlt.toFixed(0)}m`,
    details: { fixIndex: minAltIdx },
  });

  return events;
}

/**
 * Detect max climb and sink rates
 */
function detectVarioExtremes(fixes: IGCFix[], thresholds: DetectionThresholds): FlightEvent[] {
  const events: FlightEvent[] = [];
  const windowSize = thresholds.vario.varioWindowSize;

  if (fixes.length < windowSize * 2) return events;

  let maxClimb = 0;
  let maxSink = 0;
  let maxClimbIdx = 0;
  let maxSinkIdx = 0;

  for (let i = windowSize; i < fixes.length; i++) {
    const vario = calculateVario(fixes[i - windowSize], fixes[i]);

    if (vario > maxClimb) {
      maxClimb = vario;
      maxClimbIdx = i;
    }
    if (vario < maxSink) {
      maxSink = vario;
      maxSinkIdx = i;
    }
  }

  if (maxClimb > thresholds.vario.minSignificantClimb) {
    events.push({
      id: 'max-climb',
      type: 'max_climb',
      time: fixes[maxClimbIdx].time,
      latitude: fixes[maxClimbIdx].latitude,
      longitude: fixes[maxClimbIdx].longitude,
      altitude: fixes[maxClimbIdx].gnssAltitude,
      description: `Max climb: +${maxClimb.toFixed(1)}m/s`,
      details: { fixIndex: maxClimbIdx, climbRate: maxClimb },
    });
  }

  if (maxSink < thresholds.vario.minSignificantSink) {
    events.push({
      id: 'max-sink',
      type: 'max_sink',
      time: fixes[maxSinkIdx].time,
      latitude: fixes[maxSinkIdx].latitude,
      longitude: fixes[maxSinkIdx].longitude,
      altitude: fixes[maxSinkIdx].gnssAltitude,
      description: `Max sink: ${maxSink.toFixed(1)}m/s`,
      details: { fixIndex: maxSinkIdx, sinkRate: maxSink },
    });
  }

  return events;
}

/** Adjust fixIndex in event details by the given offset */
function adjustFixIndex(event: FlightEvent, offset: number): void {
  const details = event.details as Record<string, unknown> | undefined;
  if (details && typeof details.fixIndex === 'number') {
    details.fixIndex += offset;
  }
}

/** The `circle_complete` event for one detected 360° circle. */
function circleToEvent(
  circle: CircleSegment,
  indexOffset: number,
  fixes: IGCFix[],
): FlightEvent {
  const startIndex = circle.startIndex + indexOffset;
  const endIndex = circle.endIndex + indexOffset;
  const dir = circle.turnDirection === 'right' ? 'R' : 'L';
  const climbStr = circle.climbRate >= 0
    ? `+${circle.climbRate.toFixed(1)}`
    : circle.climbRate.toFixed(1);

  return {
    id: `circle-${startIndex}`,
    type: 'circle_complete',
    time: fixes[startIndex].time,
    latitude: circle.fittedCircle.centerLat,
    longitude: circle.fittedCircle.centerLon,
    altitude: fixes[startIndex].gnssAltitude,
    description: `Circle #${circle.circleNumber} (${dir}, ${climbStr}m/s, r=${Math.round(circle.fittedCircle.radiusMeters)}m)`,
    details: {
      turnDirection: circle.turnDirection,
      duration: circle.duration,
      climbRate: circle.climbRate,
      radius: circle.fittedCircle.radiusMeters,
      centerLat: circle.fittedCircle.centerLat,
      centerLon: circle.fittedCircle.centerLon,
      fitError: circle.fittedCircle.fitErrorRMS,
      quality: circle.quality,
      strongestLiftBearing: circle.strongestLiftBearing,
      circleNumber: circle.circleNumber,
      windSpeed: circle.windFromGroundSpeed?.speed,
      windDirection: circle.windFromGroundSpeed?.direction,
      driftWindSpeed: circle.windFromCenterDrift?.speed,
      driftWindDirection: circle.windFromCenterDrift?.direction,
    },
    segment: { startIndex, endIndex },
  };
}

/**
 * Main function to detect all flight events
 */
export function detectFlightEvents(
  fixes: IGCFix[],
  task?: XCTask,
  partialThresholds?: PartialThresholds
): FlightEvent[] {
  const thresholds = resolveThresholds(partialThresholds);
  const allEvents: FlightEvent[] = [];

  // IMPORTANT: Detect takeoff and landing FIRST
  // All other events should only be detected after takeoff
  const takeoffLandingEvents = detectTakeoffLanding(fixes, thresholds);
  allEvents.push(...takeoffLandingEvents);

  // Find the takeoff event to get the index where flight begins
  const takeoffEvent = takeoffLandingEvents.find(e => e.type === 'takeoff');

  // If no takeoff detected, we shouldn't detect flight events
  // (pilot might still be on the ground)
  if (!takeoffEvent) {
    return allEvents;
  }

  // Read the takeoff fix index from the event itself. Looking it up by
  // timestamp is unsafe — cheap GPS loggers stall and emit consecutive
  // fixes with identical timestamps, so findIndex can land on a fix
  // earlier than the real takeoff and leak pre-takeoff data downstream.
  const takeoffIndex = (takeoffEvent.details as FixIndexDetails).fixIndex;

  // Create a slice of fixes from takeoff onwards for analysis
  const flightFixes = fixes.slice(takeoffIndex);
  const indexOffset = takeoffIndex; // To adjust indices back to original array

  // Detect thermals (only after takeoff)
  const thermals = detectThermals(flightFixes, thresholds);
  for (const thermal of thermals) {
    allEvents.push(...thermalToEvents(thermal, indexOffset, fixes));
  }

  // Detect glides (only after takeoff)
  const glides = detectGlides(flightFixes, thermals, thresholds);
  for (const glide of glides) {
    allEvents.push(...glideToEvents(glide, indexOffset, fixes));
  }

  // Detect altitude and vario extremes (only after takeoff)
  // Apply indexOffset so fixIndex references the original fixes array
  for (const event of detectAltitudeExtremes(flightFixes)) {
    adjustFixIndex(event, indexOffset);
    allEvents.push(event);
  }
  for (const event of detectVarioExtremes(flightFixes, thresholds)) {
    adjustFixIndex(event, indexOffset);
    allEvents.push(event);
  }

  // Detect turnpoint crossings and scored reachings if task is provided (only after takeoff)
  if (task) {
    for (const event of detectTurnpointEvents(flightFixes, task)) {
      adjustFixIndex(event, indexOffset);
      allEvents.push(event);
    }
  }

  // Detect circles (only after takeoff)
  const circleResult = detectCircles(flightFixes, {
    lookbackSeconds: thresholds.circle.lookbackSeconds,
    minTurnRate: thresholds.circle.minTurnRate,
    t1Seconds: thresholds.circle.t1Seconds,
    t2Seconds: thresholds.circle.t2Seconds,
    minFixesPerCircle: thresholds.circle.minFixesPerCircle,
    maxBearingRate: thresholds.circle.maxBearingRate,
    maxReasonableWindSpeed: thresholds.circle.maxReasonableWindSpeed,
    minGroundSpeedVariation: thresholds.circle.minGroundSpeedVariation,
  });
  for (const circle of circleResult.circles) {
    allEvents.push(circleToEvent(circle, indexOffset, fixes));
  }

  // Sort by time
  allEvents.sort((a, b) => a.time.getTime() - b.time.getTime());

  return allEvents;
}

/**
 * Filter events that are visible in a bounding box
 */
export function filterEventsByBounds(
  events: FlightEvent[],
  bounds: {
    north: number;
    south: number;
    east: number;
    west: number;
  }
): FlightEvent[] {
  return events.filter(event =>
    event.latitude >= bounds.south &&
    event.latitude <= bounds.north &&
    event.longitude >= bounds.west &&
    event.longitude <= bounds.east
  );
}

// getEventStyle has been moved to event-styles.ts
export { getEventStyle } from './event-styles';
