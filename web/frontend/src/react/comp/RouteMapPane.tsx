/**
 * The route editor's map, and what a tap on it does (comp/RouteEditor.tsx).
 *
 * It is ONE map for the route page and for the map at full size (/route/map,
 * #863). The editor renders it once, in a floating detail
 * (components/FloatingWindow.tsx), which moves it between its place under the
 * list (a wide screen), its window over the page (a phone) and the full-size
 * page, and `mode` says which it is in: null under the list, the window's
 * size, or "full". The pane lays itself out for it.
 *
 * A tap on a waypoint's marker adds that waypoint to the route's DRAFT
 * (comp/route-draft.ts). With `addMode` on, a tap on bare ground opens the
 * Add waypoint page, seeded from the tap; the new point drops into the route
 * and is written to the competition only when the route is saved.
 *
 * The map library is lazy: it loads when the map's box nears the screen, and
 * never enters the server-rendered task page's bundle.
 */
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import type { WaypointFileRecord, XCTask } from "@glidecomp/engine";
import type { MapWaypoint } from "../../analysis/map-provider";
import { Button } from "@/react/rac/button";
import { cn } from "@/react/lib/utils";
import { floatDragRow, type FloatMode } from "@/react/components/FloatingWindow";
import { useInView } from "../lib/use-in-view";
import { taskRouteAddWaypointPath } from "../lib/slug";
import { newWaypointSearch } from "./AddWaypointForm";
import { floatMapClass } from "./float-map";
import { appendTurnpoint } from "./route-draft";
import { buildRoute } from "./route-editor";
import { draftFromRecord, inferAddedType } from "./turnpoint-draft";
import type { RouteEditorState } from "./use-route-editor";

const RouteMap = lazy(() => import("./RouteMap"));

/**
 * The route as parsed so far: its problems, and the task the map and the
 * list draw. Recomputed whenever the rows or the start and goal settings
 * change, so legs, directions and the map preview are read at render time.
 */
export function useRouteGeometry(editor: RouteEditorState) {
  const { draft, openDistance } = editor;
  const { rows } = draft;
  return useMemo(() => {
    const result = buildRoute(rows, { openDistance });
    const hasSSSTurnpoint = result.turnpoints.some((tp) => tp.type === "SSS");

    // The goal config shapes the preview and the distances: a LINE goal is
    // drawn as the goal line + control semicircle, and the optimised route
    // ends on the line instead of the cylinder edge. Open-distance comps
    // hide the goal panel, so carry whatever the loaded task had.
    const goal = openDistance ? draft.baseTask?.goal : { type: draft.goalType };

    // Feed the map the turnpoints parsed so far — cylinders and the optimised
    // line update live as rows are edited, added, reordered or picked.
    const mapTask: XCTask | null =
      result.turnpoints.length > 0
        ? {
            taskType: draft.baseTask?.taskType || "CLASSIC",
            version: draft.baseTask?.version ?? 1,
            turnpoints: result.turnpoints,
            // The start's direction feeds the Enter/Exit inference the
            // turnpoint listing shows, so flipping it updates the list live.
            ...(openDistance ? {} : { sss: { type: draft.sssType, direction: draft.direction } }),
            ...(goal ? { goal } : {}),
          }
        : null;

    return { result, hasSSSTurnpoint, mapTask };
  }, [rows, openDistance, draft.baseTask, draft.goalType, draft.sssType, draft.direction]);
}

export function RouteMapPane({
  editor,
  mapTask,
  addMode,
  setAddMode,
  onNote,
  mode,
  footer,
}: {
  editor: RouteEditorState;
  mapTask: XCTask | null;
  addMode: boolean;
  setAddMode: (on: boolean) => void;
  /** Said under the map: what the last tap did. */
  onNote: (note: string) => void;
  /** Where the map is (FloatingContent): null under the list, the window's
   * size, or "full". */
  mode: FloatMode | null;
  /** The full-size page's last row, under the map. */
  footer?: ReactNode;
}) {
  const navigate = useNavigate();
  const { update, urlId, compName, taskId, taskName, openDistance } = editor;
  // Mapbox waits until its box nears the screen (lib/use-in-view.ts). On a
  // phone that is the window; until it is placed there, the map's place in
  // the page is hidden, and a map made in a hidden box is made at no size.
  const [mapRef, mapInView] = useInView<HTMLDivElement>();
  /** A map the reader can work: not the small window's picture. */
  const live = mode !== "small" && mode !== "tucked";

  // Competition waypoints as map markers (index is the marker id, resolved
  // back to the record on pick so all details carry across).
  const waypointRecords = editor.waypoints;
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

  // Fit the map to the waypoints once they have arrived.
  const [fitNonce, setFitNonce] = useState(0);
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current || editor.wpLoading) return;
    fitted.current = true;
    setFitNonce((n) => n + 1);
  }, [editor.wpLoading]);

  /** Pick from the map: the nearest marker, resolved to its record by id, and
   *  appended straight to the route (a map tap is an explicit add). */
  function pickWaypoint(wp: MapWaypoint) {
    const rec: WaypointFileRecord | undefined = waypointRecords[Number(wp.id)];
    if (!rec) return;
    let place = 0;
    update((d) => {
      const added = appendTurnpoint(d, {
        ...draftFromRecord(rec),
        type: inferAddedType(d.rows, { openDistance }),
      }).draft;
      place = added.rows.length;
      return added;
    });
    onNote(`Added ${rec.code} as turnpoint ${place}.`);
  }

  const fallback = (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      Loading map…
    </div>
  );

  // Armed, the map says so under itself, with the way to stop: under, so
  // that nothing sits on the map's top right corner, which has the size
  // buttons, or its top edge, which has the window's grabber. Not on the
  // small window, which is a picture and takes no touch.
  const placing =
    addMode && live ? (
      <>
        <p role="status" className="min-w-0 flex-1 text-sm font-medium">
          Tap the map to place a new waypoint
        </p>
        <Button variant="ghost" className="h-11 px-4" onPress={() => setAddMode(false)}>
          Cancel
        </Button>
      </>
    ) : null;

  return (
    <div
      className={
        mode == null
          ? // Under the list, on a wide screen. An explicit height: Mapbox
            // renders nothing into an unsized container.
            "flex h-96 flex-col overflow-hidden rounded-xl border border-border"
          : // The window, or the page, is the frame: the map fills it.
            "flex min-h-0 flex-1 flex-col"
      }
    >
      <div
        ref={mapRef}
        className={cn("relative min-h-0 flex-1 overflow-hidden", floatMapClass(mode))}
      >
        {mode == null && !mapInView ? (
          fallback
        ) : (
          <Suspense fallback={fallback}>
            <RouteMap
              task={mapTask}
              waypoints={mapWaypoints}
              addMode={addMode}
              fitNonce={fitNonce}
              // Not on the small window's picture, which takes no input.
              placeSearch={live}
              // The map's top right corner has the size buttons.
              searchBelow
              // The same ground in view when the window changes size.
              keepView
              onWaypointPick={pickWaypoint}
              onMapPick={(lat, lon, details) => {
                // Leaving add-mode on would keep the crosshair when this page
                // comes back, so turn it off on the way out.
                setAddMode(false);
                void navigate(
                  taskRouteAddWaypointPath(
                    urlId,
                    compName,
                    taskId,
                    taskName,
                    newWaypointSearch(lat, lon, details)
                  ));
              }}
            />
          </Suspense>
        )}
      </div>
      {placing == null ? null : mode === "large" ? (
        // The window can be held by its last row, as by its grabber:
        // anywhere but the button (FloatingContent reads the mark).
        <div
          {...floatDragRow}
          className={cn(
            floatDragRow.className,
            "flex min-h-11 shrink-0 items-center gap-2 border-t border-border bg-card pr-1 pl-3"
          )}
        >
          {placing}
        </div>
      ) : (
        <div className="flex shrink-0 items-center gap-2 border-t border-border bg-card py-1 pr-1 pl-4">
          {placing}
        </div>
      )}
      {mode === "full" ? footer : null}
    </div>
  );
}
