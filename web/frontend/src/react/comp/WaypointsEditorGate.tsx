/**
 * The states every page of the waypoints editor passes through before it can
 * show anything (#811): the comp not found, still loading (the comp, the
 * session, the draft), and a viewer who is not one of its organisers.
 *
 * Those pages are the editor's own — one waypoint, Add waypoint, the map at
 * full size, the altitude review — so a visitor is sent to the list, which is
 * the read-only view of the same waypoints, rather than shown an editor they
 * cannot use (components/OrganisersOnly.tsx; signed out, to sign in first).
 * That matches the list itself, where a visitor's rows open nothing.
 */
import type { ReactElement } from "react";
import { NotFound } from "@/react/components/NotFound";
import { OrganisersOnly } from "@/react/components/OrganisersOnly";
import { Loading } from "@/react/rac/progress";
import { compWaypointsPath } from "../lib/slug";
import type { WaypointsEditor } from "./use-waypoints-editor";

/** What to render instead of the page, or null when the page can render. */
export function waypointsEditorGate(editor: WaypointsEditor): ReactElement | null {
  if (editor.notFound) return <NotFound title="Competition not found" />;
  if (editor.loading || editor.userLoading || !editor.comp) {
    return <Loading>Loading waypoints…</Loading>;
  }
  if (!editor.isAdmin) {
    return <OrganisersOnly to={compWaypointsPath(editor.urlId, editor.compName)} />;
  }
  if (!editor.draftReady) return <Loading>Loading waypoints…</Loading>;
  return null;
}
