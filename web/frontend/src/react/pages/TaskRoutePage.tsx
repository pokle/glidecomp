/**
 * The task's route editor (/comp/:compId/task/:taskId/route) — ADMIN-ONLY and
 * NOT SSR'd (functions/comp/[[path]].ts serves it a noindex shell).
 *
 * A thin page around comp/RouteEditor.tsx, which was a dialog over the task
 * page until #637. The editor needs the comp (the scoring format, the
 * timezone, the admin list), the task and the route DRAFT
 * (comp/route-draft.ts) before it can show anything — it edits a draft
 * started from the saved route, so a render with the task still loading would
 * give an admin an empty editor over a route that exists. `useRouteEditor()`
 * loads all three, the same way for every page of the editor (#812).
 *
 * `view="map"` is the route's map at the size of the screen
 * (/comp/:c/task/:t/route/map, #863): on a phone the map is a small window,
 * which is too small to pick waypoints off or to place a new one in. It is
 * THIS page, rendering the same editor, so the router keeps both across the
 * two routes and the map on the full-size page is the SAME map, with its view
 * and whether it is armed to place a point (see comp/RouteEditor.tsx). It was
 * a page of its own until 28 November 2026, with a map of its own.
 *
 * The editor itself is lazy INSIDE this page: it pulls Mapbox, and that has no
 * business in the chunk a pilot downloads to read a scoreboard. Its Suspense
 * boundary is the same element on both routes, so going between them never
 * suspends or remounts it.
 */
import { Suspense, lazy } from "react";
import { Page, PageBar } from "@/react/rac/page-bar";
import { Loading } from "@/react/rac/progress";
import { underTask, underTaskRoute } from "../lib/crumbs";
import { taskRouteMapPath } from "../lib/slug";
import { useCanonicalPath } from "../lib/use-canonical-path";
import { useRouteEditor } from "../comp/use-route-editor";
import { routeEditorGate } from "../comp/RouteEditorGate";

const RouteEditor = lazy(() =>
  import("../comp/RouteEditor").then((m) => ({ default: m.RouteEditor }))
);

export function TaskRoutePage({ view = "list" }: { view?: "list" | "map" } = {}) {
  const editor = useRouteEditor();
  const { comp, task, current, routePath, urlId, compName, taskId, taskName } = editor;

  useCanonicalPath(
    comp && task && current
      ? view === "map"
        ? taskRouteMapPath(urlId, compName, taskId, taskName)
        : routePath
      : null
  );

  // The bar is there before the route is (#863), under the same title.
  const title = view === "map" ? "Route map" : "Route";
  const trail = (view === "map" ? underTaskRoute : underTask)(urlId, compName, taskId, taskName);
  const gate = routeEditorGate(editor, { title, trail });
  if (gate) return gate;

  return (
    <Suspense
      fallback={
        <Page bar={<PageBar title={title} trail={trail} />}>
          <Loading>Loading the route editor…</Loading>
        </Page>
      }
    >
      <RouteEditor editor={editor} view={view} />
    </Suspense>
  );
}
