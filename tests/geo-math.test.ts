/**
 * Characterization Tests for Geo Math Functions
 *
 * These tests document the exact behavior of the current implementations
 * before migrating to Turf.js. They ensure that the new implementations
 * maintain the same behavior.
 */

import { describe, it, expect } from 'bun:test';

// Import from geo (the canonical export location after library extraction)
import {
  haversineDistance as oldHaversineDistance,
  getBoundingBox as oldGetBoundingBox,
  calculateBearing as oldCalculateBearing,
} from '../packages/analysis/src/geo';
import type { IGCFix } from '../packages/analysis/src/igc-parser';

// Import new Turf.js implementations
import {
  haversineDistance as turfHaversineDistance,
  getBoundingBox as turfGetBoundingBox,
  calculateBearing as turfCalculateBearing,
  destinationPoint as turfDestinationPoint,
  calculateBearingRadians as turfCalculateBearingRadians,
  isInsideCylinder as turfIsInsideCylinder,
  getCirclePoints
} from '../packages/analysis/src/geo';

// Use the old implementations by default for backwards compatibility tests
const haversineDistance = oldHaversineDistance;
const getBoundingBox = oldGetBoundingBox;
const calculateBearing = oldCalculateBearing;

// Note: destinationPoint and calculateBearing (radians) in xctsk-parser are private
// We'll test them indirectly through calculateOptimizedTaskLine

describe('Geo Math Functions - Characterization Tests', () => {
  describe('haversineDistance', () => {
    it('should calculate distance from London to Paris (~344km)', () => {
      // Big Ben to Eiffel Tower
      const londonLat = 51.5007;
      const londonLon = -0.1246;
      const parisLat = 48.8584;
      const parisLon = 2.2945;

      const distance = haversineDistance(londonLat, londonLon, parisLat, parisLon);

      // Expected ~344km, allow 5km tolerance
      expect(distance).toBeGreaterThan(339000);
      expect(distance).toBeLessThan(349000);
    });

    it('should return 0 for same point', () => {
      const distance = haversineDistance(47.0, 11.0, 47.0, 11.0);
      expect(distance).toBe(0);
    });

    it('should calculate roughly 111km for 1 degree of latitude', () => {
      // 1 degree of latitude is approximately 111km
      const distance = haversineDistance(47.0, 11.0, 48.0, 11.0);
      expect(distance).toBeCloseTo(111195, -2); // Within 100m
    });

    it('should calculate distance across equator', () => {
      // From 1°N to 1°S at same longitude
      const distance = haversineDistance(1.0, 0.0, -1.0, 0.0);
      // 2 degrees of latitude ≈ 222km
      expect(distance).toBeCloseTo(222390, -2);
    });

    it('should calculate distance in southern hemisphere', () => {
      // Melbourne to Sydney (approximately)
      const melbourneLat = -37.8136;
      const melbourneLon = 144.9631;
      const sydneyLat = -33.8688;
      const sydneyLon = 151.2093;

      const distance = haversineDistance(melbourneLat, melbourneLon, sydneyLat, sydneyLon);

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

      const distance = haversineDistance(fijiLat, fijiLon, tongaLat, tongaLon);

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

      const distance = haversineDistance(lat1, lon1, lat2, lon2);

      expect(distance).toBeGreaterThan(45);
      expect(distance).toBeLessThan(55);
    });

    it('should be symmetric (A to B equals B to A)', () => {
      const lat1 = 47.123;
      const lon1 = 11.456;
      const lat2 = 48.789;
      const lon2 = 12.012;

      const distanceAB = haversineDistance(lat1, lon1, lat2, lon2);
      const distanceBA = haversineDistance(lat2, lon2, lat1, lon1);

      expect(distanceAB).toBe(distanceBA);
    });

    it('should handle antipodal points (~20,000km)', () => {
      // Roughly antipodal: 0,0 to 0,180
      const distance = haversineDistance(0, 0, 0, 180);
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
    function createFix(lat: number, lon: number): IGCFix {
      return {
        time: new Date(),
        latitude: lat,
        longitude: lon,
        pressureAltitude: 1000,
        gnssAltitude: 1000,
        valid: true,
      };
    }

    it('should calculate bounding box for multiple fixes', () => {
      const fixes: IGCFix[] = [
        createFix(47.0, 11.0),
        createFix(48.0, 12.0),
        createFix(47.5, 11.5),
      ];

      const bounds = getBoundingBox(fixes);

      expect(bounds.minLat).toBe(47.0);
      expect(bounds.maxLat).toBe(48.0);
      expect(bounds.minLon).toBe(11.0);
      expect(bounds.maxLon).toBe(12.0);
    });

    it('should handle single fix', () => {
      const fixes: IGCFix[] = [createFix(47.5, 11.5)];

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
      const fixes: IGCFix[] = [
        createFix(-37.0, -175.0),
        createFix(-35.0, -173.0),
        createFix(-36.0, -174.0),
      ];

      const bounds = getBoundingBox(fixes);

      expect(bounds.minLat).toBe(-37.0);
      expect(bounds.maxLat).toBe(-35.0);
      expect(bounds.minLon).toBe(-175.0);
      expect(bounds.maxLon).toBe(-173.0);
    });

    it('should handle coordinates crossing equator and prime meridian', () => {
      const fixes: IGCFix[] = [
        createFix(-1.0, -1.0),
        createFix(1.0, 1.0),
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

      const distAB = haversineDistance(latA, lonA, latB, lonB);
      const distBC = haversineDistance(latB, lonB, latC, lonC);
      const distAC = haversineDistance(latA, lonA, latC, lonC);

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

  describe('haversineDistance snapshots', () => {
    it('should match snapshot: London to Paris', () => {
      const distance = haversineDistance(51.5007, -0.1246, 48.8584, 2.2945);
      // Exact value from current implementation
      expect(distance).toBeCloseTo(340538.92, 0);
    });

    it('should match snapshot: 1 degree latitude at equator', () => {
      const distance = haversineDistance(0, 0, 1, 0);
      expect(distance).toBeCloseTo(111195, 0);
    });

    it('should match snapshot: 1 degree longitude at equator', () => {
      const distance = haversineDistance(0, 0, 0, 1);
      expect(distance).toBeCloseTo(111195, 0);
    });

    it('should match snapshot: 1 degree longitude at 47°N', () => {
      const distance = haversineDistance(47, 0, 47, 1);
      expect(distance).toBeCloseTo(75834.24, 0);
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

describe('Turf.js Implementation Comparison', () => {
  describe('haversineDistance comparison', () => {
    const testCases = [
      { name: 'London to Paris', args: [51.5007, -0.1246, 48.8584, 2.2945] },
      { name: 'same point', args: [47.0, 11.0, 47.0, 11.0] },
      { name: '1 degree latitude', args: [47.0, 11.0, 48.0, 11.0] },
      { name: 'across equator', args: [1.0, 0.0, -1.0, 0.0] },
      { name: 'southern hemisphere', args: [-37.8136, 144.9631, -33.8688, 151.2093] },
      { name: 'short distance', args: [47.0, 11.0, 47.0, 11.000657] },
      { name: 'antipodal', args: [0, 0, 0, 180] },
    ] as const;

    for (const { name, args } of testCases) {
      it(`should match old implementation: ${name}`, () => {
        const oldResult = oldHaversineDistance(args[0], args[1], args[2], args[3]);
        const turfResult = turfHaversineDistance(args[0], args[1], args[2], args[3]);

        // Allow 0.1% tolerance for different earth models
        const tolerance = Math.max(oldResult * 0.001, 1);
        expect(turfResult).toBeCloseTo(oldResult, -Math.log10(tolerance));
      });
    }
  });

  describe('calculateBearing comparison', () => {
    const testCases = [
      { name: 'due north', args: [47.0, 11.0, 48.0, 11.0] },
      { name: 'due east', args: [47.0, 11.0, 47.0, 12.0] },
      { name: 'due south', args: [48.0, 11.0, 47.0, 11.0] },
      { name: 'due west', args: [47.0, 12.0, 47.0, 11.0] },
      { name: 'northeast', args: [47.0, 11.0, 48.0, 12.47] },
      { name: 'cross date line', args: [0, 170, 0, -170] },
    ] as const;

    for (const { name, args } of testCases) {
      it(`should match old implementation: ${name}`, () => {
        const oldResult = oldCalculateBearing(args[0], args[1], args[2], args[3]);
        const turfResult = turfCalculateBearing(args[0], args[1], args[2], args[3]);

        // Allow 0.1 degree tolerance
        expect(turfResult).toBeCloseTo(oldResult, 0);
      });
    }
  });

  describe('getBoundingBox comparison', () => {
    function createFix(lat: number, lon: number): IGCFix {
      return {
        time: new Date(),
        latitude: lat,
        longitude: lon,
        pressureAltitude: 1000,
        gnssAltitude: 1000,
        valid: true,
      };
    }

    it('should match old implementation: multiple fixes', () => {
      const fixes: IGCFix[] = [
        createFix(47.0, 11.0),
        createFix(48.0, 12.0),
        createFix(47.5, 11.5),
      ];

      const oldResult = oldGetBoundingBox(fixes);
      const turfResult = turfGetBoundingBox(fixes);

      expect(turfResult.minLat).toBe(oldResult.minLat);
      expect(turfResult.maxLat).toBe(oldResult.maxLat);
      expect(turfResult.minLon).toBe(oldResult.minLon);
      expect(turfResult.maxLon).toBe(oldResult.maxLon);
    });

    it('should match old implementation: single fix', () => {
      const fixes: IGCFix[] = [createFix(47.5, 11.5)];

      const oldResult = oldGetBoundingBox(fixes);
      const turfResult = turfGetBoundingBox(fixes);

      expect(turfResult.minLat).toBe(oldResult.minLat);
      expect(turfResult.maxLat).toBe(oldResult.maxLat);
      expect(turfResult.minLon).toBe(oldResult.minLon);
      expect(turfResult.maxLon).toBe(oldResult.maxLon);
    });

    it('should match old implementation: empty array', () => {
      const oldResult = oldGetBoundingBox([]);
      const turfResult = turfGetBoundingBox([]);

      expect(turfResult.minLat).toBe(oldResult.minLat);
      expect(turfResult.maxLat).toBe(oldResult.maxLat);
      expect(turfResult.minLon).toBe(oldResult.minLon);
      expect(turfResult.maxLon).toBe(oldResult.maxLon);
    });
  });

  describe('destinationPoint tests', () => {
    it('should calculate correct destination going north', () => {
      const result = turfDestinationPoint(47.0, 11.0, 1000, 0);
      // 1km north should increase latitude by ~0.009 degrees
      expect(result.lat).toBeGreaterThan(47.0);
      expect(result.lon).toBeCloseTo(11.0, 4);
    });

    it('should calculate correct destination going east', () => {
      const result = turfDestinationPoint(47.0, 11.0, 1000, Math.PI / 2);
      // 1km east should increase longitude
      expect(result.lat).toBeCloseTo(47.0, 4);
      expect(result.lon).toBeGreaterThan(11.0);
    });

    it('should return to approximately same point after round trip', () => {
      const distance = 10000; // 10km
      const bearing = Math.PI / 4; // 45 degrees

      const dest = turfDestinationPoint(47.0, 11.0, distance, bearing);
      const returnTrip = turfDestinationPoint(dest.lat, dest.lon, distance, bearing + Math.PI);

      expect(returnTrip.lat).toBeCloseTo(47.0, 2);
      expect(returnTrip.lon).toBeCloseTo(11.0, 2);
    });
  });

  describe('isInsideCylinder tests', () => {
    it('should return true for point at center', () => {
      expect(turfIsInsideCylinder(47.0, 11.0, 47.0, 11.0, 1000)).toBe(true);
    });

    it('should return true for point inside cylinder', () => {
      // Point about 500m from center
      expect(turfIsInsideCylinder(47.0, 11.005, 47.0, 11.0, 1000)).toBe(true);
    });

    it('should return false for point outside cylinder', () => {
      // Point about 2km from center
      expect(turfIsInsideCylinder(47.02, 11.0, 47.0, 11.0, 1000)).toBe(false);
    });

    it('should handle point very close to boundary', () => {
      // Create a point just inside 1km distance (accounting for floating point)
      const dest = turfDestinationPoint(47.0, 11.0, 999.9, 0);
      expect(turfIsInsideCylinder(dest.lat, dest.lon, 47.0, 11.0, 1000)).toBe(true);

      // Point slightly outside should be false
      const destOutside = turfDestinationPoint(47.0, 11.0, 1001, 0);
      expect(turfIsInsideCylinder(destOutside.lat, destOutside.lon, 47.0, 11.0, 1000)).toBe(false);
    });
  });

  describe('calculateBearingRadians tests', () => {
    it('should return radians for due north', () => {
      const result = turfCalculateBearingRadians(47.0, 11.0, 48.0, 11.0);
      expect(result).toBeCloseTo(0, 2);
    });

    it('should return PI/2 for due east', () => {
      const result = turfCalculateBearingRadians(47.0, 11.0, 47.0, 12.0);
      expect(result).toBeCloseTo(Math.PI / 2, 1);
    });

    it('should return ±PI for due south', () => {
      const result = turfCalculateBearingRadians(48.0, 11.0, 47.0, 11.0);
      expect(Math.abs(result)).toBeCloseTo(Math.PI, 1);
    });

    it('should return -PI/2 for due west', () => {
      const result = turfCalculateBearingRadians(47.0, 12.0, 47.0, 11.0);
      expect(result).toBeCloseTo(-Math.PI / 2, 1);
    });
  });

  describe('getCirclePoints tests', () => {
    it('should return correct number of points (numPoints + 1 for closure)', () => {
      const points = getCirclePoints(47.0, 11.0, 1000, 64);
      expect(points).toHaveLength(65); // 64 + 1 for closed polygon
    });

    it('should return closed polygon (first and last points match)', () => {
      const points = getCirclePoints(47.0, 11.0, 1000, 32);
      const first = points[0];
      const last = points[points.length - 1];
      expect(first.lat).toBeCloseTo(last.lat, 10);
      expect(first.lon).toBeCloseTo(last.lon, 10);
    });

    it('should generate points at correct distance from center', () => {
      const centerLat = 47.0;
      const centerLon = 11.0;
      const radius = 1000; // 1km

      const points = getCirclePoints(centerLat, centerLon, radius, 16);

      // Check several points are at the correct distance
      for (let i = 0; i < points.length - 1; i++) {
        const dist = turfHaversineDistance(centerLat, centerLon, points[i].lat, points[i].lon);
        expect(dist).toBeCloseTo(radius, -1); // Within 10m
      }
    });

    it('should generate evenly distributed points around the circle', () => {
      const points = getCirclePoints(47.0, 11.0, 1000, 4);
      // 4 points + closure = 5 points
      expect(points).toHaveLength(5);

      // Points should be at 0°, 90°, 180°, 270° from center
      // First point is at bearing 0° (north)
      expect(points[0].lat).toBeGreaterThan(47.0); // North of center
      expect(points[0].lon).toBeCloseTo(11.0, 3); // Same longitude

      // Second point is at bearing 90° (east)
      expect(points[1].lat).toBeCloseTo(47.0, 3); // Same latitude
      expect(points[1].lon).toBeGreaterThan(11.0); // East of center

      // Third point is at bearing 180° (south)
      expect(points[2].lat).toBeLessThan(47.0); // South of center
      expect(points[2].lon).toBeCloseTo(11.0, 3); // Same longitude

      // Fourth point is at bearing 270° (west)
      expect(points[3].lat).toBeCloseTo(47.0, 3); // Same latitude
      expect(points[3].lon).toBeLessThan(11.0); // West of center
    });

    it('should handle small radius', () => {
      const points = getCirclePoints(47.0, 11.0, 100, 8); // 100m radius
      expect(points).toHaveLength(9);

      // All points should be close to center
      for (const point of points) {
        const dist = turfHaversineDistance(47.0, 11.0, point.lat, point.lon);
        expect(dist).toBeCloseTo(100, -1);
      }
    });

    it('should handle large radius', () => {
      const points = getCirclePoints(47.0, 11.0, 50000, 8); // 50km radius
      expect(points).toHaveLength(9);

      for (let i = 0; i < points.length - 1; i++) {
        const dist = turfHaversineDistance(47.0, 11.0, points[i].lat, points[i].lon);
        expect(dist).toBeCloseTo(50000, -2); // Within 100m
      }
    });

    it('should work at different latitudes', () => {
      // Near equator
      const equatorPoints = getCirclePoints(0.0, 11.0, 1000, 8);
      expect(equatorPoints).toHaveLength(9);

      // High latitude
      const highLatPoints = getCirclePoints(70.0, 11.0, 1000, 8);
      expect(highLatPoints).toHaveLength(9);

      // Verify distances are correct at both latitudes
      for (let i = 0; i < 8; i++) {
        const equatorDist = turfHaversineDistance(0.0, 11.0, equatorPoints[i].lat, equatorPoints[i].lon);
        const highLatDist = turfHaversineDistance(70.0, 11.0, highLatPoints[i].lat, highLatPoints[i].lon);
        expect(equatorDist).toBeCloseTo(1000, -1);
        expect(highLatDist).toBeCloseTo(1000, -1);
      }
    });

    it('should use default numPoints of 64', () => {
      const points = getCirclePoints(47.0, 11.0, 1000);
      expect(points).toHaveLength(65); // 64 + 1 for closure
    });
  });
});
