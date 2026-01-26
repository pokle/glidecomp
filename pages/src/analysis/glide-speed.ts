/**
 * Glide Speed Calculation Utilities
 *
 * Calculates speed labels and chevron positions for glide segment visualization.
 */

import type { IGCFix } from './igc-parser';
import { haversineDistance, calculateBearing } from './geo';

// Re-export for backwards compatibility
export { haversineDistance, calculateBearing };

export interface ChevronPosition {
  lat: number;
  lon: number;
  bearing: number;
  time: number; // timestamp in ms
  distance: number; // cumulative distance in meters
  altitude: number; // altitude in meters (gnssAltitude)
}

export interface GlideMarker {
  type: 'chevron' | 'speed-label';
  lat: number;
  lon: number;
  bearing: number;
  speedMps?: number; // speed in m/s, only for speed-label type
  glideRatio?: number; // L/D ratio for the segment (only for speed-label type)
  altitudeDiff?: number; // altitude change in meters for the segment (negative = descent, only for speed-label type)
}

/**
 * Calculate positions along a glide segment at regular intervals.
 * Returns positions at every `interval` meters (e.g., 250m).
 */
export function calculateGlidePositions(
  fixes: IGCFix[],
  interval: number
): ChevronPosition[] {
  if (fixes.length < 2) {
    return [];
  }

  const positions: ChevronPosition[] = [];
  let cumulativeDistance = 0;
  let nextPositionDistance = interval;

  for (let i = 1; i < fixes.length; i++) {
    const prevFix = fixes[i - 1];
    const currFix = fixes[i];

    const segmentDistance = haversineDistance(
      prevFix.latitude,
      prevFix.longitude,
      currFix.latitude,
      currFix.longitude
    );

    const prevTime = prevFix.time.getTime();
    const currTime = currFix.time.getTime();

    const prevCumulativeDistance = cumulativeDistance;
    cumulativeDistance += segmentDistance;

    // Collect positions at each interval
    // Use small epsilon (0.1m) to handle floating point precision at exact boundaries
    while (cumulativeDistance >= nextPositionDistance - 0.1) {
      // Interpolate position along the segment
      const overshoot = cumulativeDistance - nextPositionDistance;
      // Clamp t to [0, 1] to handle boundary conditions
      const t = Math.max(0, Math.min(1, 1 - (overshoot / segmentDistance)));
      const posLat = prevFix.latitude + t * (currFix.latitude - prevFix.latitude);
      const posLon = prevFix.longitude + t * (currFix.longitude - prevFix.longitude);
      const posTime = prevTime + t * (currTime - prevTime);
      const posAltitude = prevFix.gnssAltitude + t * (currFix.gnssAltitude - prevFix.gnssAltitude);

      // Calculate local bearing at this point
      const bearing = calculateBearing(
        prevFix.latitude,
        prevFix.longitude,
        currFix.latitude,
        currFix.longitude
      );

      positions.push({
        lat: posLat,
        lon: posLon,
        bearing,
        time: posTime,
        distance: nextPositionDistance,
        altitude: posAltitude,
      });

      nextPositionDistance += interval;

      // Prevent infinite loop if we've gone past the cumulative distance
      if (nextPositionDistance > cumulativeDistance + 0.1) {
        break;
      }
    }
  }

  return positions;
}

/**
 * Calculate glide markers (chevrons and speed labels) for a glide segment.
 *
 * Layout:
 * - Speed labels at 250m, 750m, 1250m, ... (showing speed for the 500m segment)
 * - Chevrons at 500m, 1000m, 1500m, ...
 *
 * Speed calculation:
 * - Each speed label shows the average speed for its 500m segment
 * - First label (250m): speed from 0m to 500m (or to end if shorter)
 * - Second label (750m): speed from 500m to 1000m
 * - etc.
 *
 * Glide ratio and altitude:
 * - Each speed label also shows the glide ratio (L/D) for the segment
 * - Glide ratio = horizontal distance / altitude lost
 * - Altitude difference shows the altitude change (negative = descent)
 *
 * @param fixes - Array of IGC fixes for the glide segment
 * @returns Array of markers with positions, speeds, glide ratios, and altitude differences
 */
export function calculateGlideMarkers(fixes: IGCFix[]): GlideMarker[] {
  const LABEL_INTERVAL = 250; // meters
  const CHEVRON_INTERVAL = 500; // meters

  // Get positions at 250m intervals
  const positions = calculateGlidePositions(fixes, LABEL_INTERVAL);

  if (positions.length === 0) {
    return [];
  }

  const markers: GlideMarker[] = [];
  const startTime = fixes[0].time.getTime();
  const startAltitude = fixes[0].gnssAltitude;

  for (let i = 0; i < positions.length; i++) {
    const pos = positions[i];
    const isLabel = (i % 2 === 0); // 250m, 750m, 1250m, etc. (indices 0, 2, 4, ...)

    if (isLabel) {
      // Calculate speed for the 500m segment that this label is in the middle of
      // Segment boundaries: 0-500m, 500-1000m, 1000-1500m, etc.
      // Label at 250m covers segment 0-500m
      // Label at 750m covers segment 500-1000m
      // etc.

      // Get time at start of segment (previous chevron, or start of glide)
      const segmentStartTime = (i === 0) ? startTime : positions[i - 1].time;

      // Get time at end of segment (next chevron)
      const segmentEndTime = (i + 1 < positions.length) ? positions[i + 1].time : pos.time;

      const timeDiffSeconds = (segmentEndTime - segmentStartTime) / 1000;

      // Get altitude at start of segment (previous chevron, or start of glide)
      const segmentStartAltitude = (i === 0) ? startAltitude : positions[i - 1].altitude;

      // Get altitude at end of segment (next chevron, or current pos if no next)
      const segmentEndAltitude = (i + 1 < positions.length) ? positions[i + 1].altitude : pos.altitude;

      // Altitude difference (negative = descent)
      const altitudeDiff = segmentEndAltitude - segmentStartAltitude;

      // Calculate actual distance for this segment
      // If we have both start and end positions, it's a full 500m segment
      // Otherwise, it's a partial segment
      let segmentDistance: number;
      if (i === 0) {
        // First segment: from 0 to the chevron (or label if no chevron)
        segmentDistance = (i + 1 < positions.length) ? positions[i + 1].distance : pos.distance;
      } else {
        // Subsequent segments: from previous chevron to next chevron (or current pos if no next)
        const startDist = positions[i - 1].distance;
        const endDist = (i + 1 < positions.length) ? positions[i + 1].distance : pos.distance;
        segmentDistance = endDist - startDist;
      }

      let speedMps = 0;
      if (timeDiffSeconds > 0 && segmentDistance > 0) {
        speedMps = segmentDistance / timeDiffSeconds; // m/s
      }

      // Calculate glide ratio (L/D) = horizontal distance / altitude lost
      // Only calculate if descending (altitude lost > 0)
      let glideRatio: number | undefined;
      const altitudeLost = -altitudeDiff; // Convert to positive value for descent
      if (altitudeLost > 0 && segmentDistance > 0) {
        glideRatio = segmentDistance / altitudeLost;
      }

      markers.push({
        type: 'speed-label',
        lat: pos.lat,
        lon: pos.lon,
        bearing: pos.bearing,
        speedMps,
        glideRatio,
        altitudeDiff: Math.round(altitudeDiff),
      });
    } else {
      // Chevron at 500m, 1000m, 1500m, etc. (indices 1, 3, 5, ...)
      markers.push({
        type: 'chevron',
        lat: pos.lat,
        lon: pos.lon,
        bearing: pos.bearing,
      });
    }
  }

  return markers;
}

/**
 * Get the total distance of a glide segment in meters
 */
export function calculateTotalGlideDistance(fixes: IGCFix[]): number {
  if (fixes.length < 2) {
    return 0;
  }

  let totalDistance = 0;
  for (let i = 1; i < fixes.length; i++) {
    totalDistance += haversineDistance(
      fixes[i - 1].latitude,
      fixes[i - 1].longitude,
      fixes[i].latitude,
      fixes[i].longitude
    );
  }
  return totalDistance;
}
