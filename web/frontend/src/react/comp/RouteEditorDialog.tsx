/**
 * Task route editor dialog — the React replacement for the vanilla
 * analysis/task-editor on the task detail page (#270).
 *
 * A Tabulator editable grid (same pattern as the pilots dialog): drag
 * handle for reordering, per-row insert/remove, a single Google Maps
 * style coordinate column ("lat, lon"), live validation and optimized
 * leg/total distances. Start (SSS) gates and goal configuration are
 * edited in panels below the grid so a whole .xctsk is editable in one
 * place. Routes can be imported from a .xctsk file or an XContest task
 * code, and exported to a .xctsk file. Saving PATCHes the task's xctsk
 * (the server validates strictly and audit-logs the change).
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CellComponent, ColumnDefinition, Tabulator } from "tabulator-tables";
import {
  getOptimizedSegmentDistances,
  parseXCTaskAsync,
  toXctskJSON,
  type GoalConfig,
  type SSSConfig,
  type WaypointFileRecord,
  type XCTask,
} from "@glidecomp/engine";
import type { MapPickDetails, MapWaypoint } from "../../analysis/map-provider";
import { Button } from "@/react/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/react/ui/dialog";
import { Input } from "@/react/ui/input";
import { api } from "../../comp/api";
import { fetchTaskByCodeWithRaw } from "../../analysis/xctsk-fetch";
import { toast } from "../lib/toast";
import { useConfirm } from "../lib/confirm";
import { downloadFile } from "../lib/format";
import { utcToZonedHHMM, zonedToUtcHHMM, zoneNameWithOffset } from "../lib/time";
import { SimpleSelect } from "./fields";
import { slugify } from "./csv";
import {
  addMinutes,
  buildRoute,
  editableGates,
  formatCoords,
  gateToHHMM,
  turnpointsToCSV,
  turnpointToRow,
  xctskForPatch,
  TYPE_LABELS,
  type RouteRow,
} from "./route-editor";
import { AddWaypointDialog } from "./AddWaypointDialog";

// Lazy so the map libraries (mapbox/leaflet) and their CSS load only when the
// editor opens and never enter the SSR'd task-detail bundle.
const RouteMap = lazy(() => import("./RouteMap"));

const NEW_ROW_RADIUS = 400;

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
  const gridRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<Tabulator | null>(null);
  const [gridReady, setGridReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [totalKm, setTotalKm] = useState<number | null>(null);
  const [hasSSSTurnpoint, setHasSSSTurnpoint] = useState(
    xctsk?.turnpoints.some((tp) => tp.type === "SSS") ?? false
  );
  // Live task fed to the map (cylinders + optimised route line), kept in sync
  // with the grid by recompute(). Seeded from the loaded task on first render.
  const [mapTask, setMapTask] = useState<XCTask | null>(xctsk);
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
  const importInputRef = useRef<HTMLInputElement>(null);
  const [xcontestCode, setXcontestCode] = useState("");
  const [xcontestLoading, setXcontestLoading] = useState(false);

  // Fields not edited by the grid/panels (taskType, earthModel, takeoff,
  // cylinderTolerance) are carried over from the loaded task; an import
  // replaces the whole base.
  const baseRef = useRef<XCTask | null>(xctsk);

  // Row ids must be unique for Tabulator's index-based updates; never reuse.
  const rowIdRef = useRef(0);
  const nextRowId = () => ++rowIdRef.current;

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
  const [genCount, setGenCount] = useState("4");
  const [genInterval, setGenInterval] = useState("15");

  // Goal panel state
  const [goalType, setGoalType] = useState<GoalConfig["type"]>(
    xctsk?.goal?.type ?? "CYLINDER"
  );
  const [goalDeadline, setGoalDeadline] = useState<string>(() => {
    const hhmm = xctsk?.goal?.deadline ? gateToHHMM(xctsk.goal.deadline) : null;
    return hhmm ? toDisplayTime(hhmm) : "";
  });

  /** Re-validate and recompute optimized leg/total distances from the grid. */
  const recompute = useCallback(() => {
    const table = tableRef.current;
    if (!table) return;
    const rows = table.getData() as RouteRow[];
    const result = buildRoute(rows, { openDistance });
    setErrors(result.errors);
    setWarnings(result.warnings);
    setHasSSSTurnpoint(result.turnpoints.some((tp) => tp.type === "SSS"));

    // The goal config shapes the preview and the distances: a LINE goal is
    // drawn as the goal line + control semicircle, and the optimised route
    // ends on the line instead of the cylinder edge. Open-distance comps
    // hide the goal panel, so carry whatever the loaded task had.
    const goal = openDistance ? baseRef.current?.goal : { type: goalType };

    // Feed the map the turnpoints parsed so far — cylinders and the optimised
    // line update live as rows are edited, added, reordered or picked.
    setMapTask(
      result.turnpoints.length > 0
        ? {
            taskType: baseRef.current?.taskType || "CLASSIC",
            version: baseRef.current?.version ?? 1,
            turnpoints: result.turnpoints,
            ...(goal ? { goal } : {}),
          }
        : null
    );

    const legByRowId = new Map<number, number>();
    if (result.geometryComplete && result.turnpoints.length >= 2) {
      const task: XCTask = {
        taskType: baseRef.current?.taskType || "CLASSIC",
        version: baseRef.current?.version ?? 1,
        turnpoints: result.turnpoints,
        ...(goal ? { goal } : {}),
      };
      const legs = getOptimizedSegmentDistances(task);
      setTotalKm(legs.reduce((sum, d) => sum + d, 0) / 1000);
      // legs[i] is the segment into turnpoint i+1
      legs.forEach((d, i) => {
        const rowId = result.rowIds[i + 1];
        if (rowId !== undefined) legByRowId.set(rowId, d);
      });
    } else {
      setTotalKm(null);
    }
    if (rows.length > 0) {
      void table.updateData(
        rows.map((r) => ({ id: r.id, leg: legByRowId.get(r.id) ?? null }))
      );
    }
  }, [openDistance, goalType]);

  useEffect(() => {
    let cancelled = false;
    let table: Tabulator | null = null;
    void (async () => {
      // Tabulator is admin-only, so it's lazy-loaded to keep it (and its
      // CSS) out of the task-detail chunk every visitor downloads.
      const [{ TabulatorFull }] = await Promise.all([
        import("tabulator-tables"),
        import("tabulator-tables/dist/css/tabulator_simple.min.css"),
        import("./route-grid.css"),
      ]);
      if (cancelled || !gridRef.current) return;
      table = new TabulatorFull(gridRef.current, {
        data: (xctsk?.turnpoints ?? []).map((tp) => turnpointToRow(tp, nextRowId())),
        columns: gridColumns(),
        layout: "fitDataStretch",
        height: "100%",
        movableRows: true,
        // Turnpoint order IS the route — header sorting would show an order
        // that diverges from what gets saved.
        columnDefaults: { headerSort: false },
        placeholder: "No turnpoints yet — use Add turnpoint, or import a task",
        // Editor popups (type list) must render inside the modal dialog,
        // otherwise the dialog paints over them.
        popupContainer: "#route-edit-dialog",
      });
      table.on("tableBuilt", () => {
        if (!cancelled) {
          setGridReady(true);
          recompute();
        }
      });
      for (const event of ["cellEdited", "rowMoved", "rowAdded", "rowDeleted"] as const) {
        table.on(event, () => recompute());
      }
      tableRef.current = table;
    })();
    return () => {
      cancelled = true;
      table?.destroy();
      tableRef.current = null;
    };
    // The dialog mounts with a fixed xctsk; the grid owns the data from there.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The map preview and leg distances depend on the goal type (a LINE goal
  // draws as a line + semicircle and shifts the final leg), not just on the
  // grid rows — re-render them when the selector changes. `recompute` is
  // recreated on goalType changes, so it is the effect's real dependency.
  useEffect(() => {
    if (gridReady) recompute();
  }, [gridReady, recompute]);

  /**
   * Column set: drag handle, row number, per-row insert-above, then the
   * editable fields, the computed leg distance, and a remove button.
   */
  function gridColumns(): ColumnDefinition[] {
    return [
      {
        title: "",
        rowHandle: true,
        formatter: "handle",
        frozen: true,
        width: 30,
        minWidth: 30,
        resizable: false,
      },
      {
        title: "#",
        formatter: "rownum",
        width: 44,
        hozAlign: "right",
      },
      // Code / Name / Coordinates / Alt are copied from the competition
      // waypoint and shown read-only; the task's task-specific fields (Type,
      // Radius) stay editable.
      {
        title: "Code",
        field: "name",
        minWidth: 90,
      },
      {
        title: "Name",
        field: "description",
        minWidth: 130,
      },
      {
        title: "Type",
        field: "type",
        editor: "list",
        editorParams: {
          values: Object.entries(TYPE_LABELS).map(([value, label]) => ({ value, label })),
        },
        formatter: (cell) => TYPE_LABELS[String(cell.getValue() ?? "")] ?? "Turnpoint",
        minWidth: 100,
      },
      {
        title: "Coordinates (lat, lon)",
        field: "coords",
        minWidth: 190,
      },
      {
        title: "Radius (m)",
        field: "radius",
        editor: "number",
        editorParams: { selectContents: true, min: 1, max: 50000 },
        hozAlign: "right",
        minWidth: 90,
      },
      {
        title: "Alt (m)",
        field: "altitude",
        hozAlign: "right",
        minWidth: 80,
      },
      {
        title: "Leg",
        field: "leg",
        hozAlign: "right",
        minWidth: 80,
        formatter: (cell) => {
          const v = cell.getValue() as number | null;
          return v == null ? "" : `${(v / 1000).toFixed(1)} km`;
        },
      },
      {
        title: "",
        width: 36,
        hozAlign: "center",
        formatter: () =>
          '<span class="text-muted-foreground cursor-pointer" title="Remove turnpoint">✕</span>',
        cellClick: (_e: UIEvent, cell: CellComponent) => {
          void cell.getRow().delete();
        },
      },
    ];
  }

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

  /**
   * Append a turnpoint by COPYING a competition waypoint's details (code, long
   * name, coordinates, radius, altitude) into the task — so a later edit to
   * the competition waypoint never changes this task.
   */
  const addTurnpointFromRecord = useCallback((rec: WaypointFileRecord) => {
    void tableRef.current?.addRow({
      id: ++rowIdRef.current,
      name: rec.code,
      description: rec.name !== rec.code ? rec.name : "",
      type: "",
      coords: formatCoords(rec.latitude, rec.longitude),
      radius: rec.radius > 0 ? rec.radius : NEW_ROW_RADIUS,
      altitude: rec.altitude ? rec.altitude : "",
      leg: null,
    } satisfies RouteRow);
  }, []);

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
    const table = tableRef.current;
    if (!table) return;
    const existing = (table.getData() as RouteRow[]).some(
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
    await table.setData(task.turnpoints.map((tp) => turnpointToRow(tp, nextRowId())));
    setSssType(task.sss?.type ?? "RACE");
    setDirection(task.sss?.direction ?? "EXIT");
    setGates(editableGates(task.sss).map(toDisplayTime));
    setGoalType(task.goal?.type ?? "CYLINDER");
    const deadline = task.goal?.deadline ? gateToHHMM(task.goal.deadline) : null;
    setGoalDeadline(deadline ? toDisplayTime(deadline) : "");
    recompute();
    toast.success(`Loaded ${task.turnpoints.length} turnpoints from ${sourceLabel}`);
  }

  async function importFile(input: HTMLInputElement) {
    const file = input.files?.[0];
    input.value = ""; // allow re-selecting the same file
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
    const table = tableRef.current;
    if (!table) return null;
    const result = buildRoute(table.getData() as RouteRow[], { openDistance });
    if (result.errors.length > 0) {
      setErrors(result.errors);
      setWarnings(result.warnings);
      return null;
    }

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
    const table = tableRef.current;
    if (!table) return;
    const result = buildRoute(table.getData() as RouteRow[], { openDistance });
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
    const table = tableRef.current;
    if (!table) return;
    const hasRows = (table.getData() as RouteRow[]).some(
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
    await table.setData([]);
    recompute();
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
      const interval = parseInt(genInterval, 10) || 15;
      return [...prev, last ? addMinutes(last, interval) : "12:00"];
    });
  }

  function generateSeries() {
    const count = Math.min(Math.max(parseInt(genCount, 10) || 0, 1), 100);
    const interval = parseInt(genInterval, 10) || 15;
    setGates((prev) => {
      const first = prev[0] ?? "12:00";
      return Array.from({ length: count }, (_, i) => addMinutes(first, i * interval));
    });
  }

  const isRace = sssType === "RACE";
  const shownErrors = errors.slice(0, 10);
  const extraErrors = errors.length - shownErrors.length;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        id="route-edit-dialog"
        className="flex max-h-[90vh] flex-col overflow-y-auto sm:max-w-5xl"
      >
        <DialogHeader>
          <DialogTitle>Edit route</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Tap a cell to edit; drag the handle to reorder. Coordinates are decimal
          degrees: <code>lat, lon</code> (e.g. -36.550979, 147.890395). Distances
          are the optimized route through each cylinder.
        </p>
        {openDistance ? (
          <p className="text-sm text-muted-foreground">
            Open distance: define a single Takeoff turnpoint. Distance is scored
            from the take-off exit — there is no goal.
          </p>
        ) : null}

        <div className="grid gap-4 lg:grid-cols-2">
          {/* Map + waypoint picker — floats at the top on narrow screens, sits
              on the right on wide ones (same pattern as the score-explainer). */}
          <div className="order-1 flex flex-col gap-2 lg:order-2 lg:sticky lg:top-0 lg:self-start">
            <div className="h-64 overflow-hidden rounded border border-border sm:h-72 lg:h-[360px]">
              <Suspense
                fallback={
                  <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                    Loading map…
                  </div>
                }
              >
                {gridReady ? (
                  <RouteMap
                    task={mapTask}
                    waypoints={mapWaypoints}
                    addMode={addMode}
                    fitNonce={wpFitNonce}
                    onWaypointPick={pickWaypoint}
                    onMapPick={(lat, lon, details) =>
                      openAddPoint(formatCoords(lat, lon), details)
                    }
                  />
                ) : null}
              </Suspense>
            </div>
            {/* Add a missing waypoint without leaving the route editor: tap the
                map to place it, or open a blank form. Either way it's added to
                the route now and written to the competition when you save. */}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant={addMode ? "default" : "outline"}
                aria-pressed={addMode}
                onClick={() => setAddMode((a) => !a)}
              >
                {addMode ? "Tap the map to place…" : "Add from map"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => openAddPoint()}
              >
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
                <Input
                  className="h-8"
                  placeholder={`Search ${waypointRecords.length} waypoints…`}
                  aria-label="Search competition waypoints"
                  value={wpSearch}
                  onChange={(e) => setWpSearch(e.target.value)}
                />
                <div className="max-h-40 overflow-y-auto rounded border border-border">
                  {filteredWaypoints.slice(0, 200).map((w, i) => (
                    <button
                      key={`${w.code}-${i}`}
                      type="button"
                      className="flex w-full items-baseline gap-2 px-2 py-1 text-left text-sm hover:bg-accent"
                      onClick={() => addTurnpointFromRecord(w)}
                    >
                      <span className="font-medium">{w.code}</span>
                      {w.name !== w.code ? (
                        <span className="truncate text-muted-foreground">{w.name}</span>
                      ) : null}
                    </button>
                  ))}
                  {filteredWaypoints.length === 0 ? (
                    <p className="px-2 py-1.5 text-sm text-muted-foreground">No matches</p>
                  ) : null}
                </div>
                <p className="text-xs text-muted-foreground">
                  Click a waypoint (or tap it on the map) to add it as a turnpoint.
                </p>
              </>
            )}
          </div>

          {/* Editable turnpoint grid */}
          <div className="order-2 flex min-w-0 flex-col gap-2 lg:order-1">
            <div
              ref={gridRef}
              id="route-grid"
              className="h-[320px] shrink-0 rounded border border-border"
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!gridReady}
                onClick={() => void clearTurnpoints()}
              >
                Clear turnpoints
              </Button>
              {totalKm !== null ? (
                <span className="text-sm text-muted-foreground">
                  Optimized total: {totalKm.toFixed(1)} km
                </span>
              ) : null}
            </div>
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
            <section className="border-t border-border pt-3">
              <h3 className="text-sm font-medium">Start (SSS)</h3>
              {!hasSSSTurnpoint ? (
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
                    <Input
                      type="time"
                      className="w-32"
                      required
                      aria-label={`Gate ${i + 1} time — ${timeZoneLabel}`}
                      value={g}
                      onChange={(e) => updateGate(i, e.target.value)}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="ml-auto"
                      onClick={() => removeGate(i)}
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
                <Button type="button" variant="outline" size="sm" onClick={addGate}>
                  + Add gate
                </Button>
                {isRace ? (
                  <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                    <Input
                      type="number"
                      min={1}
                      max={100}
                      className="w-16"
                      aria-label="Number of gates"
                      value={genCount}
                      onChange={(e) => setGenCount(e.target.value)}
                    />
                    gates every
                    <Input
                      type="number"
                      min={1}
                      max={720}
                      className="w-16"
                      aria-label="Gate interval (minutes)"
                      value={genInterval}
                      onChange={(e) => setGenInterval(e.target.value)}
                    />
                    min
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={generateSeries}
                    >
                      Generate from first gate
                    </Button>
                  </span>
                ) : null}
              </div>
            </section>

            <section className="border-t border-border pt-3">
              <h3 className="text-sm font-medium">Goal</h3>
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
                  <Input
                    type="time"
                    className="w-32"
                    aria-label={`Goal deadline — ${timeZoneLabel}`}
                    value={goalDeadline}
                    onChange={(e) => setGoalDeadline(e.target.value)}
                  />
                  {goalDeadline ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setGoalDeadline("")}
                    >
                      Clear
                    </Button>
                  ) : (
                    "(optional)"
                  )}
                </span>
              </div>
              {goalType === "LINE" ? (
                <p className="mt-2 text-sm text-muted-foreground">
                  The goal line is centred on the last turnpoint, perpendicular
                  to the final leg, and extends the turnpoint&apos;s radius to
                  each side (total length 2 × radius).
                </p>
              ) : null}
            </section>
          </>
        ) : null}

        <DialogFooter className="border-t border-border pt-3">
          <div className="flex flex-wrap items-center gap-2 sm:mr-auto">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!gridReady}
              onClick={() => importInputRef.current?.click()}
            >
              Import .xctsk
            </Button>
            <input
              ref={importInputRef}
              type="file"
              accept=".xctsk"
              hidden
              onChange={(e) => void importFile(e.currentTarget)}
            />
            <Input
              className="w-28"
              placeholder="Task code"
              aria-label="XContest task code"
              value={xcontestCode}
              onChange={(e) => setXcontestCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void importXContest();
                }
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!gridReady || xcontestLoading || xcontestCode.trim() === ""}
              onClick={() => void importXContest()}
            >
              {xcontestLoading ? "Loading…" : "Load from XContest"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!gridReady}
              onClick={exportFile}
            >
              Export .xctsk
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!gridReady}
              onClick={exportCsv}
            >
              Export .csv
            </Button>
          </div>
          <DialogClose render={<Button type="button" variant="outline" />}>
            Cancel
          </DialogClose>
          <Button
            type="button"
            disabled={saving || !gridReady || errors.length > 0}
            onClick={() => void save()}
          >
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
      </DialogContent>
    </Dialog>
  );
}
