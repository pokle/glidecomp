/**
 * Task route editor dialog — the React replacement for the vanilla
 * analysis/task-editor on the task detail page (#270).
 *
 * RAC EXPLORATION (see pages/TaskDetail.tsx): the Tabulator grid is replaced
 * by a react-aria-components Table whose rows live in React state. Reordering
 * is RAC drag-and-drop (mouse, touch AND keyboard via the row drag handles);
 * the task-specific fields (Type, Radius) are inline RAC widgets; every
 * derived column (leg distances, crossing direction, the map preview) is a
 * useMemo over the rows instead of an imperative write-back. Start (SSS)
 * gates and goal configuration are edited in collapsible sections below the
 * grid so a whole .xctsk is editable in one place. Routes can be imported
 * from a .xctsk file or an XContest task code, and exported to a .xctsk file.
 * Saving PATCHes the task's xctsk (the server validates strictly and
 * audit-logs the change).
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FileTrigger,
  useDragAndDrop,
  Button as AriaButton,
  DropIndicator,
  DialogTrigger,
  Popover as AriaPopover,
  Dialog as AriaDialog,
} from "react-aria-components";
import {
  computeTurnpointDirections,
  getOptimizedSegmentDistances,
  parseXCTaskAsync,
  toXctskJSON,
  type GoalConfig,
  type SSSConfig,
  type WaypointFileRecord,
  type XCTask,
} from "@glidecomp/engine";
import type { MapPickDetails, MapWaypoint } from "../../analysis/map-provider";
import { Button, ToggleButton } from "@/react/rac/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Modal,
} from "@/react/rac/dialog";
import { Badge } from "@/react/rac/badge";
import { Disclosure } from "@/react/rac/disclosure";
import { NumberField, SearchField, TextField } from "@/react/rac/field";
import { ListBox, ListBoxItem } from "@/react/rac/list-box";
import { SimpleSelect } from "@/react/rac/select";
import { GridList, GridListItem } from "@/react/rac/grid-list";
import { TimePicker } from "@/react/ui/date-picker";
import { api } from "../../comp/api";
import { fetchTaskByCodeWithRaw } from "../../analysis/xctsk-fetch";
import { toast } from "../lib/toast";
import { useConfirm } from "../lib/confirm";
import { downloadFile } from "../lib/format";
import { utcToZonedHHMM, zonedToUtcHHMM, zoneNameWithOffset } from "../lib/time";
import { slugify } from "./csv";
import {
  addMinutes,
  buildRoute,
  editableGates,
  formatCoords,
  gateToHHMM,
  parseCoords,
  turnpointsToCSV,
  turnpointToRow,
  xctskForPatch,
  TYPE_LABELS,
  type RouteRow,
} from "./route-editor";
import { AddWaypointDialog } from "./AddWaypointDialog";
import { GripVerticalIcon, PencilIcon, XIcon } from "lucide-react";

// Lazy so the map library (mapbox) and its CSS load only when the editor
// opens and never enter the SSR'd task-detail bundle.
const RouteMap = lazy(() => import("./RouteMap"));

const NEW_ROW_RADIUS = 400;

// Common competition cylinder radii — one-tap presets on each turnpoint card,
// so the hottest edit (set a radius) is a single click; the NumberField beside
// them still takes any value.
const RADIUS_PRESETS = [400, 1000, 2000, 3000, 5000] as const;

const TYPE_OPTIONS = Object.entries(TYPE_LABELS).map(([value, label]) => ({
  value,
  label,
}));

/** Short radius label for a preset chip: 400 → "400", 1000 → "1 km". */
function radiusChipLabel(m: number): string {
  return m >= 1000 ? `${m / 1000} km` : `${m}`;
}

export function RouteEditorDialog({
  compId,
  taskId,
  taskName,
  taskDate,
  xctsk,
  openDistance,
  timezone,
  onClose,
  onSaved,
}: {
  compId: string;
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
  onClose: () => void;
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

  const updateRow = useCallback((id: number, patch: Partial<RouteRow>) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }, []);

  const removeRow = useCallback((id: number) => {
    setRows((prev) => prev.filter((r) => r.id !== id));
  }, []);

  // The competition's shared waypoints (loaded once on open), shown on the map
  // and in a searchable list. Turnpoints are picked from this set only — the
  // task copies each waypoint's details in, so it can't be changed after the
  // fact by editing the competition waypoints.
  const [waypointRecords, setWaypointRecords] = useState<WaypointFileRecord[]>([]);
  const [wpLoading, setWpLoading] = useState(true);
  const [wpSearch, setWpSearch] = useState("");
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

  // Fields not edited by the grid/panels (taskType, earthModel, takeoff,
  // cylinderTolerance) are carried over from the loaded task; an import
  // replaces the whole base.
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
            ...(goal ? { goal } : {}),
          }
        : null;

    const legByRowId = new Map<number, number>();
    const dirByRowId = new Map<number, RouteRow["dir"]>();
    let totalKm: number | null = null;
    if (result.geometryComplete && result.turnpoints.length >= 2) {
      const task: XCTask = {
        taskType: baseRef.current?.taskType || "CLASSIC",
        version: baseRef.current?.version ?? 1,
        turnpoints: result.turnpoints,
        // The SSS panel's direction feeds the per-turnpoint direction
        // inference, so flipping it updates the Dir column live.
        ...(openDistance ? {} : { sss: { type: sssType, direction } }),
        ...(goal ? { goal } : {}),
      };
      const legs = getOptimizedSegmentDistances(task);
      totalKm = legs.reduce((sum, d) => sum + d, 0) / 1000;
      // legs[i] is the segment into turnpoint i+1
      legs.forEach((d, i) => {
        const rowId = result.rowIds[i + 1];
        if (rowId !== undefined) legByRowId.set(rowId, d);
      });
      // Directions are derived, not chosen: a cylinder that contains the
      // previous route point is an exit cylinder (reached by flying out of
      // it). Recomputed on every edit so enlarging a radius that flips a
      // turnpoint to Exit is visible before saving.
      computeTurnpointDirections(task).forEach((d, i) => {
        const rowId = result.rowIds[i];
        if (rowId !== undefined) {
          dirByRowId.set(rowId, result.turnpoints[i].type === "TAKEOFF" ? null : d);
        }
      });
    }
    return { result, hasSSSTurnpoint, mapTask, legByRowId, dirByRowId, totalKm };
  }, [rows, openDistance, goalType, sssType, direction]);

  const { errors, warnings } = derived.result;

  /**
   * Row reordering: RAC drag-and-drop. Mouse/touch drag the handle; keyboard
   * users press Enter on the handle, then arrow keys + Enter to drop.
   */
  const { dragAndDropHooks } = useDragAndDrop({
    getItems: (keys) =>
      [...keys].map((key) => {
        const row = rows.find((r) => r.id === key);
        return { "text/plain": row ? `${row.name}` : String(key) };
      }),
    onReorder(e) {
      setRows((prev) => {
        const moved = prev.filter((r) => e.keys.has(r.id));
        const rest = prev.filter((r) => !e.keys.has(r.id));
        const targetIdx = rest.findIndex((r) => r.id === e.target.key);
        if (targetIdx === -1) return prev;
        const insertAt = e.target.dropPosition === "before" ? targetIdx : targetIdx + 1;
        return [...rest.slice(0, insertAt), ...moved, ...rest.slice(insertAt)];
      });
    },
    // The insertion line while dragging — RAC's default indicator is unstyled.
    renderDropIndicator: (target) => (
      <DropIndicator
        target={target}
        className="data-drop-target:outline-2 data-drop-target:outline-primary"
      />
    ),
  });

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

  // Filtered list for the searchable picker (by code or name).
  const filteredWaypoints = useMemo(() => {
    const q = wpSearch.trim().toLowerCase();
    if (!q) return waypointRecords;
    return waypointRecords.filter(
      (w) => w.code.toLowerCase().includes(q) || w.name.toLowerCase().includes(q)
    );
  }, [waypointRecords, wpSearch]);

  // Capped, keyed items for the picker ListBox.
  const pickerItems = useMemo(
    () =>
      filteredWaypoints
        .slice(0, 200)
        .map((w, i) => ({ id: `${w.code}-${i}`, record: w })),
    [filteredWaypoints]
  );

  /**
   * Append a turnpoint by COPYING a competition waypoint's details (code, long
   * name, coordinates, radius, altitude) into the task — so a later edit to
   * the competition waypoint never changes this task.
   */
  const addTurnpointFromRecord = useCallback(
    (rec: WaypointFileRecord) => {
      setRows((prev) => [
        ...prev,
        {
          id: nextRowId(),
          name: rec.code,
          description: rec.name !== rec.code ? rec.name : "",
          type: "",
          coords: formatCoords(rec.latitude, rec.longitude),
          radius: rec.radius > 0 ? rec.radius : NEW_ROW_RADIUS,
          altitude: rec.altitude ? rec.altitude : "",
          leg: null,
          dir: null,
        } satisfies RouteRow,
      ]);
    },
    [nextRowId]
  );

  /** Append a blank row to fill in by hand (blank rows are ignored on save). */
  const addBlankRow = useCallback(() => {
    setRows((prev) => [
      ...prev,
      {
        id: nextRowId(),
        name: "",
        description: "",
        type: "",
        coords: "",
        radius: NEW_ROW_RADIUS,
        altitude: "",
        leg: null,
        dir: null,
      } satisfies RouteRow,
    ]);
  }, [nextRowId]);

  /** Pick from the map: the nearest marker, resolved to its record by id. */
  const pickWaypoint = useCallback(
    (wp: MapWaypoint) => {
      const rec = waypointRecords[Number(wp.id)];
      if (rec) addTurnpointFromRecord(rec);
    },
    [waypointRecords, addTurnpointFromRecord]
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
    addTurnpointFromRecord(rec);
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
    <Modal
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      className="flex h-[96vh] max-h-[96vh] w-[96vw] max-w-[96vw] flex-col p-0 sm:max-w-[96vw]"
    >
      <Dialog className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        <DialogHeader>
          <DialogTitle>Edit route</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Set each turnpoint's type and radius inline; use <span className="font-medium">Edit</span> for its
          code, name, coordinates and altitude. Drag the handle (or press Enter
          on it) to reorder. Each card reads top-to-bottom like a flight plan —
          leg distance and Enter/Exit crossing are derived from the optimized
          route through each cylinder.
        </p>
        {openDistance ? (
          <p className="text-sm text-muted-foreground">
            Open distance: define a single Takeoff turnpoint. Distance is scored
            from the take-off exit — there is no goal.
          </p>
        ) : null}

        <div className="grid gap-4 lg:h-[62vh] lg:grid-cols-2">
          {/* Map + waypoint picker — floats at the top on narrow screens, sits
              on the right on wide ones (same pattern as the score-explainer).
              On wide screens the column is a full-height flex box so the map
              fills the space left by the buttons and picker below it. */}
          <div className="order-1 flex min-h-0 flex-col gap-2 lg:order-2">
            <div className="h-64 overflow-hidden rounded border border-border sm:h-72 lg:h-auto lg:min-h-0 lg:flex-1">
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
                  onWaypointPick={pickWaypoint}
                  onMapPick={(lat, lon, details) =>
                    openAddPoint(formatCoords(lat, lon), details)
                  }
                />
              </Suspense>
            </div>
            {/* Add a missing waypoint without leaving the route editor: tap the
                map to place it, or open a blank form. Either way it's added to
                the route now and written to the competition when you save. */}
            <div className="flex flex-wrap items-center gap-2">
              <ToggleButton
                size="sm"
                isSelected={addMode}
                onChange={setAddMode}
              >
                {addMode ? "Tap the map to place…" : "Add from map"}
              </ToggleButton>
              <Button size="sm" variant="outline" onPress={() => openAddPoint()}>
                New point
              </Button>
              {pendingWaypoints.length > 0 ? (
                <span className="text-xs text-muted-foreground">
                  {pendingWaypoints.length} new — saved to the competition when you save the route
                </span>
              ) : null}
            </div>
            {/* Searchable list of the competition's waypoints to pick from. */}
            {wpLoading ? (
              <p className="text-xs text-muted-foreground">Loading competition waypoints…</p>
            ) : waypointRecords.length === 0 ? (
              <p className="rounded border border-dashed border-border p-3 text-xs text-muted-foreground">
                This competition has no waypoints yet. Use <span className="font-medium">Add from map</span> or{" "}
                <span className="font-medium">New point</span> above to create one — it's added to this
                route now and saved to the competition when you save. Or{" "}
                <a
                  href={`/comp/${compId}/waypoints`}
                  target="_blank"
                  rel="noreferrer"
                  className="underline hover:text-foreground"
                >
                  manage all waypoints
                </a>
                .
              </p>
            ) : (
              <>
                <SearchField
                  aria-label="Search competition waypoints"
                  placeholder={`Search ${waypointRecords.length} waypoints…`}
                  value={wpSearch}
                  onChange={setWpSearch}
                />
                <ListBox
                  aria-label="Competition waypoints"
                  className="max-h-40"
                  items={pickerItems}
                  // Arrow keys + Enter add a turnpoint; so does a click/tap.
                  onAction={(key) => {
                    const item = pickerItems.find((it) => it.id === key);
                    if (item) addTurnpointFromRecord(item.record);
                  }}
                  renderEmptyState={() => (
                    <p className="px-2 py-1.5 text-sm text-muted-foreground">No matches</p>
                  )}
                >
                  {(item: { id: string; record: WaypointFileRecord }) => (
                    <ListBoxItem id={item.id} textValue={item.record.code}>
                      <span className="font-medium">{item.record.code}</span>
                      {item.record.name !== item.record.code ? (
                        <span className="truncate text-muted-foreground">
                          {item.record.name}
                        </span>
                      ) : null}
                    </ListBoxItem>
                  )}
                </ListBox>
                <p className="text-xs text-muted-foreground">
                  Click a waypoint (or tap it on the map) to add it as a turnpoint.
                </p>
              </>
            )}
          </div>

          {/* Editable turnpoint list — a vertical stack of cards (RAC GridList)
              instead of a wide table: each card owns one turnpoint, so a narrow
              column never forces horizontal scrolling and the row context stays
              intact on small screens. On wide screens it flexes to fill the
              column height left by the buttons and footnote below it. */}
          <div className="order-2 flex min-h-0 min-w-0 flex-col gap-2 lg:order-1">
            <div className="h-[320px] shrink-0 overflow-y-auto rounded-lg lg:h-auto lg:min-h-0 lg:flex-1 lg:shrink">
              <GridList
                aria-label="Turnpoints"
                selectionMode="none"
                dragAndDropHooks={dragAndDropHooks}
                items={rows}
                // RAC caches each item's rendered output by identity, so props
                // derived from OUTSIDE the item — the # position and the
                // Leg/Dir summary computed from the whole route — would go
                // stale on reorder or on edits to other rows. Declaring them as
                // dependencies invalidates the cache (gotcha #3).
                dependencies={[rows, derived]}
                renderEmptyState={() => (
                  <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
                    No turnpoints yet — use Add turnpoint, pick a waypoint, or
                    import a task
                  </p>
                )}
              >
                {(row) => (
                  <TurnpointCard
                    key={row.id}
                    row={row}
                    index={rows.indexOf(row)}
                    leg={derived.legByRowId.get(row.id) ?? null}
                    dir={derived.dirByRowId.get(row.id) ?? null}
                    onUpdate={updateRow}
                    onRemove={removeRow}
                  />
                )}
              </GridList>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" onPress={addBlankRow}>
                Add turnpoint
              </Button>
              <Button variant="outline" size="sm" onPress={() => void clearTurnpoints()}>
                Clear turnpoints
              </Button>
              {derived.totalKm !== null ? (
                <span className="text-sm text-muted-foreground">
                  Optimized total: {derived.totalKm.toFixed(1)} km
                </span>
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground">
              Directions are derived from the route geometry — a cylinder that
              contains the previous route point is an exit cylinder, reached by
              flying out of it.
            </p>
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
            <Disclosure title="Start (SSS)" defaultExpanded>
              {!derived.hasSSSTurnpoint ? (
                <p className="mt-1 text-sm text-amber-500">
                  ⚠ This task has no Start (SSS) turnpoint — set one in the table
                  above, otherwise gates have no cylinder to apply to.
                </p>
              ) : null}
              <div className="mt-2 flex flex-wrap gap-2">
                <SimpleSelect
                  value={sssType}
                  onChange={(v) => setSssType(v as SSSConfig["type"])}
                  options={[
                    { value: "RACE", label: "Race to goal — timed from a start gate" },
                    {
                      value: "ELAPSED-TIME",
                      label: "Elapsed time — timed from each pilot's crossing",
                    },
                  ]}
                  ariaLabel="Start type"
                />
                <SimpleSelect
                  value={direction}
                  onChange={(v) => setDirection(v as SSSConfig["direction"])}
                  options={[
                    { value: "EXIT", label: "Exit start — cross outward" },
                    { value: "ENTER", label: "Enter start — cross inward" },
                  ]}
                  ariaLabel="Start direction"
                />
              </div>

              <h4 className="mt-3 text-sm font-medium">
                {isRace ? `Start gates — ${timeZoneLabel}` : `Start open — ${timeZoneLabel}`}
              </h4>
              <p className="mt-1 text-sm text-muted-foreground">
                {isRace
                  ? "A pilot's start time is the last gate at or before their start crossing (FAI S7F §8.3.1). Starting before the first gate is an early start."
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
                  <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                    <NumberField
                      minValue={1}
                      maxValue={100}
                      step={1}
                      className="w-24"
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
                      className="w-24"
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

            <Disclosure title="Goal" defaultExpanded>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <SimpleSelect
                  value={goalType}
                  onChange={(v) => setGoalType(v as GoalConfig["type"])}
                  options={[
                    { value: "CYLINDER", label: "Cylinder — the last turnpoint's radius" },
                    { value: "LINE", label: "Goal line — perpendicular to the last leg" },
                  ]}
                  ariaLabel="Goal type"
                />
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
                <p className="mt-2 text-sm text-muted-foreground">
                  The goal line is centred on the last turnpoint, perpendicular
                  to the final leg, and extends the turnpoint&apos;s radius to
                  each side (total length 2 × radius).
                </p>
              ) : null}
            </Disclosure>
          </>
        ) : null}

        <DialogFooter className="mx-0 mb-0 border-t border-border">
          <div className="flex flex-wrap items-center gap-2 sm:mr-auto">
            <FileTrigger
              acceptedFileTypes={[".xctsk"]}
              onSelect={(files) => void importFile(files)}
            >
              <Button variant="outline" size="sm">
                Import .xctsk
              </Button>
            </FileTrigger>
            <TextField
              aria-label="XContest task code"
              placeholder="Task code"
              className="w-28"
              value={xcontestCode}
              onChange={setXcontestCode}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void importXContest();
                }
              }}
            />
            <Button
              variant="outline"
              size="sm"
              isDisabled={xcontestLoading || xcontestCode.trim() === ""}
              onPress={() => void importXContest()}
            >
              {xcontestLoading ? "Loading…" : "Load from XContest"}
            </Button>
            <Button variant="outline" size="sm" onPress={exportFile}>
              Export .xctsk
            </Button>
            <Button variant="outline" size="sm" onPress={exportCsv}>
              Export .csv
            </Button>
          </div>
          <Button slot="close" variant="outline">
            Cancel
          </Button>
          <Button isDisabled={saving || errors.length > 0} onPress={() => void save()}>
            {saving ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>

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
      </Dialog>
    </Modal>
  );
}

/**
 * One turnpoint card (RAC GridListItem). Reads top-to-bottom like a flight
 * plan: an identity line (position · code · name) with a derived recap
 * (radius · Enter/Exit crossing · optimized leg distance) alongside, then the
 * two hottest editors inline — Type (select) and Radius (preset chips + a
 * custom NumberField). Code, name, coordinates and altitude sit behind the
 * Edit popover (they're set once when the turnpoint is added). Leg and Dir are
 * outputs of the dialog's geometry memo, so they're display-only by design.
 */
function TurnpointCard({
  row,
  index,
  leg,
  dir,
  onUpdate,
  onRemove,
}: {
  row: RouteRow;
  index: number;
  leg: number | null;
  dir: RouteRow["dir"];
  onUpdate: (id: number, patch: Partial<RouteRow>) => void;
  onRemove: (id: number) => void;
}) {
  const radius = Number(row.radius);
  const label = row.name || `turnpoint ${index + 1}`;
  const coordsMissing = parseCoords(row.coords) == null;
  return (
    <GridListItem id={row.id} textValue={row.name || `Turnpoint ${index + 1}`}>
      <div className="flex items-start gap-2">
        <AriaButton
          slot="drag"
          className="mt-0.5 flex size-7 shrink-0 cursor-grab items-center justify-center rounded text-muted-foreground outline-none data-hovered:text-foreground data-focus-visible:ring-2 data-focus-visible:ring-ring/50"
          aria-label={`Reorder ${label}`}
        >
          <GripVerticalIcon className="size-4" />
        </AriaButton>

        <div className="min-w-0 flex-1">
          {/* Identity line + derived recap. */}
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium tabular-nums text-muted-foreground">
              {index + 1}
            </span>
            {row.name ? (
              <span className="font-medium">{row.name}</span>
            ) : (
              <span className="text-muted-foreground italic">New turnpoint</span>
            )}
            {row.description ? (
              <span className="min-w-0 truncate text-sm text-muted-foreground">
                {row.description}
              </span>
            ) : null}
            <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
              {coordsMissing ? (
                <span className="text-amber-500">⚠ set coordinates</span>
              ) : (
                <span className="tabular-nums">
                  {Number.isFinite(radius) && radius > 0 ? `${radius} m` : "radius?"}
                </span>
              )}
              {dir === "exit" ? (
                <Badge
                  variant="outline"
                  title="Exit cylinder — reached by flying out of it"
                >
                  Exit
                </Badge>
              ) : dir === "enter" ? (
                <span>Enter</span>
              ) : null}
              {leg != null ? (
                <span className="tabular-nums">leg {(leg / 1000).toFixed(1)} km</span>
              ) : null}
            </span>
          </div>

          {/* Inline hot fields: Type and Radius. */}
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
            <SimpleSelect
              value={row.type}
              onChange={(v) => onUpdate(row.id, { type: v as RouteRow["type"] })}
              options={TYPE_OPTIONS}
              ariaLabel={`Type of ${label}`}
              className="[&_button]:h-7 [&_button]:min-w-32"
            />
            <div
              role="group"
              aria-label={`Radius of ${label} in metres`}
              className="flex flex-wrap items-center gap-1"
            >
              {RADIUS_PRESETS.map((preset) => (
                <ToggleButton
                  key={preset}
                  size="sm"
                  isSelected={radius === preset}
                  // Chips set an absolute value; re-pressing the active one is a
                  // no-op (the toggle-off event just re-sets the same radius).
                  onChange={() => onUpdate(row.id, { radius: preset })}
                  className="h-7 px-2 tabular-nums"
                  aria-label={`Set radius ${preset} metres`}
                >
                  {radiusChipLabel(preset)}
                </ToggleButton>
              ))}
              <NumberField
                aria-label={`Custom radius of ${label} in metres`}
                minValue={1}
                maxValue={50000}
                // Step stays 1: RAC snaps values to minValue + k·step, so a
                // larger step corrupts loaded radii (1000 → 1001 with step 100).
                step={1}
                formatOptions={{ useGrouping: false }}
                value={Number.isFinite(radius) ? radius : NaN}
                onChange={(v) =>
                  onUpdate(row.id, { radius: Number.isFinite(v) ? v : "" })
                }
                className="w-24"
              />
              <span className="text-xs text-muted-foreground">m</span>
            </div>
          </div>
        </div>

        {/* Actions: edit the rest of the turnpoint, or remove it. */}
        <div className="flex shrink-0 items-center gap-1">
          <EditTurnpointPopover row={row} label={label} onUpdate={onUpdate} />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove ${label}`}
            onPress={() => onRemove(row.id)}
          >
            <XIcon className="size-4 text-muted-foreground" />
          </Button>
        </div>
      </div>
    </GridListItem>
  );
}

/**
 * The "edit the rest of the turnpoint" popover: code, name, coordinates and
 * altitude with real labels and per-field validation. Edits apply LIVE to the
 * map and legs while it's open; Cancel reverts to the values captured when it
 * opened (the dialog-level "nothing saved until Save" still holds). Dismissing
 * by clicking away keeps the live edits.
 */
function EditTurnpointPopover({
  row,
  label,
  onUpdate,
}: {
  row: RouteRow;
  label: string;
  onUpdate: (id: number, patch: Partial<RouteRow>) => void;
}) {
  const snapshotRef = useRef<Partial<RouteRow>>({});
  return (
    <DialogTrigger
      onOpenChange={(open) => {
        if (open)
          snapshotRef.current = {
            name: row.name,
            description: row.description,
            coords: row.coords,
            altitude: row.altitude,
          };
      }}
    >
      <Button variant="outline" size="icon-sm" aria-label={`Edit ${label}`}>
        <PencilIcon className="size-4" />
      </Button>
      <AriaPopover
        placement="bottom end"
        className="z-50 rounded-lg border border-border bg-popover text-popover-foreground shadow-md outline-none data-entering:animate-in data-entering:fade-in-0 data-entering:zoom-in-95 data-exiting:animate-out data-exiting:fade-out-0 data-exiting:zoom-out-95 data-entering:duration-100 data-exiting:duration-100"
      >
        <AriaDialog
          aria-label={`Edit ${label}`}
          className="w-[min(22rem,calc(100vw-2rem))] outline-none"
        >
          {({ close }) => (
            <div className="flex flex-col gap-3 p-3">
              <p className="text-sm font-medium">Turnpoint details</p>
              <TextField
                label="Code"
                isRequired
                value={row.name}
                onChange={(v) => onUpdate(row.id, { name: v })}
                placeholder="A01"
              />
              <TextField
                label="Name"
                description="Full descriptive name (optional)"
                value={row.description}
                onChange={(v) => onUpdate(row.id, { description: v })}
                placeholder="Bordano Landing"
              />
              <TextField
                label="Coordinates (lat, lon)"
                value={row.coords}
                onChange={(v) => onUpdate(row.id, { coords: v })}
                placeholder="-36.550979, 147.890395"
                validate={(v) =>
                  v.trim() === "" || parseCoords(v)
                    ? null
                    : 'Enter "lat, lon" decimal degrees'
                }
              />
              <TextField
                label="Altitude (m)"
                description="Waypoint altitude, optional"
                value={String(row.altitude ?? "")}
                onChange={(v) => onUpdate(row.id, { altitude: v })}
                placeholder="0"
              />
              <div className="mt-1 flex justify-end gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onPress={() => {
                    onUpdate(row.id, snapshotRef.current);
                    close();
                  }}
                >
                  Cancel
                </Button>
                <Button size="sm" onPress={close}>
                  Done
                </Button>
              </div>
            </div>
          )}
        </AriaDialog>
      </AriaPopover>
    </DialogTrigger>
  );
}
