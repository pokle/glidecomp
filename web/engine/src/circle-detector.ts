/**
 * Circle Detector
 *
 * Detects circular flight (thermalling) using bearing rate analysis and
 * cumulative heading change. Generates per-circle metrics including fitted
 * center/radius, climb rate, quality, strongest lift direction, and wind
 * estimates.
 *
 * Algorithm pipeline:
 * 1. Compute bearing rates using lookback window
 * 2. Detect circling segments via XCSoar-style 4-state machine
 * 3. Extract individual 360-degree circles within each segment
 * 4. Compute per-circle metrics (circle fit, wind, quality, etc.)
 *
 * Based on research in docs/event-detection/circling-flight-and-thermal-analysis-research.md
 */

import { IGCFix } from './igc-parser';
import { calculateBearing, andoyerDistance } from './geo';
import { TrackSegment } from './event-detector';

// --- Constants ---

/** Maximum plausible bearing rate (deg/s). Anything beyond this is a GPS spike. */
const MAX_BEARING_RATE = 50;

/** Maximum reasonable wind speed (m/s) — reject estimates above this. */
const MAX_REASONABLE_WIND_SPEED = 30;

/** Approximate meters per degree of latitude at the Earth's surface. */
const METERS_PER_DEGREE_LAT = 111320;

/** Minimum ground speed variation (m/s) needed for a meaningful wind estimate. */
const MIN_GROUND_SPEED_VARIATION = 1;

// --- Types ---

export type TurnDirection = 'left' | 'right';

export type CirclingState = 'CRUISE' | 'POSSIBLE_CLIMB' | 'CLIMB' | 'POSSIBLE_CRUISE';

export interface CirclingSegment extends TrackSegment {
  avgTurnRate: number;
  duration: number;
}

export interface FittedCircle {
  centerLat: number;
  centerLon: number;
  radiusMeters: number;
  fitErrorRMS: number;
}

export interface WindEstimate {
  speed: number;       // m/s
  direction: number;   // degrees, direction wind is FROM
  method: string;
}

export interface CircleSegment extends TrackSegment {
  turnDirection: TurnDirection;
  duration: number;
  climbRate: number;
  fittedCircle: FittedCircle;
  quality: number;                    // 0-1, fraction of fix intervals with positive vario
  strongestLiftBearing: number;       // degrees from fitted center to max-climb fix
  strongestLiftFixIndex: number;
  windFromGroundSpeed?: WindEstimate;
  windFromCenterDrift?: WindEstimate;
  circleNumber: number;               // 1-based within parent circling segment
  circlingSegmentIndex: number;        // index of parent circling segment
}

export interface CircleDetectionResult {
  circlingSegments: CirclingSegment[];
  circles: CircleSegment[];
  bearingRates: number[];
}

export interface CircleDetectionOptions {
  lookbackSeconds?: number;    // default 5
  minTurnRate?: number;        // default 4.0 deg/s
  t1Seconds?: number;          // default 8  (CRUISE -> CLIMB transition delay)
  t2Seconds?: number;          // default 15 (CLIMB -> CRUISE transition delay)
  minFixesPerCircle?: number;  // default 8
  maxBearingRate?: number;     // default 50 deg/s
  maxReasonableWindSpeed?: number;  // default 30 m/s
  minGroundSpeedVariation?: number; // default 1 m/s
}

// --- Exported helpers ---

/**
 * Normalize a bearing delta to the range [-180, 180].
 */
export function normalizeBearingDelta(delta: number): number {
  let d = delta % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/**
 * Compute bearing rates for each fix using a lookback window.
 *
 * For each fix i, find the fix at least `lookbackSeconds` earlier.
 * Compute bearing at both points using calculateBearing from geo.ts.
 * Rate = normalizeBearingDelta(bearing_current - bearing_lookback) / dt.
 * Clamp to [-50, 50] deg/s to reject GPS spikes.
 */
export function computeBearingRates(
  fixes: IGCFix[],
  lookbackSeconds: number = 5,
  maxBearingRateLimit: number = MAX_BEARING_RATE
): number[] {
  const rates: number[] = new Array(fixes.length).fill(0);

  if (fixes.length < 3) return rates;

  for (let i = 2; i < fixes.length; i++) {
    // Find the fix at least lookbackSeconds before fix i
    const targetTime = fixes[i].time.getTime() - lookbackSeconds * 1000;
    let j = i - 1;
    while (j > 0 && fixes[j].time.getTime() > targetTime) {
      j--;
    }

    // We need at least one fix before j and one before i for bearings
    if (j < 1 || i < 1) continue;

    const dt = (fixes[i].time.getTime() - fixes[j].time.getTime()) / 1000;
    if (dt < 1) continue;

    // Bearing at fix j (using j-1 -> j)
    const bearingAtJ = calculateBearing(
      fixes[j - 1].latitude, fixes[j - 1].longitude,
      fixes[j].latitude, fixes[j].longitude
    );

    // Bearing at fix i (using i-1 -> i)
    const bearingAtI = calculateBearing(
      fixes[i - 1].latitude, fixes[i - 1].longitude,
      fixes[i].latitude, fixes[i].longitude
    );

    const delta = normalizeBearingDelta(bearingAtI - bearingAtJ);
    let rate = delta / dt;

    // Clamp to reject GPS spikes
    if (rate > maxBearingRateLimit) rate = maxBearingRateLimit;
    if (rate < -maxBearingRateLimit) rate = -maxBearingRateLimit;

    rates[i] = rate;
  }

  return rates;
}

/**
 * Detect circling segments using XCSoar-style 4-state machine.
 *
 * States: CRUISE -> POSSIBLE_CLIMB -> CLIMB -> POSSIBLE_CRUISE -> CRUISE
 */
export function detectCirclingSegments(
  fixes: IGCFix[],
  bearingRates: number[],
  minTurnRate: number = 4.0,
  t1Seconds: number = 8,
  t2Seconds: number = 15
): CirclingSegment[] {
  const segments: CirclingSegment[] = [];

  if (fixes.length < 3) return segments;

  let state: CirclingState = 'CRUISE';
  let possibleStartIndex = 0;
  let possibleStartTime = 0;
  let climbStartIndex = 0;
  let possibleCruiseStartTime = 0;
  let sumTurnRate = 0;
  let turnRateCount = 0;

  for (let i = 0; i < fixes.length; i++) {
    const turning = Math.abs(bearingRates[i]) >= minTurnRate;
    const timeMs = fixes[i].time.getTime();

    switch (state) {
      case 'CRUISE':
        if (turning) {
          state = 'POSSIBLE_CLIMB';
          possibleStartIndex = i;
          possibleStartTime = timeMs;
          sumTurnRate = bearingRates[i];
          turnRateCount = 1;
        }
        break;

      case 'POSSIBLE_CLIMB':
        if (turning) {
          sumTurnRate += bearingRates[i];
          turnRateCount++;
          if ((timeMs - possibleStartTime) / 1000 >= t1Seconds) {
            state = 'CLIMB';
            climbStartIndex = possibleStartIndex;
          }
        } else {
          state = 'CRUISE';
        }
        break;

      case 'CLIMB':
        if (turning) {
          sumTurnRate += bearingRates[i];
          turnRateCount++;
        } else {
          state = 'POSSIBLE_CRUISE';
          possibleCruiseStartTime = timeMs;
        }
        break;

      case 'POSSIBLE_CRUISE':
        if (turning) {
          state = 'CLIMB';
          sumTurnRate += bearingRates[i];
          turnRateCount++;
        } else if ((timeMs - possibleCruiseStartTime) / 1000 >= t2Seconds) {
          // Emit circling segment
          const endIndex = i;
          const duration = (fixes[endIndex].time.getTime() - fixes[climbStartIndex].time.getTime()) / 1000;
          if (duration > 0 && turnRateCount > 0) {
            segments.push({
              startIndex: climbStartIndex,
              endIndex,
              avgTurnRate: sumTurnRate / turnRateCount,
              duration,
            });
          }
          state = 'CRUISE';
          sumTurnRate = 0;
          turnRateCount = 0;
        }
        break;
    }
  }

  // Handle circling that's still active at end of track
  if (state === 'CLIMB' || state === 'POSSIBLE_CRUISE') {
    const endIndex = fixes.length - 1;
    const duration = (fixes[endIndex].time.getTime() - fixes[climbStartIndex].time.getTime()) / 1000;
    if (duration > 0 && turnRateCount > 0) {
      segments.push({
        startIndex: climbStartIndex,
        endIndex,
        avgTurnRate: sumTurnRate / turnRateCount,
        duration,
      });
    }
  }

  return segments;
}

/**
 * Least-squares circle fit using the Kasa algebraic method.
 *
 * Converts lat/lon to local meters using flat-earth approximation,
 * then solves 2x2 moment matrix for center + radius.
 */
export function fitCircleLeastSquares(
  fixes: IGCFix[],
  startIndex: number,
  endIndex: number
): FittedCircle | null {
  const n = endIndex - startIndex + 1;
  if (n < 3) return null;

  // Convert to local meters relative to centroid
  let meanLat = 0, meanLon = 0;
  for (let i = startIndex; i <= endIndex; i++) {
    meanLat += fixes[i].latitude;
    meanLon += fixes[i].longitude;
  }
  meanLat /= n;
  meanLon /= n;

  // Flat-earth conversion factors
  const latToMeters = METERS_PER_DEGREE_LAT;
  const lonToMeters = METERS_PER_DEGREE_LAT * Math.cos(meanLat * Math.PI / 180);

  const xs: number[] = [];
  const ys: number[] = [];

  for (let i = startIndex; i <= endIndex; i++) {
    xs.push((fixes[i].latitude - meanLat) * latToMeters);
    ys.push((fixes[i].longitude - meanLon) * lonToMeters);
  }

  // Build moment matrices
  let Suu = 0, Svv = 0, Suv = 0;
  let Suuu = 0, Svvv = 0, Suvv = 0, Svuu = 0;

  for (let i = 0; i < n; i++) {
    const u = xs[i];
    const v = ys[i];
    Suu += u * u;
    Svv += v * v;
    Suv += u * v;
    Suuu += u * u * u;
    Svvv += v * v * v;
    Suvv += u * v * v;
    Svuu += v * u * u;
  }

  // Solve 2x2 linear system
  const denom = Suu * Svv - Suv * Suv;
  if (Math.abs(denom) < 1e-10) return null; // Degenerate case

  const uc = (Svv * (Suuu + Suvv) - Suv * (Svvv + Svuu)) / (2 * denom);
  const vc = (Suu * (Svvv + Svuu) - Suv * (Suuu + Suvv)) / (2 * denom);

  const radiusMeters = Math.sqrt(uc * uc + vc * vc + (Suu + Svv) / n);

  // Convert center back to lat/lon
  const centerLat = meanLat + uc / latToMeters;
  const centerLon = meanLon + vc / lonToMeters;

  // Compute RMS fit error
  let sumSqErr = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - uc;
    const dy = ys[i] - vc;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const err = dist - radiusMeters;
    sumSqErr += err * err;
  }
  const fitErrorRMS = Math.sqrt(sumSqErr / n);

  return { centerLat, centerLon, radiusMeters, fitErrorRMS };
}

// --- Internal helpers ---

/**
 * Extract individual 360-degree circles within circling segments.
 * Accumulates bearing changes between consecutive fixes.
 * Each time |cumulative| >= 360, emits a circle.
 */
function extractCircles(
  fixes: IGCFix[],
  circlingSegments: CirclingSegment[],
  minFixesPerCircle: number = 8,
  maxReasonableWindSpeedOpt: number = MAX_REASONABLE_WIND_SPEED,
  minGroundSpeedVariationOpt: number = MIN_GROUND_SPEED_VARIATION
): CircleSegment[] {
  const circles: CircleSegment[] = [];

  for (let segIdx = 0; segIdx < circlingSegments.length; segIdx++) {
    const segment = circlingSegments[segIdx];
    let cumulative = 0;
    let circleStartIndex = segment.startIndex;
    let fixCount = 0;
    let circleNumber = 0;

    for (let i = segment.startIndex + 1; i <= segment.endIndex; i++) {
      if (i < 1) continue;

      // Bearing between consecutive fixes
      const bearing1 = calculateBearing(
        fixes[i - 1].latitude, fixes[i - 1].longitude,
        fixes[i].latitude, fixes[i].longitude
      );
      // We need the previous bearing too
      if (i < 2) {
        fixCount++;
        continue;
      }
      const bearing0 = calculateBearing(
        fixes[i - 2].latitude, fixes[i - 2].longitude,
        fixes[i - 1].latitude, fixes[i - 1].longitude
      );

      const delta = normalizeBearingDelta(bearing1 - bearing0);
      cumulative += delta;
      fixCount++;

      if (Math.abs(cumulative) >= 360) {
        if (fixCount >= minFixesPerCircle) {
          circleNumber++;
          const circleEndIndex = i;
          const circle = buildCircle(
            fixes, circleStartIndex, circleEndIndex,
            cumulative, circleNumber, segIdx, circles,
            maxReasonableWindSpeedOpt, minGroundSpeedVariationOpt
          );
          if (circle) {
            circles.push(circle);
          }
        }
        // Subtract 360, preserving remainder and sign
        cumulative -= Math.sign(cumulative) * 360;
        circleStartIndex = i;
        fixCount = 0;
      }
    }
  }

  return circles;
}

/**
 * Build a CircleSegment with all per-circle metrics.
 */
function buildCircle(
  fixes: IGCFix[],
  startIndex: number,
  endIndex: number,
  cumulativeBearing: number,
  circleNumber: number,
  circlingSegmentIndex: number,
  previousCircles: CircleSegment[],
  maxReasonableWindSpeedOpt: number = MAX_REASONABLE_WIND_SPEED,
  minGroundSpeedVariationOpt: number = MIN_GROUND_SPEED_VARIATION
): CircleSegment | null {
  const duration = (fixes[endIndex].time.getTime() - fixes[startIndex].time.getTime()) / 1000;
  if (duration <= 0) return null;

  const turnDirection: TurnDirection = cumulativeBearing > 0 ? 'right' : 'left';

  // Climb rate
  const climbRate = (fixes[endIndex].gnssAltitude - fixes[startIndex].gnssAltitude) / duration;

  // Circle fit
  const fittedCircle = fitCircleLeastSquares(fixes, startIndex, endIndex);
  if (!fittedCircle) return null;

  // Quality: fraction of fix intervals with positive instantaneous vario
  let liftingCount = 0;
  let totalIntervals = 0;
  let maxClimb = -Infinity;
  let maxClimbFixIndex = startIndex;

  for (let i = startIndex; i < endIndex; i++) {
    const dt = (fixes[i + 1].time.getTime() - fixes[i].time.getTime()) / 1000;
    if (dt <= 0) continue;
    const vario = (fixes[i + 1].gnssAltitude - fixes[i].gnssAltitude) / dt;
    totalIntervals++;
    if (vario > 0) liftingCount++;
    if (vario > maxClimb) {
      maxClimb = vario;
      maxClimbFixIndex = i;
    }
  }
  const quality = totalIntervals > 0 ? liftingCount / totalIntervals : 0;

  // Strongest lift bearing: from fitted center to max-climb fix
  const strongestLiftBearing = calculateBearing(
    fittedCircle.centerLat, fittedCircle.centerLon,
    fixes[maxClimbFixIndex].latitude, fixes[maxClimbFixIndex].longitude
  );

  // Wind from ground speed (per-circle)
  const windFromGroundSpeed = estimateWindFromGroundSpeed(
    fixes, startIndex, endIndex, maxReasonableWindSpeedOpt, minGroundSpeedVariationOpt
  );

  // Wind from center drift (between consecutive circles in same segment)
  let windFromCenterDrift: WindEstimate | undefined;
  const prevCircle = findPreviousCircleInSegment(previousCircles, circlingSegmentIndex);
  if (prevCircle) {
    windFromCenterDrift = estimateWindFromCenterDrift(
      fixes, prevCircle, fittedCircle,
      prevCircle.startIndex, prevCircle.endIndex,
      startIndex, endIndex,
      maxReasonableWindSpeedOpt
    );
  }

  return {
    startIndex,
    endIndex,
    turnDirection,
    duration,
    climbRate,
    fittedCircle,
    quality,
    strongestLiftBearing,
    strongestLiftFixIndex: maxClimbFixIndex,
    windFromGroundSpeed,
    windFromCenterDrift,
    circleNumber,
    circlingSegmentIndex,
  };
}

/**
 * Find the previous circle in the same circling segment.
 */
function findPreviousCircleInSegment(
  circles: CircleSegment[],
  segmentIndex: number
): CircleSegment | undefined {
  for (let i = circles.length - 1; i >= 0; i--) {
    if (circles[i].circlingSegmentIndex === segmentIndex) {
      return circles[i];
    }
  }
  return undefined;
}

/**
 * Estimate wind from ground speed variation within a circle.
 * wind_speed = (GS_max - GS_min) / 2
 * wind_direction = track_at_GS_max + 180 (wind blows FROM the direction you were heading when fastest)
 */
function estimateWindFromGroundSpeed(
  fixes: IGCFix[],
  startIndex: number,
  endIndex: number,
  maxWindSpeed: number = MAX_REASONABLE_WIND_SPEED,
  minGSVariation: number = MIN_GROUND_SPEED_VARIATION
): WindEstimate | undefined {
  let maxGS = -Infinity;
  let minGS = Infinity;
  let maxGSIndex = startIndex;

  for (let i = startIndex; i < endIndex; i++) {
    const dt = (fixes[i + 1].time.getTime() - fixes[i].time.getTime()) / 1000;
    if (dt <= 0) continue;
    const dist = andoyerDistance(
      fixes[i].latitude, fixes[i].longitude,
      fixes[i + 1].latitude, fixes[i + 1].longitude
    );
    const gs = dist / dt;
    if (gs > maxGS) {
      maxGS = gs;
      maxGSIndex = i;
    }
    if (gs < minGS) {
      minGS = gs;
    }
  }

  if (maxGS === -Infinity || minGS === Infinity) return undefined;

  const variation = maxGS - minGS;
  if (variation < minGSVariation) return undefined; // Too little variation to be meaningful

  const speed = variation / 2;
  if (speed > maxWindSpeed) return undefined; // Reject unreasonable wind speeds

  // Track bearing at max ground speed point
  const trackBearing = calculateBearing(
    fixes[maxGSIndex].latitude, fixes[maxGSIndex].longitude,
    fixes[maxGSIndex + 1].latitude, fixes[maxGSIndex + 1].longitude
  );

  // Wind direction is FROM: track_at_max_GS + 180
  let direction = normalizeBearingDelta(trackBearing + 180);
  // Convert to 0-360 range
  if (direction < 0) direction += 360;

  return { speed, direction, method: 'ground_speed' };
}

/**
 * Estimate wind from drift between consecutive circle centers.
 */
function estimateWindFromCenterDrift(
  fixes: IGCFix[],
  prevCircle: CircleSegment,
  currentFit: FittedCircle,
  prevStartIndex: number,
  prevEndIndex: number,
  curStartIndex: number,
  curEndIndex: number,
  maxWindSpeed: number = MAX_REASONABLE_WIND_SPEED
): WindEstimate | undefined {
  const prevFit = prevCircle.fittedCircle;

  // Time between circle midpoints
  const prevMidTime = (fixes[prevStartIndex].time.getTime() + fixes[prevEndIndex].time.getTime()) / 2;
  const curMidTime = (fixes[curStartIndex].time.getTime() + fixes[curEndIndex].time.getTime()) / 2;
  const dt = (curMidTime - prevMidTime) / 1000;
  if (dt <= 0) return undefined;

  // Drift in meters
  const dLat = (currentFit.centerLat - prevFit.centerLat) * METERS_PER_DEGREE_LAT;
  const dLon = (currentFit.centerLon - prevFit.centerLon) *
    METERS_PER_DEGREE_LAT * Math.cos(((currentFit.centerLat + prevFit.centerLat) / 2) * Math.PI / 180);

  const driftDist = Math.sqrt(dLat * dLat + dLon * dLon);
  const speed = driftDist / dt;

  if (speed > maxWindSpeed) return undefined; // Reject unreasonable

  // Direction wind is blowing TO (atan2 gives angle from north)
  const dirTo = Math.atan2(dLon, dLat) * 180 / Math.PI;
  // Convert to FROM direction
  let direction = normalizeBearingDelta(dirTo + 180);
  if (direction < 0) direction += 360;

  return { speed, direction, method: 'center_drift' };
}

// --- Main export ---

/**
 * Detect circles in a flight track.
 *
 * @param fixes - Array of IGC fixes
 * @param options - Detection parameters
 * @returns Detection result with circling segments, individual circles, and bearing rates
 */
export function detectCircles(
  fixes: IGCFix[],
  options?: CircleDetectionOptions
): CircleDetectionResult {
  const lookbackSeconds = options?.lookbackSeconds ?? 5;
  const minTurnRate = options?.minTurnRate ?? 4.0;
  const t1Seconds = options?.t1Seconds ?? 8;
  const t2Seconds = options?.t2Seconds ?? 15;
  const minFixesPerCircle = options?.minFixesPerCircle ?? 8;
  const maxBearingRateOpt = options?.maxBearingRate ?? MAX_BEARING_RATE;
  const maxWindSpeedOpt = options?.maxReasonableWindSpeed ?? MAX_REASONABLE_WIND_SPEED;
  const minGSVariationOpt = options?.minGroundSpeedVariation ?? MIN_GROUND_SPEED_VARIATION;

  // Step 1: Compute bearing rates
  const bearingRates = computeBearingRates(fixes, lookbackSeconds, maxBearingRateOpt);

  // Step 2: Detect circling segments
  const circlingSegments = detectCirclingSegments(
    fixes, bearingRates, minTurnRate, t1Seconds, t2Seconds
  );

  // Step 3 & 4: Extract circles with per-circle metrics
  const circles = extractCircles(fixes, circlingSegments, minFixesPerCircle, maxWindSpeedOpt, minGSVariationOpt);

  return { circlingSegments, circles, bearingRates };
}
