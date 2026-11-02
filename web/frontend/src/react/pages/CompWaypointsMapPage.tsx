/**
 * The comp's waypoints on a map the size of the screen
 * (/comp/:compId/waypoints/map) — ADMIN-ONLY and NOT SSR'd (a noindex shell
 * in functions/comp/[[path]].ts; Mapbox is browser-only anyway).
 *
 * On a phone the waypoints page's map pane is a few centimetres tall, which
 * is too small to place a point in. Here the map gets the screen, and Add from
 * map comes with it: enough room to walk a valley dropping points one after
 * another. It was a full-screen sheet over the list until #811, and is a page
 * for the reason every overlay became one (the overlays rule in CLAUDE.md).
 * The browser Fullscreen API that Mapbox's own control rides on does not
 * exist on iPhones.
 *
 * What it shows is the waypoints DRAFT (comp/waypoints-draft.ts), so a point
 * added here is on the list when the reader goes back to it, and nothing is
 * saved until Save there.
 *
 * Add from map STAYS armed after each point — the point of the big map is to
 * place several in a row, and re-arming between each is the friction that
 * makes it not worth doing. Armed is `?add=1` in the URL, so coming back from
 * Add waypoint finds it still armed. The view is handed between this map and
 * the list's (`waypointCameras`), so neither opens on the globe.
 */
import { lazy, Suspense } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { Minimize2Icon } from "lucide-react";
import type { MapWaypoint } from "../../analysis/map-provider";
import { Breadcrumbs } from "@/react/rac/breadcrumbs";
import { Button, ToggleButton } from "@/react/rac/button";
import { underCompWaypoints } from "../lib/crumbs";
import { compWaypointsMapPath, compWaypointsNewPath, compWaypointsPath } from "../lib/slug";
import { useCanonicalPath } from "../lib/use-canonical-path";
import { parseCoords } from "../comp/route-editor";
import { newWaypointSearch } from "../comp/AddWaypointForm";
import {
  FROM_WAYPOINTS,
  FROM_WAYPOINTS_MAP,
  useWaypointsEditor,
  waypointCameras,
} from "../comp/use-waypoints-editor";
import { waypointsEditorGate } from "../comp/WaypointsEditorGate";

const RouteMap = lazy(() => import("../comp/RouteMap"));

export function CompWaypointsMapPage() {
  const editor = useWaypointsEditor();
  const { urlId, compName, bareId } = editor;
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const addMode = searchParams.get("add") === "1";

  useCanonicalPath(compName ? compWaypointsMapPath(urlId, compName) : null);

  const gate = waypointsEditorGate(editor);
  if (gate) return gate;

  const rows = editor.draft.rows;
  const mapWaypoints: MapWaypoint[] = rows.flatMap((r) => {
    const c = parseCoords(r.coords);
    return c
      ? [{ id: String(r.id), code: r.code || "?", name: r.name || r.code || "?", lat: c.lat, lon: c.lon }]
      : [];
  });

  const mapFallback = (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      Loading map…
    </div>
  );

  return (
    <div>
      <Breadcrumbs items={underCompWaypoints(urlId, compName)} current="Waypoint map" />
      {/* Controls on one line, the note under them: wrapped together on a
          phone they cost the map two rows instead of one. */}
      <div className="mt-2 flex items-center gap-2">
        <ToggleButton
          size="sm"
          isSelected={addMode}
          onChange={(on) =>
            setSearchParams(on ? { add: "1" } : {}, { replace: true, state: location.state })
          }
        >
          {addMode ? "Tap the map to place…" : "Add from map"}
        </ToggleButton>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          onPress={() => editor.leave(compWaypointsPath(urlId, compName), FROM_WAYPOINTS)}
        >
          <Minimize2Icon className="size-4" aria-hidden="true" />
          Done
        </Button>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {rows.length} waypoint{rows.length === 1 ? "" : "s"} · nothing is saved until you press
        Save
      </p>
      {/* An explicit height: Mapbox renders nothing into an unsized
          container. The screen, less the header and the two lines above. */}
      <section aria-label="Waypoint map" className="mt-2 h-[calc(100dvh-13rem)] min-h-80 w-full">
        <Suspense fallback={mapFallback}>
          <RouteMap
            task={null}
            waypoints={mapWaypoints}
            addMode={addMode}
            fitNonce={0}
            placeSearch
            initialCamera={waypointCameras.get(bareId) ?? null}
            onCameraChange={(camera) => waypointCameras.set(bareId, camera)}
            onWaypointPick={() => {}}
            onMapPick={(lat, lon, details) =>
              navigate(compWaypointsNewPath(urlId, compName, newWaypointSearch(lat, lon, details)), {
                state: { [FROM_WAYPOINTS_MAP]: true },
              })
            }
          />
        </Suspense>
      </section>
    </div>
  );
}
