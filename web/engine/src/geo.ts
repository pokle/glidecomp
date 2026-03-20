/**
 * Centralized Geographic Math Module
 *
 * Provides geographic calculations using Turf.js as the underlying implementation.
 * All functions maintain the same signatures as the original implementations for
 * drop-in replacement compatibility.
 *
 * Note: Turf.js uses [longitude, latitude] (GeoJSON standard) while this codebase
 * uses (latitude, longitude). These wrapper functions handle the coordinate swap.
 */

import { bearing } from '@turf/bearing';
import { destination } from '@turf/destination';
import { bbox } from '@turf/bbox';
import { point, lineString } from '@turf/helpers';

// WGS84 ellipsoid constants
const WGS84_A = 6378137.0; // semi-major axis (meters)
const WGS84_F = 1 / 298.257223563; // flattening

// Define minimal interface to avoid circular dependency with igc-parser
interface LatLonPoint {
  latitude: number;
  longitude: number;
}

/**
 * Calculate distance between two coordinates using the Andoyer-Lambert formula.
 *
 * Uses the WGS84 ellipsoid for accurate geodesic distance. This is significantly
 * more accurate than Haversine (spherical), matching Vincenty to within ~2 ppm,
 * while being non-iterative and fast.
 *
 * @param lat1 - Latitude of first point (degrees)
 * @param lon1 - Longitude of first point (degrees)
 * @param lat2 - Latitude of second point (degrees)
 * @param lon2 - Longitude of second point (degrees)
 * @returns Distance in meters
 */
export function andoyerDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const toRad = Math.PI / 180;
  const phi1 = lat1 * toRad, phi2 = lat2 * toRad;
  const dLambda = (lon2 - lon1) * toRad;
  const F = (phi1 + phi2) / 2, G = (phi1 - phi2) / 2;
  const sinG = Math.sin(G), cosG = Math.cos(G);
  const sinF = Math.sin(F), cosF = Math.cos(F);
  const sinHL = Math.sin(dLambda / 2), cosHL = Math.cos(dLambda / 2);
  const S = sinG * sinG * cosHL * cosHL + cosF * cosF * sinHL * sinHL;
  const C = cosG * cosG * cosHL * cosHL + sinF * sinF * sinHL * sinHL;
  if (S === 0 || C === 0) return 0;
  const omega = Math.atan(Math.sqrt(S / C));
  const R = Math.sqrt(S * C) / omega;
  const D = 2 * omega * WGS84_A;
  const H1 = (3 * R - 1) / (2 * C);
  const H2 = (3 * R + 1) / (2 * S);
  return D * (1 + WGS84_F * (H1 * sinF * sinF * cosG * cosG - H2 * cosF * cosF * sinG * sinG));
}


/**
 * Calculate bearing from point 1 to point 2 in degrees.
 *
 * @param lat1 - Latitude of start point (degrees)
 * @param lon1 - Longitude of start point (degrees)
 * @param lat2 - Latitude of end point (degrees)
 * @param lon2 - Longitude of end point (degrees)
 * @returns Bearing in degrees, between -180 and 180 (positive clockwise from north)
 */
export function calculateBearing(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  // Turf uses [lon, lat] (GeoJSON format)
  const from = point([lon1, lat1]);
  const to = point([lon2, lat2]);

  return bearing(from, to);
}

/**
 * Calculate bearing from point 1 to point 2 in radians.
 * Used internally by xctsk-parser for task optimization.
 *
 * @param lat1 - Latitude of start point (degrees)
 * @param lon1 - Longitude of start point (degrees)
 * @param lat2 - Latitude of end point (degrees)
 * @param lon2 - Longitude of end point (degrees)
 * @returns Bearing in radians
 */
export function calculateBearingRadians(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const bearingDegrees = calculateBearing(lat1, lon1, lat2, lon2);
  return bearingDegrees * Math.PI / 180;
}

/**
 * Calculate a destination point given distance and bearing from start point.
 *
 * @param lat - Starting latitude in degrees
 * @param lon - Starting longitude in degrees
 * @param distanceMeters - Distance in meters
 * @param bearingRadians - Bearing in radians
 * @returns Destination point {lat, lon} in degrees
 */
export function destinationPoint(
  lat: number,
  lon: number,
  distanceMeters: number,
  bearingRadians: number
): { lat: number; lon: number } {
  // Turf uses [lon, lat] (GeoJSON format) and bearing in degrees
  const origin = point([lon, lat]);
  const bearingDegrees = bearingRadians * 180 / Math.PI;

  // Distance in meters
  const dest = destination(origin, distanceMeters, bearingDegrees, { units: 'meters' });

  // dest.geometry.coordinates is [lon, lat]
  return {
    lat: dest.geometry.coordinates[1],
    lon: dest.geometry.coordinates[0],
  };
}

/**
 * Get bounding box for a set of points with latitude/longitude.
 *
 * @param fixes - Array of points with latitude and longitude properties
 * @returns Bounding box {minLat, maxLat, minLon, maxLon}
 */
export function getBoundingBox(fixes: LatLonPoint[]): {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
} {
  if (fixes.length === 0) {
    return { minLat: 0, maxLat: 0, minLon: 0, maxLon: 0 };
  }

  // Create a lineString from the fixes (Turf uses [lon, lat])
  const coordinates = fixes.map(fix => [fix.longitude, fix.latitude]);

  // For a single point, we can't create a lineString
  if (coordinates.length === 1) {
    return {
      minLat: fixes[0].latitude,
      maxLat: fixes[0].latitude,
      minLon: fixes[0].longitude,
      maxLon: fixes[0].longitude,
    };
  }

  const line = lineString(coordinates);
  const [minLon, minLat, maxLon, maxLat] = bbox(line);

  return { minLat, maxLat, minLon, maxLon };
}

/**
 * Sum haversine distances over consecutive fixes in a slice.
 *
 * @param fixes - Array of IGC fixes (must have latitude/longitude)
 * @param startIndex - First index in the range (inclusive, default 0)
 * @param endIndex - Last index in the range (inclusive, default fixes.length - 1)
 * @returns Total track distance in meters
 */
export function calculateTrackDistance(
  fixes: LatLonPoint[],
  startIndex = 0,
  endIndex = fixes.length - 1
): number {
  let total = 0;
  for (let i = startIndex; i < endIndex; i++) {
    total += andoyerDistance(
      fixes[i].latitude, fixes[i].longitude,
      fixes[i + 1].latitude, fixes[i + 1].longitude
    );
  }
  return total;
}

/**
 * Check if a point is inside a cylinder.
 *
 * @param lat - Latitude of point to check
 * @param lon - Longitude of point to check
 * @param centerLat - Latitude of cylinder center
 * @param centerLon - Longitude of cylinder center
 * @param radius - Cylinder radius in meters
 * @returns true if point is inside or on the cylinder boundary
 */
export function isInsideCylinder(
  lat: number,
  lon: number,
  centerLat: number,
  centerLon: number,
  radius: number
): boolean {
  const dist = andoyerDistance(lat, lon, centerLat, centerLon);
  return dist <= radius;
}

/**
 * Generate points forming a circle around a center point.
 * Useful for rendering cylinders/circles on maps.
 *
 * @param centerLat - Latitude of circle center (degrees)
 * @param centerLon - Longitude of circle center (degrees)
 * @param radiusMeters - Circle radius in meters
 * @param numPoints - Number of points to generate (default 64)
 * @returns Array of {lat, lon} points forming the circle, closed (first point repeated at end)
 */
export function getCirclePoints(
  centerLat: number,
  centerLon: number,
  radiusMeters: number,
  numPoints = 64
): Array<{ lat: number; lon: number }> {
  const points: Array<{ lat: number; lon: number }> = [];

  for (let i = 0; i <= numPoints; i++) {
    const angle = (i / numPoints) * 2 * Math.PI;
    const dest = destinationPoint(centerLat, centerLon, radiusMeters, angle);
    points.push(dest);
  }

  return points;
}
