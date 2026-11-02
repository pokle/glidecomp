/**
 * The route editor's DRAFT: a task's route as the organiser is editing it,
 * before Save sends it to the server as one `.xctsk`.
 *
 * The editor is several pages since #812 — the route (/comp/:c/task/:t/route),
 * one turnpoint (/route/:n), Quick entry (/route/quick), Load from XContest
 * (/route/xcontest) and Add waypoint (/route/add-waypoint). They all edit ONE
 * route, so it lives in this tab's storage (lib/draft-store.ts,
 * docs/drafts.md) rather than in any one page's memory: each page reads it
 * when it mounts and writes every change straight back, so Back, Forward and
 * a reload all find it where it was left. It is the waypoints editor's model
 * (comp/waypoints-draft.ts, #811), for the same reasons: the server holds the
 * route as one document, saved with one PATCH and one audit entry.
 *
 * **Row ids are the draft's own.** A turnpoint's page is addressed by its row
 * id (`/route/3`), not its code or its position: the code is one of the fields
 * that page edits, the position changes with every reorder, and a turnpoint
 * added a minute ago exists nowhere else. With no draft, the rows are
 * numbered 1..N in route order; a draft keeps the ids it was given, and a new
 * row takes an id never used before.
 *
 * **What the draft remembers of the server.** `base` is the content of the
 * saved route it started from, so the editor can tell when the saved route
 * changed under it: a draft with no edits of its own is then dropped for the
 * new route, and one with edits is kept, and says so.
 *
 * **Times are as the organiser types them**, in the competition's zone (see
 * RouteEditor's note): the gates and the goal deadline only become UTC when
 * the route is assembled for Save.
 *
 * Pure: no React, no storage of its own beyond the store definition.
 */
import type { GoalConfig, SSSConfig, WaypointFileRecord, XCTask } from "@glidecomp/engine";
import { defineDraft } from "../lib/draft-store";
import {
  editableGates,
  gateToHHMM,
  turnpointsToRows,
  type RouteRow,
} from "./route-editor";
import { parseTimeToken, type QuickTaskApply } from "./quick-task";
import { reconcileRoute } from "./route-reconcile";
import {
  blankDraft,
  demoteOtherGoals,
  draftFromRecord,
  inferAddedType,
  moveRowToEnd,
  reconcileGoalPosition,
  type TurnpointDraft,
} from "./turnpoint-draft";

export interface RouteDraft {
  /** {@link contentKey} of the saved route this draft started from. */
  base: string;
  /**
   * The task the route was loaded from — the saved one, or the file or
   * XContest task imported since. Carries what the editor does not edit
   * (task type, earth model, take-off window, cylinder tolerance) through to
   * Save.
   */
  baseTask: XCTask | null;
  /** The turnpoints, in route order. `leg` and `dir` are not used here. */
  rows: RouteRow[];
  /** The id the next new row gets. */
  nextId: number;
  sssType: SSSConfig["type"];
  direction: SSSConfig["direction"];
  /** HH:MM in the editing zone, as typed. */
  gates: string[];
  goalType: GoalConfig["type"];
  /** HH:MM in the editing zone, or "" for none. */
  goalDeadline: string;
  /** Elevated Goal height (m), or null for none. */
  goalElevation: number | null;
  /**
   * Waypoints made on the route editor's Add waypoint page: in the route
   * already, and written to the competition's waypoints only when the route
   * is saved — so discarding the route discards them too.
   */
  pendingWaypoints: WaypointFileRecord[];
}

/** How the saved route's UTC times are shown for editing. */
export interface RouteDraftContext {
  toDisplayTime: (hhmm: string) => string;
}

/** A task's Elevated Goal height (m), or null when it has none. */
export function elevationFromTask(task: XCTask | null | undefined): number | null {
  const fa = task?.goal?.finishAltitude;
  return typeof fa === "number" && fa > 0 ? fa : null;
}

/**
 * A row with neither a name nor coordinates: nothing to keep. "Add turnpoint"
 * makes one and opens its page; left like that, it is not an edit (the
 * content key ignores it) and the route page drops it ({@link pruneBlankRows}),
 * just as the turnpoint sheet used to drop an Add dismissed untouched.
 */
export function isBlankRow(r: Pick<RouteRow, "name" | "coords">): boolean {
  return String(r.name).trim() === "" && String(r.coords).trim() === "";
}

/**
 * Everything the organiser can change, as one string: two drafts with the same
 * key would save the same route. Row ids are left out (a reloaded route is
 * renumbered, and is not an edit), and so are blank rows.
 */
export function contentKey(d: Omit<RouteDraft, "base" | "nextId">): string {
  return JSON.stringify([
    d.baseTask,
    d.rows
      .filter((r) => !isBlankRow(r))
      .map((r) => [
        String(r.name),
        String(r.description),
        r.type,
        String(r.coords),
        String(r.radius),
        String(r.altitude),
        r.altitudeLimits ?? null,
      ]),
    d.sssType,
    d.direction,
    d.gates,
    d.goalType,
    d.goalDeadline,
    d.goalElevation,
    d.pendingWaypoints,
  ]);
}

/** The editor's fields for a task: rows numbered from `firstId`, times shown for editing. */
function fieldsFromTask(
  task: XCTask | null,
  ctx: RouteDraftContext,
  firstId: number
): Omit<RouteDraft, "base" | "pendingWaypoints"> {
  let id = firstId - 1;
  const rows = turnpointsToRows(task?.turnpoints ?? [], () => ++id);
  const deadline = task?.goal?.deadline ? gateToHHMM(task.goal.deadline) : null;
  return {
    baseTask: task,
    rows,
    nextId: id + 1,
    sssType: task?.sss?.type ?? "RACE",
    direction: task?.sss?.direction ?? "EXIT",
    gates: editableGates(task?.sss).map(ctx.toDisplayTime),
    goalType: task?.goal?.type ?? "CYLINDER",
    goalDeadline: deadline ? ctx.toDisplayTime(deadline) : "",
    goalElevation: elevationFromTask(task),
  };
}

/** The editor as it stands with no draft: the saved route, numbered 1..N. */
export function freshDraft(saved: XCTask | null, ctx: RouteDraftContext): RouteDraft {
  const fields = { ...fieldsFromTask(saved, ctx, 1), pendingWaypoints: [] };
  return { ...fields, base: contentKey(fields) };
}

/** The content key of the saved route: what an untouched editor holds. */
export function savedKey(saved: XCTask | null, ctx: RouteDraftContext): string {
  return freshDraft(saved, ctx).base;
}

/** Whether this draft differs from the saved route whose key is `base`. */
export function isDirty(d: RouteDraft, base: string): boolean {
  return contentKey(d) !== base;
}

/**
 * The draft to edit, given the one in storage (if any) and the route the
 * server holds now — the waypoints editor's rule (comp/waypoints-draft.ts): a
 * stored draft with no edits of its own is only a copy of an older save, and
 * is dropped when the saved route has moved; one WITH edits is kept, and
 * `serverChanged` says the saved route moved under it.
 */
export function resolveDraft(
  stored: RouteDraft | null,
  saved: XCTask | null,
  ctx: RouteDraftContext
): { draft: RouteDraft; fromStorage: boolean; serverChanged: boolean } {
  const fresh = freshDraft(saved, ctx);
  if (!stored) return { draft: fresh, fromStorage: false, serverChanged: false };
  if (stored.base === fresh.base) return { draft: stored, fromStorage: true, serverChanged: false };
  if (!isDirty(stored, stored.base)) return { draft: fresh, fromStorage: false, serverChanged: false };
  return { draft: stored, fromStorage: true, serverChanged: true };
}

/** One row as a new row of `d`, under the next id. */
function withRow(d: RouteDraft, fields: TurnpointDraft): { draft: RouteDraft; id: number } {
  const id = d.nextId;
  const row: RouteRow = { id, ...fields, leg: null, dir: null };
  return { draft: { ...d, rows: [...d.rows, row], nextId: id + 1 }, id };
}

/**
 * Append a turnpoint — a map pick, or a waypoint made on Add waypoint. A new
 * Goal is the only Goal, as the turnpoint sheet's Add made it.
 */
export function appendTurnpoint(
  d: RouteDraft,
  fields: TurnpointDraft
): { draft: RouteDraft; id: number } {
  const { draft, id } = withRow(d, fields);
  return fields.type === "GOAL"
    ? { draft: { ...draft, rows: demoteOtherGoals(draft.rows, id) }, id }
    : { draft, id };
}

/**
 * "Add turnpoint": an empty row of the inferred type, for its page to fill in.
 * Nothing else changes yet — an older Goal is demoted by the first edit
 * ({@link editTurnpoint}), not by the press, so an Add left empty changes
 * nothing at all.
 */
export function appendBlank(
  d: RouteDraft,
  type: RouteRow["type"]
): { draft: RouteDraft; id: number } {
  return withRow(d, blankDraft(type));
}

/**
 * Change one turnpoint's fields. A Goal is the last turnpoint and the only
 * Goal, so a row that is (or becomes) one goes to the end and demotes any
 * other. `movedToEnd` says it moved, for the page to say so.
 */
export function editTurnpoint(
  d: RouteDraft,
  id: number,
  patch: Partial<TurnpointDraft>
): { draft: RouteDraft; movedToEnd: boolean } {
  let rows = d.rows.map((r) => (r.id === id ? { ...r, ...patch } : r));
  const row = rows.find((r) => r.id === id);
  let movedToEnd = false;
  if (row?.type === "GOAL") {
    rows = demoteOtherGoals(rows, id);
    movedToEnd = rows[rows.length - 1]?.id !== id;
    rows = moveRowToEnd(rows, id);
  }
  return { draft: { ...d, rows }, movedToEnd };
}

/** Drop one turnpoint. */
export function removeTurnpoint(d: RouteDraft, id: number): RouteDraft {
  return { ...d, rows: d.rows.filter((r) => r.id !== id) };
}

/**
 * Move a turnpoint one place, swapping it with its neighbour; Goal stays last.
 * `to` is its new index, or -1 when it could not move.
 */
export function moveTurnpoint(
  d: RouteDraft,
  id: number,
  delta: -1 | 1
): { draft: RouteDraft; to: number } {
  const at = d.rows.findIndex((r) => r.id === id);
  const to = at + delta;
  if (at < 0 || to < 0 || to >= d.rows.length) return { draft: d, to: -1 };
  const rows = [...d.rows];
  [rows[at], rows[to]] = [rows[to], rows[at]];
  return { draft: { ...d, rows: reconcileGoalPosition(rows) }, to };
}

/** Drop the rows an Add left empty (see {@link isBlankRow}). */
export function pruneBlankRows(d: RouteDraft): RouteDraft {
  return d.rows.some(isBlankRow) ? { ...d, rows: d.rows.filter((r) => !isBlankRow(r)) } : d;
}

/** Start again with no turnpoints ("Clear turnpoints"). */
export function clearTurnpoints(d: RouteDraft): RouteDraft {
  return d.rows.length > 0 ? { ...d, rows: [] } : d;
}

/**
 * Quick entry's "Use this route": the route the line describes, RECONCILED
 * with the one in the draft (route-reconcile.ts) so a turnpoint the line still
 * names keeps its id, coordinates, elevation and long name. The line's start
 * settings follow when the route has a start (never for open distance), and
 * the gates only when the line says something other than what the draft holds
 * — a gate half-typed in the picker is absent from the line, and must not be
 * thrown away by an edit elsewhere.
 */
export function applyQuickEntry(
  d: RouteDraft,
  { picks, start }: Pick<QuickTaskApply, "picks" | "start">,
  opts: { openDistance: boolean }
): RouteDraft {
  let nextId = d.nextId;
  const rows = reconcileRoute(d.rows, picks, () => nextId++);
  const next: RouteDraft = { ...d, rows, nextId };
  if (opts.openDistance || !start) return next;
  const sayable = d.gates.filter((g) => parseTimeToken(g) !== null);
  return {
    ...next,
    sssType: start.type,
    direction: start.direction,
    gates: sayable.join(",") === start.gates.join(",") ? d.gates : start.gates,
  };
}

/**
 * A whole task loaded into the editor (an .xctsk file, or an XContest code):
 * it replaces the turnpoints, start and goal, and becomes the base for what
 * the editor does not edit. New rows take ids never used before, so a link to
 * a turnpoint of the old route names nothing rather than a stranger. Waypoints
 * made here and not yet saved stay — they are the competition's, not the
 * route's.
 */
export function loadTask(d: RouteDraft, task: XCTask, ctx: RouteDraftContext): RouteDraft {
  return { ...d, ...fieldsFromTask(task, ctx, d.nextId) };
}

/**
 * A waypoint made on Add waypoint: held for the competition until the route is
 * saved, and in the route now, as the next turnpoint.
 */
export function addNewWaypoint(
  d: RouteDraft,
  rec: WaypointFileRecord,
  opts: { openDistance: boolean }
): RouteDraft {
  const withWaypoint = { ...d, pendingWaypoints: [...d.pendingWaypoints, rec] };
  return appendTurnpoint(withWaypoint, {
    ...draftFromRecord(rec),
    type: inferAddedType(d.rows, opts),
  }).draft;
}

/** Whether the draft holds a route worth asking about before replacing it. */
export function hasTurnpoints(d: RouteDraft): boolean {
  return d.rows.some((r) => !isBlankRow(r));
}

const isRow = (x: unknown): x is RouteRow => {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  const textOrNumber = (v: unknown) => typeof v === "string" || typeof v === "number";
  return (
    typeof r.id === "number" &&
    typeof r.name === "string" &&
    typeof r.description === "string" &&
    typeof r.type === "string" &&
    typeof r.coords === "string" &&
    textOrNumber(r.radius) &&
    textOrNumber(r.altitude) &&
    (r.altitudeLimits === undefined || (typeof r.altitudeLimits === "object" && r.altitudeLimits !== null))
  );
};

/** A deep check of a stored draft: every part the editor reads. */
export function isRouteDraft(v: unknown): v is RouteDraft {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  return (
    typeof d.base === "string" &&
    typeof d.nextId === "number" &&
    (d.baseTask === null || (typeof d.baseTask === "object" && Array.isArray((d.baseTask as XCTask).turnpoints))) &&
    Array.isArray(d.rows) &&
    d.rows.every(isRow) &&
    typeof d.sssType === "string" &&
    typeof d.direction === "string" &&
    Array.isArray(d.gates) &&
    d.gates.every((g) => typeof g === "string") &&
    typeof d.goalType === "string" &&
    typeof d.goalDeadline === "string" &&
    (d.goalElevation === null || typeof d.goalElevation === "number") &&
    Array.isArray(d.pendingWaypoints)
  );
}

/** The store: one draft per task, keyed `[bare comp id, task id]`. */
export const routeDraft = defineDraft<RouteDraft>({
  kind: "route",
  version: 1,
  isValid: isRouteDraft,
});
