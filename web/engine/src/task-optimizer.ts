/**
 * Task Optimization
 *
 * Calculates the optimized (shortest) path through a competition task by finding
 * the optimal point to tag each turnpoint cylinder. Uses iterative convergence
 * matching the CIVL GAP specification (Section 7F, Annex A).
 *
 * @see /docs/optimized-task-line-spec.md - Full algorithm documentation
 * @see /docs/research/task-optimization-comparison.md - Comparison with AirScore/CIVL
 */

import {
  andoyerDistance,
  calculateBearingRadians,
  destinationPoint
} from './geo';

import type { XCTask } from './xctsk-parser';

/**
 * Find the optimal point on a circle that minimizes total path distance.
 *
 * For a circle at position (centerLat, centerLon) with radius r, find the point
 * on its perimeter that minimizes: distance(prevPoint, circlePoint) + distance(circlePoint, nextPoint)
 *
 * Uses golden section search — the cost function is unimodal (single minimum),
 * so this converges in O(log(1/ε)) iterations (~30 for ε=1e-5).
 */
function findOptimalCirclePoint(
  prevLat: number,
  prevLon: number,
  centerLat: number,
  centerLon: number,
  radius: number,
  nextLat: number,
  nextLon: number
): { lat: number; lon: number } {
  const cost = (angle: number): number => {
    const point = destinationPoint(centerLat, centerLon, radius, angle);
    const d1 = andoyerDistance(prevLat, prevLon, point.lat, point.lon);
    const d2 = andoyerDistance(point.lat, point.lon, nextLat, nextLon);
    return d1 + d2;
  };

  const phi = (1 + Math.sqrt(5)) / 2;
  const resphi = 2 - phi;

  let a = 0;
  let b = 2 * Math.PI;
  const tol = 1e-5;

  let x1 = a + resphi * (b - a);
  let x2 = b - resphi * (b - a);
  let f1 = cost(x1);
  let f2 = cost(x2);

  while (Math.abs(b - a) > tol) {
    if (f1 < f2) {
      b = x2;
      x2 = x1;
      f2 = f1;
      x1 = a + resphi * (b - a);
      f1 = cost(x1);
    } else {
      a = x1;
      x1 = x2;
      f1 = f2;
      x2 = b - resphi * (b - a);
      f2 = cost(x2);
    }
  }

  const optimalAngle = (a + b) / 2;
  return destinationPoint(centerLat, centerLon, radius, optimalAngle);
}

/**
 * Run a single forward pass of the optimization, producing one touching
 * point per turnpoint cylinder.
 *
 * For intermediate turnpoints, each point is optimized using the previous
 * optimized point and the next point (either the next already-optimized
 * point from a previous iteration, or the next turnpoint center on the
 * first pass).
 */
function optimizePass(
  task: XCTask,
  previousPath: { lat: number; lon: number }[] | null
): { lat: number; lon: number }[] {
  const path: { lat: number; lon: number }[] = [];
  const n = task.turnpoints.length;

  for (let i = 0; i < n; i++) {
    const tp = task.turnpoints[i];

    if (i === 0) {
      // First turnpoint: point toward next optimized point (or center on first pass)
      const nextPoint = previousPath
        ? previousPath[1]
        : { lat: task.turnpoints[1].waypoint.lat, lon: task.turnpoints[1].waypoint.lon };
      const bearing = calculateBearingRadians(
        tp.waypoint.lat, tp.waypoint.lon,
        nextPoint.lat, nextPoint.lon
      );
      path.push(destinationPoint(tp.waypoint.lat, tp.waypoint.lon, tp.radius, bearing));
    } else if (i === n - 1) {
      // Last turnpoint: entry point nearest to previous optimized point
      const prevPoint = path[path.length - 1];
      const bearing = calculateBearingRadians(
        prevPoint.lat, prevPoint.lon,
        tp.waypoint.lat, tp.waypoint.lon
      );
      path.push(destinationPoint(tp.waypoint.lat, tp.waypoint.lon, tp.radius, bearing + Math.PI));
    } else {
      // Intermediate: minimize distance through this cylinder
      const prevPoint = path[path.length - 1];
      // Use next optimized point from previous iteration if available,
      // otherwise fall back to next turnpoint center
      const nextPoint = previousPath
        ? previousPath[i + 1]
        : { lat: task.turnpoints[i + 1].waypoint.lat, lon: task.turnpoints[i + 1].waypoint.lon };

      path.push(findOptimalCirclePoint(
        prevPoint.lat, prevPoint.lon,
        tp.waypoint.lat, tp.waypoint.lon,
        tp.radius,
        nextPoint.lat, nextPoint.lon
      ));
    }
  }

  return path;
}

/** Sum path distance for a sequence of points */
function pathDistance(path: { lat: number; lon: number }[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    total += andoyerDistance(path[i - 1].lat, path[i - 1].lon, path[i].lat, path[i].lon);
  }
  return total;
}

/**
 * Calculate the optimized task line with iterative convergence.
 *
 * Runs multiple forward passes, each time using the previous iteration's
 * optimized points as targets for the next turnpoint. Converges when the
 * total path distance changes by less than 1 meter between iterations.
 *
 * This matches the CIVL GAP specification (Annex A) approach of iterating
 * until no further distance reduction occurs.
 *
 * @param task The competition task with turnpoint cylinders
 * @returns Array of lat/lon coordinates representing the optimized path
 */
export function calculateOptimizedTaskLine(task: XCTask): { lat: number; lon: number }[] {
  if (task.turnpoints.length === 0) return [];
  if (task.turnpoints.length === 1) {
    return [{ lat: task.turnpoints[0].waypoint.lat, lon: task.turnpoints[0].waypoint.lon }];
  }

  if (task.turnpoints.length === 2) {
    const tp1 = task.turnpoints[0];
    const tp2 = task.turnpoints[1];
    const bearing = calculateBearingRadians(
      tp1.waypoint.lat, tp1.waypoint.lon,
      tp2.waypoint.lat, tp2.waypoint.lon
    );
    return [
      destinationPoint(tp1.waypoint.lat, tp1.waypoint.lon, tp1.radius, bearing),
      destinationPoint(tp2.waypoint.lat, tp2.waypoint.lon, tp2.radius, bearing + Math.PI)
    ];
  }

  // First pass: no previous path to reference
  let path = optimizePass(task, null);
  let prevDistance = pathDistance(path);

  // Iterate until convergence (< 1m change) or max iterations
  const maxIterations = task.turnpoints.length * 10;
  for (let iter = 0; iter < maxIterations; iter++) {
    const newPath = optimizePass(task, path);
    const newDistance = pathDistance(newPath);

    if (prevDistance - newDistance < 1.0) break;

    path = newPath;
    prevDistance = newDistance;
  }

  return path;
}

/**
 * Calculate the optimized task distance (sum of all line segments).
 *
 * This is the shortest achievable distance through the task by optimally
 * tagging each turnpoint cylinder. The distance is computed as the sum
 * of great circle distances between consecutive optimized points.
 *
 * @param task The competition task with turnpoint cylinders
 * @returns Total optimized distance in meters
 *
 * @example
 * const task = await fetchTaskByCode('BUJE');
 * const distance = calculateOptimizedTaskDistance(task);
 * console.log(`Task distance: ${(distance / 1000).toFixed(2)} km`);
 * // Output: "Task distance: 133.08 km"
 */
export function calculateOptimizedTaskDistance(task: XCTask): number {
  const path = calculateOptimizedTaskLine(task);
  if (path.length < 2) return 0;

  let totalDistance = 0;
  for (let i = 1; i < path.length; i++) {
    totalDistance += andoyerDistance(
      path[i - 1].lat,
      path[i - 1].lon,
      path[i].lat,
      path[i].lon
    );
  }

  return totalDistance;
}

/**
 * Get individual segment distances for the optimized path.
 *
 * Returns an array of distances (in meters) for each segment between
 * consecutive optimized points. Used for displaying distance labels
 * on each leg of the task line.
 *
 * @param task The competition task with turnpoint cylinders
 * @returns Array of distances in meters, one per segment
 *
 * @example
 * const task = await fetchTaskByCode('BUJE');
 * const segments = getOptimizedSegmentDistances(task);
 * segments.forEach((dist, i) => {
 *   console.log(`Leg ${i+1}: ${(dist / 1000).toFixed(1)} km`);
 * });
 * // Output:
 * // Leg 1: 7.2 km
 * // Leg 2: 23.6 km
 * // ...
 */
export function getOptimizedSegmentDistances(task: XCTask): number[] {
  const path = calculateOptimizedTaskLine(task);
  if (path.length < 2) return [];

  const distances: number[] = [];
  for (let i = 1; i < path.length; i++) {
    distances.push(
      andoyerDistance(
        path[i - 1].lat,
        path[i - 1].lon,
        path[i].lat,
        path[i].lon
      )
    );
  }

  return distances;
}
