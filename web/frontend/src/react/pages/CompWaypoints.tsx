/**
 * Competition waypoints editor (issue #312, stage 1).
 *
 * A comp's shared waypoint database, edited here once and picked from when
 * building task routes. Admins upload a file (any of the supported formats),
 * fix up details in the grid, add points from the map or pasted coordinates,
 * and save. Non-admins see a read-only list. The set is stored per-comp
 * (JSON blob) via GET/PUT /api/comp/:id/waypoints.
 *
 * RAC chrome (buttons, file trigger, read-only table, dialogs) around a
 * **Tabulator** editable grid — the app's standard for editable tables (see
 * the Tabulator policy in docs/2026-07-18-rac-adoption-guide.md). The grid is
 * admin-only and lazy-loaded; React `rows` state stays the source of truth
 * for the map markers, dirty check and save — grid edits mirror back into it
 * via cellEdited/rowDeleted, and external changes (file upload, the add
 * dialog) are pushed into the grid imperatively.
 *
 * The read-only content (heading, table, download links) is server-rendered
 * via loadCompWaypoints so the page has real content for crawlers; the map
 * (mapbox) and the admin grid (tabulator) stay client-only — the server
 * streams the map's "Loading map…" fallback and an empty grid container.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { FileTrigger } from "react-aria-components";
import { MapPinIcon } from "lucide-react";
import { parseWaypointFile, type WaypointFileRecord } from "@glidecomp/engine";
import type { CellComponent, ColumnDefinition, Tabulator } from "tabulator-tables";
import type { MapPickDetails, MapWaypoint } from "../../analysis/map-provider";
import { Button, ToggleButton } from "@/react/rac/button";
import { Table, TableHeader, TableBody, Column, Row, Cell } from "@/react/rac/table";
import { RacConfirmProvider } from "@/react/rac/confirm";
import { api } from "../../comp/api";
import { toast } from "../lib/toast";
import { useConfirm } from "../lib/confirm";
import { useAdminView, useUser } from "../lib/user";
import { Breadcrumbs } from "@/react/rac/breadcrumbs";
import { underComp } from "../lib/crumbs";
import { formatCoords, parseCoords } from "../comp/route-editor";
import { AddWaypointDialog } from "../comp/AddWaypointDialog";
import { WaypointDeviceExport } from "../comp/WaypointDeviceExport";
import { useInitialData } from "../lib/initial-data";
import { formatAltitude, formatRadius, useUnits } from "../lib/units";
import type { CompWaypointsLoaderData } from "../loaders";

const RouteMap = lazy(() => import("../comp/RouteMap"));

/** One editable row. Coordinates are edited as text (Google "lat, lon"). */
interface WpRow {
  id: number;
  code: string;
  name: string;
  coords: string;
  altitude: string;
  radius: string;
}

let rowSeq = 0;
function toRow(w: WaypointFileRecord): WpRow {
  return {
    id: ++rowSeq,
    code: w.code,
    name: w.name === w.code ? "" : w.name,
    coords: formatCoords(w.latitude, w.longitude),
    altitude: w.altitude ? String(w.altitude) : "",
    radius: String(w.radius || 400),
  };
}

/** Convert an edited row back to a record, or null if the coordinates are bad. */
function fromRow(r: WpRow): WaypointFileRecord | null {
  const coords = parseCoords(r.coords);
  if (!coords) return null;
  const code = r.code.trim() || "WP";
  const alt = Number(r.altitude);
  const radius = Number(r.radius);
  return {
    code,
    name: r.name.trim() || code,
    latitude: coords.lat,
    longitude: coords.lon,
    altitude: r.altitude.trim() !== "" && Number.isFinite(alt) ? Math.round(alt) : 0,
    radius: Number.isFinite(radius) && radius > 0 ? Math.round(radius) : 400,
  };
}

/**
 * Rows whose altitude is still unknown (blank, zero or unparseable — waypoint
 * files without altitudes come through as 0, which toRow renders as ""). Only
 * these are touched by "Fill altitudes from map".
 */
function missingAltitude(r: WpRow): boolean {
  const alt = Number(r.altitude);
  return !Number.isFinite(alt) || alt === 0;
}

// Lucide's map-pin, inlined for Tabulator cell formatters (static markup only).
const PIN_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/></svg>';

export function CompWaypoints() {
  return (
    <RacConfirmProvider>
      <CompWaypointsContent />
    </RacConfirmProvider>
  );
}

function CompWaypointsContent() {
  const { compId } = useParams<{ compId: string }>();
  const { user } = useUser();
  const confirm = useConfirm();
  const units = useUnits();

  // SSR seed (null on client boot / SPA navigations, where the effect below
  // fetches instead). Seeding the same states the fetch would set makes the
  // first client render match the server markup exactly.
  const initial = useInitialData<CompWaypointsLoaderData>();
  const [compName, setCompName] = useState<string>(initial?.comp.name ?? "");
  const [realIsAdmin, setRealIsAdmin] = useState(!!initial?.comp.is_admin);
  const [rows, setRows] = useState<WpRow[]>(() =>
    initial ? initial.waypoints.map(toRow) : []
  );
  const [savedJson, setSavedJson] = useState<string>(() =>
    initial ? baselineJson(initial.waypoints) : "[]"
  );
  const [loading, setLoading] = useState(!initial);
  const [saving, setSaving] = useState(false);
  const [fillingAlts, setFillingAlts] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [addMode, setAddMode] = useState(false);
  const [fitNonce, setFitNonce] = useState(0);
  // Fly-to-waypoint request from a grid row click (see `locate`).
  const [focus, setFocus] = useState<{ lat: number; lon: number; key: number } | null>(null);
  const focusSeq = useRef(0);

  // New-waypoint dialog (from map tap or the Add button). The dialog itself is
  // the shared AddWaypointDialog; here we only hold whether it's open and the
  // seed (coordinates + map details) it opens with.
  const [adding, setAdding] = useState(false);
  const [seedCoords, setSeedCoords] = useState("");
  const [seedDetails, setSeedDetails] = useState<MapPickDetails | undefined>(undefined);

  const isAdmin = useAdminView(realIsAdmin);

  // The Tabulator grid (admin-only). rowsRef always holds the latest rows so
  // the build effect can read them without depending on `rows` (a dependency
  // would tear the grid down on every edit).
  const gridRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<Tabulator | null>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  useEffect(() => {
    if (!compId) return;
    // Seeded from SSR — skip the fetch. The seed is retired on any client-side
    // navigation (see lib/initial-data.tsx), so a return visit fetches fresh.
    if (initial) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const [compRes, wpRes] = await Promise.all([
          api.api.comp[":comp_id"].$get({ param: { comp_id: compId } }),
          api.api.comp[":comp_id"].waypoints.$get({ param: { comp_id: compId } }),
        ]);
        if (cancelled) return;
        if (!compRes.ok) {
          setNotFound(true);
          return;
        }
        // encodeComp is loosely typed, so read the fields we need via unknown.
        // The server already computes is_admin (super-admins included).
        const comp = (await compRes.json()) as unknown as {
          name?: string;
          is_admin?: boolean;
        };
        setCompName(comp.name ?? "");
        setRealIsAdmin(!!comp.is_admin);
        const wpData = wpRes.ok
          ? ((await wpRes.json()) as unknown as { waypoints: WaypointFileRecord[] })
          : { waypoints: [] };
        setRows(wpData.waypoints.map(toRow));
        setSavedJson(baselineJson(wpData.waypoints));
        setFitNonce((n) => n + 1);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [compId, user, initial]);

  // Fly the map to a row's coordinates (bumping the key so a repeat click on the
  // same row re-centres). No-op when the row's coordinates aren't yet valid.
  const locate = useCallback((r: WpRow) => {
    const c = parseCoords(r.coords);
    if (c) setFocus({ lat: c.lat, lon: c.lon, key: ++focusSeq.current });
  }, []);

  // Build the Tabulator grid once the page is loaded and the viewer is an
  // admin. Tabulator is lazy-loaded to keep it (and its CSS) out of the chunk
  // every visitor downloads — same pattern as the pilots editor. Grid edits
  // mirror back into React state (the source of truth for the map, dirty
  // check and save); the grid itself is never rebuilt per edit.
  useEffect(() => {
    if (!isAdmin || loading) return;
    let cancelled = false;
    let table: Tabulator | null = null;
    void (async () => {
      const [{ TabulatorFull }] = await Promise.all([
        import("tabulator-tables"),
        import("tabulator-tables/dist/css/tabulator_simple.min.css"),
        import("../comp/tabulator-grid.css"),
      ]);
      if (cancelled || !gridRef.current) return;
      table = new TabulatorFull(gridRef.current, {
        data: rowsRef.current.map((r) => ({ ...r })),
        index: "id",
        columns: waypointGridColumns(locate),
        columnDefaults: { headerSort: false },
        layout: "fitDataStretch",
        height: "100%",
        placeholder:
          "No waypoints yet. Upload a file or add points from the map to get started.",
      });
      const sync = () => {
        const t = table;
        if (!t) return;
        setRows((t.getData() as WpRow[]).map((r) => ({ ...r })));
      };
      table.on("cellEdited", (cell) => {
        // Re-run the row's formatters so the locate pin picks up the new
        // coordinate validity.
        if (cell.getField() === "coords") cell.getRow().reformat();
        sync();
      });
      table.on("rowDeleted", sync);
      tableRef.current = table;
    })();
    return () => {
      cancelled = true;
      table?.destroy();
      tableRef.current = null;
    };
  }, [isAdmin, loading, locate]);

  // Current records + validity, derived from the rows.
  const records = useMemo(() => rows.map(fromRow), [rows]);
  const invalidCount = records.filter((r) => r === null).length;
  const validRecords = useMemo(
    () => records.filter((r): r is WaypointFileRecord => r !== null),
    [records]
  );
  const dirty = serialize(validRecords) !== savedJson;

  // Map markers from the rows with valid coordinates.
  const mapWaypoints: MapWaypoint[] = useMemo(
    () =>
      rows.flatMap((r) => {
        const c = parseCoords(r.coords);
        return c
          ? [{ id: String(r.id), code: r.code || "?", name: r.name || r.code || "?", lat: c.lat, lon: c.lon }]
          : [];
      }),
    [rows]
  );

  /** Replace the whole set (file upload): state + grid + map refit. */
  function replaceRows(next: WpRow[]) {
    setRows(next);
    void tableRef.current?.setData(next.map((r) => ({ ...r })));
    setFitNonce((n) => n + 1);
  }

  async function loadFile(file: File | null) {
    if (!file) return;
    try {
      const { waypoints, format } = parseWaypointFile(await file.text(), file.name);
      if (waypoints.length === 0) {
        toast.error(`No waypoints found in ${file.name}`);
        return;
      }
      if (rows.length > 0) {
        const ok = await confirm({
          title: "Replace the current waypoints?",
          message: `Loading ${file.name} replaces all ${rows.length} waypoints currently in the editor. Nothing is saved until you press Save.`,
          confirmLabel: "Replace",
        });
        if (!ok) return;
      }
      replaceRows(waypoints.map(toRow));
      toast.success(
        `Loaded ${waypoints.length} waypoint${waypoints.length === 1 ? "" : "s"} (${format}) from ${file.name}`
      );
    } catch {
      toast.error(`Could not read ${file.name} as a waypoint file`);
    }
  }

  // Open the shared add dialog, seeding it with the tap's coordinates and
  // whatever the map knows about the point (elevation, place name, nearby peak).
  const openAdd = useCallback((coords = "", details?: MapPickDetails) => {
    setSeedCoords(coords);
    setSeedDetails(details);
    setAdding(true);
    setAddMode(false);
  }, []);

  // The dialog hands back a finished record; drop it in as a new row (state +
  // grid — nothing is saved until Save). The grid scrolls to the new row so
  // it's visible even when the set is longer than the viewport.
  function addWaypoint(rec: WaypointFileRecord) {
    const row = toRow(rec);
    setRows((prev) => [...prev, row]);
    void tableRef.current?.addRow({ ...row }).then((r) => r.scrollTo());
    setAdding(false);
  }

  // Waypoints that would get an altitude from "Fill altitudes from map".
  const fillableCount = rows.filter(
    (r) => missingAltitude(r) && parseCoords(r.coords) !== null
  ).length;

  /**
   * Fill blank/zero altitudes with ground elevations from the Mapbox terrain
   * DEM (fetched directly at high zoom — see analysis/elevation.ts for why we
   * don't read them off the live map). Only missing altitudes are touched;
   * values the file (or the admin) already set stay as they are, and nothing
   * is saved until Save.
   */
  async function fillAltitudes() {
    const targets = rows.flatMap((r) => {
      const c = parseCoords(r.coords);
      return missingAltitude(r) && c ? [{ id: r.id, lat: c.lat, lon: c.lon }] : [];
    });
    if (targets.length === 0) return;
    setFillingAlts(true);
    try {
      // Dynamic import: browser-only module (canvas decoding), keep it out of
      // the SSR bundle and the page chunk until the button is pressed.
      const { fetchElevations } = await import("../../analysis/elevation");
      const elevations = await fetchElevations(targets);
      const byId = new Map<number, string>();
      targets.forEach((t, i) => {
        const e = elevations[i];
        if (e !== null) byId.set(t.id, String(Math.round(e)));
      });
      if (byId.size === 0) {
        toast.error("Could not read terrain elevations from Mapbox");
        return;
      }
      // Apply against the *current* rows (the grid may have been edited while
      // the tiles were downloading), and only where the altitude is still
      // missing so we never clobber a value typed in the meantime.
      const filled: WpRow[] = [];
      const next = rowsRef.current.map((r) => {
        const alt = byId.get(r.id);
        if (alt === undefined || !missingAltitude(r)) return r;
        const row = { ...r, altitude: alt };
        filled.push(row);
        return row;
      });
      setRows(next);
      void tableRef.current?.updateData(
        filled.map((r) => ({ id: r.id, altitude: r.altitude }))
      );
      const missed = targets.length - filled.length;
      toast.success(
        `Filled ${filled.length} altitude${filled.length === 1 ? "" : "s"} from the map terrain` +
          (missed > 0 ? ` (${missed} unavailable)` : "")
      );
    } catch {
      toast.error("Could not read terrain elevations from Mapbox");
    } finally {
      setFillingAlts(false);
    }
  }

  async function save() {
    const built = rows.map(fromRow);
    if (built.some((r) => r === null)) {
      toast.error("Every waypoint needs valid coordinates before saving");
      return;
    }
    setSaving(true);
    try {
      const waypoints = built as WaypointFileRecord[];
      const res = await api.api.comp[":comp_id"].waypoints.$put({
        param: { comp_id: compId! },
        json: { waypoints },
      });
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        toast.error(err.error || "Failed to save waypoints");
        return;
      }
      setSavedJson(serialize(waypoints));
      toast.success(`Saved ${waypoints.length} waypoint${waypoints.length === 1 ? "" : "s"}`);
    } catch {
      toast.error("Network error. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  if (notFound) {
    return (
      <main className="mx-auto max-w-md py-12">
        <h1 className="text-2xl font-bold">Competition not found</h1>
        <Link to="/comp" className="mt-4 inline-block underline">
          Back to competitions
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">
      <Breadcrumbs items={underComp(compId, compName)} current="Waypoints" />
      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="min-w-0 flex-1 text-2xl font-bold">Waypoints</h1>
        {isAdmin ? (
          <div className="flex flex-wrap items-center gap-2">
            <FileTrigger
              acceptedFileTypes={[".wpt", ".cup", ".csv", ".txt", ".gpx", ".kml"]}
              onSelect={(files) => void loadFile(files?.[0] ?? null)}
            >
              <Button variant="outline" size="sm">
                Upload file
              </Button>
            </FileTrigger>
            <Button variant="outline" size="sm" onPress={() => openAdd()}>
              Add waypoint
            </Button>
            {/* Always visible so the capability is discoverable; disabled when
                every waypoint already has an altitude. */}
            <Button
              variant="outline"
              size="sm"
              isDisabled={fillingAlts || fillableCount === 0}
              onPress={() => void fillAltitudes()}
            >
              {fillingAlts
                ? "Filling altitudes…"
                : fillableCount > 0
                  ? `Fill ${fillableCount} altitude${fillableCount === 1 ? "" : "s"} from map`
                  : "Fill altitudes from map"}
            </Button>
            <Button size="sm" isDisabled={saving || !dirty} onPress={() => void save()}>
              {saving ? "Saving…" : dirty ? "Save" : "Saved"}
            </Button>
          </div>
        ) : null}
      </div>

      <p className="mb-4 text-sm text-muted-foreground">
        The shared waypoints for this competition. Tasks pick their turnpoints
        from this set.{" "}
        {isAdmin
          ? "Upload a file (OziExplorer, SeeYou, CompeGPS, FS, GPX, KML or CSV), edit details, or add points from the map."
          : null}
      </p>

      {/* Pilot download + QR (issue #312 stage 2) — visible to everyone. */}
      {!loading && validRecords.length > 0 ? (
        <div className="mb-6">
          <WaypointDeviceExport
            records={validRecords}
            baseName={compName}
            noun="waypoint"
            hostedUrl={(fmt, swap) =>
              `/api/comp/${compId}/waypoints/${fmt}${swap ? "?swap=1" : ""}`
            }
          />
        </div>
      ) : null}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading waypoints…</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {/* Map */}
          <div className="order-1 lg:order-2 lg:sticky lg:top-4 lg:self-start">
            <div className="h-64 overflow-hidden rounded border border-border sm:h-80 lg:h-[520px]">
              <Suspense
                fallback={
                  <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                    Loading map…
                  </div>
                }
              >
                <RouteMap
                  task={null}
                  waypoints={mapWaypoints}
                  addMode={addMode}
                  fitNonce={fitNonce}
                  focus={focus}
                  onWaypointPick={() => {}}
                  onMapPick={(lat, lon, details) => openAdd(formatCoords(lat, lon), details)}
                />
              </Suspense>
            </div>
            {isAdmin ? (
              <div className="mt-2 flex items-center gap-2">
                <ToggleButton size="sm" isSelected={addMode} onChange={setAddMode}>
                  {addMode ? "Tap the map to place…" : "Add from map"}
                </ToggleButton>
                <span className="text-xs text-muted-foreground">
                  {rows.length} waypoint{rows.length === 1 ? "" : "s"}
                  {invalidCount > 0 ? ` · ${invalidCount} need valid coordinates` : ""}
                </span>
              </div>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">{rows.length} waypoints</p>
            )}
          </div>

          {/* Grid (admins: editable Tabulator) / table (everyone else: RAC read-only) */}
          <div className="order-2 min-w-0 lg:order-1">
            {isAdmin ? (
              <div
                ref={gridRef}
                className="gc-grid h-[420px] rounded border border-border lg:h-[560px]"
              />
            ) : rows.length === 0 ? (
              <p className="rounded border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                No waypoints yet.
              </p>
            ) : (
              <Table aria-label="Waypoints" scrollLabel="Waypoints">
                <TableHeader>
                  <Column className="w-8">
                    <span className="sr-only">Show on map</span>
                  </Column>
                  <Column isRowHeader>Code</Column>
                  <Column>Name</Column>
                  <Column>Coordinates</Column>
                  {/* Alt and Radius are plain quantities, so they read right-
                      aligned. Coordinates stays left: it is a "lat, lon"
                      pair, not a single number to compare down the column. */}
                  <Column className="text-right">Alt</Column>
                  <Column className="text-right">Radius</Column>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <Row key={r.id} id={r.id}>
                      <Cell className="p-1 text-center">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Show ${r.code || "waypoint"} on the map`}
                          onPress={() => locate(r)}
                        >
                          <MapPinIcon className="size-4" aria-hidden="true" />
                        </Button>
                      </Cell>
                      <Cell className="font-medium">{r.code}</Cell>
                      <Cell>{r.name || "—"}</Cell>
                      <Cell className="font-mono text-xs">{r.coords}</Cell>
                      <Cell className="text-right font-mono text-xs">
                        {r.altitude && Number.isFinite(Number(r.altitude))
                          ? formatAltitude(Number(r.altitude), { prefs: units }).withUnit
                          : "—"}
                      </Cell>
                      <Cell className="text-right font-mono text-xs">
                        {Number.isFinite(Number(r.radius))
                          ? formatRadius(Number(r.radius), { prefs: units }).withUnit
                          : r.radius}
                      </Cell>
                    </Row>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </div>
      )}

      {/* New-waypoint dialog (shared with the task route editor). */}
      <AddWaypointDialog
        open={adding}
        initialCoords={seedCoords}
        details={seedDetails}
        takenCodes={rows.map((r) => r.code)}
        onAdd={addWaypoint}
        onCancel={() => setAdding(false)}
      />
    </main>
  );
}

/** Stable JSON for dirty-checking (key order fixed). */
function serialize(list: WaypointFileRecord[]): string {
  return JSON.stringify(
    list.map((w) => [w.code, w.name, w.latitude, w.longitude, w.altitude, w.radius])
  );
}

/**
 * The saved-state baseline: what the untouched grid serializes to. Rows
 * round-trip every record through the editable text form (toFixed(6)
 * coordinates, rounded altitude/radius, name folded into code), so the
 * baseline must round-trip the same way — comparing against the raw API
 * records leaves a comp stored with more precision permanently "dirty".
 */
function baselineJson(list: WaypointFileRecord[]): string {
  return serialize(
    list
      .map((w) => fromRow(toRow(w)))
      .filter((w): w is WaypointFileRecord => w !== null)
  );
}

/**
 * Tabulator column definitions for the waypoints grid: a frozen locate-on-map
 * pin, one editable column per waypoint field, and a remove button. Cell
 * formatters build DOM nodes with textContent (never HTML strings) — waypoint
 * files are user-supplied, so their values must not reach innerHTML.
 */
function waypointGridColumns(locate: (r: WpRow) => void): ColumnDefinition[] {
  const pin: ColumnDefinition = {
    title: "",
    width: 36,
    hozAlign: "center",
    frozen: true,
    formatter: (cell) => {
      const row = cell.getRow().getData() as WpRow;
      const valid = parseCoords(row.coords) !== null;
      const el = document.createElement("span");
      el.className = valid ? "gc-cell-button" : "gc-cell-button gc-cell-button-disabled";
      el.title = valid
        ? `Show ${row.code || "waypoint"} on the map`
        : "Enter valid coordinates first";
      el.innerHTML = PIN_SVG;
      return el;
    },
    cellClick: (_e: UIEvent, cell: CellComponent) => {
      locate(cell.getRow().getData() as WpRow);
    },
  };

  const text = (title: string, field: string, extra: Partial<ColumnDefinition> = {}): ColumnDefinition => ({
    title,
    field,
    editor: "input",
    // Select the existing value on edit so typing replaces it (matches
    // spreadsheet behaviour; without this, mobile taps append text).
    editorParams: { selectContents: true },
    ...extra,
  });

  const coords: ColumnDefinition = {
    ...text("Coordinates", "coords", { minWidth: 150, cssClass: "gc-mono" }),
    formatter: (cell) => {
      const value = String(cell.getValue() ?? "");
      cell.getElement().classList.toggle("gc-cell-invalid", parseCoords(value) === null);
      const el = document.createElement("span");
      el.textContent = value;
      return el;
    },
  };

  const remove: ColumnDefinition = {
    title: "",
    width: 36,
    hozAlign: "center",
    formatter: () => '<span class="gc-cell-button" title="Remove waypoint">✕</span>',
    cellClick: (_e: UIEvent, cell: CellComponent) => {
      void cell.getRow().delete();
    },
  };

  return [
    pin,
    text("Code", "code", { minWidth: 80, frozen: true }),
    text("Name", "name", { minWidth: 130 }),
    coords,
    text("Alt", "altitude", { width: 70, hozAlign: "right", headerHozAlign: "right", cssClass: "gc-mono" }),
    text("Radius", "radius", { width: 80, hozAlign: "right", headerHozAlign: "right", cssClass: "gc-mono" }),
    remove,
  ];
}
