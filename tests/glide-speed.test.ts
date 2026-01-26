import { describe, it, expect } from 'vitest';
import {
  calculateGlideMarkers,
  calculateGlidePositions,
  calculateTotalGlideDistance,
  haversineDistance,
  GlideMarker,
} from '../pages/src/analysis/glide-speed';
import type { IGCFix } from '../pages/src/analysis/igc-parser';

/**
 * Helper to create a fix at a specific position and time
 */
function createFix(
  timeSeconds: number,
  lat: number,
  lon: number,
  altitude: number = 1000
): IGCFix {
  const time = new Date('2024-01-15T10:00:00Z');
  time.setSeconds(time.getSeconds() + timeSeconds);

  return {
    time,
    latitude: lat,
    longitude: lon,
    pressureAltitude: altitude,
    gnssAltitude: altitude,
    valid: true,
  };
}

/**
 * Create a straight glide of a specific distance.
 * The glide goes due east from the start point.
 * Creates fixes at exact distance intervals to ensure precise distance.
 * 
 * Note: Due to the spherical earth model (haversine), there's a small discrepancy
 * between the intended distance and calculated distance. We compensate by slightly
 * overshooting the longitude to ensure the glide reaches the target distance.
 * 
 * @param distanceMeters - Total distance of the glide
 * @param speedMs - Speed in meters per second
 * @param startLat - Starting latitude
 * @param startLon - Starting longitude
 * @param fixIntervalMeters - Distance between fixes (default 10 meters)
 */
function createStraightGlide(
  distanceMeters: number,
  speedMs: number,
  startLat: number = 47.0,
  startLon: number = 11.0,
  fixIntervalMeters: number = 10
): IGCFix[] {
  const fixes: IGCFix[] = [];
  
  // Calculate longitude change for the distance (going due east)
  // At latitude 47°, 1 degree of longitude ≈ 75km
  const metersPerDegreeLon = 111320 * Math.cos(startLat * Math.PI / 180);
  // Add 0.15% to compensate for haversine vs simple distance calculation
  const totalLonChange = (distanceMeters * 1.0015) / metersPerDegreeLon;
  
  const numFixes = Math.floor(distanceMeters / fixIntervalMeters) + 1;

  for (let i = 0; i < numFixes; i++) {
    const distance = Math.min(i * fixIntervalMeters, distanceMeters);
    const progress = distance / distanceMeters;
    const lon = startLon + progress * totalLonChange;
    const timeSeconds = distance / speedMs;
    
    fixes.push(createFix(timeSeconds, startLat, lon));
  }
  
  // Ensure we have a fix at exactly the end distance
  if ((numFixes - 1) * fixIntervalMeters < distanceMeters) {
    const timeSeconds = distanceMeters / speedMs;
    const lon = startLon + totalLonChange;
    fixes.push(createFix(timeSeconds, startLat, lon));
  }

  return fixes;
}

describe('Glide Speed Calculations', () => {
  describe('haversineDistance', () => {
    it('should calculate distance between two points', () => {
      // Approximately 111km between 1 degree of latitude
      const distance = haversineDistance(47.0, 11.0, 48.0, 11.0);
      expect(distance).toBeCloseTo(111195, -2); // Within 100m
    });

    it('should return 0 for same point', () => {
      const distance = haversineDistance(47.0, 11.0, 47.0, 11.0);
      expect(distance).toBe(0);
    });
  });

  describe('calculateTotalGlideDistance', () => {
    it('should return 0 for empty fixes', () => {
      expect(calculateTotalGlideDistance([])).toBe(0);
    });

    it('should return 0 for single fix', () => {
      const fixes = [createFix(0, 47.0, 11.0)];
      expect(calculateTotalGlideDistance(fixes)).toBe(0);
    });

    it('should calculate correct distance for a straight glide', () => {
      const fixes = createStraightGlide(500, 10); // 500m at 10 m/s
      const distance = calculateTotalGlideDistance(fixes);
      expect(distance).toBeCloseTo(500, -1); // Within 10m
    });
  });

  describe('calculateGlidePositions', () => {
    it('should return empty for glide shorter than interval', () => {
      const fixes = createStraightGlide(200, 10); // 200m glide
      const positions = calculateGlidePositions(fixes, 250);
      expect(positions).toHaveLength(0);
    });

    it('should return one position for 300m glide with 250m interval', () => {
      const fixes = createStraightGlide(300, 10); // 300m glide
      const positions = calculateGlidePositions(fixes, 250);
      expect(positions).toHaveLength(1);
      expect(positions[0].distance).toBe(250);
    });

    it('should return one position for 499m glide with 250m interval', () => {
      const fixes = createStraightGlide(499, 10); // 499m glide
      const positions = calculateGlidePositions(fixes, 250);
      expect(positions).toHaveLength(1);
      expect(positions[0].distance).toBe(250);
    });

    it('should return two positions for 500m glide with 250m interval', () => {
      const fixes = createStraightGlide(500, 10); // 500m glide
      const positions = calculateGlidePositions(fixes, 250);
      expect(positions).toHaveLength(2);
      expect(positions[0].distance).toBe(250);
      expect(positions[1].distance).toBe(500);
    });

    it('should return two positions for 501m glide with 250m interval', () => {
      const fixes = createStraightGlide(501, 10); // 501m glide
      const positions = calculateGlidePositions(fixes, 250);
      expect(positions).toHaveLength(2);
      expect(positions[0].distance).toBe(250);
      expect(positions[1].distance).toBe(500);
    });

    it('should return three positions for 750m glide with 250m interval', () => {
      const fixes = createStraightGlide(750, 10); // 750m glide
      const positions = calculateGlidePositions(fixes, 250);
      expect(positions).toHaveLength(3);
      expect(positions[0].distance).toBe(250);
      expect(positions[1].distance).toBe(500);
      expect(positions[2].distance).toBe(750);
    });
  });

  describe('calculateGlideMarkers', () => {
    it('should return no markers for 200m glide', () => {
      const fixes = createStraightGlide(200, 10);
      const markers = calculateGlideMarkers(fixes);
      expect(markers).toHaveLength(0);
    });

    it('should return one speed label for 300m glide', () => {
      const fixes = createStraightGlide(300, 10); // 300m at 10 m/s = 30s
      const markers = calculateGlideMarkers(fixes);
      
      expect(markers).toHaveLength(1);
      expect(markers[0].type).toBe('speed-label');
      // Speed label at 250m, but only 300m total, so speed calc is partial
    });

    it('should calculate correct speed for partial segment (no chevron)', () => {
      // 400m glide at 10 m/s - only has label at 250m, no chevron at 500m
      // Speed should be based on 250m segment, NOT 500m
      // Time to 250m = 25s, so speed = 250m / 25s = 10 m/s
      const fixes = createStraightGlide(400, 10);
      const markers = calculateGlideMarkers(fixes);

      expect(markers).toHaveLength(1);
      expect(markers[0].type).toBe('speed-label');
      // Speed should be 10 m/s
      expect(markers[0].speedMps).toBeCloseTo(10, 0);
    });

    it('should return one speed label for 499m glide', () => {
      const fixes = createStraightGlide(499, 10);
      const markers = calculateGlideMarkers(fixes);
      
      expect(markers).toHaveLength(1);
      expect(markers[0].type).toBe('speed-label');
    });

    it('should return one speed label and one chevron for 500m glide', () => {
      const fixes = createStraightGlide(500, 10); // 500m at 10 m/s = 50s
      const markers = calculateGlideMarkers(fixes);
      
      expect(markers).toHaveLength(2);
      expect(markers[0].type).toBe('speed-label');
      expect(markers[1].type).toBe('chevron');
    });

    it('should return one speed label and one chevron for 501m glide', () => {
      const fixes = createStraightGlide(501, 10);
      const markers = calculateGlideMarkers(fixes);
      
      expect(markers).toHaveLength(2);
      expect(markers[0].type).toBe('speed-label');
      expect(markers[1].type).toBe('chevron');
    });

    it('should return two speed labels and one chevron for 750m glide', () => {
      const fixes = createStraightGlide(750, 10); // 750m at 10 m/s = 75s
      const markers = calculateGlideMarkers(fixes);
      
      expect(markers).toHaveLength(3);
      expect(markers[0].type).toBe('speed-label');
      expect(markers[1].type).toBe('chevron');
      expect(markers[2].type).toBe('speed-label');
    });

    it('should calculate correct speed for constant velocity glide', () => {
      // 1000m at 10 m/s = 100 seconds
      const fixes = createStraightGlide(1000, 10);
      const markers = calculateGlideMarkers(fixes);

      // Should have: speed@250m, chevron@500m, speed@750m, chevron@1000m
      expect(markers).toHaveLength(4);

      const speedLabels = markers.filter(m => m.type === 'speed-label');
      expect(speedLabels).toHaveLength(2);

      // Both speed labels should show ~10 m/s
      for (const label of speedLabels) {
        expect(label.speedMps).toBeCloseTo(10, 0);
      }
    });

    it('should calculate correct speed for faster glide', () => {
      // 1000m at 20 m/s = 50 seconds
      const fixes = createStraightGlide(1000, 20);
      const markers = calculateGlideMarkers(fixes);

      const speedLabels = markers.filter(m => m.type === 'speed-label');

      for (const label of speedLabels) {
        expect(label.speedMps).toBeCloseTo(20, 0);
      }
    });

    it('should calculate correct speed for slower glide', () => {
      // 1000m at 5 m/s = 200 seconds
      const fixes = createStraightGlide(1000, 5);
      const markers = calculateGlideMarkers(fixes);

      const speedLabels = markers.filter(m => m.type === 'speed-label');

      for (const label of speedLabels) {
        expect(label.speedMps).toBeCloseTo(5, 0);
      }
    });

    it('should handle varying speed segments', () => {
      // Create a glide with two segments at different speeds
      // First 500m at 10 m/s (50s), then 500m at 20 m/s (25s)
      const startLat = 47.0;
      const startLon = 11.0;
      const metersPerDegreeLon = 111320 * Math.cos(startLat * Math.PI / 180);
      // Add 0.15% compensation for haversine vs simple distance calculation
      const distanceCompensation = 1.0015;
      
      const fixes: IGCFix[] = [];
      
      // First segment: 0-500m at 10 m/s (50 seconds)
      for (let t = 0; t <= 50; t += 1) {
        const distance = t * 10; // 10 m/s
        const lon = startLon + (distance * distanceCompensation) / metersPerDegreeLon;
        fixes.push(createFix(t, startLat, lon));
      }
      
      // Second segment: 500-1000m at 20 m/s (25 seconds, starting at t=50)
      for (let t = 1; t <= 25; t += 1) {
        const distance = 500 + t * 20; // Starting at 500m, 20 m/s
        const lon = startLon + (distance * distanceCompensation) / metersPerDegreeLon;
        fixes.push(createFix(50 + t, startLat, lon));
      }
      
      const markers = calculateGlideMarkers(fixes);
      
      // Should have markers at 250m (label), 500m (chevron), 750m (label), 1000m (chevron)
      expect(markers).toHaveLength(4);
      
      const speedLabels = markers.filter(m => m.type === 'speed-label') as GlideMarker[];
      expect(speedLabels).toHaveLength(2);

      // First speed label (at 250m) covers 0-500m segment at 10 m/s
      expect(speedLabels[0].speedMps).toBeCloseTo(10, 0);

      // Second speed label (at 750m) covers 500-1000m segment at 20 m/s
      expect(speedLabels[1].speedMps).toBeCloseTo(20, 0);
    });
  });

  describe('edge cases', () => {
    it('should handle empty fixes array', () => {
      const markers = calculateGlideMarkers([]);
      expect(markers).toHaveLength(0);
    });

    it('should handle single fix', () => {
      const fixes = [createFix(0, 47.0, 11.0)];
      const markers = calculateGlideMarkers(fixes);
      expect(markers).toHaveLength(0);
    });

    it('should handle two fixes very close together', () => {
      const fixes = [
        createFix(0, 47.0, 11.0),
        createFix(1, 47.0, 11.00001), // ~1m apart
      ];
      const markers = calculateGlideMarkers(fixes);
      expect(markers).toHaveLength(0);
    });
  });
});
