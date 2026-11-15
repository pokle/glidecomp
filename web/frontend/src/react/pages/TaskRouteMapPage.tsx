/**
 * The route editor's map at the size of the screen
 * (/comp/:c/task/:t/route/map) — ADMIN-ONLY and NOT SSR'd (a noindex shell in
 * functions/comp/[[path]].ts; Mapbox is browser-only anyway).
 *
 * On a phone the route page's map pane is a few centimetres tall, which is
 * too small to pick waypoints off or to place a new one in. Here the map has
 * the screen (issue #863, decision 12), as the waypoints editor's has
 * (pages/CompWaypointsMapPage.tsx): the bar, then nothing but the map, on a
 * page that does not scroll, so every drag belongs to the map.
 *
 * What it shows is the route's DRAFT (comp/route-draft.ts), the same one
 * every page of the editor edits: a waypoint tapped here is a turnpoint on
 * the list when the reader goes back, and nothing is saved until Save there.
 * So there is no Done: Back is the way out, and it keeps everything.
 */
import { useState } from "react";
import { Page, PageBar } from "@/react/rac/page-bar";
import { underTaskRoute } from "../lib/crumbs";
import { taskRouteMapPath } from "../lib/slug";
import { useCanonicalPath } from "../lib/use-canonical-path";
import { isBlankRow } from "../comp/route-draft";
import { routeEditorGate } from "../comp/RouteEditorGate";
import { RouteMapPane, useRouteGeometry } from "../comp/RouteMapPane";
import { useRouteEditor } from "../comp/use-route-editor";
import { MapPinPlusIcon, MapPinXIcon } from "lucide-react";

const TITLE = "Route map";

export function TaskRouteMapPage() {
  const editor = useRouteEditor();
  const { urlId, compName, taskId, taskName } = editor;
  const derived = useRouteGeometry(editor);
  const [addMode, setAddMode] = useState(false);
  /** Said under the map: what the last tap on it did. */
  const [note, setNote] = useState("");

  useCanonicalPath(
    editor.comp && editor.task && editor.current
      ? taskRouteMapPath(urlId, compName, taskId, taskName)
      : null
  );

  const trail = underTaskRoute(urlId, compName, taskId, taskName);
  const gate = routeEditorGate(editor, { title: TITLE, trail });
  if (gate) return gate;

  const count = editor.draft.rows.filter((r) => !isBlankRow(r)).length;

  return (
    <Page
      fill
      bar={
        <PageBar
          title={TITLE}
          trail={trail}
          actions={[
            {
              id: "new",
              icon: addMode ? MapPinXIcon : MapPinPlusIcon,
              label: addMode ? "Stop placing a waypoint" : "New waypoint from the map",
              onAction: () => setAddMode(!addMode),
            },
          ]}
        />
      }
    >
      <RouteMapPane
        editor={editor}
        mapTask={derived.mapTask}
        addMode={addMode}
        setAddMode={setAddMode}
        onNote={setNote}
        className="flex min-h-0 flex-1 flex-col overflow-hidden border-y border-border sm:rounded-xl sm:border"
      />
      <p role="status" className="shrink-0 px-gutter-safe py-2 text-sm text-muted-foreground">
        {note ||
          `${count} turnpoint${count === 1 ? "" : "s"}. Tap a waypoint to add it to the route.`}
        {editor.dirty ? " Unsaved: Save is on Route." : ""}
      </p>
    </Page>
  );
}
