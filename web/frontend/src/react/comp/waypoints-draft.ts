/**
 * The waypoints editor's DRAFT: the competition's waypoint file as the
 * organiser is editing it, before Save sends it to the server as a set.
 *
 * The editor is several pages since #811 — the list (/comp/:id/waypoints),
 * one waypoint (/waypoints/:n), Add waypoint (/waypoints/new), the map at
 * full size (/waypoints/map) and the altitude review (/waypoints/altitudes,
 * and /altitudes/:n for one waypoint of it). They all edit ONE file, so the
 * file lives in this tab's storage (lib/draft-store.ts, docs/drafts.md)
 * rather than in any one page's memory: each page reads it when it mounts and
 * writes every change straight back, so Back, Forward and a reload all find
 * it where it was left.
 *
 * **Why a whole-file draft, and not a save per waypoint like the pilot
 * page.** The server holds the set as one document (`PUT
 * /api/comp/:id/waypoints`, one audit entry per save); there is no route for
 * one waypoint. And the editor's biggest changes are set-wide by nature —
 * upload a file, convert every altitude from feet, take the map's altitude for
 * all of them — each of which says "nothing is saved until you press Save". A
 * save per waypoint would be a read-modify-write of the whole set on every
 * tap, an audit entry per tap, and a lost update whenever two organisers
 * edited at once.
 *
 * **Row ids are the draft's own.** A waypoint's page is addressed by its row
 * id (`/waypoints/3`), not its code: the code is one of the fields that page
 * edits, two rows can share one until Save cleans them, and a waypoint added
 * a minute ago exists nowhere else. With no draft, the rows are numbered 1..N
 * in file order — the same numbers on every page and after every reload — and
 * a draft keeps the numbers it was given, so a link to a waypoint goes on
 * meaning that waypoint while it is edited.
 *
 * **What the draft remembers of the server.** `base` is the saved set it
 * started from, so the editor can tell when the saved file changed under it
 * (another organiser, or another tab, saved meanwhile): a draft with no edits
 * of its own is then dropped in favour of the new file, and one with edits is
 * kept, and says so.
 *
 * Pure: no React, no storage of its own beyond the store definition.
 */
import { cleanWaypointCodes, type WaypointFileRecord } from "@glidecomp/engine";
import { defineDraft } from "../lib/draft-store";
import {
  resolveStoredDraft,
  type DraftModel,
  type DraftResolution,
} from "../lib/draft-editor";
import { formatCoords, parseCoords } from "./route-editor";
import { feetToMetres, needsReview, reviewSortKey, type AltitudePair } from "./altitude-check";

/** One editable waypoint. Every field is text, as typed. */
export interface WpRow {
  /** The draft's own id for this row: stable while the draft lives. */
  id: number;
  code: string;
  name: string;
  /** "lat, lon" in decimal degrees. */
  coords: string;
  /** Metres, as typed. Blank means the file has no altitude for this point. */
  altitude: string;
  /** Metres. */
  radius: string;
}

/** The editable fields of a row — what one waypoint's page changes. */
export type WpFields = Omit<WpRow, "id">;

/** What the terrain said under one waypoint, and where the waypoint was then. */
export interface TerrainReading {
  /** Metres. */
  alt: number;
  /**
   * The row's coordinates when it was read. A reading belongs to where the
   * waypoint WAS: once the row has moved, the reading answers a question
   * nobody asked, and {@link readingFor} stops returning it.
   */
  coords: string;
}

/**
 * The altitude review in progress: what the check read, and the list it
 * showed — taken ONCE, when the check ran.
 *
 * A live list would drop each row the instant its altitude was accepted
 * (which reads as having deleted it), and a live ORDER would send it to the
 * bottom, its disagreement having just become zero. So membership and order
 * are both a snapshot, and both live here rather than in the review page's
 * memory: going into one waypoint and back, or reloading, must find the same
 * list in the same order.
 */
export interface AltitudeReviewSnapshot {
  /** Row ids the check picked out, as worth looking at. */
  listed: number[];
  /** Every row id, biggest disagreement first. */
  order: number[];
  /** By row id. */
  readings: Record<string, TerrainReading>;
}

export interface WaypointsDraft {
  /** {@link baselineJson} of the saved set this draft started from. */
  base: string;
  rows: WpRow[];
  /** The id the next new row gets. */
  nextId: number;
  /** The altitude review, while one is open. */
  review: AltitudeReviewSnapshot | null;
}

/** One waypoint as the review sees it: what it says, and what the map said. */
export interface AltitudeReviewEntry {
  id: number;
  code: string;
  name: string;
  coords: string;
  /** Metres. Undefined when the file carries no altitude. */
  fileAlt?: number;
  /** Metres. Undefined when no terrain reading could be taken. */
  mapAlt?: number;
}

/** Radius (m) a waypoint gets when its file says nothing. */
const DEFAULT_RADIUS = 400;

/** A record as a row, under the given id. */
export function toRow(w: WaypointFileRecord, id: number): WpRow {
  return {
    id,
    code: w.code,
    name: w.name === w.code ? "" : w.name,
    coords: formatCoords(w.latitude, w.longitude),
    // An altitude of 0 is a waypoint at sea level and prints as "0"; only an
    // absent one is blank (see WaypointFileRecord.altitude). A 0 that is WRONG
    // is a wrong altitude for "Check altitudes" to report, never a missing one
    // for anything to overwrite unasked.
    altitude: w.altitude === undefined ? "" : String(w.altitude),
    radius: String(w.radius || DEFAULT_RADIUS),
  };
}

/** An edited row back as a record, or null if its coordinates do not parse. */
export function fromRow(r: WpFields): WaypointFileRecord | null {
  const coords = parseCoords(r.coords);
  if (!coords) return null;
  const code = r.code.trim() || "WP";
  const alt = Number(r.altitude);
  const radius = Number(r.radius);
  const known = r.altitude.trim() !== "" && Number.isFinite(alt);
  return {
    code,
    name: r.name.trim() || code,
    latitude: coords.lat,
    longitude: coords.lon,
    // Left off entirely when the field is blank: the set then records that it
    // does not know this altitude, instead of asserting sea level. A typed 0
    // IS sea level and is kept.
    ...(known ? { altitude: Math.round(alt) } : {}),
    radius: Number.isFinite(radius) && radius > 0 ? Math.round(radius) : DEFAULT_RADIUS,
  };
}

/** A row's own altitude in metres, or undefined when the field is blank. */
export function rowAltitude(r: WpFields): number | undefined {
  const n = Number(r.altitude);
  return r.altitude.trim() !== "" && Number.isFinite(n) ? n : undefined;
}

/**
 * Case-insensitive substring match across a row's code, name and
 * coordinates — the filter the list's search box drives. `query` is expected
 * already lower-cased.
 */
export function matchesFilter(r: WpFields, query: string): boolean {
  if (!query) return true;
  return (
    r.code.toLowerCase().includes(query) ||
    r.name.toLowerCase().includes(query) ||
    r.coords.toLowerCase().includes(query)
  );
}

/** Stable JSON for dirty-checking (key order fixed). */
export function serialize(list: WaypointFileRecord[]): string {
  return JSON.stringify(
    list.map((w) => [w.code, w.name, w.latitude, w.longitude, w.altitude, w.radius])
  );
}

/** The rows that make a record, as records. */
export function validRecords(rows: WpFields[]): WaypointFileRecord[] {
  return rows.map(fromRow).filter((w): w is WaypointFileRecord => w !== null);
}

/**
 * The saved-state baseline: what the untouched editor serializes to. Rows
 * round-trip every record through the editable text form (toFixed(6)
 * coordinates, rounded altitude/radius, name folded into code), so the
 * baseline must round-trip the same way — comparing against the raw API
 * records leaves a comp stored with more precision permanently "dirty".
 */
export function baselineJson(list: WaypointFileRecord[]): string {
  return serialize(validRecords(list.map((w, i) => toRow(w, i + 1))));
}

/** The editor as it stands with no draft: the saved set, numbered 1..N. */
export function freshDraft(saved: WaypointFileRecord[]): WaypointsDraft {
  return {
    base: baselineJson(saved),
    rows: saved.map((w, i) => toRow(w, i + 1)),
    nextId: saved.length + 1,
    review: null,
  };
}

/** Whether these rows differ from the saved set whose baseline is `base`. */
export function isDirty(rows: WpFields[], base: string): boolean {
  return serialize(validRecords(rows)) !== base;
}

/**
 * How the editor reads a draft against the saved set (lib/draft-editor.ts):
 * its content is the waypoints it would save. A review in progress is not
 * content, so a rebased draft keeps it.
 */
export const waypointsModel: DraftModel<WaypointsDraft> = {
  base: (d) => d.base,
  content: (d) => serialize(validRecords(d.rows)),
  rebase: (d, base) => ({ ...d, base }),
};

/**
 * The draft to edit, given the one in storage (if any) and the set the server
 * holds now — the shared rule, `resolveStoredDraft` in lib/draft-editor.ts.
 */
export function resolveDraft(
  stored: WaypointsDraft | null,
  saved: WaypointFileRecord[]
): DraftResolution<WaypointsDraft> {
  return resolveStoredDraft(stored, freshDraft(saved), waypointsModel);
}

/** Change one row's fields. */
export function updateRow(d: WaypointsDraft, id: number, patch: Partial<WpFields>): WaypointsDraft {
  return { ...d, rows: d.rows.map((r) => (r.id === id ? { ...r, ...patch } : r)) };
}

/** Remove one row. */
export function deleteRow(d: WaypointsDraft, id: number): WaypointsDraft {
  return { ...d, rows: d.rows.filter((r) => r.id !== id) };
}

/** Append a record as a new row, and say which id it got. */
export function addRecord(
  d: WaypointsDraft,
  rec: WaypointFileRecord
): { draft: WaypointsDraft; id: number } {
  const id = d.nextId;
  return { draft: { ...d, rows: [...d.rows, toRow(rec, id)], nextId: id + 1 }, id };
}

/**
 * Replace the whole set (a file upload). The new rows take fresh ids, so a
 * link to a waypoint of the old file names nothing rather than a stranger,
 * and whatever a review was about is gone with the file it reviewed.
 */
export function replaceAll(d: WaypointsDraft, records: WaypointFileRecord[]): WaypointsDraft {
  return {
    ...d,
    rows: records.map((w, i) => toRow(w, d.nextId + i)),
    nextId: d.nextId + records.length,
    review: null,
  };
}

/**
 * Clean the codes the way a loaded file is cleaned — no spaces or commas, and
 * unique — keeping every row's id. The backstop for codes typed by hand.
 */
export function cleanCodes(d: WaypointsDraft): {
  draft: WaypointsDraft;
  changes: ReturnType<typeof cleanWaypointCodes>["changes"];
} {
  const { waypoints, changes } = cleanWaypointCodes(d.rows);
  return { draft: changes.length > 0 ? { ...d, rows: waypoints } : d, changes };
}

/**
 * The whole-file fix for a set of feet read as metres: one conversion rather
 * than the same decision taken 187 times. Only altitudes that exist are
 * touched, and a blank stays blank.
 */
export function convertFromFeet(d: WaypointsDraft): { draft: WaypointsDraft; converted: number } {
  let converted = 0;
  const rows = d.rows.map((r) => {
    const alt = rowAltitude(r);
    if (alt === undefined) return r;
    converted++;
    return { ...r, altitude: String(feetToMetres(alt)) };
  });
  return { draft: converted > 0 ? { ...d, rows } : d, converted };
}

/** The reading for a row, if there is one and the row has not moved since. */
export function readingFor(
  d: WaypointsDraft,
  row: Pick<WpRow, "id" | "coords">
): number | undefined {
  const r = d.review?.readings[String(row.id)];
  return r && r.coords === row.coords ? r.alt : undefined;
}

/** A row as the review sees it. */
export function reviewEntry(d: WaypointsDraft, r: WpRow): AltitudeReviewEntry {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    coords: r.coords,
    fileAlt: rowAltitude(r),
    mapAlt: readingFor(d, r),
  };
}

/** An entry's two altitudes, for the checks in altitude-check.ts. */
export const pairOf = (e: AltitudeReviewEntry): AltitudePair => ({
  ...(e.fileAlt === undefined ? {} : { fileAlt: e.fileAlt }),
  ...(e.mapAlt === undefined ? {} : { mapAlt: e.mapAlt }),
});

/**
 * Open a review on what the terrain said (metres, by row id): the readings,
 * and the snapshot of which rows to list and in what order.
 */
export function startReview(d: WaypointsDraft, elevations: Map<number, number>): WaypointsDraft {
  const readings: Record<string, TerrainReading> = {};
  for (const r of d.rows) {
    const alt = elevations.get(r.id);
    if (alt !== undefined) readings[String(r.id)] = { alt, coords: r.coords };
  }
  const next: WaypointsDraft = { ...d, review: { listed: [], order: [], readings } };
  const entries = d.rows.map((r) => reviewEntry(next, r));
  return {
    ...next,
    review: {
      readings,
      listed: entries.filter((e) => needsReview(pairOf(e))).map((e) => e.id),
      // Biggest disagreement first; the sort is stable, so ties keep file order.
      order: [...entries]
        .sort((a, b) => reviewSortKey(pairOf(b)) - reviewSortKey(pairOf(a)))
        .map((e) => e.id),
    },
  };
}

/** Close the review: its list and its readings go together. */
export function endReview(d: WaypointsDraft): WaypointsDraft {
  return d.review ? { ...d, review: null } : d;
}

/**
 * Take the map's altitude for these rows. Nothing is saved until Save, so this
 * is an ordinary unsaved edit.
 */
export function acceptMapAltitudes(
  d: WaypointsDraft,
  ids: number[]
): { draft: WaypointsDraft; accepted: number } {
  const take = new Map<number, number>();
  for (const id of ids) {
    const row = d.rows.find((r) => r.id === id);
    const alt = row ? readingFor(d, row) : undefined;
    if (alt !== undefined) take.set(id, alt);
  }
  if (take.size === 0) return { draft: d, accepted: 0 };
  return {
    draft: {
      ...d,
      rows: d.rows.map((r) => (take.has(r.id) ? { ...r, altitude: String(take.get(r.id)) } : r)),
    },
    accepted: take.size,
  };
}

const isRow = (x: unknown): x is WpRow => {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.id === "number" &&
    ["code", "name", "coords", "altitude", "radius"].every((k) => typeof r[k] === "string")
  );
};

/** A deep check of a stored draft: every part the editor reads. */
export function isWaypointsDraft(v: unknown): v is WaypointsDraft {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  if (typeof d.base !== "string" || typeof d.nextId !== "number") return false;
  if (!Array.isArray(d.rows) || !d.rows.every(isRow)) return false;
  if (d.review === null) return true;
  if (typeof d.review !== "object") return false;
  const r = d.review as Record<string, unknown>;
  const ids = (x: unknown) => Array.isArray(x) && x.every((n) => typeof n === "number");
  if (!ids(r.listed) || !ids(r.order)) return false;
  if (typeof r.readings !== "object" || r.readings === null) return false;
  return Object.values(r.readings).every(
    (t) =>
      typeof t === "object" &&
      t !== null &&
      typeof (t as TerrainReading).alt === "number" &&
      typeof (t as TerrainReading).coords === "string"
  );
}

/** The store: one draft per competition, keyed by its bare id. */
export const waypointsDraft = defineDraft<WaypointsDraft>({
  kind: "waypoints",
  version: 1,
  isValid: isWaypointsDraft,
});
