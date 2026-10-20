/**
 * Flight-phase detection: thermals and glides.
 *
 * A flight alternates between climbing in thermals and gliding between them.
 * This module detects both phases from the (post-takeoff) fix array and turns
 * each detected segment into its pair of boundary FlightEvents.
 */

import { IGCFix, fixAltitude } from './igc-parser';
import { calculateTrackDistance } from './geo';
import type { DetectionThresholds } from './thresholds';
import type {
  FlightEvent,
  ThermalSegment,
  GlideSegment,
  ThermalEventDetails,
} from './event-types';

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
  // fixAltitude, not raw gnssAltitude: a zero-GNSS dropout fix on a segment
  // boundary would otherwise record an entry/exit at sea level and poison
  // every downstream consumer (the task-analysis working band is a p10 over
  // exactly these values).
  const altGain = fixAltitude(fixes[endIndex]) - fixAltitude(fixes[startIndex]);

  return {
    startIndex,
    endIndex,
    startAltitude: fixAltitude(fixes[startIndex]),
    endAltitude: fixAltitude(fixes[endIndex]),
    avgClimbRate: altGain / duration,
    duration,
    location: { lat: sumLat / count, lon: sumLon / count },
  };
}

// Internal smoothing parameters of the thermal state machine. Deliberately
// NOT part of the DetectionThresholds model: they shape how the climb signal
// is read, not what counts as a thermal, so they are not user-tunable.
//
// Both are measured in SECONDS, never in fixes. They used to be 10 fixes and
// 3 fixes, which is 10 s and 3 s at 1 Hz but 100 s and 30 s on a 10 s logger:
// the same flight then split into different thermals, and the metrics built
// on them (exit decay, dolphin share, search share, time to core…) moved a
// real 5–10 s logger by 30–55 percentile points against a 1 Hz field. On an
// evenly spaced 1 Hz track the rules below are exactly the old ones. See
// docs/2026-10-20-logger-interval-evidence.md.

/** Span of the trailing climb-rate averaging window. */
const THERMAL_WINDOW_MS = 10_000;

/**
 * A thermal ends after THERMAL_EXIT_WINDOWS consecutive below-threshold
 * windows, or sooner once two of them already span THERMAL_EXIT_SPAN_MS —
 * at 1 Hz both read "weak for 2 s", while on a coarse log three windows
 * would stretch the exit to tens of seconds.
 */
const THERMAL_EXIT_WINDOWS = 3;
const THERMAL_EXIT_SPAN_MS = 2_000;

/**
 * Detect thermal segments in the flight
 * A thermal is detected when:
 * - Average climb rate > 0.5 m/s
 * - Duration > 20 seconds
 * - Relatively circular path (not a straight glide)
 */
export function detectThermals(fixes: IGCFix[], thresholds: DetectionThresholds): ThermalSegment[] {
  const thermals: ThermalSegment[] = [];
  const minClimbRate = thresholds.thermal.minClimbRate;
  const minDuration = thresholds.thermal.minThermalDuration;
  const timeMs = (k: number) => fixes[k].time.getTime();

  let inThermal = false;
  let thermalStart = 0;
  let belowStart = -1; // First fix of the current run of below-threshold windows
  let belowCount = 0; // Length of that run
  let lastThermalEnd = -1; // Track the end of the last thermal to prevent overlaps
  let windowStart = 0;

  for (let i = 1; i < fixes.length; i++) {
    if (timeMs(i) - timeMs(0) < THERMAL_WINDOW_MS) continue;
    // The shortest run of fixes ending at i that spans the window.
    while (windowStart + 1 < i && timeMs(i) - timeMs(windowStart + 1) >= THERMAL_WINDOW_MS) {
      windowStart++;
    }
    const totalTime = (timeMs(i) - timeMs(windowStart)) / 1000;
    const avgClimb =
      totalTime > 0 ? (fixAltitude(fixes[i]) - fixAltitude(fixes[windowStart])) / totalTime : 0;

    if (!inThermal && avgClimb > minClimbRate) {
      // Entering thermal - but only if we're past the last thermal's end
      // and at least minGapDuration seconds have passed
      const potentialStart = windowStart;
      const minGapDuration = thresholds.thermal.minThermalGap;
      const timeSinceLastThermal = lastThermalEnd >= 0
        ? (timeMs(potentialStart) - timeMs(lastThermalEnd)) / 1000
        : Infinity;

      if (potentialStart > lastThermalEnd && timeSinceLastThermal >= minGapDuration) {
        inThermal = true;
        thermalStart = potentialStart;
        belowStart = -1;
        belowCount = 0;
      }
    } else if (inThermal) {
      if (avgClimb <= minClimbRate) {
        if (belowStart < 0) belowStart = i;
        belowCount++;

        if (
          belowCount >= THERMAL_EXIT_WINDOWS ||
          (belowCount >= 2 && timeMs(i) - timeMs(belowStart) >= THERMAL_EXIT_SPAN_MS)
        ) {
          // The thermal ends on the last fix before the weak run began.
          const thermalEnd = Math.max(thermalStart, belowStart - 1);
          const duration = (timeMs(thermalEnd) - timeMs(thermalStart)) / 1000;

          if (duration >= minDuration) {
            const segment = buildThermalSegment(fixes, thermalStart, thermalEnd);
            if (segment) {
              thermals.push(segment);
              lastThermalEnd = thermalEnd;
            }
          }

          inThermal = false;
          belowStart = -1;
          belowCount = 0;
        }
      } else {
        belowStart = -1;
        belowCount = 0;
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
  // Same zero-GNSS guard as buildThermalSegment — glideRatio divides by this.
  const altLoss = fixAltitude(fixes[startIdx]) - fixAltitude(fixes[endIdx]);

  return {
    startIndex: startIdx,
    endIndex: endIdx,
    startAltitude: fixAltitude(fixes[startIdx]),
    endAltitude: fixAltitude(fixes[endIdx]),
    distance: totalDist,
    // undefined (not Infinity) when altitude was gained: Infinity survives into
    // display text and becomes null through JSON.stringify across worker/cache
    // boundaries — matches the glide-speed.ts convention
    glideRatio: altLoss > 0 ? totalDist / altLoss : undefined,
    duration,
  };
}

/**
 * Detect glide segments between thermals
 */
export function detectGlides(fixes: IGCFix[], thermals: ThermalSegment[], thresholds: DetectionThresholds): GlideSegment[] {
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
 * Entry + exit events for one detected thermal. Indices are shifted by
 * `indexOffset` back into the original (pre-takeoff-slice) fix array.
 */
export function thermalToEvents(
  thermal: ThermalSegment,
  indexOffset: number,
  fixes: IGCFix[],
): FlightEvent[] {
  const startIndex = thermal.startIndex + indexOffset;
  const endIndex = thermal.endIndex + indexOffset;
  const altitudeGain = thermal.endAltitude - thermal.startAltitude;
  // Entry/exit events sit on the track's boundary fixes (like glide events)
  // so the markers land where the pilot actually entered and left the climb;
  // the thermal's mean position stays available as ThermalSegment.location.
  const details: ThermalEventDetails = {
    avgClimbRate: thermal.avgClimbRate,
    duration: thermal.duration,
    altitudeGain,
  };
  const segment = { startIndex, endIndex };
  return [
    {
      id: `thermal-entry-${startIndex}`,
      type: 'thermal_entry',
      time: fixes[startIndex].time,
      latitude: fixes[startIndex].latitude,
      longitude: fixes[startIndex].longitude,
      altitude: thermal.startAltitude,
      description: `Thermal entry (${thermal.avgClimbRate > 0 ? '+' : ''}${thermal.avgClimbRate.toFixed(1)}m/s avg)`,
      details,
      segment,
    },
    {
      id: `thermal-exit-${endIndex}`,
      type: 'thermal_exit',
      time: fixes[endIndex].time,
      latitude: fixes[endIndex].latitude,
      longitude: fixes[endIndex].longitude,
      altitude: thermal.endAltitude,
      description: `Thermal exit (${altitudeGain > 0 ? '+' : ''}${altitudeGain.toFixed(0)}m gained)`,
      details,
      segment,
    },
  ];
}

/** Start + end events for one detected glide. */
export function glideToEvents(
  glide: GlideSegment,
  indexOffset: number,
  fixes: IGCFix[],
): FlightEvent[] {
  const startIndex = glide.startIndex + indexOffset;
  const endIndex = glide.endIndex + indexOffset;
  const averageSpeed = glide.duration > 0 ? glide.distance / glide.duration : 0;
  const segment = { startIndex, endIndex };
  return [
    {
      id: `glide-start-${startIndex}`,
      type: 'glide_start',
      time: fixes[startIndex].time,
      latitude: fixes[startIndex].latitude,
      longitude: fixes[startIndex].longitude,
      altitude: glide.startAltitude,
      description: glide.glideRatio !== undefined
        ? `Glide start (L/D ${glide.glideRatio.toFixed(0)})`
        : 'Glide start (altitude gained)',
      details: {
        distance: glide.distance,
        glideRatio: glide.glideRatio,
        duration: glide.duration,
        averageSpeed,
      },
      segment,
    },
    {
      id: `glide-end-${endIndex}`,
      type: 'glide_end',
      time: fixes[endIndex].time,
      latitude: fixes[endIndex].latitude,
      longitude: fixes[endIndex].longitude,
      altitude: glide.endAltitude,
      description: `Glide end (${(glide.distance / 1000).toFixed(2)}km)`,
      details: {
        distance: glide.distance,
        glideRatio: glide.glideRatio,
        altitudeLost: glide.startAltitude - glide.endAltitude,
        averageSpeed,
      },
      segment,
    },
  ];
}
