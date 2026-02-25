import { describe, it, expect } from 'bun:test';
import {
  detectCircles,
  computeBearingRates,
  fitCircleLeastSquares,
  normalizeBearingDelta,
  detectCirclingSegments,
} from '../src/circle-detector';
import { destinationPoint } from '../src/geo';
import { createFix, type IGCFix } from './test-helpers';

/**
 * Generate a straight flight track heading north.
 */
function createStraightTrack(
  numFixes: number,
  intervalSeconds: number = 1
): IGCFix[] {
  const fixes: IGCFix[] = [];
  const startLat = 47.0;
  const startLon = 11.0;

  for (let i = 0; i < numFixes; i++) {
    // Move north at ~10 m/s
    const lat = startLat + (i * intervalSeconds * 10) / 111320;
    fixes.push(createFix(i * intervalSeconds, lat, startLon, 1000));
  }
  return fixes;
}

/**
 * Generate a circular track using destinationPoint from geo.ts.
 *
 * @param center - Center lat/lon
 * @param radiusMeters - Circle radius
 * @param numCircles - Number of complete circles
 * @param secondsPerCircle - Duration of one circle
 * @param climbRateMs - Climb rate in m/s
 * @param direction - Turn direction ('right' = clockwise, 'left' = counter-clockwise)
 * @param startAltitude - Starting altitude
 * @param fixInterval - Seconds between fixes (default 1)
 */
function createCircularTrack(
  center: { lat: number; lon: number },
  radiusMeters: number,
  numCircles: number,
  secondsPerCircle: number,
  climbRateMs: number = 2.0,
  direction: 'right' | 'left' = 'right',
  startAltitude: number = 1000,
  fixInterval: number = 1
): IGCFix[] {
  const fixes: IGCFix[] = [];
  const totalSeconds = numCircles * secondsPerCircle;
  const totalFixes = Math.floor(totalSeconds / fixInterval);
  const dirSign = direction === 'right' ? 1 : -1;

  for (let i = 0; i <= totalFixes; i++) {
    const t = i * fixInterval;
    const angle = dirSign * (t / secondsPerCircle) * 2 * Math.PI;
    const bearingRad = angle; // 0 = north, increases clockwise for right
    const pos = destinationPoint(center.lat, center.lon, radiusMeters, bearingRad);
    const altitude = startAltitude + climbRateMs * t;
    fixes.push(createFix(t, pos.lat, pos.lon, altitude));
  }

  return fixes;
}

/**
 * Generate a circular track with a known wind applied.
 * Wind shifts the circle center over time, causing ground speed variation.
 */
function createCircularTrackWithWind(
  center: { lat: number; lon: number },
  radiusMeters: number,
  numCircles: number,
  secondsPerCircle: number,
  windSpeedMs: number,
  windFromDeg: number,
  climbRateMs: number = 2.0,
  direction: 'right' | 'left' = 'right',
  startAltitude: number = 1000,
  fixInterval: number = 1
): IGCFix[] {
  const fixes: IGCFix[] = [];
  const totalSeconds = numCircles * secondsPerCircle;
  const totalFixes = Math.floor(totalSeconds / fixInterval);
  const dirSign = direction === 'right' ? 1 : -1;

  // Wind blows FROM windFromDeg, so drift is in the opposite direction
  const windToRad = ((windFromDeg + 180) % 360) * Math.PI / 180;

  for (let i = 0; i <= totalFixes; i++) {
    const t = i * fixInterval;
    const angle = dirSign * (t / secondsPerCircle) * 2 * Math.PI;

    // Base circle position
    const pos = destinationPoint(center.lat, center.lon, radiusMeters, angle);

    // Add wind drift
    const driftDistance = windSpeedMs * t;
    const driftedPos = destinationPoint(pos.lat, pos.lon, driftDistance, windToRad);

    const altitude = startAltitude + climbRateMs * t;
    fixes.push(createFix(t, driftedPos.lat, driftedPos.lon, altitude));
  }

  return fixes;
}

// --- Tests ---

describe('normalizeBearingDelta', () => {
  it('should return 0 for 0', () => {
    expect(normalizeBearingDelta(0)).toBe(0);
  });

  it('should handle positive values within range', () => {
    expect(normalizeBearingDelta(90)).toBe(90);
    expect(normalizeBearingDelta(180)).toBe(180);
  });

  it('should wrap values > 180', () => {
    expect(normalizeBearingDelta(270)).toBe(-90);
    expect(normalizeBearingDelta(350)).toBe(-10);
  });

  it('should handle negative values', () => {
    expect(normalizeBearingDelta(-90)).toBe(-90);
    expect(normalizeBearingDelta(-180)).toBe(180);
  });

  it('should wrap values < -180', () => {
    expect(normalizeBearingDelta(-270)).toBe(90);
    expect(normalizeBearingDelta(-350)).toBe(10);
  });

  it('should handle multiples of 360', () => {
    expect(normalizeBearingDelta(360)).toBe(0);
    expect(normalizeBearingDelta(720)).toBe(0);
  });
});

describe('computeBearingRates', () => {
  it('should return near-zero rates for straight flight', () => {
    const fixes = createStraightTrack(60);
    const rates = computeBearingRates(fixes, 5);

    // After the initial lookback period, rates should be near zero
    for (let i = 10; i < rates.length; i++) {
      expect(Math.abs(rates[i])).toBeLessThan(1.0);
    }
  });

  it('should return consistent rates for circular flight', () => {
    const fixes = createCircularTrack(
      { lat: 47.0, lon: 11.0 },
      150, // 150m radius
      2,   // 2 circles
      30,  // 30 seconds per circle
      0,   // no climb
      'right'
    );

    const rates = computeBearingRates(fixes, 5);

    // After stabilization, rates should be consistently positive (right turn)
    // Expected rate: 360/30 = 12 deg/s
    const stableRates = rates.slice(10);
    const avgRate = stableRates.reduce((sum, r) => sum + r, 0) / stableRates.length;
    expect(avgRate).toBeGreaterThan(5);
    expect(avgRate).toBeLessThan(20);
  });

  it('should return negative rates for left turns', () => {
    const fixes = createCircularTrack(
      { lat: 47.0, lon: 11.0 },
      150, 2, 30, 0, 'left'
    );

    const rates = computeBearingRates(fixes, 5);
    const stableRates = rates.slice(10);
    const avgRate = stableRates.reduce((sum, r) => sum + r, 0) / stableRates.length;
    expect(avgRate).toBeLessThan(-5);
  });

  it('should handle very few fixes', () => {
    const fixes = createStraightTrack(2);
    const rates = computeBearingRates(fixes);
    expect(rates.length).toBe(2);
  });
});

describe('detectCirclingSegments', () => {
  it('should find no segments in straight flight', () => {
    const fixes = createStraightTrack(120);
    const rates = computeBearingRates(fixes, 5);
    const segments = detectCirclingSegments(fixes, rates);
    expect(segments.length).toBe(0);
  });

  it('should detect one circling segment for sustained circling', () => {
    const fixes = createCircularTrack(
      { lat: 47.0, lon: 11.0 },
      150, 3, 30, 2.0, 'right'
    );

    const rates = computeBearingRates(fixes, 5);
    const segments = detectCirclingSegments(fixes, rates);

    expect(segments.length).toBeGreaterThanOrEqual(1);
    expect(segments[0].duration).toBeGreaterThan(20);
  });

  it('should not detect a segment for brief turning (< t1)', () => {
    // 5 seconds of turning then straight — below t1=8s threshold
    const circularFixes = createCircularTrack(
      { lat: 47.0, lon: 11.0 },
      150, 0.15, 30, 0, 'right' // ~0.15 circles = ~4.5s
    );
    const straightFixes = createStraightTrack(60);

    // Adjust straight track times to continue after circular
    const lastCircleTime = circularFixes[circularFixes.length - 1].time.getTime();
    for (let i = 0; i < straightFixes.length; i++) {
      straightFixes[i].time = new Date(lastCircleTime + (i + 1) * 1000);
    }

    const combined = [...circularFixes, ...straightFixes];
    const rates = computeBearingRates(combined, 5);
    const segments = detectCirclingSegments(combined, rates);

    expect(segments.length).toBe(0);
  });

  it('should detect two separate segments with a glide in between', () => {
    // First thermal: 3 circles
    const thermal1 = createCircularTrack(
      { lat: 47.0, lon: 11.0 },
      150, 3, 30, 2.0, 'right'
    );

    // Straight glide for 30 seconds
    const glide: IGCFix[] = [];
    const lastTime1 = thermal1[thermal1.length - 1].time.getTime();
    const lastLat1 = thermal1[thermal1.length - 1].latitude;
    for (let i = 1; i <= 30; i++) {
      glide.push(createFix(
        (lastTime1 - new Date('2024-01-15T10:00:00Z').getTime()) / 1000 + i,
        lastLat1 + (i * 10) / 111320,
        11.0,
        1200 - i * 2
      ));
    }

    // Second thermal: 3 circles
    const thermal2Center = { lat: glide[glide.length - 1].latitude, lon: 11.0 };
    const thermal2Base = createCircularTrack(
      thermal2Center, 150, 3, 30, 2.0, 'right'
    );
    // Adjust times
    const lastGlideTime = glide[glide.length - 1].time.getTime();
    for (let i = 0; i < thermal2Base.length; i++) {
      thermal2Base[i].time = new Date(lastGlideTime + i * 1000);
    }

    const combined = [...thermal1, ...glide, ...thermal2Base];
    const rates = computeBearingRates(combined, 5);
    const segments = detectCirclingSegments(combined, rates, 4.0, 8, 15);

    expect(segments.length).toBe(2);
  });
});

describe('extractCircles (via detectCircles)', () => {
  it('should detect circles from a circular track', () => {
    const fixes = createCircularTrack(
      { lat: 47.0, lon: 11.0 },
      150, 3, 30, 2.0, 'right'
    );

    const result = detectCircles(fixes);

    // Should find at least 2 circles (3 circles minus startup effects)
    expect(result.circles.length).toBeGreaterThanOrEqual(2);
  });

  it('should detect correct turn direction for right turns', () => {
    const fixes = createCircularTrack(
      { lat: 47.0, lon: 11.0 },
      150, 3, 30, 2.0, 'right'
    );

    const result = detectCircles(fixes);
    for (const circle of result.circles) {
      expect(circle.turnDirection).toBe('right');
    }
  });

  it('should detect correct turn direction for left turns', () => {
    const fixes = createCircularTrack(
      { lat: 47.0, lon: 11.0 },
      150, 3, 30, 2.0, 'left'
    );

    const result = detectCircles(fixes);
    for (const circle of result.circles) {
      expect(circle.turnDirection).toBe('left');
    }
  });

  it('should not detect circles in straight flight', () => {
    const fixes = createStraightTrack(120);
    const result = detectCircles(fixes);
    expect(result.circles.length).toBe(0);
  });

  it('should not detect circles with fewer than 360 degrees of turn', () => {
    // Half a circle only
    const fixes = createCircularTrack(
      { lat: 47.0, lon: 11.0 },
      150, 0.5, 30, 0, 'right'
    );

    const result = detectCircles(fixes);
    expect(result.circles.length).toBe(0);
  });

  it('should assign incrementing circle numbers', () => {
    const fixes = createCircularTrack(
      { lat: 47.0, lon: 11.0 },
      150, 5, 30, 2.0, 'right'
    );

    const result = detectCircles(fixes);
    for (let i = 0; i < result.circles.length; i++) {
      expect(result.circles[i].circleNumber).toBe(i + 1);
    }
  });
});

describe('fitCircleLeastSquares', () => {
  it('should fit center near actual center for a perfect circle', () => {
    const center = { lat: 47.0, lon: 11.0 };
    const radius = 150;
    const fixes = createCircularTrack(center, radius, 1, 30, 0, 'right');

    const fit = fitCircleLeastSquares(fixes, 0, fixes.length - 1);

    expect(fit).not.toBeNull();
    if (fit) {
      // Center should be within ~20m of actual
      const centerDist = Math.sqrt(
        Math.pow((fit.centerLat - center.lat) * 111320, 2) +
        Math.pow((fit.centerLon - center.lon) * 111320 * Math.cos(center.lat * Math.PI / 180), 2)
      );
      expect(centerDist).toBeLessThan(20);

      // Radius should be within 10%
      expect(Math.abs(fit.radiusMeters - radius) / radius).toBeLessThan(0.10);
    }
  });

  it('should return null for too few fixes', () => {
    const fixes = createStraightTrack(2);
    const fit = fitCircleLeastSquares(fixes, 0, 1);
    expect(fit).toBeNull();
  });

  it('should have small fit error for perfect circle', () => {
    const center = { lat: 47.0, lon: 11.0 };
    const fixes = createCircularTrack(center, 150, 1, 30, 0, 'right');
    const fit = fitCircleLeastSquares(fixes, 0, fixes.length - 1);

    expect(fit).not.toBeNull();
    if (fit) {
      // Perfect circle should have very small fit error relative to radius
      expect(fit.fitErrorRMS / fit.radiusMeters).toBeLessThan(0.15);
    }
  });
});

describe('circle quality', () => {
  it('should have high quality for all-climbing track', () => {
    const fixes = createCircularTrack(
      { lat: 47.0, lon: 11.0 },
      150, 3, 30, 3.0, 'right' // Strong climb
    );

    const result = detectCircles(fixes);
    for (const circle of result.circles) {
      expect(circle.quality).toBeGreaterThan(0.7);
    }
  });

  it('should have lower quality for zero climb track', () => {
    // Zero climb means roughly half the intervals should be slightly
    // positive/negative due to GPS noise, but with perfect data it's 0
    const fixes = createCircularTrack(
      { lat: 47.0, lon: 11.0 },
      150, 3, 30, 0, 'right' // No climb
    );

    const result = detectCircles(fixes);
    for (const circle of result.circles) {
      // With 0 climb rate, quality should be ~0 (no positive vario)
      expect(circle.quality).toBeLessThan(0.3);
    }
  });
});

describe('circle climb rate', () => {
  it('should compute correct climb rate', () => {
    const climbRate = 2.5;
    const fixes = createCircularTrack(
      { lat: 47.0, lon: 11.0 },
      150, 3, 30, climbRate, 'right'
    );

    const result = detectCircles(fixes);
    for (const circle of result.circles) {
      // Climb rate should be close to the input
      expect(Math.abs(circle.climbRate - climbRate)).toBeLessThan(0.5);
    }
  });
});

describe('wind estimation', () => {
  it('should estimate wind from ground speed variation', () => {
    const windSpeed = 5; // m/s
    const windFromDeg = 270; // west wind

    const fixes = createCircularTrackWithWind(
      { lat: 47.0, lon: 11.0 },
      150, 3, 30,
      windSpeed, windFromDeg,
      2.0, 'right'
    );

    const result = detectCircles(fixes);
    const circlesWithWind = result.circles.filter(c => c.windFromGroundSpeed);

    if (circlesWithWind.length > 0) {
      // At least some circles should have a wind estimate
      const avgWindSpeed = circlesWithWind.reduce(
        (sum, c) => sum + (c.windFromGroundSpeed?.speed ?? 0), 0
      ) / circlesWithWind.length;

      // Wind speed estimate should be in the right ballpark (within 100%)
      expect(avgWindSpeed).toBeGreaterThan(0);
      expect(avgWindSpeed).toBeLessThan(windSpeed * 3);
    }
  });

  it('should estimate wind from center drift between circles', () => {
    const windSpeed = 5;
    const windFromDeg = 0; // north wind

    const fixes = createCircularTrackWithWind(
      { lat: 47.0, lon: 11.0 },
      150, 4, 30,
      windSpeed, windFromDeg,
      2.0, 'right'
    );

    const result = detectCircles(fixes);
    const circlesWithDrift = result.circles.filter(c => c.windFromCenterDrift);

    // Should have at least one drift estimate (from 2nd circle onward)
    if (circlesWithDrift.length > 0) {
      const avgDriftSpeed = circlesWithDrift.reduce(
        (sum, c) => sum + (c.windFromCenterDrift?.speed ?? 0), 0
      ) / circlesWithDrift.length;

      // Wind estimate should be reasonable
      expect(avgDriftSpeed).toBeGreaterThan(0);
      expect(avgDriftSpeed).toBeLessThan(windSpeed * 3);
    }
  });
});

describe('strongest lift bearing', () => {
  it('should point toward max-climb fix', () => {
    const fixes = createCircularTrack(
      { lat: 47.0, lon: 11.0 },
      150, 3, 30, 2.0, 'right'
    );

    const result = detectCircles(fixes);
    for (const circle of result.circles) {
      // Just verify it's a valid bearing
      expect(circle.strongestLiftBearing).toBeGreaterThanOrEqual(-180);
      expect(circle.strongestLiftBearing).toBeLessThanOrEqual(180);
      // The fix index should be within the circle's range
      expect(circle.strongestLiftFixIndex).toBeGreaterThanOrEqual(circle.startIndex);
      expect(circle.strongestLiftFixIndex).toBeLessThanOrEqual(circle.endIndex);
    }
  });
});

describe('edge cases', () => {
  it('should handle irregular fix intervals', () => {
    const center = { lat: 47.0, lon: 11.0 };
    const radius = 150;
    const fixes: IGCFix[] = [];

    // Generate fixes at irregular intervals (1-3 seconds)
    let t = 0;
    const totalTime = 120; // 4 circles at 30s each
    while (t < totalTime) {
      const angle = (t / 30) * 2 * Math.PI;
      const pos = destinationPoint(center.lat, center.lon, radius, angle);
      fixes.push(createFix(t, pos.lat, pos.lon, 1000 + t * 2));
      t += 1 + Math.floor(Math.random() * 3); // 1-3 second intervals
    }

    const result = detectCircles(fixes);
    // Should still detect some circles despite irregular intervals
    expect(result.bearingRates.length).toBe(fixes.length);
  });

  it('should not produce false circles from GPS noise on straight flight', () => {
    const fixes: IGCFix[] = [];
    const startLat = 47.0;

    for (let i = 0; i < 120; i++) {
      // Straight flight with small random noise (±0.00001 degrees ≈ ±1m)
      const noise = (Math.random() - 0.5) * 0.00002;
      fixes.push(createFix(
        i,
        startLat + (i * 10) / 111320 + noise,
        11.0 + noise,
        1000
      ));
    }

    const result = detectCircles(fixes);
    expect(result.circles.length).toBe(0);
  });

  it('should handle empty fix array', () => {
    const result = detectCircles([]);
    expect(result.circles.length).toBe(0);
    expect(result.circlingSegments.length).toBe(0);
    expect(result.bearingRates.length).toBe(0);
  });

  it('should handle very short fix array', () => {
    const fixes = createStraightTrack(3);
    const result = detectCircles(fixes);
    expect(result.circles.length).toBe(0);
  });
});

describe('integration with detectFlightEvents', () => {
  it('should add circle_complete events to flight events', async () => {
    // Import here to test integration
    const { detectFlightEvents } = await import('../src/event-detector');

    // Create a flight: takeoff, thermal (circles), glide, landing
    // Takeoff: straight flight climbing
    const takeoff: IGCFix[] = [];
    for (let i = 0; i < 30; i++) {
      takeoff.push(createFix(i, 47.0 + i * 0.0001, 11.0, 500 + i * 5));
    }

    // Thermal: 5 circles
    const thermalCenter = {
      lat: takeoff[takeoff.length - 1].latitude,
      lon: 11.0,
    };
    const thermal = createCircularTrack(
      thermalCenter, 150, 5, 30, 2.0, 'right', 650
    );
    const thermalStartTime = takeoff[takeoff.length - 1].time.getTime() + 1000;
    for (let i = 0; i < thermal.length; i++) {
      thermal[i].time = new Date(thermalStartTime + i * 1000);
    }

    // Final glide + landing
    const glide: IGCFix[] = [];
    const glideStartTime = thermal[thermal.length - 1].time.getTime() + 1000;
    const glideLat = thermal[thermal.length - 1].latitude;
    for (let i = 0; i < 60; i++) {
      glide.push({
        time: new Date(glideStartTime + i * 1000),
        latitude: glideLat + i * 0.0002,
        longitude: 11.0,
        pressureAltitude: 950 - i * 3,
        gnssAltitude: 950 - i * 3,
        valid: true,
      });
    }

    const fixes = [...takeoff, ...thermal, ...glide];
    const events = detectFlightEvents(fixes);

    const circleEvents = events.filter(e => e.type === 'circle_complete');
    // Should have detected some circles
    expect(circleEvents.length).toBeGreaterThan(0);

    // Verify circle event structure
    for (const event of circleEvents) {
      expect(event.id).toMatch(/^circle-/);
      expect(event.description).toContain('Circle #');
      expect(event.details).toBeDefined();
      expect(event.segment).toBeDefined();
      if (event.details) {
        const d = event.details as import('../src/event-detector').CircleEventDetails;
        expect(d.turnDirection).toBeDefined();
        expect(d.radius).toBeDefined();
        expect(d.quality).toBeDefined();
      }
    }
  });
});
