/**
 * Getting a task or a waypoint set into a flight instrument: which files are
 * offered, what each is called and what it holds, and the XCTrack `XCTSK:`
 * QR payload. Pure — the website serves these files from the competition
 * worker, the app writes them on the phone and hands them to the share
 * sheet, and both name and fill them the same way.
 *
 * The serializers are the engine's (`WAYPOINT_EXPORT_FORMATS`), so an
 * OziExplorer file states its altitudes in feet here exactly as the
 * website's download does.
 */
import {
  encodeXctskQR,
  swapCodeName,
  toXctskJSON,
  WAYPOINT_EXPORT_FORMATS,
  XCTSK_QR_MAX_BYTES,
  xctaskTurnpointsToRecords,
  type WaypointFileRecord,
  type XCTask,
} from "@glidecomp/engine";
import { slugify } from "./slug";

/** One file a reader can send to an instrument. */
export interface InstrumentFormat {
  id: string;
  label: string;
  extension: string;
  mimeType: string;
}

/** The native XCTrack task file: the whole task, not just its points. */
export const XCTSK_FORMAT: InstrumentFormat = {
  id: "xctsk",
  label: "XCTrack task (.xctsk)",
  extension: "xctsk",
  mimeType: "application/xctsk",
};

/** Every waypoint file format, in the order the website offers them. */
export const WAYPOINT_FORMATS: InstrumentFormat[] = WAYPOINT_EXPORT_FORMATS.map(
  ({ id, label, extension, mimeType }) => ({ id, label, extension, mimeType })
);

/** What a task offers: its own task file first, then its turnpoints as waypoints. */
export const TASK_FORMATS: InstrumentFormat[] = [XCTSK_FORMAT, ...WAYPOINT_FORMATS];

/** What a set is sent from: one task's route, or a competition's waypoints. */
export type InstrumentSource =
  | { kind: "task"; name: string; task: XCTask }
  | { kind: "waypoints"; name: string; records: WaypointFileRecord[] };

/** A file ready to write: the name the worker would give it, and its text. */
export interface InstrumentFile {
  filename: string;
  mimeType: string;
  text: string;
}

/** The records a source exports as waypoints, code and name swapped when asked. */
export function sourceRecords(source: InstrumentSource, swap: boolean): WaypointFileRecord[] {
  const records =
    source.kind === "task" ? xctaskTurnpointsToRecords(source.task.turnpoints) : source.records;
  return swap ? swapCodeName(records) : records;
}

/**
 * The file for one format, named as the competition worker names it
 * (`routes/waypoints.ts`): `<task>.xctsk`, `<task>-turnpoints.<ext>`,
 * `<comp>-waypoints.<ext>`. Null for a format the source cannot offer (a
 * task file from a waypoint set) or one nobody has heard of.
 *
 * `swap` only touches the waypoint formats: an `.xctsk` is the task as
 * XCTrack reads it, and its turnpoints keep the names the organiser gave.
 */
export function instrumentFile(
  source: InstrumentSource,
  formatId: string,
  { swap = false }: { swap?: boolean } = {}
): InstrumentFile | null {
  const base = slugify(source.name) || (source.kind === "task" ? "task" : "competition");
  if (formatId === XCTSK_FORMAT.id) {
    if (source.kind !== "task") return null;
    return {
      filename: `${base}.${XCTSK_FORMAT.extension}`,
      mimeType: XCTSK_FORMAT.mimeType,
      text: JSON.stringify(toXctskJSON(source.task)),
    };
  }
  const format = WAYPOINT_EXPORT_FORMATS.find((f) => f.id === formatId);
  if (!format) return null;
  const suffix = source.kind === "task" ? "turnpoints" : "waypoints";
  return {
    filename: `${base}-${suffix}.${format.extension}`,
    mimeType: format.mimeType,
    text: format.serialize(sourceRecords(source, swap)),
  };
}

/** The formats a source offers, in order. */
export function formatsFor(source: InstrumentSource): InstrumentFormat[] {
  return source.kind === "task" ? TASK_FORMATS : WAYPOINT_FORMATS;
}

/**
 * The XCTrack `XCTSK:` QR for a source: what XCTrack, Flyskyhy and most
 * flight apps scan. A set too big for one code says so instead (`value`
 * null), and the reader is pointed at a file.
 */
export interface InstrumentQr {
  value: string | null;
  /** Points in the code, for its caption ("7 turnpoints"). */
  count: number;
}

export function instrumentQr(source: InstrumentSource, { swap = false }: { swap?: boolean } = {}): InstrumentQr {
  const records = sourceRecords(source, swap);
  if (records.length === 0) return { value: null, count: 0 };
  const value = encodeXctskQR(records);
  const bytes = new TextEncoder().encode(value).length;
  return { value: bytes > XCTSK_QR_MAX_BYTES ? null : value, count: records.length };
}
