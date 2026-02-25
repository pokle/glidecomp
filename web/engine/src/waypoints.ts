/**
 * Waypoint Database
 *
 * Parses and provides lookup for competition waypoints from CSV files.
 * Used to enrich IGC task declarations with radius and altitude data.
 */

import { haversineDistance } from './geo';

/**
 * A waypoint record from a competition waypoint database.
 * Named WaypointRecord to avoid conflict with Waypoint in xctsk-parser.ts.
 */
export interface WaypointRecord {
  name: string;
  latitude: number;
  longitude: number;
  description: string;
  radius: number;
  altitude: number;
}

/**
 * Parse a CSV file containing waypoints.
 *
 * Expected format:
 * Name,Latitude,Longitude,Description,Proximity Distance,Altitude
 *
 * @param csvContent The raw CSV content
 * @returns Array of parsed waypoints
 */
export function parseWaypointsCSV(csvContent: string): WaypointRecord[] {
  const lines = csvContent.trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  // Skip header row
  const waypoints: WaypointRecord[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const parts = line.split(',');
    if (parts.length < 6) continue;

    const name = parts[0].trim();
    const latitude = parseFloat(parts[1]);
    const longitude = parseFloat(parts[2]);
    const description = parts[3].trim();
    const radius = parseInt(parts[4], 10);
    const altitude = parseInt(parts[5], 10);

    if (isNaN(latitude) || isNaN(longitude)) continue;

    waypoints.push({
      name,
      latitude,
      longitude,
      description,
      radius: isNaN(radius) ? 400 : radius,
      altitude: isNaN(altitude) ? 0 : altitude,
    });
  }

  return waypoints;
}

/**
 * Normalize a waypoint name for matching.
 * Removes common prefixes like "START", "TURN", "FINISH", etc.
 * and converts to uppercase.
 *
 * Examples:
 * - "START ELLIOT" → "ELLIOT"
 * - "TURN CUDGWE" → "CUDGWE"
 * - "FINISH NCORGL" → "NCORGL"
 * - "HALFWY" → "HALFWY"
 */
function normalizeWaypointName(name: string): string {
  return name
    .toUpperCase()
    .replace(/^(START|TURN|FINISH|TAKEOFF|LANDING|GOAL|SSS|ESS)\s+/, '')
    .trim();
}

/**
 * Find a waypoint by name, with fuzzy matching.
 *
 * Tries exact match first, then normalized match (removing prefixes).
 *
 * @param waypoints The waypoint database
 * @param name The name to search for
 * @returns The matching waypoint, or undefined
 */
export function findWaypointByName(waypoints: WaypointRecord[], name: string): WaypointRecord | undefined {
  const upperName = name.toUpperCase();
  const normalizedName = normalizeWaypointName(name);

  // Try exact match first
  const exact = waypoints.find(wp => wp.name.toUpperCase() === upperName);
  if (exact) return exact;

  // Try normalized match (e.g., "START ELLIOT" matches "ELLIOT")
  const normalized = waypoints.find(wp => wp.name.toUpperCase() === normalizedName);
  if (normalized) return normalized;

  // Try if waypoint name is contained in the search name
  // e.g., "TURN HALFWY" contains "HALFWY"
  const contained = waypoints.find(wp =>
    upperName.includes(wp.name.toUpperCase()) ||
    normalizedName.includes(wp.name.toUpperCase())
  );
  if (contained) return contained;

  return undefined;
}

/**
 * Find a waypoint by coordinates within a tolerance.
 *
 * @param waypoints The waypoint database
 * @param latitude The latitude to search for
 * @param longitude The longitude to search for
 * @param toleranceMeters Maximum distance in meters (default: 50m)
 * @returns The closest matching waypoint within tolerance, or undefined
 */
export function findWaypointByCoordinates(
  waypoints: WaypointRecord[],
  latitude: number,
  longitude: number,
  toleranceMeters: number = 50
): WaypointRecord | undefined {
  let closest: WaypointRecord | undefined;
  let closestDistance = Infinity;

  for (const wp of waypoints) {
    const distance = haversineDistance(latitude, longitude, wp.latitude, wp.longitude);
    if (distance <= toleranceMeters && distance < closestDistance) {
      closest = wp;
      closestDistance = distance;
    }
  }

  return closest;
}

/**
 * Find a waypoint by name first, then by coordinates as fallback.
 *
 * @param waypoints The waypoint database
 * @param name The name to search for
 * @param latitude The latitude to search for
 * @param longitude The longitude to search for
 * @param toleranceMeters Maximum distance in meters for coordinate matching
 * @returns The matching waypoint, or undefined
 */
export function findWaypoint(
  waypoints: WaypointRecord[],
  name: string,
  latitude: number,
  longitude: number,
  toleranceMeters: number = 50
): WaypointRecord | undefined {
  // Try name match first
  const byName = findWaypointByName(waypoints, name);
  if (byName) return byName;

  // Fall back to coordinate match
  return findWaypointByCoordinates(waypoints, latitude, longitude, toleranceMeters);
}

