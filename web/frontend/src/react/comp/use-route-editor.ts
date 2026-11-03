/**
 * What every page of the task route editor shares (#812): the competition,
 * the task, the competition's waypoints to pick turnpoints from, and the
 * DRAFT of the route being edited (comp/route-draft.ts) — read from this
 * tab's storage when the page mounts, and written straight back on every
 * change, so the route, a turnpoint's page, Quick entry, Load from XContest
 * and Add waypoint all edit the same route and none is handed it by another.
 *
 * The same shape as the waypoints editor's `useWaypointsEditor()` (#811). All
 * of these pages are admin-only noindex shells, and fetch what they show; the
 * draft is still read only once the page has mounted, like every draft.
 *
 * ## Leaving
 *
 * Going between the editor's own pages is not leaving it: nothing asks, and
 * the draft is simply there on the other side. Leaving the editor by a link
 * with unsaved edits asks "Discard route changes?" — "Discard changes" then
 * forgets the draft, "Keep editing" stays. Back is left to the browser (the
 * overlays rule in CLAUDE.md) and means "not now": the draft stays, and
 * opening the route again finds it. A reload finds it too.
 */
import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import type { WaypointFileRecord, XCTask } from "@glidecomp/engine";
import { api } from "../../comp/api";
import { useConfirm } from "../lib/confirm";
import { bareCompId, compUrlId, idFromSegment, taskRoutePath } from "../lib/slug";
import { toast } from "../lib/toast";
import { useDraftEditor } from "../lib/draft-editor";
import { useLeave } from "../lib/leave";
import { useMounted } from "../lib/use-mounted";
import { useTaskAdminPage } from "../lib/use-task-admin-page";
import { useUser } from "../lib/user";
import { utcToZonedHHMM, zonedToUtcHHMM, zoneNameWithOffset } from "../lib/time";
import { fetchWithRetry, type CompDetailData, type TaskDetailData } from "./types";
import {
  freshDraft,
  hasTurnpoints,
  loadTask,
  routeDraft,
  routeModel,
  type RouteDraft,
  type RouteDraftContext,
} from "./route-draft";

/** The question asked before the route editor is left with unsaved edits. */
export const ROUTE_DISCARD = {
  title: "Discard route changes?",
  message: "This route has unsaved changes. Leaving will discard them.",
};

/**
 * Set by "Add turnpoint" on the turnpoint page it opens: the Type the new
 * turnpoint started as. That page is then "Add turnpoint", and shows the goal
 * settings by what is being added rather than by where the row sits.
 */
export const ADDING_TYPE = "addingType";

export interface RouteEditorState {
  /** The comp's id as the URL carries it (share key and all). */
  compId: string;
  /** The comp's bare id: half of the draft's key. */
  bareId: string;
  taskId: string;
  comp: CompDetailData | null;
  task: TaskDetailData | null;
  /** The comp id this viewer's URLs carry, once the comp is known. */
  urlId: string;
  compName: string;
  taskName: string;
  /** The route editor itself, in canonical form. */
  routePath: string;
  loading: boolean;
  notFound: boolean;
  /** Both resources are the ones the URL names now (for useCanonicalPath). */
  current: boolean;
  isAdmin: boolean;
  /**
   * The organiser's draft has been read from storage (or found absent). Until
   * then `draft` is the saved route, and a page addressing a row that exists
   * only in the draft must wait rather than call it missing.
   */
  draftReady: boolean;
  /** Open distance: one Takeoff, no speed section, no goal. */
  openDistance: boolean;
  /** The comp's own zone, or null (the editor then works in UTC). */
  tz: string | null;
  /** What gate and deadline times are typed in, e.g. "Australia/Sydney (UTC+11)". */
  timeZoneLabel: string;
  ctx: RouteDraftContext;
  toUtcTime: (hhmm: string) => string;
  /**
   * The competition's waypoints, to pick turnpoints from: the saved ones and
   * the ones made here, waiting for Save.
   */
  waypoints: WaypointFileRecord[];
  /** The saved waypoints, verbatim. */
  savedWaypoints: WaypointFileRecord[];
  wpLoading: boolean;
  /**
   * The competition's waypoints did not load, after retries. Not "none":
   * Save writes the saved ones back with any made here, so it must not run
   * on a list that only failed to arrive.
   */
  wpError: boolean;
  /** The editor's working copy: the stored draft, or the saved route. */
  draft: RouteDraft;
  /** The working copy differs from the saved route. */
  dirty: boolean;
  /** The saved route changed after this draft was started (see resolveStoredDraft). */
  serverChanged: boolean;
  /** The browser is not storing the draft: a reload will lose it. */
  notKept: boolean;
  /** Change the draft; the change is in storage before this returns. */
  update: (change: (d: RouteDraft) => RouteDraft) => void;
  /** Forget the draft: back to the saved route. */
  discard: () => void;
  /**
   * The route is saved: forget the stored draft, leaving this page as it is
   * on screen until it has gone (it navigates away next).
   */
  markSaved: () => void;
  /** Waypoints just written to the competition (before the route itself). */
  addSavedWaypoints: (records: WaypointFileRecord[]) => void;
  /** A save is in flight (the kit form's `onPendingChange`). */
  setSaving: (saving: boolean) => void;
  /**
   * Leave this page for the route: a real Back when a page of the editor
   * opened it, else replace it with the route (lib/leave.ts).
   */
  leave: () => void;
}

/** Whether `url` is a page of this task's route editor. */
function inEditor(url: URL, bareId: string, taskId: string): boolean {
  const m = url.pathname.match(/^\/comp\/([^/]+)\/task\/([^/]+)\/route(?:\/|$)/);
  return (
    !!m &&
    bareCompId(idFromSegment(m[1])) === bareId &&
    idFromSegment(m[2]) === taskId
  );
}

export function useRouteEditor(): RouteEditorState {
  const { compId: compParam, taskId: taskParam } = useParams<{
    compId: string;
    taskId: string;
  }>();
  const compId = idFromSegment(compParam ?? "");
  const taskId = idFromSegment(taskParam ?? "");
  const bareId = bareCompId(compId);
  const { user } = useUser();
  const leave = useLeave();
  const mounted = useMounted();

  const { comp, task, isAdmin, notFound, loading, current } = useTaskAdminPage({
    compId,
    taskId,
    title: (t) => `GlideComp - ${t.name} route`,
  });

  // The competition's waypoints: turnpoints are picked from these (the task
  // copies each one's details in, so editing a waypoint later never changes a
  // task set from it).
  const [savedWaypoints, setSavedWaypoints] = useState<WaypointFileRecord[]>([]);
  const [wpLoading, setWpLoading] = useState(true);
  const [wpError, setWpError] = useState(false);
  useEffect(() => {
    if (!compId) return;
    let cancelled = false;
    setWpError(false);
    void (async () => {
      try {
        const res = await fetchWithRetry(() =>
          api.api.comp[":comp_id"].waypoints.$get({ param: { comp_id: compId } })
        );
        if (cancelled) return;
        // A failure to ask is not an answer (#481): not "no waypoints".
        if (!res.ok) {
          setWpError(true);
          return;
        }
        const data = (await res.json()) as unknown as { waypoints: WaypointFileRecord[] };
        if (!cancelled) setSavedWaypoints(data.waypoints);
      } catch {
        if (!cancelled) setWpError(true);
      } finally {
        if (!cancelled) setWpLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [compId]);

  // Gate and deadline times are edited in the comp's zone when it has one
  // (#274). The xctsk stores UTC, so times convert on load and on save, each
  // anchored to the task date so a DST offset is the day's own.
  const tz = comp?.timezone ?? null;
  const taskDate = task?.task_date ?? "";
  const ctx = useMemo<RouteDraftContext>(
    () => ({
      toDisplayTime: (hhmm) => (tz ? (utcToZonedHHMM(taskDate, hhmm, tz) ?? hhmm) : hhmm),
    }),
    [tz, taskDate]
  );
  const toUtcTime = (hhmm: string) =>
    tz ? (zonedToUtcHHMM(taskDate, hhmm, tz) ?? hhmm) : hhmm;
  const timeZoneLabel = tz
    ? zoneNameWithOffset(new Date(`${taskDate}T12:00:00Z`), tz)
    : "UTC";

  const urlId = comp ? compUrlId(comp, compId) : compId;
  const compName = comp?.name ?? "";
  const taskName = task?.name ?? "";
  const routePath = taskRoutePath(urlId, compName, taskId, taskName);

  const saved = task?.xctsk ?? null;
  const fresh = useMemo(() => freshDraft(saved, ctx), [saved, ctx]);
  const editor = useDraftEditor({
    store: routeDraft,
    draftKey: [bareId, taskId],
    owner: user?.id ?? null,
    // Only an organiser has a draft, and only once mounted (see the note above).
    enabled: mounted && isAdmin && !!comp && !!task && !loading,
    fresh,
    model: routeModel,
    guard: { ...ROUTE_DISCARD, isWithin: (url) => inEditor(url, bareId, taskId) },
  });

  return {
    compId,
    bareId,
    taskId,
    comp,
    task,
    urlId,
    compName,
    taskName,
    routePath,
    loading,
    notFound,
    current,
    isAdmin,
    draftReady: editor.ready,
    openDistance: comp?.scoring_format === "open_distance",
    tz,
    timeZoneLabel,
    ctx,
    toUtcTime,
    waypoints: [...savedWaypoints, ...editor.draft.pendingWaypoints],
    savedWaypoints,
    wpLoading,
    wpError,
    draft: editor.draft,
    dirty: editor.dirty,
    serverChanged: editor.serverChanged,
    notKept: editor.notKept,
    update: editor.update,
    discard: () => editor.discard(),
    markSaved: editor.forget,
    addSavedWaypoints(records) {
      setSavedWaypoints((prev) => [...prev, ...records]);
    },
    setSaving: editor.setSaving,
    leave: () => leave(routePath),
  };
}

/**
 * Load a whole task into the route — an .xctsk file, or an XContest code —
 * asking first when that would replace turnpoints already there. Resolves
 * true once it is in the draft, false when the organiser kept what they had.
 */
export function useLoadRoute(editor: RouteEditorState) {
  const confirm = useConfirm();
  return async (task: XCTask, sourceLabel: string): Promise<boolean> => {
    if (hasTurnpoints(editor.draft)) {
      const ok = await confirm({
        title: "Replace the route in the editor?",
        message: `Loading ${sourceLabel} replaces the turnpoints, start gates and goal currently in the editor. Nothing is saved until you press Save.`,
        confirmLabel: "Replace",
      });
      if (!ok) return false;
    }
    editor.update((d) => loadTask(d, task, editor.ctx));
    toast.success(`Loaded ${task.turnpoints.length} turnpoints from ${sourceLabel}`);
    return true;
  };
}
