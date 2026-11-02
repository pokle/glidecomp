/**
 * What every page of the waypoints editor shares (#811): the competition, the
 * waypoint set the server holds, and the DRAFT of it being edited
 * (comp/waypoints-draft.ts) — read from this tab's storage when the page
 * mounts, and written straight back on every change, so the list, a
 * waypoint's page, Add waypoint, the full-size map and the altitude review
 * all edit the same file and none is handed it by another.
 *
 * The list (pages/CompWaypoints.tsx) is server-rendered and seeds this from
 * the SSR data; the other pages are admin-only noindex shells and fetch.
 * Either way the draft is read only once the page has mounted: the server has
 * no storage, and a first client render that differed from the server's
 * markup would not hydrate.
 *
 * ## Leaving
 *
 * Going between the editor's own pages is not leaving it: nothing asks, and
 * the draft is simply there on the other side. Leaving the editor by a link
 * with unsaved edits asks first — "Discard changes" then forgets the draft,
 * "Keep editing" stays. Back is left to the browser (the overlays rule in
 * CLAUDE.md retired the machinery that intercepted it), and Back means "not
 * now": the draft stays, and coming back to the waypoints finds it. A reload
 * finds it too.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import type { WaypointFileRecord } from "@glidecomp/engine";
import type { MapCamera } from "../../analysis/map-provider";
import { api } from "../../comp/api";
import { useInitialData } from "../lib/initial-data";
import { bareCompId, compUrlId, idFromSegment } from "../lib/slug";
import { useDraft } from "../lib/use-draft";
import { useMounted } from "../lib/use-mounted";
import { useUnsavedChangesGuard } from "../lib/use-unsaved-changes-guard";
import { useAdminView, useUser } from "../lib/user";
import type { CompWaypointsLoaderData } from "../loaders";
import { toast } from "../lib/toast";
import { fetchWithRetry } from "./types";
import { parseCoords } from "./route-editor";
import {
  isDirty,
  baselineJson,
  resolveDraft,
  startReview,
  validRecords,
  waypointsDraft,
  type WaypointsDraft,
} from "./waypoints-draft";

export type WaypointsComp = CompWaypointsLoaderData["comp"];

/**
 * How a page was reached, set on the `navigate()` state that opens it. A page
 * leaves by a real Back when its flag is there — the page underneath then
 * returns as it was left, scroll and all — and by replacing itself with its
 * parent when it is not (a reload of a bookmark, a link opened elsewhere).
 */
export const FROM_WAYPOINTS = "fromWaypoints";
export const FROM_WAYPOINTS_MAP = "fromWaypointsMap";
export const FROM_ALTITUDE_REVIEW = "fromAltitudeReview";

/**
 * The last view of each comp's waypoints map, so the list's small map and the
 * full-size one open where the other was left (by bare comp id). A module
 * variable rather than storage: it only has to survive going between the two
 * pages, and Mapbox keeps its own last view across a reload.
 */
export const waypointCameras = new Map<string, MapCamera>();

export interface WaypointsEditor {
  /** The comp's id as the URL carries it (share key and all). */
  compId: string;
  /** The comp's bare id: the draft's key. */
  bareId: string;
  comp: WaypointsComp | null;
  /** The id this viewer's URLs carry, once the comp is known. */
  urlId: string;
  compName: string;
  loading: boolean;
  notFound: boolean;
  /**
   * An organiser's draft has been read from storage (or found absent). Until
   * then `draft` is the saved set, and a page addressing a row that exists
   * only in the draft must wait rather than call it missing.
   */
  draftReady: boolean;
  /** The session is still being resolved. */
  userLoading: boolean;
  isAdmin: boolean;
  /** The set the server holds, verbatim. */
  saved: WaypointFileRecord[];
  /** The editor's working copy: the stored draft, or the saved set. */
  draft: WaypointsDraft;
  /** The working copy differs from the saved set. */
  dirty: boolean;
  /** The saved set changed after this draft was started (see resolveDraft). */
  serverChanged: boolean;
  /** Change the draft; the change is in storage before this returns. */
  update: (change: (d: WaypointsDraft) => WaypointsDraft) => void;
  /** Forget the draft: back to the saved set. */
  /**
   * Change the draft in storage only, for a page on its way out: it stays as
   * it is on screen until it has gone, rather than flash the state the change
   * leaves it in. The next page reads the change when it mounts.
   */
  updateOnLeave: (change: (d: WaypointsDraft) => WaypointsDraft) => void;
  discard: () => void;
  /** The server now holds `records`: a new baseline, and no draft. */
  markSaved: (records: WaypointFileRecord[]) => void;
  /**
   * Leave this page: a real Back when it was opened with `flag` set, else
   * replace it with `fallback`. See {@link FROM_WAYPOINTS}.
   */
  leave: (fallback: string, ...flags: string[]) => void;
}

/** Whether `url` is a page of this comp's waypoints editor. */
function inEditor(url: URL, bareId: string): boolean {
  const m = url.pathname.match(/^\/comp\/([^/]+)\/waypoints(?:\/|$)/);
  return !!m && bareCompId(idFromSegment(m[1])) === bareId;
}

export function useWaypointsEditor(): WaypointsEditor {
  const { compId: compParam } = useParams<{ compId: string }>();
  const compId = idFromSegment(compParam ?? "");
  const bareId = bareCompId(compId);
  const { user, loading: userLoading } = useUser();
  const location = useLocation();
  const navigate = useNavigate();
  const mounted = useMounted();

  // SSR seed — the list page only (null on a client boot, on an SPA
  // navigation, and on every other page of the editor, which fetch instead).
  // Seeding the same state the fetch would set makes the first client render
  // match the server markup exactly.
  const initial = useInitialData<CompWaypointsLoaderData>();
  const [comp, setComp] = useState<WaypointsComp | null>(initial?.comp ?? null);
  const [saved, setSaved] = useState<WaypointFileRecord[]>(() => initial?.waypoints ?? []);
  const [loading, setLoading] = useState(!initial);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    // Clear any previous verdict first. react-router keeps a page mounted
    // when only the id in the path changes, so a "not found" left over from
    // the old id would mask whatever the new one loads — and the 404 page's
    // own "did you mean" links point back at this very route.
    setNotFound(false);
    if (!compId) {
      setNotFound(true);
      return;
    }
    // Seeded from SSR — skip the fetch. The seed is retired on any client-side
    // navigation (see lib/initial-data.tsx), so a return visit fetches fresh.
    if (initial) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        // Both go through fetchWithRetry: a dropped comp GET used to leave
        // the page with no name, no waypoints and no admin controls (#481).
        const [compRes, wpRes] = await Promise.all([
          fetchWithRetry(() => api.api.comp[":comp_id"].$get({ param: { comp_id: compId } })),
          fetchWithRetry(() =>
            api.api.comp[":comp_id"].waypoints.$get({ param: { comp_id: compId } })
          ),
        ]);
        if (cancelled) return;
        if (!compRes.ok) {
          setNotFound(true);
          return;
        }
        // encodeComp is loosely typed, so read the fields we need via unknown.
        // The server already computes is_admin (super-admins included).
        const c = (await compRes.json()) as unknown as WaypointsComp;
        const wp = wpRes.ok
          ? ((await wpRes.json()) as unknown as { waypoints: WaypointFileRecord[] }).waypoints
          : [];
        if (cancelled) return;
        setComp(c);
        setSaved(wp);
      } catch {
        // Every retry was dropped. Say so, rather than render an empty list
        // that looks like a comp with no waypoints.
        if (!cancelled) setNotFound(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // The user: a sign-in changes what the comp says about the viewer
    // (is_admin).
  }, [compId, user?.id, initial]);

  const isAdmin = useAdminView(!!comp?.is_admin);

  // Only an organiser has a draft, and only once mounted (see the note above).
  const draftOn = mounted && isAdmin && !!comp && !loading;
  const stored = useDraft(
    waypointsDraft,
    draftOn ? [bareId] : null,
    draftOn && user ? user.id : null
  );
  const resolved = useMemo(() => resolveDraft(stored.draft, saved), [stored.draft, saved]);
  const savedBase = useMemo(() => baselineJson(saved), [saved]);

  // A stored draft that resolveDraft passed over (an unedited copy of an
  // older save) is never going to be read: it does not stay.
  const passedOver = stored.draft !== null && !resolved.fromStorage;
  useEffect(() => {
    if (passedOver) waypointsDraft.clear([bareId]);
  }, [passedOver, bareId]);

  // The latest working copy, so two changes in one event both land.
  const latest = useRef(resolved.draft);
  latest.current = resolved.draft;

  const dirty = useMemo(
    () => isAdmin && isDirty(resolved.draft.rows, savedBase),
    [isAdmin, resolved.draft.rows, savedBase]
  );

  const discard = () => {
    stored.clearDraft();
    latest.current = resolveDraft(null, saved).draft;
  };

  useUnsavedChangesGuard(dirty, {
    title: "Discard changes?",
    message: "This page has unsaved changes. Leaving will discard them.",
    isWithin: (url) => inEditor(url, bareId),
    onDiscard: () => waypointsDraft.clear([bareId]),
  });

  return {
    compId,
    bareId,
    comp,
    urlId: comp ? compUrlId(comp, compId) : compId,
    compName: comp?.name ?? "",
    loading,
    notFound,
    draftReady: draftOn && !!user,
    userLoading,
    isAdmin,
    saved,
    draft: resolved.draft,
    dirty,
    serverChanged: resolved.serverChanged,
    update(change) {
      const next = change(latest.current);
      if (next === latest.current) return;
      latest.current = next;
      stored.setDraft(next);
    },
    updateOnLeave(change) {
      if (!draftOn || !user) return;
      waypointsDraft.save([bareId], user.id, change(latest.current));
    },
    discard,
    markSaved(records) {
      setSaved(records);
      stored.clearDraft();
      latest.current = resolveDraft(null, records).draft;
    },
    leave(fallback, ...flags) {
      const state = location.state as Record<string, unknown> | null;
      if (flags.some((f) => state?.[f])) navigate(-1);
      else navigate(fallback, { replace: true });
    },
  };
}

/** The working copy's records, for a map or an export. */
export function draftRecords(d: WaypointsDraft): WaypointFileRecord[] {
  return validRecords(d.rows);
}

/**
 * Compare every waypoint's altitude with the terrain under it and open the
 * review on what it found — changing no altitude. Resolves true once the
 * review is in the draft; false (having said why) when there was nothing to
 * check or the terrain could not be read.
 */
export function useAltitudeCheck(editor: WaypointsEditor): {
  checking: boolean;
  run: () => Promise<boolean>;
} {
  const [checking, setChecking] = useState(false);
  return {
    checking,
    async run() {
      const targets = editor.draft.rows.flatMap((r) => {
        const c = parseCoords(r.coords);
        return c ? [{ id: r.id, lat: c.lat, lon: c.lon }] : [];
      });
      if (targets.length === 0) {
        toast.error("No waypoints have valid coordinates to check");
        return false;
      }
      setChecking(true);
      try {
        // Dynamic import: browser-only module, loaded on press.
        const { fetchElevations } = await import("../../analysis/elevation");
        const elevations = await fetchElevations(targets);
        const byId = new Map<number, number>();
        targets.forEach((t, i) => {
          const e = elevations[i];
          if (e !== null) byId.set(t.id, Math.round(e));
        });
        if (byId.size === 0) {
          toast.error("Could not read terrain elevations from Mapbox");
          return false;
        }
        // Keyed by row id, against the draft as it is NOW rather than the
        // rows the check started with. The check writes NO altitude: it
        // records what the terrain said, and the review presents the two
        // side by side.
        editor.update((d) => startReview(d, byId));
        return true;
      } catch {
        toast.error("Could not read terrain elevations from Mapbox");
        return false;
      } finally {
        setChecking(false);
      }
    },
  };
}
