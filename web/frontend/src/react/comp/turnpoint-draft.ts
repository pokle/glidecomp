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

/** Type list order: Takeoff, SSS, Turnpoint, ESS, Goal. */
const TYPE_ORDER: Array<RouteRow["type"]> = [
  "TAKEOFF",
  "SSS",
  "",
  "ESS",
  "GOAL",
];

export const TYPE_OPTIONS = TYPE_ORDER.map((value) => ({
  value,
  label: TYPE_LABELS[value],
}));

/**
 * The Type list for one turnpoint. Goal is a UI type (xctsk has none); the
 * last turnpoint is still the scoring goal even when Type says Turnpoint, so
 * that option is labelled when this row is last.
 */
export function typeOptions(opts: { lastIsGoal?: boolean } = {}): typeof TYPE_OPTIONS {
  if (!opts.lastIsGoal) return TYPE_OPTIONS;
  return TYPE_OPTIONS.map((o) =>
    o.value === "" ? { ...o, label: "Turnpoint (last is goal)" } : o
  );
}

/**
 * The Type a newly appended turnpoint should start as.
 *
 * First is always Takeoff, second always Start. Third onwards is a Turnpoint
 * unless the current last is an explicit Goal — then the new last takes Goal
 * and the caller demotes the old one, so last-is-goal stays true. ESS and
 * Goal are never inferred: the organiser has to pick them.
 */
export function inferAddedType(
  rows: Pick<RouteRow, "type">[],
  opts: { openDistance?: boolean } = {}
): RouteRow["type"] {
  if (opts.openDistance) return rows.length === 0 ? "TAKEOFF" : "";
  if (rows.length === 0) return "TAKEOFF";
  if (rows.length === 1) return "SSS";
  if (rows[rows.length - 1]?.type === "GOAL") return "GOAL";
  return "";
}

/** Every Goal except `keepId` becomes an ordinary Turnpoint. */
export function demoteOtherGoals<T extends { id: number; type: RouteRow["type"] }>(
  rows: T[],
  keepId: number
): T[] {
  return rows.map((r) =>
    r.id !== keepId && r.type === "GOAL" ? { ...r, type: "" } : r
  );
}

/** Move a row to the end (Goal is last by position). No-op if already last. */
export function moveRowToEnd<T extends { id: number }>(rows: T[], id: number): T[] {
  const at = rows.findIndex((r) => r.id === id);
  if (at < 0 || at === rows.length - 1) return rows;
  const next = rows.slice();
  const [row] = next.splice(at, 1);
  next.push(row);
  return next;
}

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
export function blankDraft(type: RouteRow["type"] = ""): TurnpointDraft {
  return {
    name: "",
    description: "",
    type,
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
