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
 * the Tabulator policy in docs/2026-07-18-rac-adoption-guide.md), declared
 * through the shared `TabulatorGrid` wrapper — which owns the lazy load and
 * lifecycle. The grid is admin-only; React `rows` state stays the source of truth
 * for the map markers, dirty check and save — grid edits mirror back into it
 * via cellEdited/rowDeleted, and external changes (file upload, the add
 * dialog) are pushed into the grid imperatively.
 *
 * The read-only content (heading, table, download links) is server-rendered
 * via loadCompWaypoints so the page has real content for crawlers; the map
 * (mapbox) and the admin grid (tabulator) stay client-only — the server
 * streams the map's "Loading map…" fallback and an empty grid container.
 *
 * Table and map are laid out by the shared {@link MasterDetail}: the map is
 * the pinned pane on a phone (so a row's locate pin flies a map that is on
 * screen) and the sticky right-hand column on a wide screen. The pane is a
 * few centimetres tall there, so the map also MAXIMISES into a full-screen
 * sheet, carrying its Add-from-map toggle with it — enough room to walk a
 * valley dropping points one after another.
 *
 * Nothing here is saved until Save, which is why Save is the page's own
 * fixed bottom bar (the end of the work, always in reach) and why leaving
 * with edits outstanding asks first — the same guard the comp settings forms
 * use. An admin lost a set of added waypoints to a tap on a link before it
 * was here.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useInView } from "../lib/use-in-view";
import { useParams } from "react-router-dom";
import { NotFound } from "@/react/components/NotFound";
import { FileTrigger, type SortDescriptor } from "react-aria-components";
import { MapPinIcon, Maximize2Icon, Minimize2Icon } from "lucide-react";
import {
  cleanWaypointCodes,
  describeCodeChanges,
  parseWaypointFile,
  type WaypointFileRecord,
} from "@glidecomp/engine";
import type { CellComponent, ColumnDefinition, Tabulator } from "tabulator-tables";
import type { MapCamera, MapPickDetails, MapWaypoint } from "../../analysis/map-provider";
import { Button, ToggleButton } from "@/react/rac/button";
import { FullScreenSheet } from "@/react/rac/full-screen-sheet";
import { MasterDetail } from "@/react/components/MasterDetail";
import { Loading } from "@/react/rac/progress";
import { SearchField } from "@/react/rac/field";
import { Table, TableHeader, TableBody, Column, Row, Cell } from "@/react/rac/table";
import { api } from "../../comp/api";
import { toast } from "../lib/toast";
import { useConfirm } from "../lib/confirm";
import { useUnsavedChangesGuard } from "../lib/use-unsaved-changes-guard";
import { useAdminView, useUser } from "../lib/user";
import { Breadcrumbs } from "@/react/rac/breadcrumbs";
import { underComp } from "../lib/crumbs";
import { idFromSegment, compWaypointsPath } from "../lib/slug";
import { useCanonicalPath } from "../lib/use-canonical-path";
import { fetchWithRetry } from "../comp/types";
import { formatCoords, parseCoords } from "../comp/route-editor";
import { AddWaypointDialog } from "../comp/AddWaypointDialog";
import { TabulatorGrid } from "../comp/TabulatorGrid";
import { WaypointDeviceExport } from "../comp/WaypointDeviceExport";
import { useInitialData } from "../lib/initial-data";
import { cn } from "@/react/lib/utils";
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
 * Rows whose altitude is still unknown. "Unknown" is a *blank* (or
 * unparseable) altitude — NOT a zero. A waypoint genuinely at sea level reads
 * "0", and once "Fill altitudes from map" writes that 0 it must count as
 * filled, or the button would forever claim there are altitudes left to fill
 * (the reported bug). Blank is the only "missing" signal: waypoint files
 * without altitudes arrive as 0 and toRow renders those as "".
 *
 * Consequence of the ambiguity in the file format: a file that genuinely
 * carries an altitude of 0 also renders as "" (toRow can't tell "no altitude"
 * from "altitude 0"), so such a point is still treated as missing and gets
 * filled from the map — which lands on ~0 anyway. Only an explicit "0" already
 * in a cell (typed, or filled from the map) counts as known.
 */
function missingAltitude(r: WpRow): boolean {
  const s = r.altitude.trim();
  if (s === "") return true;
  return !Number.isFinite(Number(s));
}

/**
 * Case-insensitive substring match across a row's code, name and coordinates —
 * the filter the search box drives. `query` is expected already lower-cased so
 * the per-row work stays a plain includes().
 */
function matchesFilter(r: WpRow, query: string): boolean {
  if (!query) return true;
  return (
    r.code.toLowerCase().includes(query) ||
    r.name.toLowerCase().includes(query) ||
    r.coords.toLowerCase().includes(query)
  );
}

/** Numeric value of an altitude/radius cell, or NaN when blank/unparseable. */
function numField(r: WpRow, field: "altitude" | "radius"): number {
  const s = r[field].trim();
  return s === "" ? NaN : Number(s);
}

/**
 * Sort a copy of the rows for the read-only table by the RAC sort descriptor.
 * Alt/Radius sort numerically with blanks pinned last (in both directions);
 * everything else sorts as locale strings.
 */
function sortRows(rows: WpRow[], sort: SortDescriptor): WpRow[] {
  const dir = sort.direction === "descending" ? -1 : 1;
  const col = String(sort.column);
  return [...rows].sort((a, b) => {
    if (col === "altitude" || col === "radius") {
      const an = numField(a, col);
      const bn = numField(b, col);
      const aNan = Number.isNaN(an);
      const bNan = Number.isNaN(bn);
      if (aNan && bNan) return 0;
      if (aNan) return 1; // blanks always last, regardless of direction
      if (bNan) return -1;
      return (an - bn) * dir;
    }
    const av = String((a as unknown as Record<string, string>)[col] ?? "");
    const bv = String((b as unknown as Record<string, string>)[col] ?? "");
    return av.localeCompare(bv) * dir;
  });
}

// Lucide's map-pin, inlined for Tabulator cell formatters (static markup only).
const PIN_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/></svg>';

export function CompWaypoints() {
  const { compId: compParam } = useParams<{ compId: string }>();
  const compId = idFromSegment(compParam ?? "");
  const { user } = useUser();
  const confirm = useConfirm();
  const units = useUnits();

  // SSR seed (null on client boot / SPA navigations, where the effect below
  // fetches instead). Seeding the same states the fetch would set makes the
  // first client render match the server markup exactly.
  const initial = useInitialData<CompWaypointsLoaderData>();
  const [compName, setCompName] = useState<string>(initial?.comp.name ?? "");
  // Settle the address bar on the canonical `${slug}-${id}` once the name loads.
  useCanonicalPath(compName ? compWaypointsPath(compId, compName) : null);
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
  // Mapbox (764 KB) waits until the panel nears the viewport — see use-in-view.
  const [mapRef, mapInView] = useInView<HTMLDivElement>();
  const [addMode, setAddMode] = useState(false);
  // The map at full screen (see the sheet at the foot of the render). Only
  // ever ONE map instance: the inline pane unmounts while the sheet is up,
  // and `cameraRef` carries the view across so neither hand-over drops the
  // admin back on the globe.
  const [maximised, setMaximised] = useState(false);
  const cameraRef = useRef<MapCamera | null>(null);
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

  // Filter box (narrows a long list) and the read-only table's sort. The admin
  // grid does its own sorting via Tabulator header clicks; `sort` here only
  // drives the RAC read-only table.
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<SortDescriptor | undefined>(undefined);
  const filterRef = useRef(filter);
  filterRef.current = filter;

  const isAdmin = useAdminView(realIsAdmin);

  // The Tabulator grid (admin-only). rowsRef always holds the latest rows so
  // async work (filling altitudes) can apply its results against whatever is
  // in the grid by the time it finishes.
  const tableRef = useRef<Tabulator | null>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  useEffect(() => {
    // Clear any previous verdict first. react-router keeps this component
    // mounted when only the id in the path changes, so a "not found" left over
    // from the old id would mask whatever the new one loads. That is not
    // hypothetical: the 404 page's own "did you mean" links point back at this
    // very route, so clicking one changed the URL and nothing else.
    setNotFound(false);
    if (!compId) return;
    // Seeded from SSR — skip the fetch. The seed is retired on any client-side
    // navigation (see lib/initial-data.tsx), so a return visit fetches fresh.
    if (initial) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        // Both go through fetchWithRetry: a dropped comp GET used to leave
        // this page with no name, no waypoints and no admin controls, and a
        // bare rejection nobody caught (issue #481).
        const [compRes, wpRes] = await Promise.all([
          fetchWithRetry(() =>
            api.api.comp[":comp_id"].$get({ param: { comp_id: compId } })
          ),
          fetchWithRetry(() =>
            api.api.comp[":comp_id"].waypoints.$get({ param: { comp_id: compId } })
          ),
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
      } catch {
        // Every retry was dropped. Say so, rather than rendering an empty
        // waypoint list that looks like a comp with no waypoints.
        if (!cancelled) setNotFound(true);
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

  // Mirror the grid's rows back into React state (the source of truth for the
  // map, dirty check and save). getData() returns the master row list in
  // insertion order, unaffected by an active sort or filter, so mirroring it
  // back never reorders state or drops filtered-out rows.
  const syncFromGrid = useCallback(() => {
    const t = tableRef.current;
    if (!t) return;
    setRows((t.getData() as WpRow[]).map((r) => ({ ...r })));
  }, []);

  // Push the filter box into the (already-built) grid. `onReady` seeds the
  // initial filter, so this handles every subsequent keystroke/clear.
  useEffect(() => {
    const t = tableRef.current;
    if (!t) return;
    const q = filter.trim().toLowerCase();
    if (q) t.setFilter((data: WpRow) => matchesFilter(data, q));
    else t.clearFilter(true);
  }, [filter]);

  // Current records + validity, derived from the rows.
  const records = useMemo(() => rows.map(fromRow), [rows]);
  const invalidCount = records.filter((r) => r === null).length;
  const validRecords = useMemo(
    () => records.filter((r): r is WaypointFileRecord => r !== null),
    [records]
  );
  const dirty = serialize(validRecords) !== savedJson;

  // Everything on this page — a whole uploaded file, a filled column of
  // altitudes, an afternoon of typed coordinates — lives in the browser until
  // Save. Leaving used to throw it away without a word (the reported bug), so
  // the page is guarded exactly like the comp settings forms are. `!saving`
  // keeps the guard out of the way of the save's own re-render.
  useUnsavedChangesGuard(dirty && !saving, {
    title: "Discard changes?",
    message: "This page has unsaved changes. Leaving will discard them.",
  });

  // Rows for the read-only table: filter, then sort (a copy — `rows` stays the
  // canonical order). The admin grid handles its own filter/sort in Tabulator.
  const query = filter.trim().toLowerCase();
  const visibleRows = useMemo(() => {
    const filtered = query ? rows.filter((r) => matchesFilter(r, query)) : rows;
    return sort ? sortRows(filtered, sort) : filtered;
  }, [rows, query, sort]);

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
      // Codes can't hold a space or a comma (they separate turnpoints when a
      // route is written as text), and they have to be unique to name a
      // turnpoint at all. Clean on the way in, and say what changed.
      const { waypoints: cleaned, changes } = cleanWaypointCodes(waypoints);
      replaceRows(cleaned.map(toRow));
      toast.success(
        `Loaded ${cleaned.length} waypoint${cleaned.length === 1 ? "" : "s"} (${format}) from ${file.name}`
      );
      const note = describeCodeChanges(changes);
      if (note) toast.warning(note);
    } catch {
      toast.error(`Could not read ${file.name} as a waypoint file`);
    }
  }

  // Open the shared add dialog, seeding it with the tap's coordinates and
  // whatever the map knows about the point (elevation, place name, nearby peak).
  const openAdd = useCallback(
    (coords = "", details?: MapPickDetails) => {
      setSeedCoords(coords);
      setSeedDetails(details);
      setAdding(true);
      // Full screen, add mode STAYS armed: the point of maximising is to walk
      // the map dropping several points in a row, and re-arming between each
      // is the friction that makes it not worth doing. Inline it disarms, so
      // the next tap on a small map scrolls rather than places.
      setAddMode(maximised);
    },
    [maximised]
  );

  // The dialog hands back a finished record; drop it in as a new row (state +
  // grid — nothing is saved until Save). The grid scrolls to the new row so
  // it's visible even when the set is longer than the viewport.
  function addWaypoint(rec: WaypointFileRecord) {
    const row = toRow(rec);
    setRows((prev) => [...prev, row]);
    void tableRef.current?.addRow({ ...row }).then((r) => r.scrollTo());
    setAdding(false);
  }

  // Waypoints that would get an altitude from "Fill altitudes from map", and
  // the ones it CANNOT reach because their coordinates don't parse — so a
  // disabled button can say which of the two it is (an admin who had just
  // filled every altitude read the dead button as the fill having failed).
  const fillableCount = rows.filter(
    (r) => missingAltitude(r) && parseCoords(r.coords) !== null
  ).length;
  const unfillableCount = rows.filter(
    (r) => missingAltitude(r) && parseCoords(r.coords) === null
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
    // Backstop for codes typed straight into the grid: clean here rather than
    // fighting the editor keystroke by keystroke, and show the result in the
    // grid so what's saved is what's on screen.
    const { waypoints, changes } = cleanWaypointCodes(built as WaypointFileRecord[]);
    if (changes.length > 0) {
      replaceRows(waypoints.map(toRow));
      const note = describeCodeChanges(changes);
      if (note) toast.warning(note);
    }
    setSaving(true);
    try {
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
      <NotFound title="Competition not found" />
    );
  }

  const mapFallback = (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      Loading map…
    </div>
  );

  /**
   * The map. Rendered EITHER in the pane or in the full-screen sheet, never
   * both: one Mapbox instance is enough of a page weight, and two would each
   * hold their own idea of where the admin is looking.
   *
   * Which is why the camera is handed over. Mapbox's own persisted location
   * is debounced by five seconds, so a pan followed straight away by
   * Maximise would open on wherever the map was before the pan; passing the
   * live camera makes the hand-over exact in both directions.
   */
  const mapElement = (
    <Suspense fallback={mapFallback}>
      <RouteMap
        task={null}
        waypoints={mapWaypoints}
        addMode={addMode}
        fitNonce={fitNonce}
        focus={focus}
        placeSearch={isAdmin}
        initialCamera={cameraRef.current}
        onCameraChange={(camera) => {
          cameraRef.current = camera;
        }}
        onWaypointPick={() => {}}
        onMapPick={(lat, lon, details) => openAdd(formatCoords(lat, lon), details)}
      />
    </Suspense>
  );

  return (
    <main
      className={cn(
        "mx-auto w-full max-w-6xl px-4 py-6 sm:px-6",
        // Reserve the space the fixed save bar covers (see it at the foot).
        isAdmin && "pb-24"
      )}
    >
      <Breadcrumbs items={underComp(compId, compName)} current="Waypoints" />
      {/* The heading keeps the row to itself. Four buttons beside an h1 is the
          app's convention for a section with ONE manage action; here they
          wrapped under the title on a phone and read as page chrome, so the
          editing toolbar sits with the grid it edits and Save sits at the
          bottom of the page — where the work ends. */}
      <h1 className="mt-1 text-2xl font-bold">Waypoints</h1>

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
        <Loading className="text-sm">Loading waypoints…</Loading>
      ) : (
        <MasterDetail
          detailLabel="map"
          detailAriaLabel="Waypoint map"
          bleed="page"
          wideCols="@5xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
          // A map wants the whole line, not the chart pane's 35rem cap.
          paneWidthClassName="w-full"
          detail={
            <div>
              {/* Explicit heights: Mapbox renders nothing into an unsized
                  container. Stacked they fit under the pane's caps with the
                  control row; side by side the taller map is the point. */}
              <div ref={mapRef} className="h-56 sm:h-72 @5xl:h-[520px]">
                {maximised ? (
                  <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                    The map is full screen.
                  </div>
                ) : !mapInView ? (
                  mapFallback
                ) : (
                  mapElement
                )}
              </div>
              {isAdmin && maximised ? (
                // The sheet has the map AND the controls that drive it; a
                // second Add-from-map toggle behind the backdrop would be a
                // duplicate of a control the reader can already see.
                <p className="p-2 text-xs text-muted-foreground">
                  {rows.length} waypoint{rows.length === 1 ? "" : "s"}
                </p>
              ) : isAdmin ? (
                <div className="flex flex-wrap items-center gap-2 p-2">
                  <ToggleButton size="sm" isSelected={addMode} onChange={setAddMode}>
                    {addMode ? "Tap the map to place…" : "Add from map"}
                  </ToggleButton>
                  {/* Stacked on a phone the pane is capped at ~19rem, which
                      leaves the map a few centimetres to place a point in.
                      Full screen it gets the whole device, and Add from map
                      goes with it. */}
                  <Button
                    variant="outline"
                    size="sm"
                    // Contains the visible label (WCAG 2.5.3) while saying
                    // WHAT is maximised for anyone reading the button alone.
                    aria-label="Maximise map"
                    onPress={() => setMaximised(true)}
                  >
                    <Maximize2Icon className="size-4" aria-hidden="true" />
                    Maximise
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    {rows.length} waypoint{rows.length === 1 ? "" : "s"}
                    {invalidCount > 0 ? ` · ${invalidCount} need valid coordinates` : ""}
                  </span>
                </div>
              ) : (
                <p className="p-2 text-xs text-muted-foreground">{rows.length} waypoints</p>
              )}
            </div>
          }
          master={
          <div>
            {/* The editing actions, at the head of the thing they edit: they
                fill the grid (upload, add) or a column of it (altitudes), and
                on a phone this is the row directly above it rather than four
                buttons wrapped under the page title. */}
            {isAdmin ? (
              <div className="mb-2 flex flex-wrap items-center gap-2">
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
                {/* Always visible so the capability is discoverable; disabled
                    when every waypoint already has an altitude. */}
                <Button
                  variant="outline"
                  size="sm"
                  isDisabled={fillableCount === 0}
                  isPending={fillingAlts}
                  pendingLabel="Filling altitudes"
                  onPress={() => void fillAltitudes()}
                >
                  {fillableCount > 0
                    ? `Fill ${fillableCount} altitude${fillableCount === 1 ? "" : "s"} from map`
                    : "Fill altitudes from map"}
                </Button>
                {/* Why the button is dead. Filling every altitude disables the
                    button that just did it, which reads as the fill having
                    failed — so the state that means "done" has to say so. */}
                {rows.length > 0 && fillableCount === 0 && !fillingAlts ? (
                  <span className="text-xs text-muted-foreground">
                    {unfillableCount > 0
                      ? `${unfillableCount} waypoint${unfillableCount === 1 ? "" : "s"} need valid coordinates before an altitude can be filled`
                      : "Every waypoint has an altitude"}
                  </span>
                ) : null}
              </div>
            ) : null}
            {/* Filter box — narrows a long set. Drives the Tabulator grid
                (admins) and the read-only table alike; the admin grid also
                sorts on header clicks, the read-only table via its columns. */}
            {rows.length > 0 ? (
              <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                <SearchField
                  aria-label="Filter waypoints"
                  placeholder="Filter by code, name or coordinates…"
                  value={filter}
                  onChange={setFilter}
                  className="min-w-40 flex-1 sm:max-w-xs"
                />
                {query ? (
                  <span className="text-xs text-muted-foreground" aria-live="polite">
                    {visibleRows.length} of {rows.length} match
                  </span>
                ) : null}
              </div>
            ) : null}
            {isAdmin ? (
              <TabulatorGrid
                className="gc-grid h-[420px] rounded border border-border lg:h-[560px]"
                initialColumns={() => waypointGridColumns(locate)}
                initialData={() => rows}
                options={{
                  index: "id",
                  // Header-sort defaults off (the pin/remove action columns
                  // must stay unsortable); data columns opt in individually.
                  columnDefaults: { headerSort: false },
                  layout: "fitDataStretch",
                  height: "100%",
                  placeholder:
                    "No waypoints yet. Upload a file or add points from the map to get started.",
                }}
                tableRef={tableRef}
                events={{
                  cellEdited: (cell) => {
                    // Re-run the row's formatters so the locate pin picks up
                    // the new coordinate validity.
                    if (cell.getField() === "coords") cell.getRow().reformat();
                    syncFromGrid();
                  },
                  rowDeleted: syncFromGrid,
                }}
                onReady={(table) => {
                  // A remount (admin toggle, reload) starts with no filter —
                  // re-apply whatever is in the box so the grid agrees with
                  // the search field.
                  const q = filterRef.current.trim().toLowerCase();
                  if (q) table.setFilter((data: WpRow) => matchesFilter(data, q));
                }}
              />
            ) : rows.length === 0 ? (
              <p className="rounded border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                No waypoints yet.
              </p>
            ) : visibleRows.length === 0 ? (
              <p className="rounded border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                No waypoints match “{filter.trim()}”.
              </p>
            ) : (
              <Table
                aria-label="Waypoints"
                scrollLabel="Waypoints"
                sortDescriptor={sort}
                onSortChange={setSort}
              >
                <TableHeader>
                  <Column className="w-8">
                    <span className="sr-only">Show on map</span>
                  </Column>
                  <Column id="code" isRowHeader allowsSorting>
                    Code
                  </Column>
                  <Column id="name" allowsSorting>
                    Name
                  </Column>
                  <Column id="coords" allowsSorting>
                    Coordinates
                  </Column>
                  {/* Alt and Radius are plain quantities, so they read right-
                      aligned. Coordinates stays left: it is a "lat, lon"
                      pair, not a single number to compare down the column. */}
                  <Column id="altitude" className="text-right" allowsSorting>
                    Alt
                  </Column>
                  <Column id="radius" className="text-right" allowsSorting>
                    Radius
                  </Column>
                </TableHeader>
                <TableBody>
                  {visibleRows.map((r) => (
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
          }
        />
      )}

      {/* The map at full screen. Mounted only while open (the sheet's
          contract), and it holds the page's only map while it is — see
          `mapElement`. The browser Fullscreen API the Mapbox control rides on
          does not exist on iPhones, which is what the app's sheet is for. */}
      {maximised ? (
        <FullScreenSheet
          label="Waypoint map"
          onClose={() => setMaximised(false)}
          className="flex flex-col gap-2 p-2 sm:p-3"
        >
          {/* Controls on one line, the note under them: wrapped together on
              a phone they cost the map two rows instead of one. */}
          <div className="flex items-center gap-2">
            <ToggleButton size="sm" isSelected={addMode} onChange={setAddMode}>
              {addMode ? "Tap the map to place…" : "Add from map"}
            </ToggleButton>
            {/* autoFocus so a keyboard user lands on the way out rather than
                on the dialog container — Escape alone is not a discoverable
                affordance (accessibility standard §4.1). */}
            <Button
              autoFocus
              variant="outline"
              size="sm"
              className="ml-auto"
              onPress={() => setMaximised(false)}
            >
              <Minimize2Icon className="size-4" aria-hidden="true" />
              Done
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {rows.length} waypoint{rows.length === 1 ? "" : "s"} · nothing is
            saved until you press Save
          </p>
          <div className="min-h-0 w-full flex-1">{mapElement}</div>
        </FullScreenSheet>
      ) : null}

      {/* New-waypoint dialog (shared with the task route editor). `elevated`
          while the map is full screen: the dialog is opened from inside the
          sheet, and at the default z it would open behind it. */}
      <AddWaypointDialog
        open={adding}
        initialCoords={seedCoords}
        details={seedDetails}
        takenCodes={rows.map((r) => r.code)}
        elevated={maximised}
        onAdd={addWaypoint}
        onCancel={() => setAdding(false)}
      />

      {/* Save, at the end of the work rather than up beside the title — and
          sticky to the BOTTOM OF THE VIEWPORT, not the end of the document:
          the grid and the map are both taller than a phone, so a Save an
          admin has to scroll past them to reach is a Save they will not find.
          The main's pb-24 reserves the space it covers.

          Bottom chrome touching the viewport edge, so the background is
          full-bleed while the button clears the home indicator —
          `pb-gutter-safe` is the app's vocabulary for exactly that (#642),
          and `px-gutter-safe` does the same for a landscape notch. */}
      {isAdmin ? (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-background/95 backdrop-blur-sm print:hidden">
          {/* Save first, hint beside it — the /settings save-form order, and
              it leaves the bottom-RIGHT corner to the floating Preview-as
              pill, which would otherwise sit on top of the button. */}
          <div className="mx-auto flex max-w-6xl items-center gap-3 px-gutter-safe pt-3 pb-gutter-safe">
            <Button
              isDisabled={!dirty}
              isPending={saving}
              pendingLabel="Saving"
              onPress={() => void save()}
            >
              Save
            </Button>
            {/* The hint doubles as the explanation for what Save will do;
                role=status so the state change is announced. */}
            <span role="status" className="text-sm text-muted-foreground">
              {dirty && !saving ? "Unsaved changes" : ""}
            </span>
          </div>
        </div>
      ) : null}
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
    ...text("Coordinates", "coords", { minWidth: 150, cssClass: "gc-mono", headerSort: true }),
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

  // Numeric header-sort for the quantity columns, with blank altitudes/radii
  // pinned to the bottom whichever way the sort runs.
  const numberSort: Partial<ColumnDefinition> = {
    headerSort: true,
    sorter: "number",
    sorterParams: { alignEmptyValues: "bottom" },
  };

  return [
    pin,
    text("Code", "code", { minWidth: 80, frozen: true, headerSort: true }),
    text("Name", "name", { minWidth: 130, headerSort: true }),
    coords,
    text("Alt", "altitude", { width: 70, hozAlign: "right", headerHozAlign: "right", cssClass: "gc-mono", ...numberSort }),
    text("Radius", "radius", { width: 80, hozAlign: "right", headerHozAlign: "right", cssClass: "gc-mono", ...numberSort }),
    remove,
  ];
}
