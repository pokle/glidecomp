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
 * The editor itself is lazy INSIDE this page: it pulls Mapbox, and that has no
 * business in the chunk a pilot downloads to read a scoreboard.
 */
import { Suspense, lazy } from "react";
import { Loading } from "@/react/rac/progress";
import { useCanonicalPath } from "../lib/use-canonical-path";
import { useRouteEditor } from "../comp/use-route-editor";
import { routeEditorGate } from "../comp/RouteEditorGate";

const RouteEditor = lazy(() =>
  import("../comp/RouteEditor").then((m) => ({ default: m.RouteEditor }))
);

export function TaskRoutePage() {
  const editor = useRouteEditor();
  const { comp, task, current, routePath } = editor;

  useCanonicalPath(comp && task && current ? routePath : null);

  const gate = routeEditorGate(editor);
  if (gate) return gate;

  return (
    <Suspense fallback={<Loading>Loading the route editor…</Loading>}>
      <RouteEditor editor={editor} />
    </Suspense>
  );
}
