/**
 * Adding a competition waypoint from the route editor's map
 * (/comp/:c/task/:t/route/add-waypoint) — ADMIN-ONLY and NOT SSR'd (a noindex
 * shell in functions/comp/[[path]].ts).
 *
 * Reached by a tap on the route's map with Add from map armed. The tap and
 * what the map said about it ride in the URL (`?at=…&pick=…`,
 * comp/AddWaypointForm.tsx), so a reload comes back to the same point. It was
 * a dialog over the route editor until #812 (the overlays rule in CLAUDE.md
 * makes anything with fields a page); its fields are the ones the waypoints
 * editor's Add waypoint shows (pages/CompWaypointNewPage.tsx), from the same
 * component, so the two cannot fork.
 *
 * A kit form: coordinates that do not parse are refused under their field.
 * Add puts the waypoint into the route's DRAFT (comp/route-draft.ts) as the
 * next turnpoint, and holds it there for the competition: it is written to the
 * competition's waypoints only when the route is saved, so throwing the route
 * away throws it away too. Back is Cancel, and so is the Cancel button.
 */
import { useSearchParams } from "react-router-dom";
import { Loading } from "@/react/rac/progress";
import { underTaskRoute } from "../lib/crumbs";
import { taskRouteAddWaypointPath } from "../lib/slug";
import { useCanonicalPath } from "../lib/use-canonical-path";
import { NewWaypointPage, readNewWaypointSeed } from "../comp/AddWaypointForm";
import { addNewWaypoint } from "../comp/route-draft";
import { useRouteEditor } from "../comp/use-route-editor";
import { routeEditorGate } from "../comp/RouteEditorGate";

export function TaskRouteAddWaypointPage() {
  const editor = useRouteEditor();
  const [searchParams] = useSearchParams();
  const { urlId, compName, taskId, taskName, openDistance } = editor;
  useCanonicalPath(
    editor.comp && editor.task && editor.current
      ? taskRouteAddWaypointPath(urlId, compName, taskId, taskName)
      : null
  );
  const gate = routeEditorGate(editor);
  if (gate) return gate;
  // Wait for the waypoints, so the code it suggests is unique among them.
  if (editor.wpLoading) return <Loading>Loading waypoints…</Loading>;
  return (
    <NewWaypointPage
      crumbs={underTaskRoute(urlId, compName, taskId, taskName)}
      seed={readNewWaypointSeed(searchParams)}
      codes={() => editor.waypoints.map((w) => w.code)}
      onAdd={(record) => {
        // Nothing to send: the waypoint joins the route's draft, and the
        // competition's waypoints when the route is saved.
        editor.update((d) => addNewWaypoint(d, record, { openDistance }));
        return `Added ${record.code} to the route. Save to keep it.`;
      }}
      onLeave={() => editor.leave()}
    />
  );
}
