/**
 * The waypoints list's rows (IA §10), read-only: the filter, and the one
 * detail line under each code. The same facts in the same order as the
 * website's read-only WaypointList — coordinates, altitude, radius — so the
 * two lists read alike.
 */
import { formatAltitude, formatCylinderRadius, type UnitPreferences, type WaypointFileRecord } from '@glidecomp/engine';

/** "lat, lon" to six places: the coordinates as the website prints and filters them. */
export function formatCoords(w: Pick<WaypointFileRecord, 'latitude' | 'longitude'>): string {
  return `${w.latitude.toFixed(6)}, ${w.longitude.toFixed(6)}`;
}

/** Case-insensitive substring match across code, name and coordinates. */
export function matchesWaypoint(w: WaypointFileRecord, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return w.code.toLowerCase().includes(q) || w.name.toLowerCase().includes(q) || formatCoords(w).includes(q);
}

/**
 * The indexes of the waypoints a filter keeps, in the file's order. Indexes,
 * not records, so a row and its map marker stay the same waypoint.
 */
export function filterWaypoints(waypoints: readonly WaypointFileRecord[], query: string): number[] {
  const kept: number[] = [];
  waypoints.forEach((w, i) => {
    if (matchesWaypoint(w, query)) kept.push(i);
  });
  return kept;
}

/**
 * Coordinates · altitude · radius. A read-only altitude is printed to a
 * reader, so it is in their unit; a zero is a known altitude (a waypoint on a
 * beach), and only an absent one says "no altitude". The radius is the
 * task's own number, always metres.
 */
export function waypointDetail(w: WaypointFileRecord, prefs: UnitPreferences): string {
  return [
    formatCoords(w),
    w.altitude === undefined ? 'no altitude' : formatAltitude(w.altitude, { prefs }).withUnit,
    formatCylinderRadius(w.radius).withUnit,
  ].join(' · ');
}

/** The row's title: the code, and the long name when the file gives one. */
export function waypointTitle(w: WaypointFileRecord): string {
  return w.name && w.name !== w.code ? `${w.code}  ${w.name}` : w.code;
}
