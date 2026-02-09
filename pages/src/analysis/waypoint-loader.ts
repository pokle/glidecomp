/**
 * Waypoint loader (browser-only, uses fetch API).
 * Pure parsing logic lives in @taskscore/analysis.
 */

import { parseWaypointsCSV, type WaypointRecord } from '@taskscore/analysis';

/**
 * Fetch and parse the default Corryong waypoints file.
 */
export async function loadCorryongWaypoints(): Promise<WaypointRecord[]> {
  const response = await fetch('/data/waypoints/corryong-cup-waypoints.csv');
  if (!response.ok) {
    console.warn('Failed to load Corryong waypoints:', response.status);
    return [];
  }
  const content = await response.text();
  return parseWaypointsCSV(content);
}
