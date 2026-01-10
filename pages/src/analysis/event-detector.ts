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

import { IGCFix, haversineDistance } from './igc-parser';
import { XCTask, Turnpoint } from './xctsk-parser';

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
  | 'max_altitude'
  | 'min_altitude'
  | 'max_climb'
  | 'max_sink';

export interface FlightEvent {
  id: string;
  type: FlightEventType;
  time: Date;
  latitude: number;
  longitude: number;
  altitude: number;
  description: string;
  details?: Record<string, unknown>;
}

export interface ThermalSegment {
  startIndex: number;
  endIndex: number;
  startAltitude: number;
  endAltitude: number;
  avgClimbRate: number;
  duration: number;
  location: { lat: number; lon: number };
}

export interface GlideSegment {
  startIndex: number;
  endIndex: number;
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
 * Check if a point is inside a cylinder
 */
function isInsideCylinder(
  lat: number,
  lon: number,
  centerLat: number,
  centerLon: number,
  radius: number
): boolean {
  const distance = haversineDistance(lat, lon, centerLat, centerLon);
  return distance <= radius;
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
      // Entering thermal
      inThermal = true;
      thermalStart = i - windowSize;
    } else if (inThermal && avgClimb <= 0) {
      // Exiting thermal
      const thermalEnd = i;
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

      inThermal = false;
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
      const endIdx = thermal.startIndex;

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

  return glides;
}

/**
 * Detect turnpoint cylinder crossings
 */
function detectTurnpointCrossings(
  fixes: IGCFix[],
  task: XCTask
): FlightEvent[] {
  const events: FlightEvent[] = [];

  for (let tpIdx = 0; tpIdx < task.turnpoints.length; tpIdx++) {
    const tp = task.turnpoints[tpIdx];
    let wasInside = false;
    let entryDetected = false;

    for (let i = 0; i < fixes.length; i++) {
      const fix = fixes[i];
      const inside = isInsideCylinder(
        fix.latitude,
        fix.longitude,
        tp.waypoint.lat,
        tp.waypoint.lon,
        tp.radius
      );

      if (inside && !wasInside) {
        // Entry into cylinder
        const eventType = tp.type === 'SSS' ? 'start_crossing' :
                         (tpIdx === task.turnpoints.length - 1 ? 'goal_crossing' : 'turnpoint_entry');

        events.push({
          id: `tp-entry-${tpIdx}-${i}`,
          type: eventType,
          time: fix.time,
          latitude: fix.latitude,
          longitude: fix.longitude,
          altitude: fix.gnssAltitude,
          description: `Entered ${tp.waypoint.name} (${tp.type || 'TP' + (tpIdx + 1)})`,
          details: {
            turnpointIndex: tpIdx,
            turnpointName: tp.waypoint.name,
            radius: tp.radius,
          },
        });
        entryDetected = true;
      } else if (!inside && wasInside && entryDetected) {
        // Exit from cylinder
        events.push({
          id: `tp-exit-${tpIdx}-${i}`,
          type: 'turnpoint_exit',
          time: fix.time,
          latitude: fix.latitude,
          longitude: fix.longitude,
          altitude: fix.gnssAltitude,
          description: `Exited ${tp.waypoint.name}`,
          details: {
            turnpointIndex: tpIdx,
            turnpointName: tp.waypoint.name,
          },
        });
      }

      wasInside = inside;
    }
  }

  return events;
}

/**
 * Detect takeoff and landing
 */
function detectTakeoffLanding(fixes: IGCFix[]): FlightEvent[] {
  const events: FlightEvent[] = [];

  if (fixes.length < 10) return events;

  // Find takeoff - first point where ground speed > 5 m/s
  for (let i = 1; i < fixes.length; i++) {
    const speed = calculateGroundSpeed(fixes[i - 1], fixes[i]);
    if (speed > 5) {
      events.push({
        id: 'takeoff',
        type: 'takeoff',
        time: fixes[i].time,
        latitude: fixes[i].latitude,
        longitude: fixes[i].longitude,
        altitude: fixes[i].gnssAltitude,
        description: 'Takeoff',
        details: { groundSpeed: speed },
      });
      break;
    }
  }

  // Find landing - last point where ground speed > 5 m/s
  for (let i = fixes.length - 1; i > 0; i--) {
    const speed = calculateGroundSpeed(fixes[i - 1], fixes[i]);
    if (speed > 5) {
      events.push({
        id: 'landing',
        type: 'landing',
        time: fixes[i].time,
        latitude: fixes[i].latitude,
        longitude: fixes[i].longitude,
        altitude: fixes[i].gnssAltitude,
        description: 'Landing',
        details: { groundSpeed: speed },
      });
      break;
    }
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
    description: `Max altitude: ${maxAlt}m`,
  });

  events.push({
    id: 'min-altitude',
    type: 'min_altitude',
    time: fixes[minAltIdx].time,
    latitude: fixes[minAltIdx].latitude,
    longitude: fixes[minAltIdx].longitude,
    altitude: minAlt,
    description: `Min altitude: ${minAlt}m`,
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
      description: `Max climb: ${maxClimb.toFixed(1)} m/s`,
      details: { climbRate: maxClimb },
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
      description: `Max sink: ${maxSink.toFixed(1)} m/s`,
      details: { sinkRate: maxSink },
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

  // Detect thermals
  const thermals = detectThermals(fixes);

  for (const thermal of thermals) {
    allEvents.push({
      id: `thermal-entry-${thermal.startIndex}`,
      type: 'thermal_entry',
      time: fixes[thermal.startIndex].time,
      latitude: thermal.location.lat,
      longitude: thermal.location.lon,
      altitude: thermal.startAltitude,
      description: `Thermal entry (+${thermal.avgClimbRate.toFixed(1)} m/s avg)`,
      details: {
        avgClimbRate: thermal.avgClimbRate,
        duration: thermal.duration,
        altitudeGain: thermal.endAltitude - thermal.startAltitude,
      },
    });

    allEvents.push({
      id: `thermal-exit-${thermal.endIndex}`,
      type: 'thermal_exit',
      time: fixes[thermal.endIndex].time,
      latitude: thermal.location.lat,
      longitude: thermal.location.lon,
      altitude: thermal.endAltitude,
      description: `Thermal exit (${thermal.endAltitude - thermal.startAltitude}m gained)`,
      details: {
        avgClimbRate: thermal.avgClimbRate,
        duration: thermal.duration,
        altitudeGain: thermal.endAltitude - thermal.startAltitude,
      },
    });
  }

  // Detect glides
  const glides = detectGlides(fixes, thermals);

  for (const glide of glides) {
    allEvents.push({
      id: `glide-start-${glide.startIndex}`,
      type: 'glide_start',
      time: fixes[glide.startIndex].time,
      latitude: fixes[glide.startIndex].latitude,
      longitude: fixes[glide.startIndex].longitude,
      altitude: glide.startAltitude,
      description: `Glide start (L/D ${glide.glideRatio.toFixed(0)})`,
      details: {
        distance: glide.distance,
        glideRatio: glide.glideRatio,
        duration: glide.duration,
      },
    });

    allEvents.push({
      id: `glide-end-${glide.endIndex}`,
      type: 'glide_end',
      time: fixes[glide.endIndex].time,
      latitude: fixes[glide.endIndex].latitude,
      longitude: fixes[glide.endIndex].longitude,
      altitude: glide.endAltitude,
      description: `Glide end (${(glide.distance / 1000).toFixed(1)}km)`,
      details: {
        distance: glide.distance,
        glideRatio: glide.glideRatio,
        altitudeLost: glide.startAltitude - glide.endAltitude,
      },
    });
  }

  // Detect takeoff and landing
  allEvents.push(...detectTakeoffLanding(fixes));

  // Detect altitude extremes
  allEvents.push(...detectAltitudeExtremes(fixes));

  // Detect vario extremes
  allEvents.push(...detectVarioExtremes(fixes));

  // Detect turnpoint crossings if task is provided
  if (task) {
    allEvents.push(...detectTurnpointCrossings(fixes, task));
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
