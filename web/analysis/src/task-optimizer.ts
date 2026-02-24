/**
 * Task Optimization
 *
 * Calculates the optimized (shortest) path through a competition task by finding
 * the optimal point to tag each turnpoint cylinder. Works with any task source
 * (XCTask from .xctsk files, IGC task declarations, AirScore tasks, etc.).
 *
 * @see /docs/optimized-task-line-spec.md - Full algorithm documentation
 * @see https://github.com/LK8000/LK8000/pull/286 - LK8000 task optimization
 * @see https://github.com/teobouvard/igclib - Python task optimization library
 */

import {
  haversineDistance,
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
 * This is a constrained optimization problem where we search for the angle θ ∈ [0, 2π]
 * that minimizes the cost function. The cost function is unimodal (has a single minimum),
 * making golden section search an efficient choice.
 *
 * Golden section search has linear convergence and requires O(log(1/ε)) iterations
 * where ε is the tolerance (1e-5). For typical cases, this means ~30 iterations.
 *
 * @param prevLat Latitude of the previous optimized point
 * @param prevLon Longitude of the previous optimized point
 * @param centerLat Latitude of the current turnpoint center
 * @param centerLon Longitude of the current turnpoint center
 * @param radius Radius of the current turnpoint cylinder (in meters)
 * @param nextLat Latitude of the next turnpoint center
 * @param nextLon Longitude of the next turnpoint center
 * @returns The optimal point on the cylinder's perimeter
 *
 * @see https://en.wikipedia.org/wiki/Golden-section_search
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
  // Cost function: total distance through a point on the circle
  const cost = (angle: number): number => {
    const point = destinationPoint(centerLat, centerLon, radius, angle);
    const d1 = haversineDistance(prevLat, prevLon, point.lat, point.lon);
    const d2 = haversineDistance(point.lat, point.lon, nextLat, nextLon);
    return d1 + d2;
  };

  // Golden section search for minimum
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
 * Calculate the optimized task line that tags the edges of turnpoint cylinders
 * rather than going through their centers.
 *
 * This algorithm finds the shortest achievable distance through a competition task
 * by determining the optimal point to tag each turnpoint cylinder. Each cylinder
 * contributes exactly ONE point to the path.
 *
 * Algorithm:
 * - First turnpoint: Point on circle along bearing toward next turnpoint
 * - Intermediate turnpoints: Use golden section search to minimize total distance
 * - Last turnpoint: Point on circle along bearing from previous optimized point (entry side)
 *
 * The optimization for intermediate turnpoints is greedy (considers only adjacent
 * points) but is computationally efficient and matches the behavior of professional
 * scoring systems like XContest, XCTrack, AirScore, and LK8000.
 *
 * Mathematical formulation:
 * For each turnpoint i, find point pᵢ on circle i such that:
 *   min Σ distance(pᵢ₋₁, pᵢ) + distance(pᵢ, pᵢ₊₁)
 *
 * @param task The competition task with turnpoint cylinders
 * @returns Array of lat/lon coordinates representing the optimized path
 *
 * @example
 * const task = await fetchTaskByCode('BUJE');
 * const optimizedPath = calculateOptimizedTaskLine(task);
 * // Returns: [{lat: 45.123, lon: 13.456}, {lat: 45.234, lon: 13.567}, ...]
 */
export function calculateOptimizedTaskLine(task: XCTask): { lat: number; lon: number }[] {
  if (task.turnpoints.length === 0) return [];
  if (task.turnpoints.length === 1) {
    // Single turnpoint - just return its center
    return [{ lat: task.turnpoints[0].waypoint.lat, lon: task.turnpoints[0].waypoint.lon }];
  }

  if (task.turnpoints.length === 2) {
    // Two turnpoints - simple case: find points along line between centers
    const tp1 = task.turnpoints[0];
    const tp2 = task.turnpoints[1];

    const bearing = calculateBearingRadians(
      tp1.waypoint.lat,
      tp1.waypoint.lon,
      tp2.waypoint.lat,
      tp2.waypoint.lon
    );

    return [
      destinationPoint(tp1.waypoint.lat, tp1.waypoint.lon, tp1.radius, bearing),
      destinationPoint(tp2.waypoint.lat, tp2.waypoint.lon, tp2.radius, bearing + Math.PI)
    ];
  }

  // Three or more turnpoints - optimize each point
  const path: { lat: number; lon: number }[] = [];

  for (let i = 0; i < task.turnpoints.length; i++) {
    const tp = task.turnpoints[i];

    if (i === 0) {
      // First turnpoint: point along line towards next
      const next = task.turnpoints[i + 1];
      const bearing = calculateBearingRadians(
        tp.waypoint.lat,
        tp.waypoint.lon,
        next.waypoint.lat,
        next.waypoint.lon
      );
      path.push(destinationPoint(tp.waypoint.lat, tp.waypoint.lon, tp.radius, bearing));
    } else if (i === task.turnpoints.length - 1) {
      // Last turnpoint (goal): entry point on cylinder nearest to previous optimized point
      const prevPoint = path[path.length - 1];
      const bearing = calculateBearingRadians(
        prevPoint.lat,
        prevPoint.lon,
        tp.waypoint.lat,
        tp.waypoint.lon
      );
      path.push(destinationPoint(tp.waypoint.lat, tp.waypoint.lon, tp.radius, bearing + Math.PI));
    } else {
      // Intermediate turnpoint: find optimal point minimizing total distance
      const prevPoint = path[path.length - 1]; // Use the already optimized previous point
      const next = task.turnpoints[i + 1];

      const optimal = findOptimalCirclePoint(
        prevPoint.lat,
        prevPoint.lon,
        tp.waypoint.lat,
        tp.waypoint.lon,
        tp.radius,
        next.waypoint.lat,
        next.waypoint.lon
      );

      path.push(optimal);
    }
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
    totalDistance += haversineDistance(
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
      haversineDistance(
        path[i - 1].lat,
        path[i - 1].lon,
        path[i].lat,
        path[i].lon
      )
    );
  }

  return distances;
}
