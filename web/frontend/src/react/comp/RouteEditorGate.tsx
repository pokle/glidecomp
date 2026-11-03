/**
 * The states every page of the route editor passes through before it can
 * show anything (#812): the task not found, still loading (the comp, the
 * task, the session, the draft), and a viewer who is not one of the
 * competition's organisers — who is sent to the task page, where the route
 * is to read (components/OrganisersOnly.tsx; signed out, to sign in first).
 *
 * The editor must not render until all of it has arrived: it edits a draft
 * started from the saved route, so a render with the task still loading
 * would show an organiser an empty route over one that exists.
 */
import type { ReactElement } from "react";
import { NotFound } from "@/react/components/NotFound";
import { OrganisersOnly } from "@/react/components/OrganisersOnly";
import { Loading } from "@/react/rac/progress";
import { taskPath } from "../lib/slug";
import type { RouteEditorState } from "./use-route-editor";

/** What to render instead of the page, or null when the page can render. */
export function routeEditorGate(editor: RouteEditorState): ReactElement | null {
  if (editor.notFound) return <NotFound title="Task not found" />;
  if (editor.loading || !editor.comp || !editor.task) {
    return <Loading>Loading route…</Loading>;
  }
  // The route itself is on the task page, for everyone.
  if (!editor.isAdmin) {
    return (
      <OrganisersOnly to={taskPath(editor.urlId, editor.compName, editor.taskId, editor.taskName)} />
    );
  }
  if (!editor.draftReady) return <Loading>Loading route…</Loading>;
  return null;
}
