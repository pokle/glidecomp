/**
 * Tests for Geo Math Functions (WGS84 ellipsoid formulas in geo.ts)
 */

import { describe, it, expect } from 'bun:test';

import {
  andoyerDistance,
  getBoundingBox,
  calculateBearing,
  destinationPoint,
  calculateBearingRadians,
  isInsideCylinder,
  getCirclePoints
} from '../src/geo';
import { createFix } from './test-helpers';

describe('Geo Math Functions - Characterization Tests', () => {
  describe('andoyerDistance', () => {
    it('should calculate distance from London to Paris (~344km)', () => {
      // Big Ben to Eiffel Tower
      const londonLat = 51.5007;
      const londonLon = -0.1246;
      const parisLat = 48.8584;
      const parisLon = 2.2945;

      const distance = andoyerDistance(londonLat, londonLon, parisLat, parisLon);

      // Expected ~344km, allow 5km tolerance
      expect(distance).toBeGreaterThan(339000);
      expect(distance).toBeLessThan(349000);
    });

    it('should return 0 for same point', () => {
      const distance = andoyerDistance(47.0, 11.0, 47.0, 11.0);
      expect(distance).toBe(0);
    });

    it('should calculate roughly 111km for 1 degree of latitude', () => {
      // 1 degree of latitude is approximately 110-111km (varies with ellipsoid)
      const distance = andoyerDistance(47.0, 11.0, 48.0, 11.0);
      expect(distance).toBeGreaterThan(110000);
      expect(distance).toBeLessThan(112000);
    });

    it('should calculate distance across equator', () => {
      // From 1°N to 1°S at same longitude
      const distance = andoyerDistance(1.0, 0.0, -1.0, 0.0);
      // 2 degrees of latitude ≈ 221-222km
      expect(distance).toBeGreaterThan(220000);
      expect(distance).toBeLessThan(223000);
    });

    it('should calculate distance in southern hemisphere', () => {
      // Melbourne to Sydney (approximately)
      const melbourneLat = -37.8136;
      const melbourneLon = 144.9631;
      const sydneyLat = -33.8688;
      const sydneyLon = 151.2093;

      const distance = andoyerDistance(melbourneLat, melbourneLon, sydneyLat, sydneyLon);

      // Expected ~713km
      expect(distance).toBeGreaterThan(700000);
      expect(distance).toBeLessThan(730000);
    });

    it('should calculate distance across date line', () => {
      // Fiji to Tonga (across date line)
      const fijiLat = -17.7134;
      const fijiLon = 178.065;
      const tongaLat = -21.1789;
      const tongaLon = -175.1982;

      const distance = andoyerDistance(fijiLat, fijiLon, tongaLat, tongaLon);

      // Expected ~804km (actual value from implementation)
      expect(distance).toBeGreaterThan(800000);
      expect(distance).toBeLessThan(810000);
    });

    it('should calculate short distances accurately (<100m)', () => {
      // Two points about 50m apart at latitude 47°
      const lat1 = 47.0;
      const lon1 = 11.0;
      // ~50m east: 50m / (111320 * cos(47°)) ≈ 0.000657 degrees
      const lat2 = 47.0;
      const lon2 = 11.000657;

      const distance = andoyerDistance(lat1, lon1, lat2, lon2);

      expect(distance).toBeGreaterThan(45);
      expect(distance).toBeLessThan(55);
    });

    it('should be symmetric (A to B equals B to A)', () => {
      const lat1 = 47.123;
      const lon1 = 11.456;
      const lat2 = 48.789;
      const lon2 = 12.012;

      const distanceAB = andoyerDistance(lat1, lon1, lat2, lon2);
      const distanceBA = andoyerDistance(lat2, lon2, lat1, lon1);

      expect(distanceAB).toBe(distanceBA);
    });

    it('should handle antipodal points (~20,000km)', () => {
      // Roughly antipodal: 0,0 to 0,180
      const distance = andoyerDistance(0, 0, 0, 180);
      // Half circumference ≈ 20,015km
      expect(distance).toBeGreaterThan(20000000);
      expect(distance).toBeLessThan(20050000);
    });
  });

  describe('calculateBearing (degrees)', () => {
    it('should return ~0° for due north', () => {
      const bearing = calculateBearing(47.0, 11.0, 48.0, 11.0);
      expect(bearing).toBeCloseTo(0, 0);
    });

    it('should return ~90° for due east', () => {
      const bearing = calculateBearing(47.0, 11.0, 47.0, 12.0);
      expect(bearing).toBeCloseTo(90, 0);
    });

    it('should return ~180° for due south', () => {
      const bearing = calculateBearing(48.0, 11.0, 47.0, 11.0);
      expect(Math.abs(bearing)).toBeCloseTo(180, 0);
    });

    it('should return ~-90° for due west', () => {
      const bearing = calculateBearing(47.0, 12.0, 47.0, 11.0);
      expect(bearing).toBeCloseTo(-90, 0);
    });

    it('should return ~45° for northeast', () => {
      // Go 1° north and adjust east to make it roughly 45°
      // At 47°, need to go ~1.47° east to match 1° north distance
      const bearing = calculateBearing(47.0, 11.0, 48.0, 12.47);
      expect(bearing).toBeCloseTo(44.26, 1);
    });

    it('should return ~135° for southeast', () => {
      const bearing = calculateBearing(48.0, 11.0, 47.0, 12.47);
      expect(bearing).toBeCloseTo(134.65, 1);
    });

    it('should return ~-135° for southwest', () => {
      const bearing = calculateBearing(48.0, 12.0, 47.0, 10.53);
      expect(bearing).toBeCloseTo(-134.65, 1);
    });

    it('should return ~-45° for northwest', () => {
      const bearing = calculateBearing(47.0, 12.0, 48.0, 10.53);
      expect(bearing).toBeCloseTo(-44.26, 1);
    });

    it('should return a valid bearing for same point (edge case)', () => {
      const bearing = calculateBearing(47.0, 11.0, 47.0, 11.0);
      // Should be 0 or close to it (undefined behavior, but we document it)
      expect(typeof bearing).toBe('number');
      expect(isNaN(bearing)).toBe(false);
    });

    it('should handle cross-date-line bearing', () => {
      // From 170°E to 170°W (crossing date line eastward)
      const bearing = calculateBearing(0, 170, 0, -170);
      // Should be roughly 90° (east)
      expect(bearing).toBeCloseTo(90, 0);
    });

    it('should handle bearing range [-180, 180]', () => {
      // Various bearings should all be within [-180, 180]
      const testCases = [
        [47.0, 11.0, 48.0, 11.0],   // North
        [47.0, 11.0, 47.0, 12.0],   // East
        [48.0, 11.0, 47.0, 11.0],   // South
        [47.0, 12.0, 47.0, 11.0],   // West
        [47.0, 11.0, 48.0, 12.0],   // NE
        [47.0, 11.0, 46.0, 12.0],   // SE
        [47.0, 11.0, 46.0, 10.0],   // SW
        [47.0, 11.0, 48.0, 10.0],   // NW
      ];

      for (const [lat1, lon1, lat2, lon2] of testCases) {
        const bearing = calculateBearing(lat1, lon1, lat2, lon2);
        expect(bearing).toBeGreaterThanOrEqual(-180);
        expect(bearing).toBeLessThanOrEqual(180);
      }
    });
  });

  describe('getBoundingBox', () => {
    it('should calculate bounding box for multiple fixes', () => {
      const fixes = [
        createFix(0, 47.0, 11.0),
        createFix(0, 48.0, 12.0),
        createFix(0, 47.5, 11.5),
      ];

      const bounds = getBoundingBox(fixes);

      expect(bounds.minLat).toBe(47.0);
      expect(bounds.maxLat).toBe(48.0);
      expect(bounds.minLon).toBe(11.0);
      expect(bounds.maxLon).toBe(12.0);
    });

    it('should handle single fix', () => {
      const fixes = [createFix(0, 47.5, 11.5)];

      const bounds = getBoundingBox(fixes);

      expect(bounds.minLat).toBe(47.5);
      expect(bounds.maxLat).toBe(47.5);
      expect(bounds.minLon).toBe(11.5);
      expect(bounds.maxLon).toBe(11.5);
    });

    it('should return zeros for empty array', () => {
      const bounds = getBoundingBox([]);

      expect(bounds.minLat).toBe(0);
      expect(bounds.maxLat).toBe(0);
      expect(bounds.minLon).toBe(0);
      expect(bounds.maxLon).toBe(0);
    });

    it('should handle negative coordinates (southern/western hemisphere)', () => {
      const fixes = [
        createFix(0, -37.0, -175.0),
        createFix(0, -35.0, -173.0),
        createFix(0, -36.0, -174.0),
      ];

      const bounds = getBoundingBox(fixes);

      expect(bounds.minLat).toBe(-37.0);
      expect(bounds.maxLat).toBe(-35.0);
      expect(bounds.minLon).toBe(-175.0);
      expect(bounds.maxLon).toBe(-173.0);
    });

    it('should handle coordinates crossing equator and prime meridian', () => {
      const fixes = [
        createFix(0, -1.0, -1.0),
        createFix(0, 1.0, 1.0),
      ];

      const bounds = getBoundingBox(fixes);

      expect(bounds.minLat).toBe(-1.0);
      expect(bounds.maxLat).toBe(1.0);
      expect(bounds.minLon).toBe(-1.0);
      expect(bounds.maxLon).toBe(1.0);
    });
  });

  describe('Integration: distance + bearing consistency', () => {
    it('should maintain triangle inequality', () => {
      // For any three points A, B, C:
      // distance(A, C) <= distance(A, B) + distance(B, C)
      const latA = 47.0, lonA = 11.0;
      const latB = 47.5, lonB = 11.5;
      const latC = 48.0, lonC = 12.0;

      const distAB = andoyerDistance(latA, lonA, latB, lonB);
      const distBC = andoyerDistance(latB, lonB, latC, lonC);
      const distAC = andoyerDistance(latA, lonA, latC, lonC);

      expect(distAC).toBeLessThanOrEqual(distAB + distBC + 1); // +1 for floating point
    });

    it('should have consistent bearing and reverse bearing', () => {
      const lat1 = 47.0, lon1 = 11.0;
      const lat2 = 48.0, lon2 = 12.0;

      const bearingForward = calculateBearing(lat1, lon1, lat2, lon2);
      const bearingBack = calculateBearing(lat2, lon2, lat1, lon1);

      // Reverse bearing should be approximately opposite (differ by ~180°)
      // On a sphere, initial and final bearings differ slightly
      let diff = Math.abs(bearingForward - bearingBack);
      if (diff > 180) diff = 360 - diff;

      // Allow 1 degree tolerance for spherical geometry effects
      expect(diff).toBeGreaterThan(178);
      expect(diff).toBeLessThan(182);
    });
  });
});

describe('Snapshot Tests for Known Values', () => {
  // These tests capture specific values that the current implementation produces
  // so we can verify the new implementation matches exactly

  describe('andoyerDistance snapshots', () => {
    it('should match snapshot: London to Paris', () => {
      const distance = andoyerDistance(51.5007, -0.1246, 48.8584, 2.2945);
      expect(distance).toBeCloseTo(340896.67, 0);
    });

    it('should match snapshot: 1 degree latitude at equator', () => {
      const distance = andoyerDistance(0, 0, 1, 0);
      expect(distance).toBeCloseTo(110573.14, 0);
    });

    it('should match snapshot: 1 degree longitude at equator', () => {
      const distance = andoyerDistance(0, 0, 0, 1);
      expect(distance).toBeCloseTo(111319.49, 0);
    });

    it('should match snapshot: 1 degree longitude at 47°N', () => {
      const distance = andoyerDistance(47, 0, 47, 1);
      expect(distance).toBeCloseTo(76055.34, 0);
    });
  });



  describe('calculateBearing snapshots', () => {
    it('should match snapshot: due north', () => {
      const bearing = calculateBearing(47.0, 11.0, 48.0, 11.0);
      expect(bearing).toBeCloseTo(0, 5);
    });

    it('should match snapshot: due east', () => {
      const bearing = calculateBearing(47.0, 11.0, 47.0, 12.0);
      expect(bearing).toBeCloseTo(89.63, 1);
    });

    it('should match snapshot: northeast diagonal', () => {
      const bearing = calculateBearing(47.0, 11.0, 48.0, 12.0);
      expect(bearing).toBeCloseTo(33.67, 1);
    });
  });
});

describe('destinationPoint tests (WGS84 Vincenty direct)', () => {
  it('should calculate correct destination going north', () => {
    const result = destinationPoint(47.0, 11.0, 1000, 0);
    expect(result.lat).toBeGreaterThan(47.0);
    expect(result.lon).toBeCloseTo(11.0, 8); // longitude unchanged for due north
  });

  it('should calculate correct destination going east', () => {
    const result = destinationPoint(47.0, 11.0, 1000, Math.PI / 2);
    expect(result.lat).toBeCloseTo(47.0, 5);
    expect(result.lon).toBeGreaterThan(11.0);
  });

  it('should return to approximately same point after round trip', () => {
    const distance = 10000; // 10km
    const bearing = Math.PI / 4; // 45 degrees

    const dest = destinationPoint(47.0, 11.0, distance, bearing);
    const returnTrip = destinationPoint(dest.lat, dest.lon, distance, bearing + Math.PI);

    // On an ellipsoid, the reverse azimuth isn't exactly bearing+π, so the
    // round trip doesn't return perfectly. Within ~10m for 10km is expected.
    expect(returnTrip.lat).toBeCloseTo(47.0, 3);
    expect(returnTrip.lon).toBeCloseTo(11.0, 3);
  });

  it('should be consistent with andoyerDistance (<0.1m at 5km, <0.5m at 50km)', () => {
    // Place a point away, then measure with andoyerDistance — both use WGS84
    // but Vincenty direct and Andoyer inverse are different algorithms,
    // so they agree to ~10 ppm (0.05m per 5km, 0.5m per 50km)
    const testCases = [
      { lat: 47.0, lon: 11.0, dist: 5000, bearing: 0, tol: 0.1 },
      { lat: 47.0, lon: 11.0, dist: 5000, bearing: Math.PI / 2, tol: 0.1 },
      { lat: -36.0, lon: 148.0, dist: 5000, bearing: Math.PI / 4, tol: 0.1 },
      { lat: 0.0, lon: 0.0, dist: 50000, bearing: 1.0, tol: 0.5 },
    ];

    for (const tc of testCases) {
      const dest = destinationPoint(tc.lat, tc.lon, tc.dist, tc.bearing);
      const measured = andoyerDistance(tc.lat, tc.lon, dest.lat, dest.lon);
      expect(Math.abs(measured - tc.dist)).toBeLessThan(tc.tol);
    }
  });

  it('should return identity for zero distance', () => {
    const result = destinationPoint(47.0, 11.0, 0, Math.PI / 3);
    expect(result.lat).toBe(47.0);
    expect(result.lon).toBe(11.0);
  });
});

describe('isInsideCylinder tests', () => {
  it('should return true for point at center', () => {
    expect(isInsideCylinder(47.0, 11.0, 47.0, 11.0, 1000)).toBe(true);
  });

  it('should return true for point inside cylinder', () => {
    expect(isInsideCylinder(47.0, 11.005, 47.0, 11.0, 1000)).toBe(true);
  });

  it('should return false for point outside cylinder', () => {
    expect(isInsideCylinder(47.02, 11.0, 47.0, 11.0, 1000)).toBe(false);
  });

  it('should handle point very close to boundary', () => {
    const dest = destinationPoint(47.0, 11.0, 999.9, 0);
    expect(isInsideCylinder(dest.lat, dest.lon, 47.0, 11.0, 1000)).toBe(true);

    const destOutside = destinationPoint(47.0, 11.0, 1001, 0);
    expect(isInsideCylinder(destOutside.lat, destOutside.lon, 47.0, 11.0, 1000)).toBe(false);
  });
});

describe('calculateBearingRadians tests', () => {
  it('should return radians for due north', () => {
    const result = calculateBearingRadians(47.0, 11.0, 48.0, 11.0);
    expect(result).toBeCloseTo(0, 2);
  });

  it('should return PI/2 for due east', () => {
    const result = calculateBearingRadians(47.0, 11.0, 47.0, 12.0);
    expect(result).toBeCloseTo(Math.PI / 2, 1);
  });

  it('should return ±PI for due south', () => {
    const result = calculateBearingRadians(48.0, 11.0, 47.0, 11.0);
    expect(Math.abs(result)).toBeCloseTo(Math.PI, 1);
  });

  it('should return -PI/2 for due west', () => {
    const result = calculateBearingRadians(47.0, 12.0, 47.0, 11.0);
    expect(result).toBeCloseTo(-Math.PI / 2, 1);
  });
});

describe('getCirclePoints tests (WGS84)', () => {
  it('should return correct number of points (numPoints + 1 for closure)', () => {
    const points = getCirclePoints(47.0, 11.0, 1000, 64);
    expect(points).toHaveLength(65);
  });

  it('should return closed polygon (first and last points match)', () => {
    const points = getCirclePoints(47.0, 11.0, 1000, 32);
    const first = points[0];
    const last = points[points.length - 1];
    expect(first.lat).toBeCloseTo(last.lat, 10);
    expect(first.lon).toBeCloseTo(last.lon, 10);
  });

  it('should generate points within 0.1m of target radius (WGS84)', () => {
    const centerLat = 47.0;
    const centerLon = 11.0;
    const radius = 1000;

    const points = getCirclePoints(centerLat, centerLon, radius, 16);

    for (let i = 0; i < points.length - 1; i++) {
      const dist = andoyerDistance(centerLat, centerLon, points[i].lat, points[i].lon);
      expect(Math.abs(dist - radius)).toBeLessThan(0.1);
    }
  });

  it('should generate evenly distributed points around the circle', () => {
    const points = getCirclePoints(47.0, 11.0, 1000, 4);
    expect(points).toHaveLength(5);

    // First point is north (bearing=0)
    expect(points[0].lat).toBeGreaterThan(47.0);
    expect(points[0].lon).toBeCloseTo(11.0, 6);

    // Second point is east (bearing=π/2)
    expect(points[1].lat).toBeCloseTo(47.0, 4);
    expect(points[1].lon).toBeGreaterThan(11.0);

    // Third point is south (bearing=π)
    expect(points[2].lat).toBeLessThan(47.0);
    expect(points[2].lon).toBeCloseTo(11.0, 6);

    // Fourth point is west (bearing=3π/2)
    expect(points[3].lat).toBeCloseTo(47.0, 4);
    expect(points[3].lon).toBeLessThan(11.0);
  });

  it('should handle small radius (100m) within 0.01m', () => {
    const points = getCirclePoints(47.0, 11.0, 100, 8);
    expect(points).toHaveLength(9);

    for (let i = 0; i < points.length - 1; i++) {
      const dist = andoyerDistance(47.0, 11.0, points[i].lat, points[i].lon);
      expect(Math.abs(dist - 100)).toBeLessThan(0.01);
    }
  });

  it('should handle large radius (50km) within 0.5m', () => {
    const points = getCirclePoints(47.0, 11.0, 50000, 8);
    expect(points).toHaveLength(9);

    // Vincenty direct and Andoyer inverse agree to ~10 ppm
    for (let i = 0; i < points.length - 1; i++) {
      const dist = andoyerDistance(47.0, 11.0, points[i].lat, points[i].lon);
      expect(Math.abs(dist - 50000)).toBeLessThan(0.5);
    }
  });

  it('should be accurate at different latitudes within 0.1m', () => {
    const equatorPoints = getCirclePoints(0.0, 11.0, 1000, 8);
    const highLatPoints = getCirclePoints(70.0, 11.0, 1000, 8);
    const southPoints = getCirclePoints(-36.0, 148.0, 1000, 8);

    for (let i = 0; i < 8; i++) {
      const equatorDist = andoyerDistance(0.0, 11.0, equatorPoints[i].lat, equatorPoints[i].lon);
      const highLatDist = andoyerDistance(70.0, 11.0, highLatPoints[i].lat, highLatPoints[i].lon);
      const southDist = andoyerDistance(-36.0, 148.0, southPoints[i].lat, southPoints[i].lon);
      expect(Math.abs(equatorDist - 1000)).toBeLessThan(0.1);
      expect(Math.abs(highLatDist - 1000)).toBeLessThan(0.1);
      expect(Math.abs(southDist - 1000)).toBeLessThan(0.1);
    }
  });

  it('should use default numPoints of 64', () => {
    const points = getCirclePoints(47.0, 11.0, 1000);
    expect(points).toHaveLength(65);
  });
});
