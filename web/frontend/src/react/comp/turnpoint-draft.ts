/**
 * What one turnpoint's editable fields are, and the small vocabulary the
 * turnpoint sheet and the route list both speak about them.
 *
 * Shared so the route editor, its turnpoint sheet and the Quick entry
 * reconcile agree by construction rather than by all happening to say 1000
 * and "1 km".
 */
import type { WaypointFileRecord } from "@glidecomp/engine";
import { formatCoords, TYPE_LABELS, type RouteRow } from "./route-editor";

/** The radius a freshly added turnpoint starts at. */
export const NEW_ROW_RADIUS = 400;

export const RADIUS_PRESETS = [400, 1000, 2000, 3000, 5000] as const;

export const TYPE_OPTIONS = Object.entries(TYPE_LABELS).map(([value, label]) => ({
  value,
  label,
}));

/** Short radius label for a preset chip: 400 → "400", 1000 → "1 km". */
export function radiusChipLabel(m: number): string {
  return m >= 1000 ? `${m / 1000} km` : `${m}`;
}

/** The editable fields of a turnpoint (everything the details dialog sets). */
export type TurnpointDraft = Pick<
  RouteRow,
  "name" | "description" | "type" | "coords" | "radius" | "altitude"
>;

/**
 * A turnpoint altitude that's still unknown: a blank or unparseable one, and
 * nothing else. Only these are touched by "Fill altitudes from map".
 *
 * A zero is NOT missing. It used to be — an xctsk file with no altitudes
 * comes through as altSmoothed 0, so treating 0 as unknown filled those in —
 * but it also meant a turnpoint genuinely at sea level could never be left
 * alone, and the editor disagreed with the waypoints grid beside it about
 * what a 0 in the same column meant. A 0 that is WRONG is a wrong altitude,
 * which is what the waypoints page's "Check altitudes" review is for; it is
 * not a blank, and nothing may overwrite it without being asked.
 */
export function missingAltitude(altitude: string | number): boolean {
  if (typeof altitude === "string" && altitude.trim() === "") return true;
  return !Number.isFinite(Number(altitude));
}

/** A fresh, empty turnpoint draft (for the "Add turnpoint" flow). */
export function blankDraft(): TurnpointDraft {
  return {
    name: "",
    description: "",
    type: "",
    coords: "",
    radius: NEW_ROW_RADIUS,
    altitude: "",
  };
}


/**
 * A competition waypoint's details as a turnpoint draft.
 *
 * The waypoint's values are COPIED in, so a later edit to the competition's
 * waypoint never changes a task that was set from it. Shared by every route
 * that turns a waypoint into a turnpoint — the map pick, the details sheet's
 * "Load from a waypoint", and the Quick entry reconcile.
 */
export function draftFromRecord(rec: WaypointFileRecord): TurnpointDraft {
  return {
    name: rec.code,
    description: rec.name !== rec.code ? rec.name : "",
    type: "",
    coords: formatCoords(rec.latitude, rec.longitude),
    radius: rec.radius > 0 ? rec.radius : NEW_ROW_RADIUS,
    // A waypoint at sea level carries 0 across; only an absent altitude is
    // blank (see WaypointFileRecord.altitude).
    altitude: rec.altitude ?? "",
  };
}
