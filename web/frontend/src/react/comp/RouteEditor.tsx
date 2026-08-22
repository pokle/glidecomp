/**
 * Task route editor — the React replacement for the vanilla
 * analysis/task-editor on the task detail page (#270), and since #637 a
 * ROUTED PAGE (/comp/:c/task/:t/route) rather than a dialog over the task.
 *
 * It was the tallest modal in the app: a map, a turnpoint grid, start gates
 * and a goal panel inside a 100dvh panel that scrolled internally, which on a
 * phone means a scrolling region inside a scrolling region and a sticky title
 * bar spending height that the map wanted. As a page all of that is just the
 * page — one scroll, the browser's own back button, and a URL an organiser can
 * send to a co-admin.
 *
 * A whole route can be set here WITHOUT typing the quick-task syntax (#661).
 * The turnpoint list (comp/TurnpointList.tsx) is the editing surface: a row
 * opens comp/TurnpointSheet.tsx, "Add turnpoint" opens the same sheet empty,
 * Delete lives in it, and "Reorder" turns the rows into Move up / Move down.
 * The syntax is still here, and still the fast way in for someone who knows
 * the waypoint codes — but behind a "Quick entry" button, in its own sheet
 * (comp/QuickEntrySheet.tsx), applied by an explicit press that RECONCILES
 * with the route rather than rebuilding it (comp/route-reconcile.ts).
 *
 * Everything on this page is a DRAFT until Save. That is what makes the two
 * sheets sheets and not routes: the whole route is unsaved React state, a
 * sibling route would unmount it, and lib/use-unsaved-changes-guard.ts
 * intercepts every same-origin anchor click while the route is dirty, so a row
 * that linked anywhere would ask "Discard route changes?" on the way IN to
 * editing a turnpoint.
 *
 * The rest is unchanged: every derived value (leg distances, crossing
 * direction, the map preview) is a useMemo over `rows` rather than an
 * imperative write-back; Start (SSS) gates and goal configuration are edited
 * in collapsible sections below the list so a whole .xctsk is editable in one
 * place; routes can be imported from a .xctsk file or an XContest task code,
 * and exported to a .xctsk file. Saving PATCHes the task's xctsk (the server
 * validates strictly and audit-logs the change).
 *
 * AddWaypointDialog stays a plain dialog over this page: it is a short
 * single-purpose form, and it is shared with the competition waypoints page,
 * so reshaping it here would fork it.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileTrigger } from "react-aria-components";
import {
  parseXCTaskAsync,
  toXctskJSON,
  type GoalConfig,
  type SSSConfig,
  type WaypointFileRecord,
  type XCTask,
} from "@glidecomp/engine";
import type { MapPickDetails, MapWaypoint } from "../../analysis/map-provider";
import { Button, ToggleButton } from "@/react/rac/button";
import { Explain } from "@/react/rac/explain";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Modal,
} from "@/react/rac/dialog";
import { Breadcrumbs } from "@/react/rac/breadcrumbs";
import { Disclosure } from "@/react/rac/disclosure";
import { NumberField, TextField } from "@/react/rac/field";
import { ChoiceList } from "@/react/rac/choice-list";
import { TimePicker } from "@/react/rac/date-picker";
import { api } from "../../comp/api";
import { fetchTaskByCodeWithRaw } from "../../analysis/xctsk-fetch";
import { toast } from "../lib/toast";
import { useConfirm } from "../lib/confirm";
import { useUnsavedChangesGuard } from "../lib/use-unsaved-changes-guard";
import { downloadFile } from "../lib/format";
import { utcToZonedHHMM, zonedToUtcHHMM, zoneNameWithOffset } from "../lib/time";
import { slugify } from "./csv";
import { underTask } from "../lib/crumbs";
import {
  addMinutes,
  buildRoute,
  editableGates,
  formatCoords,
  gateToHHMM,
  parseCoords,
  startConfigSummary,
  turnpointsToCSV,
  turnpointToRow,
  xctskForPatch,
  type RouteRow,
} from "./route-editor";
import { AddWaypointDialog } from "./AddWaypointDialog";
import { QuickEntrySheet } from "./QuickEntrySheet";
import { TurnpointList } from "./TurnpointList";
import { parseTimeToken, quickTaskText, type QuickTaskApply } from "./quick-task";
import { reconcileRoute } from "./route-reconcile";

// Lazy so the map library (mapbox) and its CSS load only when the editor
// opens and never enter the SSR'd task-detail bundle.
const RouteMap = lazy(() => import("./RouteMap"));


import {
  NEW_ROW_RADIUS,
  blankDraft,
  draftFromRecord,
  missingAltitude,
  type TurnpointDraft,
} from "./turnpoint-draft";
import { TurnpointSheet } from "./TurnpointSheet";

export function RouteEditor({
  compId,
  compName,
  taskId,
  taskName,
  taskDate,
  xctsk,
  openDistance,
  timezone,
  onCancel,
  onSaved,
}: {
  compId: string;
  /** For the breadcrumb trail's canonical links. */
  compName: string;
  taskId: string;
  taskName: string;
  taskDate: string;
  xctsk: XCTask | null;
  /** Comp scoring format is open distance: single-Takeoff rule, no SSS/goal. */
  openDistance: boolean;
  /**
   * Comp-local IANA zone (comp settings). When set, gates and the goal
   * deadline are edited in comp-local time (stored as UTC either way);
   * when null the editor falls back to UTC, today's behaviour.
   */
  timezone: string | null;
  /** Leaving without saving; the caller decides where "back" is. */
  onCancel: () => void;
  onSaved: () => void;
}) {
  const confirm = useConfirm();

  // Gate/deadline times are edited in the comp zone when one is set (#274).
  // The xctsk file stores UTC, so times convert on load and on save; all
  // conversions anchor to the task date so DST offsets are the day's own.
  const tz = timezone;
  const toDisplayTime = (hhmm: string): string =>
    tz ? (utcToZonedHHMM(taskDate, hhmm, tz) ?? hhmm) : hhmm;
  const toUtcTime = (hhmm: string): string =>
    tz ? (zonedToUtcHHMM(taskDate, hhmm, tz) ?? hhmm) : hhmm;
  const timeZoneLabel = tz
    ? zoneNameWithOffset(new Date(`${taskDate}T12:00:00Z`), tz)
    : "UTC";

  const [saving, setSaving] = useState(false);

  // Row ids must be unique for React keys and DnD keys; never reuse.
  const rowIdRef = useRef(0);
  const nextRowId = useCallback(() => ++rowIdRef.current, []);

  // THE grid state: turnpoint rows, in route order. Everything else (legs,
  // directions, validation, the map preview) is derived below.
  const [rows, setRows] = useState<RouteRow[]>(() =>
    (xctsk?.turnpoints ?? []).map((tp) => turnpointToRow(tp, ++rowIdRef.current))
  );
  // Latest rows for async flows (fillAltitudes applies its results against the
  // rows as they are *after* the tile downloads, not a stale closure).
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const [fillingAlts, setFillingAlts] = useState(false);

  // The turnpoint sheet: adding one by hand, or editing the row whose id this
  // holds. Draft-first — the sheet applies its draft on the way out.
  const [addingTurnpoint, setAddingTurnpoint] = useState(false);
  const [editingRowId, setEditingRowId] = useState<number | null>(null);

  // Quick entry: the whole route as text, in its own sheet.
  const [quickOpen, setQuickOpen] = useState(false);

  /**
   * Reorder mode. Rows stop opening the sheet and carry Move up / Move down
   * instead — a mode rather than per-row chrome, so a list at rest is a name,
   * a summary and a chevron.
   */
  const [reordering, setReordering] = useState(false);
  /** The move just made: focus follows the turnpoint (see TurnpointList). */
  const [moved, setMoved] = useState<{
    rowId: number;
    delta: -1 | 1;
    nonce: number;
  } | null>(null);
  /** Said out loud for a screen reader, which sees no rows swap. */
  const [moveNote, setMoveNote] = useState("");

  // The competition's shared waypoints (loaded once on open), shown on the map
  // and in a searchable list. Turnpoints are picked from this set only — the
  // task copies each waypoint's details in, so it can't be changed after the
  // fact by editing the competition waypoints.
  const [waypointRecords, setWaypointRecords] = useState<WaypointFileRecord[]>([]);
  const [wpLoading, setWpLoading] = useState(true);
  const [wpFitNonce, setWpFitNonce] = useState(0);
  // Inline "add a missing waypoint" flow. The map goes into add-mode so a tap
  // seeds the shared dialog; the new point drops straight into this route (see
  // addNewWaypoint) and is written to the competition only when the route is
  // saved.
  const [addMode, setAddMode] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addSeedCoords, setAddSeedCoords] = useState("");
  const [addSeedDetails, setAddSeedDetails] = useState<MapPickDetails | undefined>(undefined);
  // Waypoints created inline but not yet persisted. They show in the picker and
  // on the map right away, but reach the competition's waypoint set only on
  // route save — so cancelling the edit discards them cleanly (a way out if a
  // new point was a mistake, since a picked turnpoint can't be renamed here),
  // and a saved route never references a comp waypoint that was never stored.
  const [pendingWaypoints, setPendingWaypoints] = useState<WaypointFileRecord[]>([]);
  const [xcontestCode, setXcontestCode] = useState("");
  const [xcontestLoading, setXcontestLoading] = useState(false);
  // The "Load from XContest" flow is a small pop-up (a code input + Load).
  const [xcImportOpen, setXcImportOpen] = useState(false);

  // Fields not edited by the grid/panels (taskType, earthModel, takeoff,
  // cylinderTolerance) are carried over from the loaded task; an import
  // replaces the whole base. A declared cylinderTolerance is preserved on
  // the file but no longer edited or scored — S7F 2026 §9.1.1 fixes the
  // band at ±5 m.
  const baseRef = useRef<XCTask | null>(xctsk);

  // Load the competition's waypoints once, to pick turnpoints from.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.api.comp[":comp_id"].waypoints.$get({
          param: { comp_id: compId },
        });
        if (cancelled) return;
        const data = res.ok
          ? ((await res.json()) as unknown as { waypoints: WaypointFileRecord[] })
          : { waypoints: [] };
        setWaypointRecords(data.waypoints);
        setWpFitNonce((n) => n + 1);
      } catch {
        /* leave the list empty; the empty-state points at the waypoints page */
      } finally {
        if (!cancelled) setWpLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [compId]);

  // Start (SSS) panel state
  const [sssType, setSssType] = useState<SSSConfig["type"]>(xctsk?.sss?.type ?? "RACE");
  const [direction, setDirection] = useState<SSSConfig["direction"]>(
    xctsk?.sss?.direction ?? "EXIT"
  );
  const [gates, setGates] = useState<string[]>(() =>
    editableGates(xctsk?.sss).map(toDisplayTime)
  );
  const [genCount, setGenCount] = useState(4);
  const [genInterval, setGenInterval] = useState(15);

  // Goal panel state
  const [goalType, setGoalType] = useState<GoalConfig["type"]>(
    xctsk?.goal?.type ?? "CYLINDER"
  );
  const [goalDeadline, setGoalDeadline] = useState<string>(() => {
    const hhmm = xctsk?.goal?.deadline ? gateToHHMM(xctsk.goal.deadline) : null;
    return hhmm ? toDisplayTime(hhmm) : "";
  });

  /**
   * Has anything been edited? A snapshot comparison rather than a per-field
   * diff, because the editable surface is six pieces of state and any of them
   * moving means the same thing: there is work here to lose.
   *
   * It cannot go through `assembleTask()` — that toasts on an invalid gate,
   * and a guard must not talk. A half-typed route is exactly the state worth
   * guarding, so the snapshot has to tolerate one.
   *
   * As a dialog this had no guard at all: dismissing threw the route away
   * silently. A page has more ways out (the breadcrumb, the back button, a
   * stray tap), which is what makes the guard worth having now.
   */
  const snapshot = (): string =>
    JSON.stringify([
      rows,
      gates,
      sssType,
      direction,
      goalType,
      goalDeadline,
      pendingWaypoints,
    ]);
  const initialSnapshotRef = useRef<string | null>(null);
  if (initialSnapshotRef.current === null) initialSnapshotRef.current = snapshot();
  const dirty = snapshot() !== initialSnapshotRef.current;

  useUnsavedChangesGuard(dirty && !saving, {
    title: "Discard route changes?",
    message: "This route has unsaved changes. Leaving will discard them.",
  });

  /**
   * Validation + derived geometry, recomputed whenever the rows or the
   * SSS/goal panels change. Replaces Tabulator's recompute()-and-write-back:
   * legs and directions are read straight from this memo at render time.
   */
  const derived = useMemo(() => {
    const result = buildRoute(rows, { openDistance });
    const hasSSSTurnpoint = result.turnpoints.some((tp) => tp.type === "SSS");

    // The goal config shapes the preview and the distances: a LINE goal is
    // drawn as the goal line + control semicircle, and the optimised route
    // ends on the line instead of the cylinder edge. Open-distance comps
    // hide the goal panel, so carry whatever the loaded task had.
    const goal = openDistance ? baseRef.current?.goal : { type: goalType };

    // Feed the map the turnpoints parsed so far — cylinders and the optimised
    // line update live as rows are edited, added, reordered or picked.
    const mapTask: XCTask | null =
      result.turnpoints.length > 0
        ? {
            taskType: baseRef.current?.taskType || "CLASSIC",
            version: baseRef.current?.version ?? 1,
            turnpoints: result.turnpoints,
            // The SSS panel's direction feeds the Enter/Exit inference the
            // turnpoint listing shows, so flipping it updates the list live.
            ...(openDistance ? {} : { sss: { type: sssType, direction } }),
            ...(goal ? { goal } : {}),
          }
        : null;

    return { result, hasSSSTurnpoint, mapTask };
  }, [rows, openDistance, goalType, sssType, direction]);

  const { errors, warnings } = derived.result;

  // Competition waypoints as map markers (index is the marker id, resolved
  // back to the record on pick so all details carry across).
  const mapWaypoints: MapWaypoint[] = useMemo(
    () =>
      waypointRecords.map((w, i) => ({
        id: String(i),
        code: w.code,
        name: w.name,
        lat: w.latitude,
        lon: w.longitude,
      })),
    [waypointRecords]
  );

  /** Append a new turnpoint from a draft (the turnpoint sheet's Add). */
  const appendTurnpoint = useCallback(
    (draft: TurnpointDraft) => {
      setRows((prev) => [
        ...prev,
        { id: nextRowId(), ...draft, leg: null, dir: null } satisfies RouteRow,
      ]);
    },
    [nextRowId]
  );

  /** Patch one turnpoint in place (the turnpoint sheet's Done). */
  const updateTurnpoint = useCallback((id: number, draft: TurnpointDraft) => {
    setRows((prev) =>
      prev.map((r) => (r.id === id ? { ...r, ...draft, leg: null, dir: null } : r))
    );
  }, []);

  /** Drop one turnpoint (the turnpoint sheet's Delete). */
  const removeTurnpoint = useCallback((id: number) => {
    setRows((prev) => prev.filter((r) => r.id !== id));
  }, []);

  /**
   * Move a turnpoint one place: swap it with its neighbour.
   *
   * The whole of reordering, and deliberately so — see the issue and RAC
   * gotcha #4. It also says what happened, because the only other evidence is
   * two rows changing places, which a screen reader never sees.
   */
  const moveTurnpoint = useCallback((id: number, delta: -1 | 1) => {
    // Read the rows off the ref rather than a setRows updater: the move also
    // announces itself, and a state update inside another one's updater is not
    // something to rely on.
    const prev = rowsRef.current;
    const at = prev.findIndex((r) => r.id === id);
    const to = at + delta;
    if (at < 0 || to < 0 || to >= prev.length) return;
    const next = [...prev];
    [next[at], next[to]] = [next[to], next[at]];
    setRows(next);
    const name = String(next[to].name).trim() || "Turnpoint";
    setMoveNote(`${name} moved to ${to + 1} of ${next.length}`);
    setMoved((m) => ({ rowId: id, delta, nonce: (m?.nonce ?? 0) + 1 }));
  }, []);

  // Quick entry needs waypoints to match names against; without any, the sheet
  // would be a dead end (and the empty state must not point at it).
  const showQuickTask = !wpLoading && waypointRecords.length > 0;

  /** The turnpoint names the route holds — what Quick entry may keep. */
  const knownNames = useMemo(() => rows.map((r) => String(r.name)), [rows]);

  /** The row the turnpoint sheet is editing, or null. */
  const editingRow = rows.find((r) => r.id === editingRowId) ?? null;

  // The route as a quick-task line, so the Quick entry sheet opens showing the
  // task that is loaded and edits it rather than starting from a blank box.
  // The start config is part of it (#436) — otherwise the line would say "sss"
  // while the panel quietly held an enter start.
  //
  // Only gates that read as times are offered: a gate mid-edit in the picker
  // isn't something the line can say.
  const quickText = useMemo(
    () =>
      quickTaskText(
        rows.map((r) => ({
          name: String(r.name),
          radius: Number(r.radius) || NEW_ROW_RADIUS,
          type: r.type,
        })),
        openDistance
          ? {}
          : {
              start: {
                direction,
                type: sssType,
                gates: gates.filter((g) => parseTimeToken(g) !== null),
              },
            }
      ),
    [rows, openDistance, direction, sssType, gates]
  );

  /**
   * Quick entry: make the route the line describes.
   *
   * RECONCILED against the route already loaded, not rebuilt from the matched
   * waypoints (route-reconcile.ts): a turnpoint the line still names keeps its
   * id, its coordinates, its elevation and its long name, none of which the
   * grammar can say. Rebuilding used to throw all of that away on a keystroke.
   *
   * Nothing is saved until Save, so this stays undoable by cancelling the page.
   *
   * The line also carries the start config, so the Start panel below follows it
   * — but only when the route has a start to configure, and never for an
   * open-distance task (which has no speed section and hides the panel).
   */
  const applyQuickTask = useCallback(
    ({ picks, start }: QuickTaskApply) => {
      setRows((prev) => reconcileRoute(prev, picks, nextRowId));
      if (openDistance || !start) return;
      setSssType(start.type);
      setDirection(start.direction);
      // Rewrite the gates only when the line genuinely says something else:
      // an edit elsewhere in the route mustn't discard a gate that's mid-edit
      // in the picker (and so absent from the line — see quickText above).
      setGates((prev) => {
        const sayable = prev.filter((g) => parseTimeToken(g) !== null);
        return sayable.join(",") === start.gates.join(",") ? prev : start.gates;
      });
    },
    [nextRowId, openDistance]
  );

  /** Pick from the map: the nearest marker, resolved to its record by id, and
   *  appended straight to the route (a map tap is an explicit add). */
  const pickWaypoint = useCallback(
    (wp: MapWaypoint) => {
      const rec = waypointRecords[Number(wp.id)];
      if (rec) appendTurnpoint(draftFromRecord(rec));
    },
    [waypointRecords, appendTurnpoint]
  );

  // Open the shared add-waypoint dialog, seeded from a map tap (or blank when
  // opened from the button). Leaving add-mode on afterwards would keep the
  // crosshair, so turn it off.
  const openAddPoint = useCallback((coords = "", details?: MapPickDetails) => {
    setAddSeedCoords(coords);
    setAddSeedDetails(details);
    setAdding(true);
    setAddMode(false);
  }, []);

  /**
   * Stage a brand-new waypoint: show it in the picker/map and drop it into the
   * route as a turnpoint now, but hold it out of the competition until the route
   * is saved (see save → persistPendingWaypoints). Nothing hits the network here,
   * so cancelling the edit throws the point away.
   */
  function addNewWaypoint(rec: WaypointFileRecord) {
    setAdding(false);
    setWaypointRecords((prev) => [...prev, rec]);
    setPendingWaypoints((prev) => [...prev, rec]);
    appendTurnpoint(draftFromRecord(rec));
    toast.success(`Added ${rec.code} to the route — saved to the competition when you save`);
  }

  /**
   * Write the staged waypoints to the competition, on route save. Waypoints are
   * stored as one full-replace blob (there's no append endpoint), so re-fetch
   * the freshest set and append the pending ones — that way a waypoint added
   * elsewhere since this dialog opened isn't clobbered. Audited server-side; not
   * a scoring input. Returns false (with a toast) so the caller can abort the
   * save instead of writing a route whose new waypoints failed to persist.
   */
  async function persistPendingWaypoints(): Promise<boolean> {
    try {
      // The freshest server set, falling back to the records we loaded minus the
      // still-unsaved ones (compared by reference — pending records are the very
      // objects pushed into waypointRecords).
      let base = waypointRecords.filter((w) => !pendingWaypoints.includes(w));
      try {
        const res = await api.api.comp[":comp_id"].waypoints.$get({
          param: { comp_id: compId },
        });
        if (res.ok) {
          base = (await res.json() as unknown as { waypoints: WaypointFileRecord[] }).waypoints;
        }
      } catch {
        /* fall back to the list we already loaded */
      }
      const put = await api.api.comp[":comp_id"].waypoints.$put({
        param: { comp_id: compId },
        json: { waypoints: [...base, ...pendingWaypoints] },
      });
      if (!put.ok) {
        const err = (await put.json()) as { error?: string };
        toast.error(err.error || "Failed to save the new waypoints");
        return false;
      }
      setPendingWaypoints([]);
      return true;
    } catch {
      toast.error("Network error saving the new waypoints. Please try again.");
      return false;
    }
  }

  /** Load a parsed task into the editor (grid + panels + base fields). */
  async function loadTask(task: XCTask, sourceLabel: string) {
    const existing = rows.some(
      (r) => String(r.name).trim() !== "" || String(r.coords).trim() !== ""
    );
    if (existing) {
      const ok = await confirm({
        title: "Replace the route in the editor?",
        message: `Loading ${sourceLabel} replaces the turnpoints, start gates and goal currently in the editor. Nothing is saved until you press Save.`,
        confirmLabel: "Replace",
      });
      if (!ok) return;
    }
    baseRef.current = task;
    setRows(task.turnpoints.map((tp) => turnpointToRow(tp, nextRowId())));
    setSssType(task.sss?.type ?? "RACE");
    setDirection(task.sss?.direction ?? "EXIT");
    setGates(editableGates(task.sss).map(toDisplayTime));
    setGoalType(task.goal?.type ?? "CYLINDER");
    const deadline = task.goal?.deadline ? gateToHHMM(task.goal.deadline) : null;
    setGoalDeadline(deadline ? toDisplayTime(deadline) : "");
    toast.success(`Loaded ${task.turnpoints.length} turnpoints from ${sourceLabel}`);
  }

  async function importFile(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    try {
      const parsed = await parseXCTaskAsync(await file.text());
      if (parsed.turnpoints.length === 0) {
        toast.error(`${file.name} has no turnpoints`);
        return;
      }
      await loadTask(parsed, file.name);
    } catch {
      toast.error(`Could not read ${file.name} — is it a valid .xctsk task file?`);
    }
  }

  async function importXContest() {
    const code = xcontestCode.trim();
    if (!code) return;
    setXcontestLoading(true);
    try {
      const { task } = await fetchTaskByCodeWithRaw(code);
      await loadTask(task, `XContest task ${code.toUpperCase()}`);
      setXcontestCode("");
      setXcImportOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load XContest task");
    } finally {
      setXcontestLoading(false);
    }
  }

  /** Assemble a full XCTask from the grid + panels, or null with a toast. */
  function assembleTask(): XCTask | null {
    const result = buildRoute(rows, { openDistance });
    if (result.errors.length > 0) return null;

    const base = baseRef.current;
    const task: XCTask = {
      taskType: base?.taskType || "CLASSIC",
      version: base?.version ?? 1,
      ...(base?.earthModel ? { earthModel: base.earthModel } : {}),
      turnpoints: result.turnpoints,
      ...(base?.takeoff ? { takeoff: base.takeoff } : {}),
      // Preserved from the loaded task for file fidelity only — scoring
      // evaluates every task at the fixed S7F 2026 band (±5 m).
      ...(base?.cylinderTolerance !== undefined
        ? { cylinderTolerance: base.cylinderTolerance }
        : {}),
    };
    if (openDistance) {
      // Open distance has no speed section or goal; keep whatever the
      // loaded task carried rather than inventing config the panels hide.
      if (base?.sss) task.sss = base.sss;
      if (base?.goal) task.goal = base.goal;
      return task;
    }

    const cleaned = gates.map(gateToHHMM).filter((g): g is string => g !== null);
    if (cleaned.length !== gates.length) {
      toast.warning("Every start gate needs a valid time");
      return null;
    }
    // Dedup + sort in the editing zone: the comp's flying day is contiguous
    // on its own clock, while the equivalent UTC times can wrap midnight
    // (Australian mornings are the previous UTC evening) — sorting the UTC
    // strings would misorder the gates.
    const sorted = [...new Set(cleaned)].sort();
    task.sss = {
      type: sssType,
      direction,
      ...(sorted.length > 0
        ? { timeGates: sorted.map((g) => `${toUtcTime(g)}:00Z`) }
        : {}),
    };
    task.goal = {
      type: goalType,
      ...(goalDeadline ? { deadline: `${toUtcTime(goalDeadline)}:00Z` } : {}),
      ...(base?.goal?.finishAltitude !== undefined
        ? { finishAltitude: base.goal.finishAltitude }
        : {}),
    };
    return task;
  }

  function exportFile() {
    const task = assembleTask();
    if (!task) {
      toast.error("Fix the route problems before exporting");
      return;
    }
    downloadFile(
      `${slugify(taskName)}.xctsk`,
      JSON.stringify(toXctskJSON(task)),
      "application/json"
    );
  }

  /** Export the turnpoints as a competition waypoint CSV file. */
  function exportCsv() {
    const result = buildRoute(rows, { openDistance });
    if (result.turnpoints.length === 0) {
      toast.error("Add some turnpoints with valid coordinates first");
      return;
    }
    downloadFile(
      `${slugify(taskName)}-waypoints.csv`,
      turnpointsToCSV(result.turnpoints),
      "text/csv"
    );
  }

  // Turnpoints that would get an altitude from "Fill altitudes from map".
  const fillableAltCount = useMemo(
    () =>
      rows.filter((r) => missingAltitude(r.altitude) && parseCoords(r.coords) !== null)
        .length,
    [rows]
  );

  /**
   * Fill blank/zero turnpoint altitudes with ground elevations from the Mapbox
   * terrain DEM (fetched directly at high zoom — see analysis/elevation.ts for
   * why we don't read them off the live map). Same behaviour as the waypoints
   * page: only missing altitudes are touched, and nothing is saved until Save.
   */
  async function fillAltitudes() {
    const targets = rows.flatMap((r) => {
      const c = parseCoords(r.coords);
      return missingAltitude(r.altitude) && c
        ? [{ id: r.id, lat: c.lat, lon: c.lon }]
        : [];
    });
    if (targets.length === 0) return;
    setFillingAlts(true);
    try {
      // Dynamic import: browser-only module (canvas decoding), loaded on press.
      const { fetchElevations } = await import("../../analysis/elevation");
      const elevations = await fetchElevations(targets);
      const byId = new Map<number, number>();
      targets.forEach((t, i) => {
        const e = elevations[i];
        if (e !== null) byId.set(t.id, Math.round(e));
      });
      if (byId.size === 0) {
        toast.error("Could not read terrain elevations from Mapbox");
        return;
      }
      // Apply against the *current* rows, and only where the altitude is still
      // missing so we never clobber a value edited while tiles downloaded.
      let filled = 0;
      const next = rowsRef.current.map((r) => {
        const alt = byId.get(r.id);
        if (alt === undefined || !missingAltitude(r.altitude)) return r;
        filled += 1;
        return { ...r, altitude: alt };
      });
      setRows(next);
      const missed = targets.length - filled;
      toast.success(
        `Filled ${filled} altitude${filled === 1 ? "" : "s"} from the map terrain` +
          (missed > 0 ? ` (${missed} unavailable)` : "")
      );
    } catch {
      toast.error("Could not read terrain elevations from Mapbox");
    } finally {
      setFillingAlts(false);
    }
  }

  /** Empty the turnpoint grid (start the route over). */
  async function clearTurnpoints() {
    const hasRows = rows.some(
      (r) => String(r.name).trim() !== "" || String(r.coords).trim() !== ""
    );
    if (hasRows) {
      const ok = await confirm({
        title: "Clear all turnpoints?",
        message:
          "This removes every turnpoint from the editor. Loaded waypoints stay on the map, and nothing is saved until you press Save.",
        confirmLabel: "Clear",
      });
      if (!ok) return;
    }
    setRows([]);
  }

  async function save() {
    const task = assembleTask();
    if (!task) return;
    setSaving(true);
    try {
      // Persist any inline-created waypoints to the competition first, so a saved
      // route never references a comp waypoint that isn't stored. On failure,
      // abort — the route isn't saved and the admin can retry (pending kept).
      const newWpCount = pendingWaypoints.length;
      if (newWpCount > 0 && !(await persistPendingWaypoints())) return;

      const res = await api.api.comp[":comp_id"].task[":task_id"].$patch({
        param: { comp_id: compId, task_id: taskId },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        json: { xctsk: xctskForPatch(task) as any },
      });
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        toast.error(err.error || "Failed to save the route");
        return;
      }
      const wpNote =
        newWpCount > 0
          ? ` · ${newWpCount} new waypoint${newWpCount === 1 ? "" : "s"} added to the competition`
          : "";
      toast.success(
        `Route saved: ${task.turnpoints.length} turnpoint${task.turnpoints.length === 1 ? "" : "s"}${wpNote} — scores will recompute`
      );
      onSaved();
    } catch {
      toast.error("Network error. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  function updateGate(index: number, value: string) {
    setGates((prev) => prev.map((g, i) => (i === index ? value : g)));
  }

  function removeGate(index: number) {
    setGates((prev) => prev.filter((_, i) => i !== index));
  }

  function addGate() {
    setGates((prev) => {
      const last = prev[prev.length - 1];
      const interval = Number.isFinite(genInterval) && genInterval > 0 ? genInterval : 15;
      return [...prev, last ? addMinutes(last, interval) : "12:00"];
    });
  }

  function generateSeries() {
    const count = Math.min(Math.max(Number.isFinite(genCount) ? genCount : 0, 1), 100);
    const interval = Number.isFinite(genInterval) && genInterval > 0 ? genInterval : 15;
    setGates((prev) => {
      const first = prev[0] ?? "12:00";
      return Array.from({ length: count }, (_, i) => addMinutes(first, i * interval));
    });
  }

  const isRace = sssType === "RACE";
  const shownErrors = errors.slice(0, 10);
  const extraErrors = errors.length - shownErrors.length;

  return (
    // Wider than a settings form on purpose: the map and the turnpoint grid
    // are the page, and `SettingsPage`'s max-w-2xl column would squeeze both.
    // The breadcrumb + title are built here rather than reusing SettingsPage
    // for the same reason.
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 pb-24">
      <div>
        <Breadcrumbs
          items={underTask(compId, compName, taskId, taskName)}
          current="Route"
        />
        <h1 className="mt-2 text-2xl font-bold">Route</h1>
      </div>
        {/* The quick-task grammar is no longer the first thing this page
            says: it moved, verbatim, into the Quick entry sheet that uses it
            (#661). A first-time scorer meets a list of turnpoints. */}
        {openDistance ? (
          <p className="text-sm text-muted-foreground">
            Open distance: define a single Takeoff turnpoint. Distance is scored
            from the take-off exit — there is no goal.
          </p>
        ) : null}

        {/* The turnpoint list — the editor's own (comp/TurnpointList.tsx),
            not the read-only listing the task page shows: rows here open the
            turnpoint sheet, and in Reorder mode they carry Move up / Move
            down. */}
        <div className="flex flex-col gap-2">
          {rows.length > 0 ? (
            <TurnpointList
              rows={rows}
              task={derived.mapTask}
              rowIds={derived.result.rowIds}
              reordering={reordering}
              moved={moved}
              onOpen={setEditingRowId}
              onMove={moveTurnpoint}
            />
          ) : (
            <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
              {showQuickTask
                ? "No turnpoints yet — add them one at a time, or use Quick entry to type the whole route."
                : "No turnpoints yet — use Add turnpoint, or import a task"}
            </p>
          )}
          {/* Reordering is the only thing said out loud: rows swapping places
              is invisible to a screen reader, and to anyone whose focus is on
              the button that did it. */}
          <p role="status" aria-live="polite" className="sr-only">
            {moveNote}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onPress={() => setAddingTurnpoint(true)}
            >
              Add turnpoint
            </Button>
            {/* Two turnpoints is the least that can be in the wrong order. */}
            {rows.length > 1 ? (
              <ToggleButton
                size="sm"
                isSelected={reordering}
                onChange={(on) => {
                  setReordering(on);
                  if (!on) setMoved(null);
                }}
              >
                {reordering ? "Done reordering" : "Reorder"}
              </ToggleButton>
            ) : null}
            {showQuickTask ? (
              <Button
                variant="outline"
                size="sm"
                onPress={() => setQuickOpen(true)}
              >
                Quick entry
              </Button>
            ) : null}
            <Button variant="outline" size="sm" onPress={() => void clearTurnpoints()}>
              Clear turnpoints
            </Button>
            {/* Always visible so the capability is discoverable; disabled when
                every turnpoint already has an altitude. */}
            <Button
              variant="outline"
              size="sm"
              isDisabled={fillingAlts || fillableAltCount === 0}
              onPress={() => void fillAltitudes()}
            >
              {fillingAlts
                ? "Filling altitudes…"
                : fillableAltCount > 0
                  ? `Fill ${fillableAltCount} altitude${fillableAltCount === 1 ? "" : "s"} from map`
                  : "Fill altitudes from map"}
            </Button>
            {/* Import / export the whole route (moved out of the footer, which
                now holds only Cancel / Save). */}
            <FileTrigger
              acceptedFileTypes={[".xctsk"]}
              onSelect={(files) => void importFile(files)}
            >
              <Button variant="outline" size="sm">
                Import .xctsk
              </Button>
            </FileTrigger>
            <Button
              variant="outline"
              size="sm"
              onPress={() => setXcImportOpen(true)}
            >
              Load from XContest
            </Button>
            <Button variant="outline" size="sm" onPress={exportFile}>
              Export .xctsk
            </Button>
            <Button variant="outline" size="sm" onPress={exportCsv}>
              Export .csv
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Directions are derived from the route geometry — a cylinder that
            contains the previous route point is an exit cylinder, reached by
            flying out of it.
          </p>
        </div>

        {/* Map preview — below the list, showing the optimized route as it's
            edited. Tap a waypoint to add it, or tap empty space to create a new
            one (added to the competition when the route is saved). */}
        <div className="flex flex-col gap-2">
          <div className="h-64 overflow-hidden rounded border border-border sm:h-72 lg:h-96">
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  Loading map…
                </div>
              }
            >
              <RouteMap
                task={derived.mapTask}
                waypoints={mapWaypoints}
                addMode={addMode}
                fitNonce={wpFitNonce}
                placeSearch
                onWaypointPick={pickWaypoint}
                onMapPick={(lat, lon, details) =>
                  openAddPoint(formatCoords(lat, lon), details)
                }
              />
            </Suspense>
          </div>
          {/* Create a competition waypoint by tapping the map: the tap seeds a
              form (place name, terrain elevation, nearest peak) and, once
              confirmed, drops into the route and is saved to the competition. */}
          <div className="flex flex-wrap items-center gap-2">
            <ToggleButton size="sm" isSelected={addMode} onChange={setAddMode}>
              {addMode ? "Tap the map to place a waypoint…" : "Add from map"}
            </ToggleButton>
            {pendingWaypoints.length > 0 ? (
              <span className="text-xs text-muted-foreground">
                {pendingWaypoints.length} new — saved to the competition when you save the route
              </span>
            ) : null}
          </div>
        </div>

        {shownErrors.length > 0 ? (
          <ul className="list-disc pl-5 text-sm text-destructive">
            {shownErrors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
            {extraErrors > 0 ? <li>… and {extraErrors} more</li> : null}
          </ul>
        ) : null}
        {warnings.length > 0 ? (
          <ul className="text-sm text-amber-500">
            {warnings.map((w, i) => (
              <li key={i}>⚠ {w}</li>
            ))}
          </ul>
        ) : null}

        {!openDistance ? (
          <>
            {/* Collapsed by default — the defaults suit most competitions. The
                badge is why that's safe: it reads the live configuration back
                on the header row, so an exit start (or a gate list) is never
                something you'd have to expand the panel to discover (#436).
                Same sentence the task page prints, from the same helper. */}
            <Disclosure
              title="Start (SSS)"
              badge={
                <span className="text-xs font-normal text-muted-foreground">
                  {startConfigSummary(
                    {
                      type: sssType,
                      direction,
                      timeGates: gates.flatMap((g) =>
                        parseTimeToken(g) !== null ? [`${toUtcTime(g)}:00Z`] : []
                      ),
                    },
                    { timeZone: tz, taskDate }
                  )}
                </span>
              }
            >
              {!derived.hasSSSTurnpoint ? (
                <p className="mt-1 text-sm text-amber-500">
                  ⚠ This task has no Start (SSS) turnpoint — set one in the list
                  above, otherwise gates have no cylinder to apply to.
                </p>
              ) : null}
              {/* Lists in flow, not popovers (#638). Both choices are
                  two-way and each option carries an explanation, which a
                  collapsed select shows one of and hides the other — here
                  they are side by side, which is how you choose between
                  them. */}
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                <ChoiceList
                  label="Start type"
                  value={sssType}
                  onChange={(v) => setSssType(v as SSSConfig["type"])}
                  options={[
                    { value: "RACE", label: "Race to goal — timed from a start gate" },
                    {
                      value: "ELAPSED-TIME",
                      label: "Elapsed time — timed from each pilot's crossing",
                    },
                  ]}
                />
                <ChoiceList
                  label="Start direction"
                  value={direction}
                  onChange={(v) => setDirection(v as SSSConfig["direction"])}
                  options={[
                    { value: "EXIT", label: "Exit start — cross outward" },
                    { value: "ENTER", label: "Enter start — cross inward" },
                  ]}
                />
              </div>

              <h4 className="mt-3 text-sm font-medium">
                {isRace ? `Start gates — ${timeZoneLabel}` : `Start open — ${timeZoneLabel}`}
              </h4>
              <p className="mt-1 text-sm text-muted-foreground">
                {isRace
                  ? "A pilot's start time is the last gate at or before their start crossing (FAI S7F §9.2.4.1). Starting before the first gate is an early start."
                  : "Elapsed-time pilots are timed from their actual start crossing; a gate only sets when the start opens."}{" "}
                {tz
                  ? "Times are comp-local (set in Competition Settings)."
                  : "Times are UTC — save a route (or set a timezone in Competition Settings) to edit in comp-local time."}
              </p>
              <ul className="mt-2 flex flex-col gap-2">
                {gates.map((g, i) => (
                  <li key={i} className="flex items-center gap-2">
                    <TimePicker
                      className="w-32"
                      required
                      aria-label={`Gate ${i + 1} time — ${timeZoneLabel}`}
                      value={g}
                      onChange={(v) => updateGate(i, v)}
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      className="ml-auto"
                      onPress={() => removeGate(i)}
                    >
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
              {isRace && gates.length === 0 ? (
                <p className="mt-2 text-sm text-amber-500">
                  ⚠ No start gates — every pilot will be timed from their actual
                  start crossing, like an elapsed-time task.
                </p>
              ) : null}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Button variant="outline" size="sm" onPress={addGate}>
                  + Add gate
                </Button>
                {isRace ? (
                  <span className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
                    <NumberField
                      minValue={1}
                      maxValue={100}
                      step={1}
                      className="w-28"
                      aria-label="Number of gates"
                      value={genCount}
                      onChange={setGenCount}
                    />
                    gates every
                    <NumberField
                      minValue={1}
                      maxValue={720}
                      // step must stay 1: RAC snaps to minValue + k·step, so
                      // step 5 with min 1 would corrupt 15 → 16.
                      step={1}
                      className="w-28"
                      aria-label="Gate interval (minutes)"
                      value={genInterval}
                      onChange={setGenInterval}
                    />
                    min
                    <Button variant="outline" size="sm" onPress={generateSeries}>
                      Generate from first gate
                    </Button>
                  </span>
                ) : null}
              </div>
            </Disclosure>

            <Disclosure title="Goal">
              <ChoiceList
                className="mt-2"
                label="Goal type"
                value={goalType}
                onChange={(v) => setGoalType(v as GoalConfig["type"])}
                options={[
                  { value: "CYLINDER", label: "Cylinder — the last turnpoint's radius" },
                  { value: "LINE", label: "Goal line — perpendicular to the last leg" },
                ]}
              />
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  Deadline — {timeZoneLabel}
                  <TimePicker
                    className="w-32"
                    clearable
                    aria-label={`Goal deadline — ${timeZoneLabel}`}
                    value={goalDeadline}
                    onChange={setGoalDeadline}
                  />
                  {goalDeadline ? null : "(optional)"}
                </span>
              </div>
              {goalType === "LINE" ? (
                // Geometry an organiser reads once, so it sits on the ⓘ rather
                // than under the control every time the dialog opens.
                <p className="mt-2 text-sm text-muted-foreground">
                  <span className="inline-flex items-baseline gap-1">
                    <span>Line length is 2 × the turnpoint&apos;s radius.</span>
                    <Explain label="Goal line geometry" className="self-center">
                      <p>
                        The goal line is centred on the last turnpoint,
                        perpendicular to the final leg, and extends the
                        turnpoint&apos;s radius to each side.
                      </p>
                    </Explain>
                  </span>
                </p>
              ) : null}
            </Disclosure>
          </>
        ) : null}

      {/* Sticky to the BOTTOM of the viewport, not the end of the document:
          this page is long, and a Save an admin has to scroll past the whole
          goal panel to reach is a Save they will not find on a phone. The
          page's pb-24 reserves the space it covers.

          Bottom chrome touching the viewport edge, so the background is
          full-bleed while the buttons clear the home indicator —
          `pb-gutter-safe` is the app's vocabulary for exactly that (#642),
          and `px-gutter-safe` does the same for a landscape notch. */}
      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-background/95 backdrop-blur-sm">
        <div className="mx-auto flex max-w-5xl justify-end gap-2 px-gutter-safe pt-3 pb-gutter-safe">
          <Button variant="outline" onPress={onCancel}>
            Cancel
          </Button>
          <Button
            isDisabled={errors.length > 0}
            isPending={saving}
            pendingLabel="Saving"
            onPress={() => void save()}
          >
            Save
          </Button>
        </div>
      </div>

        {/* Load a whole task from an XContest / XCTrack task code. */}
        <Modal
          isOpen={xcImportOpen}
          onOpenChange={(open) => {
            if (!open) setXcImportOpen(false);
          }}
        >
          <Dialog className="gap-3">
            <DialogHeader>
              <DialogTitle>Load from XContest</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              Paste an XContest / XCTrack task code to replace the editor with
              that task's turnpoints, start and goal. Nothing is saved until you
              press Save.
            </p>
            <TextField
              label="Task code"
              autoFocus
              placeholder="e.g. 3sVv6dV"
              value={xcontestCode}
              onChange={setXcontestCode}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void importXContest();
                }
              }}
            />
            <DialogFooter>
              <Button slot="close" variant="outline">
                Cancel
              </Button>
              <Button
                isDisabled={xcontestLoading || xcontestCode.trim() === ""}
                onPress={() => void importXContest()}
              >
                {xcontestLoading ? "Loading…" : "Load"}
              </Button>
            </DialogFooter>
          </Dialog>
        </Modal>

        {/* Add a single turnpoint by hand. The sheet applies its draft on the
            way out; the route is still unsaved until this page's Save. */}
        {addingTurnpoint ? (
          <TurnpointSheet
            mode="add"
            initial={blankDraft()}
            waypointRecords={waypointRecords}
            wpLoading={wpLoading}
            compId={compId}
            onSave={appendTurnpoint}
            onClose={() => setAddingTurnpoint(false)}
          />
        ) : null}

        {/* Edit the turnpoint a row opened. Keyed on the row so re-opening a
            different one starts from that turnpoint's own draft. */}
        {editingRow ? (
          <TurnpointSheet
            key={editingRow.id}
            mode="edit"
            initial={{
              name: editingRow.name,
              description: editingRow.description,
              type: editingRow.type,
              coords: editingRow.coords,
              radius: editingRow.radius,
              altitude: editingRow.altitude,
            }}
            waypointRecords={waypointRecords}
            wpLoading={wpLoading}
            compId={compId}
            onSave={(draft) => updateTurnpoint(editingRow.id, draft)}
            onDelete={() => removeTurnpoint(editingRow.id)}
            onClose={() => setEditingRowId(null)}
          />
        ) : null}

        {/* The whole route as text. Opens showing the route that's loaded, and
            applying it reconciles rather than rebuilds. */}
        {quickOpen ? (
          <QuickEntrySheet
            waypoints={waypointRecords}
            defaultRadius={NEW_ROW_RADIUS}
            initialText={quickText}
            knownNames={knownNames}
            openDistance={openDistance}
            timeZoneLabel={openDistance ? undefined : timeZoneLabel}
            onUse={applyQuickTask}
            onClose={() => setQuickOpen(false)}
          />
        ) : null}

        {/* Inline create — stages a new waypoint into the route; it's written to
            the competition on save. Shared with the competition waypoints page. */}
        <AddWaypointDialog
          open={adding}
          initialCoords={addSeedCoords}
          details={addSeedDetails}
          takenCodes={waypointRecords.map((w) => w.code)}
          onAdd={addNewWaypoint}
          onCancel={() => setAdding(false)}
        />
    </div>
  );
}
