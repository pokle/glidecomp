import { describe, it, expect } from 'bun:test';
import {
  calculateGlideMarkers,
  calculateGlidePositions,
  calculateTotalGlideDistance,
  calculatePointMetrics,
  GlideMarker,
  GlideContext,
  GlideContextResolver,
} from '../src/glide-speed';
import { haversineDistance } from '../src/geo';
import { createFix, type IGCFix } from './test-helpers';

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

    it('should return no markers for 300m glide', () => {
      const fixes = createStraightGlide(300, 10); // 300m at 10 m/s = 30s
      const markers = calculateGlideMarkers(fixes);

      expect(markers).toHaveLength(0);
    });

    it('should calculate correct speed for partial segment (no chevron)', () => {
      // 750m glide at 10 m/s - has label at 500m, no chevron at 1000m
      // Speed should be based on the partial 500m segment
      const fixes = createStraightGlide(750, 10);
      const markers = calculateGlideMarkers(fixes);

      expect(markers).toHaveLength(1);
      expect(markers[0].type).toBe('speed-label');
      expect(markers[0].speedMps).toBeCloseTo(10, 0);
    });

    it('should return no markers for 499m glide', () => {
      const fixes = createStraightGlide(499, 10);
      const markers = calculateGlideMarkers(fixes);

      expect(markers).toHaveLength(0);
    });

    it('should return one speed label for 500m glide', () => {
      const fixes = createStraightGlide(500, 10); // 500m at 10 m/s = 50s
      const markers = calculateGlideMarkers(fixes);

      expect(markers).toHaveLength(1);
      expect(markers[0].type).toBe('speed-label');
    });

    it('should return one speed label for 501m glide', () => {
      const fixes = createStraightGlide(501, 10);
      const markers = calculateGlideMarkers(fixes);

      expect(markers).toHaveLength(1);
      expect(markers[0].type).toBe('speed-label');
    });

    it('should return one speed label for 750m glide', () => {
      const fixes = createStraightGlide(750, 10); // 750m at 10 m/s = 75s
      const markers = calculateGlideMarkers(fixes);

      expect(markers).toHaveLength(1);
      expect(markers[0].type).toBe('speed-label');
    });

    it('should calculate correct speed for constant velocity glide', () => {
      // 1000m at 10 m/s = 100 seconds
      const fixes = createStraightGlide(1000, 10);
      const markers = calculateGlideMarkers(fixes);

      // Should have: speed@500m, chevron@1000m
      expect(markers).toHaveLength(2);

      const speedLabels = markers.filter(m => m.type === 'speed-label');
      expect(speedLabels).toHaveLength(1);
      expect(speedLabels[0].speedMps).toBeCloseTo(10, 0);
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

      // Should have markers at 500m (label), 1000m (chevron)
      expect(markers).toHaveLength(2);

      const speedLabels = markers.filter(m => m.type === 'speed-label') as GlideMarker[];
      expect(speedLabels).toHaveLength(1);

      // Single 1km segment average speed: 1000m / 75s = 13.3 m/s
      expect(speedLabels[0].speedMps).toBeCloseTo(13.3, 1);
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

  describe('required glide ratio', () => {
    it('should not include requiredGlideRatio when no context provided', () => {
      const fixes = createStraightGlide(1500, 10);
      const markers = calculateGlideMarkers(fixes);
      const labels = markers.filter(m => m.type === 'speed-label');
      expect(labels.length).toBeGreaterThan(0);
      for (const label of labels) {
        expect(label.requiredGlideRatio).toBeUndefined();
        expect(label.targetName).toBeUndefined();
      }
    });

    it('should not include requiredGlideRatio when nextTurnpoint is null', () => {
      const fixes = createStraightGlide(1500, 10);
      const context: GlideContext = { nextTurnpoint: null };
      const markers = calculateGlideMarkers(fixes, () => context);
      const labels = markers.filter(m => m.type === 'speed-label');
      expect(labels.length).toBeGreaterThan(0);
      for (const label of labels) {
        expect(label.requiredGlideRatio).toBeUndefined();
        expect(label.targetName).toBeUndefined();
      }
    });

    it('should calculate requiredGlideRatio when marker altitude above target', () => {
      // Create a 1500m glide at altitude 1000m (default), target TP at 500m altitude ~10km away
      const fixes = createStraightGlide(1500, 10, 47.0, 11.0);
      const context: GlideContext = {
        nextTurnpoint: { lat: 47.0, lon: 11.2, altitude: 500, name: 'TINTAL' },
      };
      const markers = calculateGlideMarkers(fixes, () => context);
      const labels = markers.filter(m => m.type === 'speed-label');
      expect(labels.length).toBeGreaterThan(0);
      for (const label of labels) {
        expect(label.requiredGlideRatio).toBeDefined();
        expect(label.targetName).toBe('TINTAL');
        // Required GR should be positive and reasonable
        expect(label.requiredGlideRatio!).toBeGreaterThan(0);
      }
    });

    it('should compute correct requiredGlideRatio for known values', () => {
      // Marker at (47.0, 11.0) altitude 1000m, target at (47.0, 11.132) altitude 500m
      // Distance ~10km, altitude diff 500m, so required GR ≈ 20
      const fixes = createStraightGlide(1500, 10, 47.0, 11.0);
      const targetLon = 11.0 + 10000 / (111320 * Math.cos(47.0 * Math.PI / 180));
      const context: GlideContext = {
        nextTurnpoint: { lat: 47.0, lon: targetLon, altitude: 500, name: 'GOAL' },
      };
      const markers = calculateGlideMarkers(fixes, () => context);
      const firstLabel = markers.find(m => m.type === 'speed-label');
      expect(firstLabel).toBeDefined();
      // The first label is at 500m into the glide, so distance to target
      // is slightly less than 10km. Required GR should be around 19-20.
      expect(firstLabel!.requiredGlideRatio!).toBeCloseTo(20, -1);
      expect(firstLabel!.targetName).toBe('GOAL');
    });

    it('should not include requiredGlideRatio when marker altitude below target', () => {
      // Create glide at altitude 1000m (default), target TP at 1500m altitude
      const fixes = createStraightGlide(1500, 10, 47.0, 11.0);
      const context: GlideContext = {
        nextTurnpoint: { lat: 47.0, lon: 11.2, altitude: 1500, name: 'HIGH_TP' },
      };
      const markers = calculateGlideMarkers(fixes, () => context);
      const labels = markers.filter(m => m.type === 'speed-label');
      expect(labels.length).toBeGreaterThan(0);
      for (const label of labels) {
        expect(label.requiredGlideRatio).toBeUndefined();
        expect(label.targetName).toBeUndefined();
      }
    });

    it('should not include requiredGlideRatio when marker altitude equals target', () => {
      // Create glide at altitude 1000m (default), target TP at 1000m altitude
      const fixes = createStraightGlide(1500, 10, 47.0, 11.0);
      const context: GlideContext = {
        nextTurnpoint: { lat: 47.0, lon: 11.2, altitude: 1000, name: 'LEVEL_TP' },
      };
      const markers = calculateGlideMarkers(fixes, () => context);
      const labels = markers.filter(m => m.type === 'speed-label');
      expect(labels.length).toBeGreaterThan(0);
      for (const label of labels) {
        expect(label.requiredGlideRatio).toBeUndefined();
        expect(label.targetName).toBeUndefined();
      }
    });

    it('should resolve different targets for markers before and after a turnpoint transition', () => {
      // 3500m glide at 10 m/s — produces labels at 500m, 1500m, 2500m, 3500m
      // The resolver switches from CUDG to NCORGL at t=200s (2000m into glide)
      const fixes = createStraightGlide(3500, 10, 47.0, 11.0);
      const startTime = fixes[0].time.getTime();
      const transitionTimeMs = startTime + 200 * 1000; // 200s = 2000m at 10m/s

      const contextBefore: GlideContext = {
        nextTurnpoint: { lat: 47.0, lon: 11.2, altitude: 500, name: 'CUDG' },
      };
      const contextAfter: GlideContext = {
        nextTurnpoint: { lat: 47.1, lon: 11.3, altitude: 600, name: 'NCORGL' },
      };

      const resolver: GlideContextResolver = (timeMs: number) =>
        timeMs < transitionTimeMs ? contextBefore : contextAfter;

      const markers = calculateGlideMarkers(fixes, resolver);
      const labels = markers.filter(m => m.type === 'speed-label');

      // Should have labels at 500m, 1500m, 2500m, 3500m
      expect(labels.length).toBeGreaterThanOrEqual(3);

      // Labels before transition (500m @ 50s, 1500m @ 150s) should target CUDG
      const beforeLabels = labels.filter(l => l.targetName === 'CUDG');
      expect(beforeLabels.length).toBeGreaterThanOrEqual(1);

      // Labels after transition (2500m @ 250s, 3500m @ 350s) should target NCORGL
      const afterLabels = labels.filter(l => l.targetName === 'NCORGL');
      expect(afterLabels.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('calculatePointMetrics', () => {
    it('should return null for empty fixes', () => {
      expect(calculatePointMetrics([], 0, 1000)).toBeNull();
    });

    it('should return null for single fix', () => {
      const fixes = [createFix(0, 47.0, 11.0)];
      expect(calculatePointMetrics(fixes, 0, 1000)).toBeNull();
    });

    it('should return null for out-of-bounds index', () => {
      const fixes = createStraightGlide(2000, 10);
      expect(calculatePointMetrics(fixes, -1, 1000)).toBeNull();
      expect(calculatePointMetrics(fixes, fixes.length, 1000)).toBeNull();
    });

    it('should compute correct speed for a straight glide', () => {
      // 3000m glide at 15 m/s, sample from the middle
      const fixes = createStraightGlide(3000, 15);
      const midIndex = Math.floor(fixes.length / 2);
      const metrics = calculatePointMetrics(fixes, midIndex, 1000);

      expect(metrics).not.toBeNull();
      expect(metrics!.speedMps).toBeCloseTo(15, 0);
    });

    it('should work near the start of a track', () => {
      const fixes = createStraightGlide(2000, 10);
      // Index 1 is very near the start — backward walk is short
      const metrics = calculatePointMetrics(fixes, 1, 1000);
      expect(metrics).not.toBeNull();
      expect(metrics!.speedMps).toBeCloseTo(10, 0);
    });

    it('should work near the end of a track', () => {
      const fixes = createStraightGlide(2000, 10);
      const metrics = calculatePointMetrics(fixes, fixes.length - 2, 1000);
      expect(metrics).not.toBeNull();
      expect(metrics!.speedMps).toBeCloseTo(10, 0);
    });

    it('should compute glide ratio for descending flight', () => {
      // Create fixes that descend: start at 1000m, end at 900m over 1km
      const fixes: IGCFix[] = [];
      const startLat = 47.0;
      const startLon = 11.0;
      const metersPerDegreeLon = 111320 * Math.cos(startLat * Math.PI / 180);
      const distanceCompensation = 1.0015;

      for (let i = 0; i <= 100; i++) {
        const distance = i * 20; // 20m intervals, 2000m total
        const lon = startLon + (distance * distanceCompensation) / metersPerDegreeLon;
        const altitude = 1000 - (i * 1); // Descend 1m per fix = 100m over 2000m
        fixes.push(createFix(i * 2, startLat, lon, altitude)); // 10 m/s
      }

      const midIndex = 50;
      const metrics = calculatePointMetrics(fixes, midIndex, 1000);
      expect(metrics).not.toBeNull();
      expect(metrics!.glideRatio).toBeDefined();
      // ~1000m distance / ~50m altitude loss = ~20:1
      expect(metrics!.glideRatio!).toBeCloseTo(20, -1);
      expect(metrics!.altitudeDiff).toBeLessThan(0);
    });

    it('should return undefined glide ratio for climbing flight', () => {
      const fixes: IGCFix[] = [];
      const startLat = 47.0;
      const startLon = 11.0;
      const metersPerDegreeLon = 111320 * Math.cos(startLat * Math.PI / 180);

      for (let i = 0; i <= 50; i++) {
        const distance = i * 20;
        const lon = startLon + (distance * 1.0015) / metersPerDegreeLon;
        const altitude = 1000 + i * 2; // Climbing
        fixes.push(createFix(i * 2, startLat, lon, altitude));
      }

      const metrics = calculatePointMetrics(fixes, 25, 1000);
      expect(metrics).not.toBeNull();
      expect(metrics!.glideRatio).toBeUndefined();
      expect(metrics!.altitudeDiff).toBeGreaterThan(0);
    });

    it('should compute required GR with context', () => {
      const fixes = createStraightGlide(2000, 10); // altitude 1000m (default)
      const targetLon = 11.0 + 10000 / (111320 * Math.cos(47.0 * Math.PI / 180));
      const context: GlideContext = {
        nextTurnpoint: { lat: 47.0, lon: targetLon, altitude: 500, name: 'GOAL' },
      };
      const midIndex = Math.floor(fixes.length / 2);
      const metrics = calculatePointMetrics(fixes, midIndex, 1000, context);

      expect(metrics).not.toBeNull();
      expect(metrics!.requiredGlideRatio).toBeDefined();
      expect(metrics!.targetName).toBe('GOAL');
      expect(metrics!.requiredGlideRatio!).toBeGreaterThan(0);
    });

    it('should not compute required GR without context', () => {
      const fixes = createStraightGlide(2000, 10);
      const midIndex = Math.floor(fixes.length / 2);
      const metrics = calculatePointMetrics(fixes, midIndex, 1000);

      expect(metrics).not.toBeNull();
      expect(metrics!.requiredGlideRatio).toBeUndefined();
      expect(metrics!.targetName).toBeUndefined();
    });

    it('should not compute required GR when below target altitude', () => {
      const fixes = createStraightGlide(2000, 10); // altitude 1000m
      const context: GlideContext = {
        nextTurnpoint: { lat: 47.0, lon: 11.2, altitude: 1500, name: 'HIGH' },
      };
      const midIndex = Math.floor(fixes.length / 2);
      const metrics = calculatePointMetrics(fixes, midIndex, 1000, context);

      expect(metrics).not.toBeNull();
      expect(metrics!.requiredGlideRatio).toBeUndefined();
      expect(metrics!.targetName).toBeUndefined();
    });
  });
});
