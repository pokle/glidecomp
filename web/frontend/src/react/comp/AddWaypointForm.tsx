/**
 * Adding one waypoint — code, name, coordinates and altitude, with
 * snap-to-peak (#341) — as fields any form can hold.
 *
 * The waypoints editor shows them on a page of its own
 * (pages/CompWaypointNewPage.tsx, /comp/:id/waypoints/new), on the kit
 * `Form`; it was a dialog with three text fields over the list until #811,
 * which the overlays rule in CLAUDE.md retired. The task route editor still
 * opens them in comp/AddWaypointDialog.tsx until its own turn (#812), so the
 * fields, their seeding and the record they build live here, once.
 *
 * A tap on the map is the usual way in, and what the map knew about the
 * point — the terrain's elevation, the nearest place name, a peak close by —
 * pre-fills the fields. The page is reached by a URL, so all of that rides in
 * it ({@link newWaypointSearch}), and a reload of the page comes back to the
 * same pick.
 *
 * Nothing here manages the waypoint set. The fields birth one record and the
 * caller decides where it goes (a row of the waypoints draft, or a new
 * turnpoint and a waypoint saved with the route).
 */
import { useState } from "react";
import { cleanWaypointCodes, type WaypointFileRecord } from "@glidecomp/engine";
import type { MapPickDetails, PickedPeak } from "../../analysis/map-provider";
import { Button } from "@/react/rac/button";
import { TextField } from "@/react/rac/field";
import { useUnits } from "../lib/units";
import { AltitudeField } from "./fields";
import {
  formatCoords,
  formatSnapDistance,
  parseCoords,
  peakSnapMode,
  suggestWaypointCode,
} from "./route-editor";

/** Radius (m) a freshly added waypoint gets until the admin changes it. */
const DEFAULT_RADIUS = 400;

/** Where a new waypoint starts: a map tap and what the map said about it. */
export interface NewWaypointSeed {
  /** "lat, lon", or "" when added by a button rather than a tap. */
  coords: string;
  details?: MapPickDetails;
}

/** The field names, as the kit form knows them. */
export const NEW_WAYPOINT_FIELD = { code: "code", name: "name", coords: "coords" } as const;

/** The message under a coordinates field that does not parse. */
export const COORDS_HINT = 'Enter "lat, lon" decimal degrees';

/** A map tap, as the query string of the Add waypoint page. */
export function newWaypointSearch(lat: number, lon: number, details?: MapPickDetails): string {
  const q = new URLSearchParams({ at: formatCoords(lat, lon) });
  if (details && Object.keys(details).length > 0) q.set("pick", JSON.stringify(details));
  return `?${q.toString()}`;
}

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

function readPeak(x: unknown): PickedPeak | undefined {
  if (typeof x !== "object" || x === null) return undefined;
  const p = x as Record<string, unknown>;
  if (typeof p.name !== "string" || !isNum(p.lat) || !isNum(p.lon) || !isNum(p.distanceM)) {
    return undefined;
  }
  return {
    name: p.name,
    lat: p.lat,
    lon: p.lon,
    distanceM: p.distanceM,
    withinTapPx: p.withinTapPx === true,
    ...(isNum(p.elevation) ? { elevation: p.elevation } : {}),
  };
}

/**
 * The seed back out of the page's URL. Anything that does not read is left
 * out rather than trusted: it is a URL, and anyone can type one.
 */
export function readNewWaypointSeed(search: URLSearchParams): NewWaypointSeed {
  const at = search.get("at") ?? "";
  const coords = parseCoords(at) ? at : "";
  let details: MapPickDetails | undefined;
  try {
    const raw = JSON.parse(search.get("pick") ?? "null") as Record<string, unknown> | null;
    if (raw && typeof raw === "object") {
      const peak = readPeak(raw.peak);
      details = {
        ...(isNum(raw.elevation) ? { elevation: raw.elevation } : {}),
        ...(typeof raw.placeName === "string" && raw.placeName ? { placeName: raw.placeName } : {}),
        ...(peak ? { peak } : {}),
      };
    }
  } catch {
    details = undefined;
  }
  return { coords, details };
}

/** The fields' state, seeded once from where the waypoint started. */
export interface NewWaypointState {
  code: string;
  name: string;
  coords: string;
  /** Metres, or NaN when blank. */
  altitude: number;
  /** The peak near the tap, if any, and whether the coordinates are on it. */
  peak: PickedPeak | null;
  snapped: boolean;
  /** The tap itself, to go back to from a snap. */
  tapCoords: string;
  tapAltitude: number;
}

function initialState(seed: NewWaypointSeed, takenCodes: string[]): NewWaypointState {
  // Everything the map knows pre-fills but stays editable: terrain elevation
  // → altitude, nearest label → name, a short code derived from that name.
  // When a peak is near the tap: a tight tap adopts the summit (revertible),
  // a looser one only offers it — decided by peakSnapMode.
  const { details } = seed;
  const placeName = details?.placeName ?? "";
  const tapAlt = details?.elevation !== undefined ? Math.round(details.elevation) : NaN;
  const peak = details?.peak ?? null;
  const snap = peak !== null && peakSnapMode(peak) === "auto";
  return {
    code: placeName ? suggestWaypointCode(placeName, takenCodes) : "",
    name: placeName,
    coords: snap ? formatCoords(peak.lat, peak.lon) : seed.coords,
    altitude: snap && peak.elevation !== undefined ? Math.round(peak.elevation) : tapAlt,
    peak,
    snapped: snap,
    tapCoords: seed.coords,
    tapAltitude: tapAlt,
  };
}

/** The state for one new waypoint. Remount (a `key`) to start another. */
export function useNewWaypoint(seed: NewWaypointSeed, takenCodes: string[]) {
  const [state, setState] = useState(() => initialState(seed, takenCodes));
  const set = (patch: Partial<NewWaypointState>) => setState((s) => ({ ...s, ...patch }));
  return {
    state,
    set,
    /** Move the coordinates onto the offered peak. */
    applySnap() {
      const { peak } = state;
      if (!peak) return;
      set({
        coords: formatCoords(peak.lat, peak.lon),
        ...(peak.elevation !== undefined ? { altitude: Math.round(peak.elevation) } : {}),
        snapped: true,
      });
    },
    /** Back to the point that was tapped. */
    revertToTap() {
      set({ coords: state.tapCoords, altitude: state.tapAltitude, snapped: false });
    },
  };
}

export type NewWaypoint = ReturnType<typeof useNewWaypoint>;

/** The form's own check: coordinates that parse. */
export function newWaypointProblems(state: NewWaypointState): Record<string, string | null> {
  return { [NEW_WAYPOINT_FIELD.coords]: parseCoords(state.coords) ? null : COORDS_HINT };
}

/**
 * The record to add, and a note when the code had to change to be one —
 * the same hygiene as a loaded file: no spaces or commas (they separate
 * turnpoints when a route is written as text), and unique among the codes
 * already there, disambiguated with a digit. Null when the coordinates do not
 * parse.
 */
export function buildNewWaypoint(
  state: NewWaypointState,
  takenCodes: string[]
): { record: WaypointFileRecord; adjusted: string | null } | null {
  const c = parseCoords(state.coords);
  if (!c) return null;
  const typed = state.code.trim() || "WP";
  const [{ code }] = cleanWaypointCodes([
    ...takenCodes.map((t) => ({ code: t })),
    { code: typed },
  ]).waypoints.slice(-1);
  return {
    record: {
      code,
      name: state.name.trim() || code,
      latitude: c.lat,
      longitude: c.lon,
      // Left off when blank: the set then says it does not know this
      // altitude, rather than putting the waypoint at sea level.
      ...(Number.isFinite(state.altitude) ? { altitude: Math.round(state.altitude) } : {}),
      radius: DEFAULT_RADIUS,
    },
    adjusted:
      code === typed
        ? null
        : `Code adjusted: "${typed}" → ${code}. Codes can't contain spaces or commas, and must be unique.`,
  };
}

/**
 * The "we pre-filled these" note for a waypoint started from a map tap. It
 * names what the map supplied; every field stays editable. A nearby peak gets
 * its own status line under Coordinates.
 */
function filledNote(seed: NewWaypointSeed): string {
  const { details } = seed;
  if (!details) return "";
  const parts: string[] = [];
  if (seed.coords) parts.push("coordinates");
  if (details.elevation !== undefined) parts.push("elevation");
  if (details.placeName) parts.push("name");
  if (parts.length === 0) return "";
  const list =
    parts.length === 1
      ? parts[0]
      : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return details.placeName
    ? `Filled ${list} from the map — adjust anything below.`
    : `Filled ${list} from the map — add a code and name below.`;
}

export function AddWaypointFields({
  seed,
  waypoint,
  autoFocus = false,
}: {
  seed: NewWaypointSeed;
  waypoint: NewWaypoint;
  autoFocus?: boolean;
}) {
  const units = useUnits();
  const { state, set, applySnap, revertToTap } = waypoint;
  const { peak } = state;
  const note = filledNote(seed);
  return (
    <>
      {note ? (
        <p
          className="flex items-start gap-1.5 rounded-md bg-muted/60 px-2.5 py-1.5 text-xs text-muted-foreground"
          aria-live="polite"
        >
          <span aria-hidden="true">📍</span>
          <span>{note}</span>
        </p>
      ) : null}
      <TextField
        label="Code"
        name={NEW_WAYPOINT_FIELD.code}
        placeholder="e.g. A01"
        autoFocus={autoFocus}
        value={state.code}
        onChange={(code) => set({ code })}
      />
      <TextField
        label={
          <>
            Name <span className="font-normal text-muted-foreground">— optional</span>
          </>
        }
        name={NEW_WAYPOINT_FIELD.name}
        placeholder="e.g. Bordano Landing"
        value={state.name}
        onChange={(name) => set({ name })}
      />
      <div className="flex flex-col gap-1.5">
        <TextField
          label="Coordinates (lat, lon)"
          name={NEW_WAYPOINT_FIELD.coords}
          placeholder="-36.185, 147.891"
          spellCheck="false"
          value={state.coords}
          onChange={(coords) => set({ coords })}
          validate={(v) => (v.trim() === "" || parseCoords(v) !== null ? null : COORDS_HINT)}
        />
        {peak && (
          <p
            className="flex items-start gap-1.5 text-xs text-muted-foreground"
            aria-live="polite"
          >
            <span aria-hidden="true">⛰</span>
            {state.snapped ? (
              <span>
                Snapped to <span className="font-medium text-foreground">{peak.name}</span>{" "}
                summit — {formatSnapDistance(peak.distanceM, units)} from your tap ·{" "}
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto p-0 text-xs font-medium underline underline-offset-2"
                  onPress={revertToTap}
                >
                  Use tapped point
                </Button>
              </span>
            ) : (
              <span>
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto p-0 text-xs font-medium underline underline-offset-2"
                  onPress={applySnap}
                >
                  Snap to {peak.name} summit
                </Button>{" "}
                ({formatSnapDistance(peak.distanceM, units)} away)
              </span>
            )}
          </p>
        )}
      </div>
      <AltitudeField
        hint={<span className="font-normal text-muted-foreground">— optional</span>}
        valueM={state.altitude}
        onChange={(altitude) => set({ altitude })}
      />
    </>
  );
}
