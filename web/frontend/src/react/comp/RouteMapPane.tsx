/**
 * The route editor's map, and what a tap on it does — shared by the route
 * page (comp/RouteEditor.tsx), where it is a pane under the list, and the map
 * at full size (pages/TaskRouteMapPage.tsx), where it has the screen (#863).
 *
 * A tap on a waypoint's marker adds that waypoint to the route's DRAFT
 * (comp/route-draft.ts). With `addMode` on, a tap on bare ground opens the
 * Add waypoint page, seeded from the tap; the new point drops into the route
 * and is written to the competition only when the route is saved.
 *
 * The map library is lazy: it loads when a page with a map opens, and never
 * enters the server-rendered task page's bundle.
 */
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { WaypointFileRecord, XCTask } from "@glidecomp/engine";
import type { MapWaypoint } from "../../analysis/map-provider";
import { Button } from "@/react/rac/button";
import { openedHere } from "../lib/leave";
import { taskRouteAddWaypointPath } from "../lib/slug";
import { newWaypointSearch } from "./AddWaypointForm";
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
  className,
}: {
  editor: RouteEditorState;
  mapTask: XCTask | null;
  addMode: boolean;
  setAddMode: (on: boolean) => void;
  /** Said under the map: what the last tap did. */
  onNote: (note: string) => void;
  className: string;
}) {
  const navigate = useNavigate();
  const { update, urlId, compName, taskId, taskName, openDistance } = editor;

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

  return (
    <div className={className}>
      {/* The mode says so above the map, in the page's flow, where it cannot
          sit on the map's own controls. */}
      {addMode ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-card py-1 pr-1 pl-4">
          <p role="status" className="min-w-0 flex-1 text-sm font-medium">
            Tap the map to place a new waypoint
          </p>
          <Button variant="ghost" className="h-11 px-4" onPress={() => setAddMode(false)}>
            Cancel
          </Button>
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Loading map…
            </div>
          }
        >
          <RouteMap
            task={mapTask}
            waypoints={mapWaypoints}
            addMode={addMode}
            fitNonce={fitNonce}
            placeSearch
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
                ),
                openedHere()
              );
            }}
          />
        </Suspense>
      </div>
    </div>
  );
}
