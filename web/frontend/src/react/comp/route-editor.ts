/**
 * Pure logic for the task route editor dialog (RouteEditorDialog.tsx):
 * grid-row <-> turnpoint conversion, coordinate parsing (Google Maps
 * "lat, lon" format), live validation, and xctsk (de)serialization helpers
 * shared with the task detail page. Kept DOM-free so it's unit-testable.
 */
import type { SSSConfig, Turnpoint, TurnpointType, XCTask } from "@glidecomp/engine";
import { utcToZonedHHMM, zoneNameWithOffset } from "../lib/time";

// ---------------------------------------------------------------------------
// Grid rows
// ---------------------------------------------------------------------------

/** One Tabulator row. Editors produce strings/numbers; parse defensively. */
export interface RouteRow {
  /** Tabulator index field — unique per row, never reused within a dialog. */
  id: number;
  /** Short code / turnpoint name (e.g. "A01"). */
  name: string;
  /** Long descriptive name (e.g. "BORDANO LANDING"); kept separate from the
   *  code so both survive a round-trip to a waypoint file. */
  description: string;
  /** "" = plain turnpoint. */
  type: "" | TurnpointType;
  /** Google Maps format: "lat, lon" decimal degrees. */
  coords: string;
  radius: string | number;
  altitude: string | number;
  /** Optimized distance (m) from the previous turnpoint; display-only. */
  leg: number | null;
}

export const TYPE_LABELS: Record<string, string> = {
  "": "Turnpoint",
  TAKEOFF: "Takeoff",
  SSS: "Start (SSS)",
  ESS: "ESS",
};

export function formatCoords(lat: number, lon: number): string {
  return `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
}

/**
 * Parse a Google Maps style coordinate pair: two decimal degrees separated
 * by a comma and/or whitespace, e.g. "-38.232923, 144.399782". Returns null
 * when the text isn't exactly two in-range numbers.
 */
export function parseCoords(text: string): { lat: number; lon: number } | null {
  const parts = text.trim().split(/[,\s]+/).filter((p) => p.length > 0);
  if (parts.length !== 2) return null;
  const numRe = /^[+-]?\d+(\.\d+)?$/;
  if (!numRe.test(parts[0]) || !numRe.test(parts[1])) return null;
  const lat = Number(parts[0]);
  const lon = Number(parts[1]);
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

/** Quote a CSV field only when it needs it (comma, quote or newline). */
function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Serialize turnpoints to the competition waypoint CSV format
 * (`Name,Latitude,Longitude,Description,Proximity Distance,Altitude`) — the
 * shape parseWaypointsCSV reads back. Proximity Distance is the cylinder
 * radius; Altitude is the waypoint's altSmoothed (0 when unknown).
 */
export function turnpointsToCSV(turnpoints: Turnpoint[]): string {
  const header = "Name,Latitude,Longitude,Description,Proximity Distance,Altitude";
  const rows = turnpoints.map((tp) =>
    [
      csvField(tp.waypoint.name),
      tp.waypoint.lat.toFixed(6),
      tp.waypoint.lon.toFixed(6),
      csvField(tp.waypoint.description ?? ""),
      String(tp.radius),
      String(Math.round(tp.waypoint.altSmoothed ?? 0)),
    ].join(",")
  );
  return [header, ...rows].join("\n") + "\n";
}

export function turnpointToRow(tp: Turnpoint, id: number): RouteRow {
  return {
    id,
    name: tp.waypoint.name,
    description: tp.waypoint.description ?? "",
    type: tp.type ?? "",
    coords: formatCoords(tp.waypoint.lat, tp.waypoint.lon),
    radius: tp.radius,
    altitude: tp.waypoint.altSmoothed ?? "",
    leg: null,
  };
}

// ---------------------------------------------------------------------------
// Validation / turnpoint building
// ---------------------------------------------------------------------------

// Mirror the server's xctsk validator bounds (competition-api validators.ts)
// so problems surface live in the grid instead of as a rejected save.
const MAX_TURNPOINTS = 50;
const MAX_NAME = 64;
const MIN_RADIUS = 1;
const MAX_RADIUS = 50000;
const MIN_ALT = -1000;
const MAX_ALT = 30000;

export interface BuildRouteResult {
  turnpoints: Turnpoint[];
  /** Row ids, parallel to `turnpoints` (grid rows that produced each tp). */
  rowIds: number[];
  /** Problems that block saving. */
  errors: string[];
  /** Task-setting smells that still score (shown amber, non-blocking). */
  warnings: string[];
  /** True when every kept row has valid geometry — legs are computable. */
  geometryComplete: boolean;
}

/**
 * Convert grid rows to turnpoints, collecting blocking errors and
 * non-blocking warnings. Rows that are entirely empty (no name, no
 * coordinates) are skipped, mirroring the pilots grid's "blank rows are
 * ignored" behaviour so a stray inserted row can't block a save.
 */
export function buildRoute(
  rows: RouteRow[],
  opts: { openDistance: boolean }
): BuildRouteResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const turnpoints: Turnpoint[] = [];
  const rowIds: number[] = [];
  let geometryComplete = true;

  const kept = rows.filter(
    (r) => String(r.name).trim() !== "" || String(r.coords).trim() !== ""
  );

  kept.forEach((row, i) => {
    const label = `Turnpoint ${i + 1}`;
    const name = String(row.name).trim();
    if (name.length === 0) {
      errors.push(`${label}: name is required`);
    } else if (name.length > MAX_NAME) {
      errors.push(`${label}: name is longer than ${MAX_NAME} characters`);
    }

    const coords = parseCoords(String(row.coords));
    if (!coords) {
      errors.push(
        `${label} (${name || "unnamed"}): coordinates must be "lat, lon" decimal degrees, e.g. -36.550979, 147.890395`
      );
      geometryComplete = false;
    }

    const radius = Number(row.radius);
    if (
      String(row.radius).trim() === "" ||
      !Number.isFinite(radius) ||
      !Number.isInteger(radius) ||
      radius < MIN_RADIUS ||
      radius > MAX_RADIUS
    ) {
      errors.push(
        `${label} (${name || "unnamed"}): radius must be a whole number of meters between ${MIN_RADIUS} and ${MAX_RADIUS}`
      );
      geometryComplete = false;
    }

    let altitude: number | undefined;
    if (String(row.altitude).trim() !== "") {
      const alt = Number(row.altitude);
      if (!Number.isFinite(alt) || alt < MIN_ALT || alt > MAX_ALT) {
        errors.push(
          `${label} (${name || "unnamed"}): altitude must be between ${MIN_ALT} and ${MAX_ALT} m`
        );
      } else {
        altitude = alt;
      }
    }

    if (coords) {
      // Keep the long name only when it adds something beyond the code.
      const description = String(row.description ?? "").trim();
      turnpoints.push({
        ...(row.type ? { type: row.type } : {}),
        radius: Number.isFinite(radius) ? radius : 0,
        waypoint: {
          name: name || "unnamed",
          ...(description && description !== name ? { description } : {}),
          lat: coords.lat,
          lon: coords.lon,
          ...(altitude !== undefined ? { altSmoothed: altitude } : {}),
        },
      });
      rowIds.push(row.id);
    } else {
      geometryComplete = false;
    }
  });

  if (kept.length === 0) {
    errors.push("The route needs at least one turnpoint");
    geometryComplete = false;
  }
  if (kept.length > MAX_TURNPOINTS) {
    errors.push(`Too many turnpoints (max ${MAX_TURNPOINTS})`);
  }

  if (opts.openDistance) {
    // Mirrors the competition-api rule for open-distance comps.
    if (kept.length !== 1 || kept[0]?.type !== "TAKEOFF") {
      errors.push(
        "Open distance tasks must have exactly one turnpoint, of type Takeoff."
      );
    }
  } else if (kept.length >= 2) {
    const types = kept.map((r) => r.type);
    const sssCount = types.filter((t) => t === "SSS").length;
    const essCount = types.filter((t) => t === "ESS").length;
    if (sssCount === 0) {
      warnings.push(
        "No Start (SSS) turnpoint — scoring will treat the first turnpoint as the start."
      );
    }
    if (essCount === 0) {
      warnings.push(
        "No ESS turnpoint — the speed section will end at the last turnpoint (goal)."
      );
    }
    if (sssCount > 1) warnings.push("Multiple Start (SSS) turnpoints — only the first is used.");
    if (essCount > 1) warnings.push("Multiple ESS turnpoints — only the last is used.");
    if (sssCount > 0 && essCount > 0 && types.indexOf("SSS") > types.lastIndexOf("ESS")) {
      warnings.push("The Start (SSS) turnpoint comes after the ESS turnpoint.");
    }
    if (types.filter((t) => t === "TAKEOFF").length > 1) {
      warnings.push("Multiple Takeoff turnpoints — only the first is used.");
    }
  }

  return { turnpoints, rowIds, errors, warnings, geometryComplete };
}

// ---------------------------------------------------------------------------
// Start gate helpers (shared with the task detail page's read-only summary)
// ---------------------------------------------------------------------------

/** "HH:MM:SSZ" / "HH:MM" (the xctsk gate format) → "HH:MM", or null. */
export function gateToHHMM(value: string): string | null {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?Z?$/.exec(value.trim());
  if (!m) return null;
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

/** The task's real gates as "HH:MM" — drops the lone 00:00 placeholder. */
export function editableGates(sss: SSSConfig | undefined): string[] {
  const gates = (sss?.timeGates ?? [])
    .map(gateToHHMM)
    .filter((g): g is string => g !== null);
  // toXctskJSON writes a lone 00:00:00Z to satisfy the format's
  // non-empty-gates rule; scoring ignores it, so the editor does too.
  if (gates.length === 1 && gates[0] === "00:00") return [];
  return gates;
}

/** Add minutes to an "HH:MM" time of day, wrapping at midnight. */
export function addMinutes(hhmm: string, minutes: number): string {
  const [h, m] = hhmm.split(":").map(Number);
  const total = (((h * 60 + m + minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * One-line human summary of the start configuration. When the comp's
 * timezone and the task date are known, gate times are shown comp-local
 * (labelled with the zone); otherwise they stay UTC as stored.
 */
export function startConfigSummary(
  sss: SSSConfig,
  opts?: { timeZone?: string | null; taskDate?: string }
): string {
  const kind = sss.type === "ELAPSED-TIME" ? "Elapsed time" : "Race to goal";
  const dir = sss.direction === "ENTER" ? "enter" : "exit";
  let gates = editableGates(sss);
  let zoneLabel = "UTC";
  const tz = opts?.timeZone;
  if (tz && opts?.taskDate && gates.length > 0) {
    const converted = gates.map((g) => utcToZonedHHMM(opts.taskDate!, g, tz));
    if (converted.every((g): g is string => g !== null)) {
      gates = converted;
      zoneLabel = zoneNameWithOffset(new Date(`${opts.taskDate}T12:00:00Z`), tz);
    }
  }
  const gateStr =
    sss.type === "ELAPSED-TIME"
      ? gates.length > 0
        ? ` · start opens ${gates[0]} ${zoneLabel}`
        : ""
      : gates.length > 0
        ? ` · ${gates.length} start gate${gates.length === 1 ? "" : "s"}: ${gates.join(", ")} ${zoneLabel}`
        : " · no start gates (pilots timed from their crossing)";
  return `${kind} · ${dir} start${gateStr}`;
}

// ---------------------------------------------------------------------------
// Serialization for the task PATCH
// ---------------------------------------------------------------------------

/**
 * Serialize a parsed XCTask to the strict shape the API's xctsk validator
 * accepts. Picks only known fields so stray keys (e.g. from tasks stored
 * by the seed script, or spec extensions in uploaded files) can't fail
 * the strict schema.
 */
export function xctskForPatch(task: XCTask): Record<string, unknown> {
  const takeoff = {
    ...(task.takeoff?.timeOpen !== undefined ? { timeOpen: task.takeoff.timeOpen } : {}),
    ...(task.takeoff?.timeClose !== undefined ? { timeClose: task.takeoff.timeClose } : {}),
  };
  return {
    taskType: task.taskType || "CLASSIC",
    version: task.version ?? 1,
    ...(task.earthModel ? { earthModel: task.earthModel } : {}),
    turnpoints: task.turnpoints.map((tp) => ({
      ...(tp.type ? { type: tp.type } : {}),
      radius: tp.radius,
      waypoint: {
        name: tp.waypoint.name,
        ...(tp.waypoint.description !== undefined
          ? { description: tp.waypoint.description }
          : {}),
        lat: tp.waypoint.lat,
        lon: tp.waypoint.lon,
        ...(tp.waypoint.altSmoothed !== undefined
          ? { altSmoothed: tp.waypoint.altSmoothed }
          : {}),
      },
    })),
    ...(Object.keys(takeoff).length > 0 ? { takeoff } : {}),
    ...(task.sss
      ? {
          sss: {
            type: task.sss.type,
            direction: task.sss.direction,
            ...(task.sss.timeGates && task.sss.timeGates.length > 0
              ? { timeGates: task.sss.timeGates }
              : {}),
          },
        }
      : {}),
    ...(task.goal
      ? {
          goal: {
            type: task.goal.type ?? "CYLINDER",
            ...(task.goal.deadline !== undefined ? { deadline: task.goal.deadline } : {}),
            ...(task.goal.finishAltitude !== undefined
              ? { finishAltitude: task.goal.finishAltitude }
              : {}),
          },
        }
      : {}),
    ...(task.cylinderTolerance !== undefined
      ? { cylinderTolerance: task.cylinderTolerance }
      : {}),
  };
}
