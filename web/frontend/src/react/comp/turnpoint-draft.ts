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
 * A turnpoint altitude that's still unknown (blank, zero or unparseable —
 * xctsk files without altitudes come through as altSmoothed 0). Only these are
 * touched by "Fill altitudes from map".
 */
export function missingAltitude(altitude: string | number): boolean {
  const alt = Number(altitude);
  return !Number.isFinite(alt) || alt === 0;
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
    altitude: rec.altitude ? rec.altitude : "",
  };
}
