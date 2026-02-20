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
import { haversineDistance } from './geo';
import { XCTask, getSSSIndex, getESSIndex } from './xctsk-parser';
import { resolveTurnpointSequence } from './turnpoint-sequence';

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
  | 'max_sink';

/**
 * Base interface for track segments (thermals, glides, etc.)
 * Contains the fix array indices that define the segment bounds
 */
export interface TrackSegment {
  startIndex: number;
  endIndex: number;
}

export interface FlightEvent {
  id: string;
  type: FlightEventType;
  time: Date;
  latitude: number;
  longitude: number;
  altitude: number;
  description: string;
  details?: Record<string, unknown>;
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

  const distance = haversineDistance(
    fix1.latitude,
    fix1.longitude,
    fix2.latitude,
    fix2.longitude
  );

  return distance / timeDiff;
}

/**
 * Detect thermal segments in the flight
 * A thermal is detected when:
 * - Average climb rate > 0.5 m/s
 * - Duration > 20 seconds
 * - Relatively circular path (not a straight glide)
 */
function detectThermals(fixes: IGCFix[], windowSize = 10): ThermalSegment[] {
  const thermals: ThermalSegment[] = [];
  const minClimbRate = 0.5; // m/s
  const minDuration = 20; // seconds

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
      const minGapDuration = 20; // seconds between thermals
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
        // Climb rate below threshold - increment exit counter
        exitCounter++;

        if (exitCounter >= exitThreshold) {
          // Exiting thermal - sustained drop below threshold
          const thermalEnd = i - exitThreshold;
          const duration = (fixes[thermalEnd].time.getTime() - fixes[thermalStart].time.getTime()) / 1000;

          if (duration >= minDuration) {
            // Calculate thermal statistics
            let sumLat = 0;
            let sumLon = 0;
            let count = 0;

            for (let j = thermalStart; j <= thermalEnd; j++) {
              sumLat += fixes[j].latitude;
              sumLon += fixes[j].longitude;
              count++;
            }

            const altGain = fixes[thermalEnd].gnssAltitude - fixes[thermalStart].gnssAltitude;

            thermals.push({
              startIndex: thermalStart,
              endIndex: thermalEnd,
              startAltitude: fixes[thermalStart].gnssAltitude,
              endAltitude: fixes[thermalEnd].gnssAltitude,
              avgClimbRate: altGain / duration,
              duration,
              location: {
                lat: sumLat / count,
                lon: sumLon / count,
              },
            });
            lastThermalEnd = thermalEnd;
          }

          inThermal = false;
          exitCounter = 0;
        }
      } else {
        // Climb rate back above threshold - reset exit counter
        exitCounter = 0;
      }
    }
  }

  // Handle thermal that's still active at end of flight
  if (inThermal) {
    const thermalEnd = fixes.length - 1;
    const duration = (fixes[thermalEnd].time.getTime() - fixes[thermalStart].time.getTime()) / 1000;

    if (duration >= minDuration) {
      // Calculate thermal statistics
      let sumLat = 0;
      let sumLon = 0;
      let count = 0;

      for (let j = thermalStart; j <= thermalEnd; j++) {
        sumLat += fixes[j].latitude;
        sumLon += fixes[j].longitude;
        count++;
      }

      const altGain = fixes[thermalEnd].gnssAltitude - fixes[thermalStart].gnssAltitude;

      thermals.push({
        startIndex: thermalStart,
        endIndex: thermalEnd,
        startAltitude: fixes[thermalStart].gnssAltitude,
        endAltitude: fixes[thermalEnd].gnssAltitude,
        avgClimbRate: altGain / duration,
        duration,
        location: {
          lat: sumLat / count,
          lon: sumLon / count,
        },
      });
    }
  }

  return thermals;
}

/**
 * Detect glide segments between thermals
 */
function detectGlides(fixes: IGCFix[], thermals: ThermalSegment[]): GlideSegment[] {
  const glides: GlideSegment[] = [];

  // Sort thermals by start index
  const sortedThermals = [...thermals].sort((a, b) => a.startIndex - b.startIndex);

  // Find glides between thermals
  let prevEnd = 0;

  for (const thermal of sortedThermals) {
    if (thermal.startIndex > prevEnd + 10) {
      const startIdx = prevEnd;
      // Glide ends one index before the thermal starts to avoid timestamp overlap
      const endIdx = thermal.startIndex - 1;

      const duration = (fixes[endIdx].time.getTime() - fixes[startIdx].time.getTime()) / 1000;

      if (duration > 30) {
        // Calculate glide statistics
        let totalDist = 0;
        for (let i = startIdx; i < endIdx; i++) {
          totalDist += haversineDistance(
            fixes[i].latitude,
            fixes[i].longitude,
            fixes[i + 1].latitude,
            fixes[i + 1].longitude
          );
        }

        const altLoss = fixes[startIdx].gnssAltitude - fixes[endIdx].gnssAltitude;
        const glideRatio = altLoss > 0 ? totalDist / altLoss : Infinity;

        glides.push({
          startIndex: startIdx,
          endIndex: endIdx,
          startAltitude: fixes[startIdx].gnssAltitude,
          endAltitude: fixes[endIdx].gnssAltitude,
          distance: totalDist,
          glideRatio,
          duration,
        });
      }
    }
    prevEnd = thermal.endIndex;
  }

  // Trailing glide: from last thermal end (or start of flight) to end of track
  const lastIdx = fixes.length - 1;
  if (lastIdx > prevEnd + 10) {
    const startIdx = prevEnd;
    const endIdx = lastIdx;
    const duration = (fixes[endIdx].time.getTime() - fixes[startIdx].time.getTime()) / 1000;

    if (duration > 30) {
      let totalDist = 0;
      for (let i = startIdx; i < endIdx; i++) {
        totalDist += haversineDistance(
          fixes[i].latitude,
          fixes[i].longitude,
          fixes[i + 1].latitude,
          fixes[i + 1].longitude
        );
      }

      const altLoss = fixes[startIdx].gnssAltitude - fixes[endIdx].gnssAltitude;
      const glideRatio = altLoss > 0 ? totalDist / altLoss : Infinity;

      glides.push({
        startIndex: startIdx,
        endIndex: endIdx,
        startAltitude: fixes[startIdx].gnssAltitude,
        endAltitude: fixes[endIdx].gnssAltitude,
        distance: totalDist,
        glideRatio,
        duration,
      });
    }
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
  const goalIdx = task.turnpoints.length - 1;

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
      description: `${crossing.direction === 'enter' ? 'Entered' : 'Exited'} ${tp.waypoint.name} (${tp.type || 'TP' + (crossing.taskIndex + 1)})`,
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
 * Detect takeoff and landing using multiple criteria
 * Based on XCSoar's approach - uses ground speed, altitude gain, and climb rate
 */
function detectTakeoffLanding(fixes: IGCFix[]): FlightEvent[] {
  const events: FlightEvent[] = [];

  if (fixes.length < 10) return events;

  // Configuration (based on XCSoar)
  const minGroundSpeed = 5; // m/s (~18 km/h)
  const minAltitudeGain = 50; // meters above start altitude
  const minClimbRate = 1.0; // m/s sustained climb
  const takeoffTimeWindow = 10; // seconds - must sustain criteria
  const landingTimeWindow = 30; // seconds - asymmetric for safety

  // Find starting altitude (average of first few fixes to reduce noise)
  let startAltitude = 0;
  const startSampleSize = Math.min(10, fixes.length);
  for (let i = 0; i < startSampleSize; i++) {
    startAltitude += fixes[i].gnssAltitude;
  }
  startAltitude /= startSampleSize;

  // === TAKEOFF DETECTION ===
  // Scan forward to find first point where flight criteria are continuously met
  let takeoffIndex = -1;

  for (let i = 1; i < fixes.length; i++) {
    // Calculate criteria at current position
    let criteriaMetCount = 0;

    // Criteria 1: Instant ground speed check
    if (i < fixes.length - 1) {
      const speed = calculateGroundSpeed(fixes[i - 1], fixes[i]);
      if (speed > minGroundSpeed) {
        criteriaMetCount++;
      }
    }

    // Criteria 2: Current altitude gain above start
    const altitudeGain = fixes[i].gnssAltitude - startAltitude;
    if (altitudeGain > minAltitudeGain) {
      criteriaMetCount++;
    }

    // Criteria 3: Recent climb rate (over last few fixes)
    const climbWindowSize = Math.min(5, i); // Look back up to 5 fixes
    if (climbWindowSize > 0) {
      const climbStartIdx = i - climbWindowSize;
      const climbDuration = (fixes[i].time.getTime() - fixes[climbStartIdx].time.getTime()) / 1000;
      const altitudeChange = fixes[i].gnssAltitude - fixes[climbStartIdx].gnssAltitude;
      const avgClimbRate = climbDuration > 0 ? altitudeChange / climbDuration : 0;

      if (avgClimbRate > minClimbRate) {
        criteriaMetCount++;
      }
    }

    // Found flight indication - verify it sustains for takeoffTimeWindow
    if (criteriaMetCount >= 1) {
      // Check if flight criteria continue for the next N seconds
      const verifyEndTime = fixes[i].time.getTime() + takeoffTimeWindow * 1000;
      let verifyEndIndex = i;

      for (let j = i + 1; j < fixes.length; j++) {
        if (fixes[j].time.getTime() >= verifyEndTime) {
          verifyEndIndex = j;
          break;
        }
      }

      if (verifyEndIndex > i) {
        // Check if we're still flying at the end of the window
        let stillFlying = false;

        // Check sustained altitude gain
        const futureAltGain = fixes[verifyEndIndex].gnssAltitude - startAltitude;
        if (futureAltGain > minAltitudeGain) {
          stillFlying = true;
        }

        // Check sustained climb over window
        const windowDuration = (fixes[verifyEndIndex].time.getTime() - fixes[i].time.getTime()) / 1000;
        const windowAltChange = fixes[verifyEndIndex].gnssAltitude - fixes[i].gnssAltitude;
        const windowClimbRate = windowDuration > 0 ? windowAltChange / windowDuration : 0;

        if (windowClimbRate > minClimbRate) {
          stillFlying = true;
        }

        // Check for any good ground speed in the window
        for (let j = i; j < verifyEndIndex - 1; j++) {
          const speed = calculateGroundSpeed(fixes[j], fixes[j + 1]);
          if (speed > minGroundSpeed) {
            stillFlying = true;
            break;
          }
        }

        if (stillFlying) {
          takeoffIndex = i;
          break;
        }
      }
    }
  }

  if (takeoffIndex >= 0) {
    const takeoffFix = fixes[takeoffIndex];
    events.push({
      id: 'takeoff',
      type: 'takeoff',
      time: takeoffFix.time,
      latitude: takeoffFix.latitude,
      longitude: takeoffFix.longitude,
      altitude: takeoffFix.gnssAltitude,
      description: 'Takeoff',
      details: {
        fixIndex: takeoffIndex,
        startAltitude,
        altitudeGain: takeoffFix.gnssAltitude - startAltitude,
      },
    });
  }

  // === LANDING DETECTION ===
  // Scan backward to find last sustained flight indication
  let landingIndex = -1;

  for (let i = fixes.length - 2; i >= landingTimeWindow; i--) {
    // Check if we're still flying in the time window BEFORE this point
    let windowStartTime = fixes[i].time.getTime() - landingTimeWindow * 1000;

    // Find the index at start of time window
    let windowStartIndex = i;
    for (let j = i; j >= 0; j--) {
      if (fixes[j].time.getTime() <= windowStartTime) {
        windowStartIndex = j;
        break;
      }
    }

    if (windowStartIndex === i) continue; // Window too short

    // Check for flight indicators in the window before this point
    let stillFlying = false;

    // Check 1: Any significant ground speed?
    for (let j = windowStartIndex; j < i; j++) {
      const speed = calculateGroundSpeed(fixes[j], fixes[j + 1]);
      if (speed > minGroundSpeed / 2) {
        // Lower threshold for landing (hysteresis)
        stillFlying = true;
        break;
      }
    }

    // Check 2: Still descending? (indicates approach, not landed)
    if (!stillFlying) {
      const altChange = fixes[i].gnssAltitude - fixes[windowStartIndex].gnssAltitude;
      const timeDiff = (fixes[i].time.getTime() - fixes[windowStartIndex].time.getTime()) / 1000;
      const vario = timeDiff > 0 ? altChange / timeDiff : 0;

      if (vario < -0.5) {
        // Descending > 0.5 m/s = still on approach
        stillFlying = true;
      }
    }

    // If still flying in the window before this point, this is our landing
    if (stillFlying) {
      landingIndex = i;
      break;
    }
  }

  if (landingIndex >= 0) {
    const landingFix = fixes[landingIndex];
    events.push({
      id: 'landing',
      type: 'landing',
      time: landingFix.time,
      latitude: landingFix.latitude,
      longitude: landingFix.longitude,
      altitude: landingFix.gnssAltitude,
      description: 'Landing',
      details: { fixIndex: landingIndex },
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
function detectVarioExtremes(fixes: IGCFix[]): FlightEvent[] {
  const events: FlightEvent[] = [];
  const windowSize = 10; // Average over 10 fixes for smoother values

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

  if (maxClimb > 0.5) {
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

  if (maxSink < -1) {
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

/**
 * Main function to detect all flight events
 */
export function detectFlightEvents(
  fixes: IGCFix[],
  task?: XCTask
): FlightEvent[] {
  const allEvents: FlightEvent[] = [];

  // IMPORTANT: Detect takeoff and landing FIRST
  // All other events should only be detected after takeoff
  const takeoffLandingEvents = detectTakeoffLanding(fixes);
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
  const thermals = detectThermals(flightFixes);

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
  const glides = detectGlides(flightFixes, thermals);

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

  // Detect altitude extremes (only after takeoff)
  const altitudeEvents = detectAltitudeExtremes(flightFixes);
  // Adjust indices in altitude extreme events
  for (const event of altitudeEvents) {
    const adjustedEvent = {
      ...event,
      // Time is already correct from flightFixes, no need to adjust
    };
    allEvents.push(adjustedEvent);
  }

  // Detect vario extremes (only after takeoff)
  const varioEvents = detectVarioExtremes(flightFixes);
  // Vario events already have correct time from flightFixes
  allEvents.push(...varioEvents);

  // Detect turnpoint crossings and scored reachings if task is provided (only after takeoff)
  if (task) {
    const turnpointEvents = detectTurnpointEvents(flightFixes, task);
    allEvents.push(...turnpointEvents);
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

/**
 * Get event icon/color based on type
 */
export function getEventStyle(type: FlightEventType): {
  icon: string;
  color: string;
} {
  switch (type) {
    case 'takeoff':
      return { icon: 'plane-departure', color: '#22c55e' };
    case 'landing':
      return { icon: 'plane-arrival', color: '#ef4444' };
    case 'thermal_entry':
      return { icon: 'arrow-up', color: '#f97316' };
    case 'thermal_exit':
      return { icon: 'arrow-down', color: '#f97316' };
    case 'glide_start':
      return { icon: 'arrow-right', color: '#3b82f6' };
    case 'glide_end':
      return { icon: 'arrow-right', color: '#3b82f6' };
    case 'turnpoint_entry':
      return { icon: 'map-pin', color: '#a855f7' };
    case 'turnpoint_exit':
      return { icon: 'map-pin', color: '#a855f7' };
    case 'start_crossing':
      return { icon: 'flag', color: '#22c55e' };
    case 'goal_crossing':
      return { icon: 'trophy', color: '#eab308' };
    case 'start_reaching':
      return { icon: 'flag', color: '#16a34a' };
    case 'turnpoint_reaching':
      return { icon: 'check-circle', color: '#7c3aed' };
    case 'ess_reaching':
      return { icon: 'check-circle', color: '#dc2626' };
    case 'goal_reaching':
      return { icon: 'trophy', color: '#ca8a04' };
    case 'max_altitude':
      return { icon: 'mountain', color: '#06b6d4' };
    case 'min_altitude':
      return { icon: 'valley', color: '#64748b' };
    case 'max_climb':
      return { icon: 'trending-up', color: '#22c55e' };
    case 'max_sink':
      return { icon: 'trending-down', color: '#ef4444' };
    default:
      return { icon: 'circle', color: '#64748b' };
  }
}
