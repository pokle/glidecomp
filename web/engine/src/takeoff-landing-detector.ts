/**
 * Takeoff / landing detection.
 *
 * Detects the takeoff and landing fixes from an IGC track using XCSoar-style
 * multi-criteria checks (ground speed, altitude gain, sustained climb). The
 * takeoff fix bounds every other flight-event detector — nothing is detected
 * before the pilot leaves the ground — so this runs first.
 */

import { IGCFix } from './igc-parser';
import { andoyerDistance } from './geo';
import type { DetectionThresholds } from './thresholds';
import type { FlightEvent } from './event-types';

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

  // Criteria 1: Instant ground speed check (needs a previous fix to compare to)
  if (index >= 1) {
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

  // Sustained ground speed: require two consecutive fast intervals whose
  // combined displacement is also fast. A single-fix GPS spike while grounded
  // produces two fast intervals (out and back) but near-zero net displacement,
  // so it cannot pass; real flight moves through both intervals.
  for (let j = startIdx; j + 2 <= endIdx; j++) {
    if (
      calculateGroundSpeed(fixes[j], fixes[j + 1]) > config.minGroundSpeed &&
      calculateGroundSpeed(fixes[j + 1], fixes[j + 2]) > config.minGroundSpeed &&
      calculateGroundSpeed(fixes[j], fixes[j + 2]) > config.minGroundSpeed
    ) {
      return true;
    }
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
  // Loop to index 1, not landingTimeWindow: that threshold is in seconds, not
  // fixes, so using it as an index bound assumes 1 Hz logging and can miss a
  // landing early in a low-rate track. The windowStartIndex === i guard below
  // already skips candidates without a full lookback window.
  for (let i = fixes.length - 2; i >= 1; i--) {
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
export function detectTakeoffLanding(fixes: IGCFix[], thresholds: DetectionThresholds): FlightEvent[] {
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
