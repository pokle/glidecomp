/**
 * The states every page of the route editor passes through before it can
 * show anything (#812): the task not found, still loading (the comp, the
 * task, the session, the draft), and a viewer who is not one of the
 * competition's organisers — who is sent to the task page, where the route
 * is to read (components/OrganisersOnly.tsx).
 *
 * The editor must not render until all of it has arrived: it edits a draft
 * started from the saved route, so a render with the task still loading
 * would show an organiser an empty route over one that exists.
 *
 * While it waits, the page's bar is there already, with the trail's fallback
 * names until the real ones arrive (#863), so the page does not jump when the
 * route does.
 */
import type { ReactElement } from "react";
import { NotFound } from "@/react/components/NotFound";
import { OrganisersOnly } from "@/react/components/OrganisersOnly";
import { Page, PageBar, type Crumb, type PageWidth } from "@/react/rac/page-bar";
import { Loading } from "@/react/rac/progress";
import { taskPath } from "../lib/slug";
import type { RouteEditorState } from "./use-route-editor";

/** What to render instead of the page, or null when the page can render. */
export function routeEditorGate(
  editor: RouteEditorState,
  /** The bar to wait under: the page's own title and trail. */
  bar: { title: string; trail: Crumb[]; width?: PageWidth; fill?: boolean }
): ReactElement | null {
  if (editor.notFound) return <NotFound title="Task not found" />;
  const waiting = (
    <Page
      width={bar.width}
      fill={bar.fill}
      bar={<PageBar title={bar.title} trail={bar.trail} />}
    >
      <Loading>Loading route…</Loading>
    </Page>
  );
  if (editor.loading || !editor.comp || !editor.task) return waiting;
  // The route itself is on the task page, for everyone.
  if (!editor.isAdmin) {
    return (
      <OrganisersOnly to={taskPath(editor.urlId, editor.compName, editor.taskId, editor.taskName)} />
    );
  }
  if (!editor.draftReady) return waiting;
  return null;
}
