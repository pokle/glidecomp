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
 * The page is the bar and the map (issue #863): `<Page fill>`, so the page
 * does not scroll and every drag belongs to the map. Add from map is the
 * bar's one action, under ⋯, and the bar's Back is the way out — there is no
 * Done, which did the same thing.
 *
 * Add from map STAYS armed after each point — the point of the big map is to
 * place several in a row, and re-arming between each is the friction that
 * makes it not worth doing. Armed is `?add=1` in the URL, so coming back from
 * Add waypoint finds it still armed. The view is handed between this map and
 * the list's (`waypointCameras`), so neither opens on the globe.
 */
import { lazy, Suspense } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import type { MapWaypoint } from "../../analysis/map-provider";
import { Button } from "@/react/rac/button";
import { Page, PageBar } from "@/react/rac/page-bar";
import { underCompWaypoints } from "../lib/crumbs";
import { compWaypointsMapPath, compWaypointsNewPath } from "../lib/slug";
import { useCanonicalPath } from "../lib/use-canonical-path";
import { parseCoords } from "../comp/route-editor";
import { newWaypointSearch } from "../comp/AddWaypointForm";
import {
  useWaypointsEditor,
  waypointCameras,
} from "../comp/use-waypoints-editor";
import { openedHere } from "../lib/leave";
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

  const trail = underCompWaypoints(urlId, compName);
  const gate = waypointsEditorGate(editor, { title: "Waypoint map", trail });
  if (gate) return gate;

  /** Armed is in the URL, so coming back from Add waypoint finds it armed. */
  const setAddMode = (on: boolean) =>
    setSearchParams(on ? { add: "1" } : {}, { replace: true, state: location.state });

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
    <Page
      fill
      bar={
        <PageBar
          title="Waypoint map"
          trail={trail}
          actions={[
            {
              id: "add-from-map",
              label: addMode ? "Stop adding from map" : "Add from map",
              onAction: () => setAddMode(!addMode),
            },
          ]}
        />
      }
    >
      {/* The mode says so above the map, in the page's flow, where it cannot
          sit on the map's own controls. */}
      {addMode ? (
        <div className="flex shrink-0 items-center gap-2 border-t border-border bg-card py-1 pr-1 pl-4">
          <p role="status" className="min-w-0 flex-1 text-sm font-medium">
            Tap the map to place…
          </p>
          <Button variant="ghost" className="h-11 px-4" onPress={() => setAddMode(false)}>
            Stop
          </Button>
        </div>
      ) : null}
      {/* The rest of the screen: Mapbox renders nothing into an unsized
          container, and `min-h-0 flex-1` inside the fill page is a size. */}
      <section
        aria-label="Waypoint map"
        className="min-h-0 w-full flex-1 overflow-hidden border-y border-border sm:rounded-xl sm:border"
      >
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
              navigate(
                compWaypointsNewPath(urlId, compName, newWaypointSearch(lat, lon, details)),
                openedHere()
              )
            }
          />
        </Suspense>
      </section>
      <p className="shrink-0 px-gutter-safe py-2 text-xs text-muted-foreground">
        {rows.length} waypoint{rows.length === 1 ? "" : "s"} · nothing is saved until you press
        Save
      </p>
    </Page>
  );
}
