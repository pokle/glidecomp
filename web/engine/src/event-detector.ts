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
import { andoyerDistance, calculateTrackDistance } from './geo';
import { XCTask, getSSSIndex, getESSIndex, getGoalIndex } from './xctsk-parser';
import { resolveTurnpointSequence } from './turnpoint-sequence';
import { detectCircles } from './circle-detector';
import { resolveThresholds, DEFAULT_THRESHOLDS, type DetectionThresholds, type PartialThresholds } from './thresholds';

export type FlightEventType =
  | 'takeoff'
  | 'landing'
  | 'thermal_entry'
  | 'thermal_exit'
  | 'glide_start'
  | 'glide_end'
  | 'turnpoint_entry'
  | 'turnpoint_exit'
  | 'start_crossing'
  | 'goal_crossing'
  | 'start_reaching'
  | 'turnpoint_reaching'
  | 'ess_reaching'
  | 'goal_reaching'
  | 'max_altitude'
  | 'min_altitude'
  | 'max_climb'
  | 'max_sink'
  | 'circle_complete';

/**
 * Base interface for track segments (thermals, glides, etc.)
 * Contains the fix array indices that define the segment bounds
 */
export interface TrackSegment {
  startIndex: number;
  endIndex: number;
}

// --- Event detail types ---

export interface ThermalEventDetails {
  avgClimbRate: number;
  duration: number;
  altitudeGain: number;
}

export interface GlideEventDetails {
  distance: number;
  glideRatio: number;
  duration?: number;
  averageSpeed: number;
  altitudeLost?: number;
}

export interface FixIndexDetails {
  fixIndex: number;
  climbRate?: number;
  sinkRate?: number;
  startAltitude?: number;
  altitudeGain?: number;
}

export interface TurnpointCrossingDetails {
  fixIndex: number;
  turnpointIndex: number;
  turnpointName: string;
  radius: number;
  direction: string;
  distanceToCenter: number;
}

export interface TurnpointReachingDetails {
  fixIndex: number;
  turnpointIndex: number;
  turnpointName: string;
  selectionReason: string;
  candidateCount: number;
  madeGoal: boolean;
  flownDistance: number;
  taskDistance: number;
  speedSectionTime?: number | null;
}

export interface CircleEventDetails {
  turnDirection: string;
  duration: number;
  climbRate: number;
  radius: number;
  centerLat: number;
  centerLon: number;
  fitError: number;
  quality: number;
  strongestLiftBearing: number;
  circleNumber: number;
  windSpeed?: number;
  windDirection?: number;
  driftWindSpeed?: number;
  driftWindDirection?: number;
}

export type EventDetails =
  | ThermalEventDetails
  | GlideEventDetails
  | FixIndexDetails
  | TurnpointCrossingDetails
  | TurnpointReachingDetails
  | CircleEventDetails;

export interface FlightEvent {
  id: string;
  type: FlightEventType;
  time: Date;
  latitude: number;
  longitude: number;
  altitude: number;
  description: string;
  details?: EventDetails;
  /** For segment events (thermals, glides), contains the track indices */
  segment?: TrackSegment;
}

export interface ThermalSegment extends TrackSegment {
  startAltitude: number;
  endAltitude: number;
  avgClimbRate: number;
  duration: number;
  location: { lat: number; lon: number };
}

export interface GlideSegment extends TrackSegment {
  startAltitude: number;
  endAltitude: number;
  distance: number;
  glideRatio: number;
  duration: number;
}

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
 * Calculate ground speed between two fixes (m/s)
 */
function calculateGroundSpeed(fix1: IGCFix, fix2: IGCFix): number {
  const timeDiff = (fix2.time.getTime() - fix1.time.getTime()) / 1000;
  if (timeDiff <= 0) return 0;

  const distance = andoyerDistance(
    fix1.latitude,
    fix1.longitude,
    fix2.latitude,
    fix2.longitude
  );

  return distance / timeDiff;
}

/**
 * Build a ThermalSegment from a detected thermal's start/end indices.
 */
function buildThermalSegment(fixes: IGCFix[], startIndex: number, endIndex: number): ThermalSegment | null {
  const duration = (fixes[endIndex].time.getTime() - fixes[startIndex].time.getTime()) / 1000;
  if (duration <= 0) return null;

  let sumLat = 0;
  let sumLon = 0;
  for (let j = startIndex; j <= endIndex; j++) {
    sumLat += fixes[j].latitude;
    sumLon += fixes[j].longitude;
  }
  const count = endIndex - startIndex + 1;
  const altGain = fixes[endIndex].gnssAltitude - fixes[startIndex].gnssAltitude;

  return {
    startIndex,
    endIndex,
    startAltitude: fixes[startIndex].gnssAltitude,
    endAltitude: fixes[endIndex].gnssAltitude,
    avgClimbRate: altGain / duration,
    duration,
    location: { lat: sumLat / count, lon: sumLon / count },
  };
}

/**
 * Detect thermal segments in the flight
 * A thermal is detected when:
 * - Average climb rate > 0.5 m/s
 * - Duration > 20 seconds
 * - Relatively circular path (not a straight glide)
 */
function detectThermals(fixes: IGCFix[], thresholds: DetectionThresholds, windowSize = 10): ThermalSegment[] {
  const thermals: ThermalSegment[] = [];
  const minClimbRate = thresholds.thermal.minClimbRate;
  const minDuration = thresholds.thermal.minThermalDuration;

  let inThermal = false;
  let thermalStart = 0;
  let exitCounter = 0; // Count consecutive windows below threshold
  const exitThreshold = 3; // Exit after N consecutive windows below threshold
  let lastThermalEnd = -1; // Track the end of the last thermal to prevent overlaps

  for (let i = windowSize; i < fixes.length; i++) {
    // Calculate average climb rate over window
    let totalClimb = 0;
    let totalTime = 0;

    for (let j = i - windowSize; j < i; j++) {
      const dt = (fixes[j + 1].time.getTime() - fixes[j].time.getTime()) / 1000;
      const da = fixes[j + 1].gnssAltitude - fixes[j].gnssAltitude;
      totalClimb += da;
      totalTime += dt;
    }

    const avgClimb = totalTime > 0 ? totalClimb / totalTime : 0;

    if (!inThermal && avgClimb > minClimbRate) {
      // Entering thermal - but only if we're past the last thermal's end
      // and at least minGapDuration seconds have passed
      const potentialStart = i - windowSize;
      const minGapDuration = thresholds.thermal.minThermalGap;
      const timeSinceLastThermal = lastThermalEnd >= 0
        ? (fixes[potentialStart].time.getTime() - fixes[lastThermalEnd].time.getTime()) / 1000
        : Infinity;

      if (potentialStart > lastThermalEnd && timeSinceLastThermal >= minGapDuration) {
        inThermal = true;
        thermalStart = potentialStart;
        exitCounter = 0;
      }
    } else if (inThermal) {
      if (avgClimb <= minClimbRate) {
        exitCounter++;

        if (exitCounter >= exitThreshold) {
          const thermalEnd = i - exitThreshold;
          const duration = (fixes[thermalEnd].time.getTime() - fixes[thermalStart].time.getTime()) / 1000;

          if (duration >= minDuration) {
            const segment = buildThermalSegment(fixes, thermalStart, thermalEnd);
            if (segment) {
              thermals.push(segment);
              lastThermalEnd = thermalEnd;
            }
          }

          inThermal = false;
          exitCounter = 0;
        }
      } else {
        exitCounter = 0;
      }
    }
  }

  // Handle thermal that's still active at end of flight
  if (inThermal) {
    const thermalEnd = fixes.length - 1;
    const duration = (fixes[thermalEnd].time.getTime() - fixes[thermalStart].time.getTime()) / 1000;

    if (duration >= minDuration) {
      const segment = buildThermalSegment(fixes, thermalStart, thermalEnd);
      if (segment) thermals.push(segment);
    }
  }

  return thermals;
}

/**
 * Build a GlideSegment from a detected glide's start/end indices.
 * Returns null if the segment is too short (< 30 seconds).
 */
function buildGlideSegment(fixes: IGCFix[], startIdx: number, endIdx: number, minGlideDuration: number): GlideSegment | null {
  const duration = (fixes[endIdx].time.getTime() - fixes[startIdx].time.getTime()) / 1000;
  if (duration <= minGlideDuration) return null;

  const totalDist = calculateTrackDistance(fixes, startIdx, endIdx);
  const altLoss = fixes[startIdx].gnssAltitude - fixes[endIdx].gnssAltitude;

  return {
    startIndex: startIdx,
    endIndex: endIdx,
    startAltitude: fixes[startIdx].gnssAltitude,
    endAltitude: fixes[endIdx].gnssAltitude,
    distance: totalDist,
    glideRatio: altLoss > 0 ? totalDist / altLoss : Infinity,
    duration,
  };
}

/**
 * Detect glide segments between thermals
 */
function detectGlides(fixes: IGCFix[], thermals: ThermalSegment[], thresholds: DetectionThresholds): GlideSegment[] {
  const glides: GlideSegment[] = [];
  const minGlideGapIndices = thresholds.glide.minGlideGapIndices;
  const minGlideDuration = thresholds.glide.minGlideDuration;

  // Sort thermals by start index
  const sortedThermals = [...thermals].sort((a, b) => a.startIndex - b.startIndex);

  // Find glides between thermals
  let prevEnd = 0;

  for (const thermal of sortedThermals) {
    if (thermal.startIndex > prevEnd + minGlideGapIndices) {
      // Glide ends one index before the thermal starts to avoid timestamp overlap
      const glide = buildGlideSegment(fixes, prevEnd, thermal.startIndex - 1, minGlideDuration);
      if (glide) glides.push(glide);
    }
    prevEnd = thermal.endIndex;
  }

  // Trailing glide: from last thermal end (or start of flight) to end of track
  if (fixes.length - 1 > prevEnd + minGlideGapIndices) {
    const glide = buildGlideSegment(fixes, prevEnd, fixes.length - 1, minGlideDuration);
    if (glide) glides.push(glide);
  }

  return glides;
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

  const sssIdx = getSSSIndex(task);
  const essIdx = getESSIndex(task);
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

// Configuration for takeoff/landing detection (based on XCSoar)
interface TakeoffLandingConfig {
  minGroundSpeed: number;  // m/s
  minAltitudeGain: number; // meters above start altitude
  minClimbRate: number;    // m/s sustained climb
  takeoffTimeWindow: number; // seconds
  landingTimeWindow: number; // seconds
  landingSpeedFactor: number; // ratio
  landingDescentThreshold: number; // m/s
}

/**
 * Find the index of the fix closest to `fixes[refIndex].timestamp + deltaSeconds`.
 * Scans forward (positive delta) or backward (negative delta) from refIndex.
 * Returns refIndex if no fix is found at the target time offset.
 */
function findFixIndexAtTime(fixes: IGCFix[], refIndex: number, deltaSeconds: number): number {
  const targetTime = fixes[refIndex].time.getTime() + deltaSeconds * 1000;

  if (deltaSeconds >= 0) {
    for (let j = refIndex + 1; j < fixes.length; j++) {
      if (fixes[j].time.getTime() >= targetTime) return j;
    }
  } else {
    for (let j = refIndex - 1; j >= 0; j--) {
      if (fixes[j].time.getTime() <= targetTime) return j;
    }
  }

  return refIndex;
}

/**
 * Evaluate whether a takeoff has occurred at a given fix index by checking
 * multiple criteria: instant ground speed, altitude gain above start, and
 * recent climb rate. Returns the number of criteria met (0-3).
 */
function evaluateTakeoffCriteria(
  fixes: IGCFix[],
  index: number,
  startAltitude: number,
  config: TakeoffLandingConfig
): number {
  let criteriaMetCount = 0;

  // Criteria 1: Instant ground speed check
  if (index < fixes.length - 1) {
    const speed = calculateGroundSpeed(fixes[index - 1], fixes[index]);
    if (speed > config.minGroundSpeed) criteriaMetCount++;
  }

  // Criteria 2: Current altitude gain above start
  if (fixes[index].gnssAltitude - startAltitude > config.minAltitudeGain) {
    criteriaMetCount++;
  }

  // Criteria 3: Recent climb rate (over last few fixes)
  const climbWindowSize = Math.min(5, index);
  if (climbWindowSize > 0) {
    const climbStartIdx = index - climbWindowSize;
    const climbDuration = (fixes[index].time.getTime() - fixes[climbStartIdx].time.getTime()) / 1000;
    const altitudeChange = fixes[index].gnssAltitude - fixes[climbStartIdx].gnssAltitude;
    if (climbDuration > 0 && altitudeChange / climbDuration > config.minClimbRate) {
      criteriaMetCount++;
    }
  }

  return criteriaMetCount;
}

/**
 * Verify that flight is sustained between startIdx and endIdx after a
 * potential takeoff point. Checks altitude gain, climb rate, and ground
 * speed within the verification window.
 */
function verifyFlightSustained(
  fixes: IGCFix[],
  startIdx: number,
  endIdx: number,
  startAltitude: number,
  config: TakeoffLandingConfig
): boolean {
  if (fixes[endIdx].gnssAltitude - startAltitude > config.minAltitudeGain) {
    return true;
  }

  const windowDuration = (fixes[endIdx].time.getTime() - fixes[startIdx].time.getTime()) / 1000;
  const windowAltChange = fixes[endIdx].gnssAltitude - fixes[startIdx].gnssAltitude;
  if (windowDuration > 0 && windowAltChange / windowDuration > config.minClimbRate) {
    return true;
  }

  for (let j = startIdx; j < endIdx - 1; j++) {
    const speed = calculateGroundSpeed(fixes[j], fixes[j + 1]);
    if (speed > config.minGroundSpeed) return true;
  }

  return false;
}

/**
 * Detect takeoff index by scanning forward for sustained flight criteria.
 * Returns the fix index of takeoff, or -1 if not found.
 */
function detectTakeoff(fixes: IGCFix[], config: TakeoffLandingConfig): { index: number; startAltitude: number } | null {
  // Find starting altitude (average of first few fixes to reduce noise)
  let startAltitude = 0;
  const startSampleSize = Math.min(10, fixes.length);
  for (let i = 0; i < startSampleSize; i++) {
    startAltitude += fixes[i].gnssAltitude;
  }
  startAltitude /= startSampleSize;

  for (let i = 1; i < fixes.length; i++) {
    const criteriaMetCount = evaluateTakeoffCriteria(fixes, i, startAltitude, config);
    if (criteriaMetCount < 1) continue;

    // Verify sustained flight for takeoffTimeWindow
    const verifyEndIndex = findFixIndexAtTime(fixes, i, config.takeoffTimeWindow);
    if (verifyEndIndex <= i) continue;

    if (verifyFlightSustained(fixes, i, verifyEndIndex, startAltitude, config)) {
      return { index: i, startAltitude };
    }
  }

  return null;
}

/**
 * Detect landing index by scanning backward for the last sustained flight indication.
 * Returns the fix index of landing, or -1 if not found.
 */
function detectLanding(fixes: IGCFix[], config: TakeoffLandingConfig): { index: number } | null {
  for (let i = fixes.length - 2; i >= config.landingTimeWindow; i--) {
    const windowStartIndex = findFixIndexAtTime(fixes, i, -config.landingTimeWindow);
    if (windowStartIndex === i) continue;

    let stillFlying = false;

    // Check 1: Any significant ground speed?
    for (let j = windowStartIndex; j < i; j++) {
      const speed = calculateGroundSpeed(fixes[j], fixes[j + 1]);
      if (speed > config.minGroundSpeed * config.landingSpeedFactor) {
        stillFlying = true;
        break;
      }
    }

    // Check 2: Still descending? (indicates approach, not landed)
    if (!stillFlying) {
      const altChange = fixes[i].gnssAltitude - fixes[windowStartIndex].gnssAltitude;
      const timeDiff = (fixes[i].time.getTime() - fixes[windowStartIndex].time.getTime()) / 1000;
      if (timeDiff > 0 && altChange / timeDiff < config.landingDescentThreshold) {
        stillFlying = true;
      }
    }

    if (stillFlying) return { index: i };
  }

  return null;
}

/**
 * Detect takeoff and landing using multiple criteria.
 * Based on XCSoar's approach - uses ground speed, altitude gain, and climb rate.
 */
function detectTakeoffLanding(fixes: IGCFix[], thresholds: DetectionThresholds): FlightEvent[] {
  const events: FlightEvent[] = [];
  if (fixes.length < 10) return events;

  const config: TakeoffLandingConfig = {
    ...thresholds.takeoffLanding,
    landingDescentThreshold: thresholds.vario.landingDescentThreshold,
  };

  const takeoff = detectTakeoff(fixes, config);
  if (takeoff) {
    const fix = fixes[takeoff.index];
    events.push({
      id: 'takeoff',
      type: 'takeoff',
      time: fix.time,
      latitude: fix.latitude,
      longitude: fix.longitude,
      altitude: fix.gnssAltitude,
      description: 'Takeoff',
      details: {
        fixIndex: takeoff.index,
        startAltitude: takeoff.startAltitude,
        altitudeGain: fix.gnssAltitude - takeoff.startAltitude,
      },
    });
  }

  const landing = detectLanding(fixes, config);
  if (landing) {
    const fix = fixes[landing.index];
    events.push({
      id: 'landing',
      type: 'landing',
      time: fix.time,
      latitude: fix.latitude,
      longitude: fix.longitude,
      altitude: fix.gnssAltitude,
      description: 'Landing',
      details: { fixIndex: landing.index },
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

  // Find the index of the takeoff fix in the original array
  const takeoffIndex = fixes.findIndex(f => f.time.getTime() === takeoffEvent.time.getTime());

  if (takeoffIndex === -1) {
    // Shouldn't happen, but safety check
    return allEvents;
  }

  // Create a slice of fixes from takeoff onwards for analysis
  const flightFixes = fixes.slice(takeoffIndex);
  const indexOffset = takeoffIndex; // To adjust indices back to original array

  // Detect thermals (only after takeoff)
  const thermals = detectThermals(flightFixes, thresholds);

  for (const thermal of thermals) {
    // Adjust indices to reference original array
    const adjustedStartIndex = thermal.startIndex + indexOffset;
    const adjustedEndIndex = thermal.endIndex + indexOffset;

    allEvents.push({
      id: `thermal-entry-${adjustedStartIndex}`,
      type: 'thermal_entry',
      time: fixes[adjustedStartIndex].time,
      latitude: thermal.location.lat,
      longitude: thermal.location.lon,
      altitude: thermal.startAltitude,
      description: `Thermal entry (${thermal.avgClimbRate > 0 ? '+' : ''}${thermal.avgClimbRate.toFixed(1)}m/s avg)`,
      details: {
        avgClimbRate: thermal.avgClimbRate,
        duration: thermal.duration,
        altitudeGain: thermal.endAltitude - thermal.startAltitude,
      },
      segment: { startIndex: adjustedStartIndex, endIndex: adjustedEndIndex },
    });

    allEvents.push({
      id: `thermal-exit-${adjustedEndIndex}`,
      type: 'thermal_exit',
      time: fixes[adjustedEndIndex].time,
      latitude: thermal.location.lat,
      longitude: thermal.location.lon,
      altitude: thermal.endAltitude,
      description: `Thermal exit (${(thermal.endAltitude - thermal.startAltitude) > 0 ? '+' : ''}${(thermal.endAltitude - thermal.startAltitude).toFixed(0)}m gained)`,
      details: {
        avgClimbRate: thermal.avgClimbRate,
        duration: thermal.duration,
        altitudeGain: thermal.endAltitude - thermal.startAltitude,
      },
      segment: { startIndex: adjustedStartIndex, endIndex: adjustedEndIndex },
    });
  }

  // Detect glides (only after takeoff)
  const glides = detectGlides(flightFixes, thermals, thresholds);

  for (const glide of glides) {
    // Adjust indices to reference original array
    const adjustedStartIndex = glide.startIndex + indexOffset;
    const adjustedEndIndex = glide.endIndex + indexOffset;

    // Calculate average speed in m/s
    const averageSpeed = glide.duration > 0 ? glide.distance / glide.duration : 0;

    allEvents.push({
      id: `glide-start-${adjustedStartIndex}`,
      type: 'glide_start',
      time: fixes[adjustedStartIndex].time,
      latitude: fixes[adjustedStartIndex].latitude,
      longitude: fixes[adjustedStartIndex].longitude,
      altitude: glide.startAltitude,
      description: `Glide start (L/D ${glide.glideRatio.toFixed(0)})`,
      details: {
        distance: glide.distance,
        glideRatio: glide.glideRatio,
        duration: glide.duration,
        averageSpeed: averageSpeed,
      },
      segment: { startIndex: adjustedStartIndex, endIndex: adjustedEndIndex },
    });

    allEvents.push({
      id: `glide-end-${adjustedEndIndex}`,
      type: 'glide_end',
      time: fixes[adjustedEndIndex].time,
      latitude: fixes[adjustedEndIndex].latitude,
      longitude: fixes[adjustedEndIndex].longitude,
      altitude: glide.endAltitude,
      description: `Glide end (${(glide.distance / 1000).toFixed(2)}km)`,
      details: {
        distance: glide.distance,
        glideRatio: glide.glideRatio,
        altitudeLost: glide.startAltitude - glide.endAltitude,
        averageSpeed: averageSpeed,
      },
      segment: { startIndex: adjustedStartIndex, endIndex: adjustedEndIndex },
    });
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
    const adjustedStartIndex = circle.startIndex + indexOffset;
    const adjustedEndIndex = circle.endIndex + indexOffset;
    const dir = circle.turnDirection === 'right' ? 'R' : 'L';
    const climbStr = circle.climbRate >= 0
      ? `+${circle.climbRate.toFixed(1)}`
      : circle.climbRate.toFixed(1);

    allEvents.push({
      id: `circle-${adjustedStartIndex}`,
      type: 'circle_complete',
      time: fixes[adjustedStartIndex].time,
      latitude: circle.fittedCircle.centerLat,
      longitude: circle.fittedCircle.centerLon,
      altitude: fixes[adjustedStartIndex].gnssAltitude,
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
      segment: { startIndex: adjustedStartIndex, endIndex: adjustedEndIndex },
    });
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
