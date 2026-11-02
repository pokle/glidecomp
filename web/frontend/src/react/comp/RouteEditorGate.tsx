/**
 * The states every page of the route editor passes through before it can
 * show anything (#812): the task not found, still loading (the comp, the
 * task, the session, the draft), and a viewer who is not one of the
 * competition's organisers — who is told so, and where the route is to read.
 *
 * The editor must not render until all of it has arrived: it edits a draft
 * started from the saved route, so a render with the task still loading
 * would show an organiser an empty route over one that exists.
 */
import type { ReactElement } from "react";
import { NotFound } from "@/react/components/NotFound";
import { Breadcrumbs } from "@/react/rac/breadcrumbs";
import { Loading } from "@/react/rac/progress";
import { underTask } from "../lib/crumbs";
import type { RouteEditorState } from "./use-route-editor";

/** What to render instead of the page, or null when the page can render. */
export function routeEditorGate(editor: RouteEditorState): ReactElement | null {
  if (editor.notFound) return <NotFound title="Task not found" />;
  if (editor.loading || !editor.comp || !editor.task) {
    return <Loading>Loading route…</Loading>;
  }
  if (!editor.isAdmin) {
    return (
      <div>
        <Breadcrumbs
          items={underTask(editor.urlId, editor.compName, editor.taskId, editor.taskName)}
          current="Route"
        />
        <h1 className="mt-2 text-2xl font-bold">Route</h1>
        <p className="mt-2 text-muted-foreground">
          Editing a task&rsquo;s route is for the competition’s organisers. The route
          itself is on the task page, for everyone.
        </p>
      </div>
    );
  }
  if (!editor.draftReady) return <Loading>Loading route…</Loading>;
  return null;
}
