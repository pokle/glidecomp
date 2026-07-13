/**
 * Competition waypoints editor (issue #312, stage 1).
 *
 * A comp's shared waypoint database, edited here once and picked from when
 * building task routes. Admins upload a file (any of the supported formats),
 * fix up details in the grid, add points from the map or pasted coordinates,
 * and save. Non-admins see a read-only list. The set is stored per-comp
 * (JSON blob) via GET/PUT /api/comp/:id/waypoints.
 *
 * The map (mapbox/leaflet) is lazy so it stays out of the SSR bundle; this
 * page is never server-rendered (the SSR function serves the SPA shell for it).
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { parseWaypointFile, type WaypointFileRecord } from "@glidecomp/engine";
import type { MapPickDetails, MapWaypoint } from "../../analysis/map-provider";
import { Button } from "@/react/ui/button";
import { Input } from "@/react/ui/input";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/react/ui/dialog";
import { api } from "../../comp/api";
import { toast } from "../lib/toast";
import { useConfirm } from "../lib/confirm";
import { useAdminView, useUser } from "../lib/user";
import { Breadcrumbs } from "../components/Breadcrumbs";
import { formatCoords, parseCoords, suggestWaypointCode } from "../comp/route-editor";
import { WaypointDeviceExport } from "../comp/WaypointDeviceExport";

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

export function CompWaypoints() {
  const { compId } = useParams<{ compId: string }>();
  const { user } = useUser();
  const confirm = useConfirm();

  const [compName, setCompName] = useState<string>("");
  const [realIsAdmin, setRealIsAdmin] = useState(false);
  const [rows, setRows] = useState<WpRow[]>([]);
  const [savedJson, setSavedJson] = useState<string>("[]");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [addMode, setAddMode] = useState(false);
  const [fitNonce, setFitNonce] = useState(0);

  // New-waypoint dialog (from map tap or the Add button).
  const [adding, setAdding] = useState(false);
  const [newCode, setNewCode] = useState("");
  const [newName, setNewName] = useState("");
  const [newCoords, setNewCoords] = useState("");
  const [newAltitude, setNewAltitude] = useState("");

  const fileRef = useRef<HTMLInputElement>(null);
  const isAdmin = useAdminView(realIsAdmin);

  useEffect(() => {
    if (!compId) return;
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
        setSavedJson(serialize(wpData.waypoints));
        setFitNonce((n) => n + 1);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [compId, user]);

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

  const update = (id: number, patch: Partial<WpRow>) =>
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const removeRow = (id: number) => setRows((prev) => prev.filter((r) => r.id !== id));

  async function loadFile(input: HTMLInputElement) {
    const file = input.files?.[0];
    input.value = "";
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
      setRows(waypoints.map(toRow));
      setFitNonce((n) => n + 1);
      toast.success(
        `Loaded ${waypoints.length} waypoint${waypoints.length === 1 ? "" : "s"} (${format}) from ${file.name}`
      );
    } catch {
      toast.error(`Could not read ${file.name} as a waypoint file`);
    }
  }

  // Everything the map can tell us about the tapped point pre-fills the
  // dialog (still fully editable): terrain elevation → altitude, nearest
  // rendered label → name, and a short code derived from that name. All
  // blank on the Leaflet fallback, which reports no details.
  const openAdd = useCallback(
    (coords = "", details?: MapPickDetails) => {
      const placeName = details?.placeName ?? "";
      setNewCode(
        placeName
          ? suggestWaypointCode(placeName, rows.map((r) => r.code))
          : ""
      );
      setNewName(placeName);
      setNewCoords(coords);
      setNewAltitude(
        details?.elevation !== undefined ? String(Math.round(details.elevation)) : ""
      );
      setAdding(true);
      setAddMode(false);
    },
    [rows]
  );

  function addWaypoint() {
    const coords = parseCoords(newCoords);
    if (!coords) {
      toast.error('Enter coordinates as "lat, lon" decimal degrees');
      return;
    }
    const code = newCode.trim() || "WP";
    setRows((prev) => [
      ...prev,
      {
        id: ++rowSeq,
        code,
        name: newName.trim(),
        coords: formatCoords(coords.lat, coords.lon),
        altitude: newAltitude.trim(),
        radius: "400",
      },
    ]);
    setAdding(false);
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
      <Breadcrumbs
        items={[
          { label: "Competitions", to: "/comp" },
          { label: compName || "Competition", to: `/comp/${compId}` },
        ]}
      />
      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="min-w-0 flex-1 text-2xl font-bold">Waypoints</h1>
        {isAdmin ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => fileRef.current?.click()}
            >
              Upload file
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".wpt,.cup,.csv,.txt,.gpx,.kml"
              hidden
              onChange={(e) => void loadFile(e.currentTarget)}
            />
            <Button type="button" variant="outline" size="sm" onClick={() => openAdd()}>
              Add waypoint
            </Button>
            <Button type="button" size="sm" disabled={saving || !dirty} onClick={() => void save()}>
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
                  onWaypointPick={() => {}}
                  onMapPick={(lat, lon, details) => openAdd(formatCoords(lat, lon), details)}
                />
              </Suspense>
            </div>
            {isAdmin ? (
              <div className="mt-2 flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={addMode ? "default" : "outline"}
                  aria-pressed={addMode}
                  onClick={() => setAddMode((a) => !a)}
                >
                  {addMode ? "Tap the map to place…" : "Add from map"}
                </Button>
                <span className="text-xs text-muted-foreground">
                  {rows.length} waypoint{rows.length === 1 ? "" : "s"}
                  {invalidCount > 0 ? ` · ${invalidCount} need valid coordinates` : ""}
                </span>
              </div>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">{rows.length} waypoints</p>
            )}
          </div>

          {/* Table */}
          <div className="order-2 min-w-0 lg:order-1">
            {rows.length === 0 ? (
              <p className="rounded border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                No waypoints yet.{" "}
                {isAdmin ? "Upload a file or add points from the map to get started." : null}
              </p>
            ) : (
              <div className="overflow-x-auto rounded border border-border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
                    <tr>
                      <th className="px-2 py-2 font-medium">Code</th>
                      <th className="px-2 py-2 font-medium">Name</th>
                      <th className="px-2 py-2 font-medium">Coordinates</th>
                      <th className="px-2 py-2 font-medium">Alt</th>
                      <th className="px-2 py-2 font-medium">Radius</th>
                      {isAdmin ? <th className="w-8" /> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const valid = parseCoords(r.coords) !== null;
                      return (
                        <tr key={r.id} className="border-t border-border">
                          {isAdmin ? (
                            <>
                              <td className="p-1">
                                <CellInput value={r.code} onChange={(v) => update(r.id, { code: v })} className="w-24" />
                              </td>
                              <td className="p-1">
                                <CellInput value={r.name} placeholder="—" onChange={(v) => update(r.id, { name: v })} className="w-40" />
                              </td>
                              <td className="p-1">
                                <CellInput
                                  value={r.coords}
                                  mono
                                  invalid={!valid}
                                  onChange={(v) => update(r.id, { coords: v })}
                                  className="w-44"
                                />
                              </td>
                              <td className="p-1">
                                <CellInput value={r.altitude} mono onChange={(v) => update(r.id, { altitude: v })} className="w-16" />
                              </td>
                              <td className="p-1">
                                <CellInput value={r.radius} mono onChange={(v) => update(r.id, { radius: v })} className="w-16" />
                              </td>
                              <td className="p-1 text-center">
                                <button
                                  type="button"
                                  className="text-muted-foreground hover:text-destructive"
                                  title="Remove"
                                  onClick={() => removeRow(r.id)}
                                >
                                  ✕
                                </button>
                              </td>
                            </>
                          ) : (
                            <>
                              <td className="px-2 py-1.5 font-medium">{r.code}</td>
                              <td className="px-2 py-1.5">{r.name || "—"}</td>
                              <td className="px-2 py-1.5 font-mono text-xs">{r.coords}</td>
                              <td className="px-2 py-1.5 font-mono text-xs">{r.altitude || "—"}</td>
                              <td className="px-2 py-1.5 font-mono text-xs">{r.radius}</td>
                            </>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* New-waypoint dialog */}
      <Dialog open={adding} onOpenChange={(o) => { if (!o) setAdding(false); }}>
        <DialogContent className="flex flex-col gap-3 sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Add waypoint</DialogTitle>
          </DialogHeader>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Code</span>
            <Input autoFocus placeholder="e.g. A01" value={newCode} onChange={(e) => setNewCode(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Name <span className="text-muted-foreground">— optional</span></span>
            <Input placeholder="e.g. Bordano Landing" value={newName} onChange={(e) => setNewName(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Coordinates (lat, lon)</span>
            <Input
              placeholder="-36.185, 147.891"
              spellCheck={false}
              value={newCoords}
              onChange={(e) => setNewCoords(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Altitude (m) <span className="text-muted-foreground">— optional</span></span>
            <Input type="number" inputMode="numeric" value={newAltitude} onChange={(e) => setNewAltitude(e.target.value)} />
          </label>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
            <Button type="button" disabled={parseCoords(newCoords) === null} onClick={addWaypoint}>
              Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}

/** Stable JSON for dirty-checking (key order fixed). */
function serialize(list: WaypointFileRecord[]): string {
  return JSON.stringify(
    list.map((w) => [w.code, w.name, w.latitude, w.longitude, w.altitude, w.radius])
  );
}

function CellInput({
  value,
  onChange,
  className,
  placeholder,
  mono,
  invalid,
}: {
  value: string;
  onChange: (v: string) => void;
  className?: string;
  placeholder?: string;
  mono?: boolean;
  invalid?: boolean;
}) {
  return (
    <input
      value={value}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => onChange(e.target.value)}
      className={`rounded border bg-background px-2 py-1 text-sm outline-none focus:border-ring ${
        mono ? "font-mono text-xs" : ""
      } ${invalid ? "border-destructive" : "border-border"} ${className ?? ""}`}
    />
  );
}
