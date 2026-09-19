/**
 * Competition waypoints editor (issue #312, stage 1).
 *
 * A comp's shared waypoint database, edited here once and picked from when
 * building task routes. Admins upload a file (any of the supported formats),
 * fix up details a waypoint at a time, add points from the map or pasted
 * coordinates, and save. The set is stored per-comp (JSON blob) via
 * GET/PUT /api/comp/:id/waypoints.
 *
 * **It is ONE list of waypoints, at every width, for everyone** —
 * comp/WaypointList.tsx, with comp/WaypointSheet.tsx behind an admin's rows
 * and the altitude review in another sheet (comp/AltitudeReviewSheet.tsx).
 * Admin and visitor differ by what a row opens, not by what the page is.
 *
 * It was a Tabulator grid for admins until 2026-09-19, and the grid was the
 * app's standard for an editable table; what settled it is that GlideComp is
 * used from a hill with a phone, and on a phone the grid scrolled sideways
 * inside a page that scrolled down, under a map pane that stuck, with its
 * frozen Code column hiding whichever column sat beside it. See the
 * mobile-first rule in CLAUDE.md. A visitor's six-column RAC Table went the
 * same way and for the same reason, a little later: it sat in its own
 * sideways-scrolling region, so the shape the editor had stopped using
 * survived for the PILOT, who is the one actually on the hill.
 *
 * React `rows` state is the single source of truth for the map markers, the
 * dirty check and the save; every edit goes through `updateRow`/`deleteRow`,
 * so nothing has a second copy to keep in step.
 *
 * The read-only content (heading, list, download links) is server-rendered
 * via loadCompWaypoints so the page has real content for crawlers; the map
 * (mapbox) stays client-only — the server streams its "Loading map…"
 * fallback.
 *
 * List and map are laid out by the shared {@link MasterDetail}: the map is
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
import { FileTrigger } from "react-aria-components";
import { Maximize2Icon, Minimize2Icon } from "lucide-react";
import {
  cleanWaypointCodes,
  describeCodeChanges,
  parseWaypointFile,
  type WaypointFileRecord,
} from "@glidecomp/engine";
import type { MapCamera, MapPickDetails, MapWaypoint } from "../../analysis/map-provider";
import { Button, ToggleButton } from "@/react/rac/button";
import { FullScreenSheet } from "@/react/rac/full-screen-sheet";
import { MasterDetail } from "@/react/components/MasterDetail";
import { Loading } from "@/react/rac/progress";
import { SearchField } from "@/react/rac/field";
import { api } from "../../comp/api";
import { toast } from "../lib/toast";
import { useConfirm } from "../lib/confirm";
import { useUnsavedChangesGuard } from "../lib/use-unsaved-changes-guard";
import { useAdminView, useUser } from "../lib/user";
import { Breadcrumbs } from "@/react/rac/breadcrumbs";
import { underComp } from "../lib/crumbs";
import { idFromSegment, compWaypointsPath } from "../lib/slug";
import { useCanonicalPath } from "../lib/use-canonical-path";
import { fetchWithRetry, type CompDetailData } from "../comp/types";
import { formatCoords, parseCoords } from "../comp/route-editor";
import { feetToMetres } from "../comp/altitude-check";
import { AddWaypointDialog } from "../comp/AddWaypointDialog";
import { AltitudeReviewSheet } from "../comp/AltitudeReviewSheet";
import { WaypointList } from "../comp/WaypointList";
import { WaypointSheet } from "../comp/WaypointSheet";
import { WaypointDeviceExport } from "../comp/WaypointDeviceExport";
import { CompSectionNav } from "../comp/CompSectionNav";
import { useInitialData } from "../lib/initial-data";
import { cn } from "@/react/lib/utils";
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
    // An altitude of 0 is a waypoint at sea level and prints as "0"; only an
    // absent one is blank (see WaypointFileRecord.altitude). A 0 that is WRONG
    // is a wrong altitude for "Check altitudes" to report, never a missing one
    // for anything to overwrite unasked.
    altitude: w.altitude === undefined ? "" : String(w.altitude),
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
  const known = r.altitude.trim() !== "" && Number.isFinite(alt);
  return {
    code,
    name: r.name.trim() || code,
    latitude: coords.lat,
    longitude: coords.lon,
    // Left off entirely when the cell is blank: the set then records that it
    // does not know this altitude, instead of asserting sea level. A typed 0
    // IS sea level and is kept.
    ...(known ? { altitude: Math.round(alt) } : {}),
    radius: Number.isFinite(radius) && radius > 0 ? Math.round(radius) : 400,
  };
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

/** A row's own altitude in metres, or undefined when the cell is blank. */
function rowAltitude(r: WpRow): number | undefined {
  const n = Number(r.altitude);
  return r.altitude.trim() !== "" && Number.isFinite(n) ? n : undefined;
}

export function CompWaypoints() {
  const { compId: compParam } = useParams<{ compId: string }>();
  const compId = idFromSegment(compParam ?? "");
  const { user } = useUser();
  const confirm = useConfirm();

  // SSR seed (null on client boot / SPA navigations, where the effect below
  // fetches instead). Seeding the same states the fetch would set makes the
  // first client render match the server markup exactly.
  const initial = useInitialData<CompWaypointsLoaderData>();
  const [compName, setCompName] = useState<string>(initial?.comp.name ?? "");
  // Settle the address bar on the canonical `${slug}-${id}` once the name loads.
  useCanonicalPath(compName ? compWaypointsPath(compId, compName) : null);
  const [realIsAdmin, setRealIsAdmin] = useState(!!initial?.comp.is_admin);
  const [taskCount, setTaskCount] = useState<number | undefined>(
    initial?.comp.tasks?.length
  );
  const [waypointCount, setWaypointCount] = useState<number | undefined>(
    initial?.comp.waypoint_count ?? (initial ? initial.waypoints.length : undefined)
  );
  const [pilotCount, setPilotCount] = useState<number | undefined>(
    initial?.comp.pilot_count
  );
  const [scoringFormat, setScoringFormat] = useState<
    CompDetailData["scoring_format"] | undefined
  >(initial?.comp.scoring_format);
  const [rows, setRows] = useState<WpRow[]>(() =>
    initial ? initial.waypoints.map(toRow) : []
  );
  const [savedJson, setSavedJson] = useState<string>(() =>
    initial ? baselineJson(initial.waypoints) : "[]"
  );
  // What the SERVER holds, verbatim — the set a pilot's download, hosted file
  // or QR would actually contain. Kept beside `savedJson` (the normalised
  // dirty baseline) rather than derived from it, so the device panel offers
  // exactly the bytes the hosted endpoint serialises.
  const [savedRecords, setSavedRecords] = useState<WaypointFileRecord[]>(
    () => initial?.waypoints ?? []
  );
  const [loading, setLoading] = useState(!initial);
  const [saving, setSaving] = useState(false);
  // The altitude review (see checkAltitudes), which is a SHEET rather than
  // columns in the grid — see comp/AltitudeReviewSheet.tsx for why.
  const [checkingAlts, setCheckingAlts] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  /**
   * The terrain elevation under each waypoint, in metres, keyed by row id.
   *
   * Beside the rows rather than on them: it is not part of a waypoint, it is
   * never saved, and keeping it out of the row means the grid needs no column
   * for it and a row edit cannot lose it. A reading is dropped when the
   * row's coordinates change, because it belonged to where the waypoint was.
   */
  const [mapAltById, setMapAltById] = useState<Map<number, number>>(() => new Map());
  /** The waypoint open in the phone editor's sheet, if any. */
  const [editingId, setEditingId] = useState<number | null>(null);
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

  // The filter box, which narrows a long list. Nothing re-orders the list:
  // the file's own order is the order, for a visitor as for an organiser. The
  // read-only table's sortable columns went with the table — a sort control
  // over the list can come back if anyone misses them.
  const [filter, setFilter] = useState("");
  const filterRef = useRef(filter);
  filterRef.current = filter;

  const isAdmin = useAdminView(realIsAdmin);

  // rowsRef always holds the latest rows, so async work (the altitude
  // check) applies its results against whatever is on screen by the time it
  // finishes rather than against the rows it started with.
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
        const comp = (await compRes.json()) as unknown as CompDetailData & {
          is_admin?: boolean;
        };
        setCompName(comp.name ?? "");
        setRealIsAdmin(!!comp.is_admin);
        setTaskCount(comp.tasks?.length);
        setWaypointCount(comp.waypoint_count);
        setPilotCount(comp.pilot_count);
        setScoringFormat(comp.scoring_format);
        const wpData = wpRes.ok
          ? ((await wpRes.json()) as unknown as { waypoints: WaypointFileRecord[] })
          : { waypoints: [] };
        setRows(wpData.waypoints.map(toRow));
        setSavedJson(baselineJson(wpData.waypoints));
        setSavedRecords(wpData.waypoints);
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

  /**
   * Change one row. Every edit comes through here — the waypoint sheet, the
   * review's accept, the review's own fields — so `rows` stays the only copy
   * of the set.
   */
  const updateRow = useCallback((id: number, patch: Partial<WpRow>) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }, []);

  /**
   * Forget a row's terrain reading. It belonged to where the waypoint was, so
   * moving the waypoint makes it an answer to a question nobody asked — and a
   * stale one sitting beside a corrected coordinate is exactly the kind of
   * number this whole feature exists to stop presenting.
   */
  const forgetReading = useCallback((id: number) => {
    setMapAltById((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  /** Remove one row, and the reading that belonged to it. */
  const deleteRow = useCallback(
    (id: number) => {
      setRows((prev) => prev.filter((r) => r.id !== id));
      forgetReading(id);
    },
    [forgetReading]
  );

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

  // The rows on screen: everything, or whatever the filter box matches.
  const query = filter.trim().toLowerCase();
  const visibleRows = useMemo(
    () => (query ? rows.filter((r) => matchesFilter(r, query)) : rows),
    [rows, query]
  );

  /** The row the phone editor's sheet is open on, if it still exists. */
  const editingRow = editingId === null ? null : rows.find((r) => r.id === editingId) ?? null;

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
    setFitNonce((n) => n + 1);
    // Whatever the review was about is gone, and so is every reading.
    setReviewing(false);
    setMapAltById(new Map());
    setEditingId(null);
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
    setRows((prev) => [...prev, toRow(rec)]);
    setAdding(false);
  }

  /**
   * Compare EVERY waypoint's altitude with the terrain under it, then put the
   * grid into review mode rather than changing anything.
   *
   * This is the other half of "Fill altitudes from map": that one answers a
   * blank and cannot be wrong, this one questions a value that is already
   * there and therefore must not apply itself. The grid is where the review
   * happens — it already has the map, the locate pin, the filter box and an
   * editable altitude cell, so a reader who finds a wrong COORDINATE (the
   * usual cause of a big disagreement) can fix the actual fault in place
   * instead of accepting a number that would hide it.
   */
  async function checkAltitudes() {
    const targets = rows.flatMap((r) => {
      const c = parseCoords(r.coords);
      return c ? [{ id: r.id, lat: c.lat, lon: c.lon }] : [];
    });
    if (targets.length === 0) {
      toast.error("No waypoints have valid coordinates to check");
      return;
    }
    setCheckingAlts(true);
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
      // Keyed by row id, so it survives whatever the grid did to its rows
      // while the tiles were downloading. The check writes NO altitude: it
      // only records what the terrain said, and the sheet presents the two
      // side by side.
      setMapAltById(byId);
      setReviewing(true);
    } catch {
      toast.error("Could not read terrain elevations from Mapbox");
    } finally {
      setCheckingAlts(false);
    }
  }

  /**
   * Take the map's altitude for these rows. Nothing is saved until Save, so
   * this is an ordinary unsaved edit — which is also the undo: the page's
   * guard offers to discard on the way out.
   */
  function acceptMapAltitudes(ids: number[]) {
    const accepted = ids.filter((id) => mapAltById.has(id));
    if (accepted.length === 0) return;
    const byId = new Set(accepted);
    setRows((prev) =>
      prev.map((r) =>
        byId.has(r.id) ? { ...r, altitude: String(mapAltById.get(r.id)) } : r
      )
    );
    toast.success(
      `Took the map altitude for ${accepted.length} waypoint${accepted.length === 1 ? "" : "s"}` +
        " · nothing is saved until you press Save"
    );
  }

  /**
   * The whole-file fix for a set of feet read as metres: one conversion rather
   * than the same decision taken 187 times. Only altitudes that exist are
   * touched, and a blank stays blank.
   */
  function convertAltitudesFromFeet() {
    const converted: WpRow[] = [];
    const next = rowsRef.current.map((r) => {
      const alt = Number(r.altitude);
      if (r.altitude.trim() === "" || !Number.isFinite(alt)) return r;
      const row = { ...r, altitude: String(feetToMetres(alt)) };
      converted.push(row);
      return row;
    });
    if (converted.length === 0) return;
    setRows(next);
    toast.success(
      `Converted ${converted.length} altitude${converted.length === 1 ? "" : "s"} from feet to metres` +
        " · nothing is saved until you press Save"
    );
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
      setSavedRecords(waypoints);
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

      <CompSectionNav
        compId={compId}
        compName={compName}
        taskCount={taskCount}
        waypointCount={waypointCount}
        pilotCount={pilotCount}
        scoringFormat={scoringFormat}
        isAdmin={isAdmin}
      />

      <p className="mb-4 mt-4 text-sm text-muted-foreground">
        The shared waypoints for this competition. Tasks pick their turnpoints
        from this set.{" "}
        {isAdmin
          ? "Upload a file (OziExplorer, SeeYou, CompeGPS, FS, GPX, KML or CSV), edit details, or add points from the map."
          : null}
      </p>

      {/* Pilot download + QR (issue #312 stage 2) — visible to everyone, and
          keyed off the SAVED set rather than the editor's rows. A comp with
          nothing published yet has nothing to put on a device, and the
          scorer setting one up for the first time has one job: upload a file
          or add points from the map. It used to appear the moment a file was
          parsed, offering hosted links to a set the server did not have. */}
      {!loading && savedRecords.length > 0 ? (
        <div className="mb-6">
          <WaypointDeviceExport
            records={savedRecords}
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
          defaultMasterShare={0.5}
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
                {/* ONE altitude action, and it reports nothing until it is
                    pressed. There used to be a "Fill altitudes from map"
                    beside it — an action that answered blanks without asking —
                    and a status line saying whether any blanks were left. The
                    check does the fill's job better (it shows what it would
                    write before writing it), and the status line was a verdict
                    on a set nobody had asked about yet: standing clutter on
                    the page for a question that had not been put. */}
                <Button
                  variant="outline"
                  size="sm"
                  isDisabled={rows.length === 0 || reviewing}
                  isPending={checkingAlts}
                  pendingLabel="Checking altitudes"
                  onPress={() => void checkAltitudes()}
                >
                  Check altitudes
                </Button>
              </div>
            ) : null}
            {/* Filter box — narrows a long set, for an admin and a visitor
                alike. Nothing re-orders: the file's own order is the order. */}
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
            {/* One list, at every width, for everyone. An admin's rows open
                the editing sheet; a visitor's do not, and that is the only
                difference (see WaypointList). The six-column RAC Table this
                replaced sat in a sideways-scrolling region, which handed the
                pilot on the hill exactly the shape the editor had just
                stopped using. */}
            <WaypointList
              rows={visibleRows}
              emptyMessage={
                rows.length > 0 && query
                  ? `No waypoints match “${filter.trim()}”.`
                  : undefined
              }
              onOpen={isAdmin ? setEditingId : undefined}
              onLocate={locate}
            />
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

      {/* The altitude review, at every width — see AltitudeReviewSheet for
          why it is a sheet rather than columns in the grid. Mounted only
          while open, which is the sheet's contract, and the page (with its
          unsaved rows) stays mounted behind it. */}
      {isAdmin && reviewing ? (
        <AltitudeReviewSheet
          entries={rows.map((r) => ({
            id: r.id,
            code: r.code,
            name: r.name,
            coords: r.coords,
            fileAlt: rowAltitude(r),
            mapAlt: mapAltById.get(r.id),
          }))}
          onAccept={acceptMapAltitudes}
          onEditAltitude={(id, altitude) =>
            updateRow(id, { altitude: altitude === undefined ? "" : String(Math.round(altitude)) })
          }
          onEditCoords={(id, coords) => {
            updateRow(id, { coords });
            forgetReading(id);
          }}
          onConvertFromFeet={convertAltitudesFromFeet}
          onClose={() => setReviewing(false)}
        />
      ) : null}

      {/* The phone editor's one-waypoint sheet. Draft applied on the way out,
          like the route editor's turnpoint sheet. */}
      {isAdmin && editingRow ? (
        <WaypointSheet
          initial={{
            code: editingRow.code,
            name: editingRow.name,
            coords: editingRow.coords,
            altitude: editingRow.altitude,
            radius: editingRow.radius,
          }}
          onDone={(draft) => {
            const id = editingRow.id;
            setEditingId(null);
            if (draft.coords !== editingRow.coords) forgetReading(id);
            updateRow(id, draft);
          }}
          onRemove={() => {
            const id = editingRow.id;
            setEditingId(null);
            deleteRow(id);
          }}
        />
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
