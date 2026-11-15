/**
 * What the roster's bulk-action pages (/pilots/import, /pilots/civl-fill,
 * /pilots/copy) fetch for themselves — the comp and its roster — and the states they share
 * before either is shown: not found, loading, not an organiser, no roster.
 *
 * They were sheets over the list until #810, handed the roster in memory.
 * A page cannot be: a reload, or a link opened in another tab, has no list
 * underneath it. So each asks the server, which also means each works on the
 * roster as it is NOW — a pilot who joined since the list loaded is in it.
 *
 * Leaving goes back the way the reader came, as on a pilot's page
 * (pages/CompPilotPage.tsx, lib/leave.ts): opened from the list, a real
 * Back, so the list returns searched, sorted and scrolled as it was left;
 * opened any other way, it replaces this entry with the list.
 *
 * Each is a tool with the page's bar (rac/page-bar.tsx, issue #863): Cancel on
 * the left, and its commit on the right where it has one. The states before
 * the page is ready carry the same bar, so the page does not jump.
 */
import { useEffect, useState, type ReactElement } from "react";
import { useParams } from "react-router-dom";
import { useLeave } from "../lib/leave";
import { NotFound } from "@/react/components/NotFound";
import { OrganisersOnly } from "@/react/components/OrganisersOnly";
import { Page, PageBar } from "@/react/rac/page-bar";
import { Loading } from "@/react/rac/progress";
import { api } from "../../comp/api";
import { underCompPilots, type Crumb } from "../lib/crumbs";
import { compPilotsPath, compScoresPath, compUrlId, idFromSegment } from "../lib/slug";
import { useCanonicalPath } from "../lib/use-canonical-path";
import { useSeededResource } from "../lib/use-seeded-resource";
import { useAdminView, useUser } from "../lib/user";
import type { CompPilot } from "./csv";
import { fetchWithRetry, type CompDetailData } from "./types";

export type RosterAdminPage =
  | { ready: false; element: ReactElement }
  | {
      ready: true;
      comp: CompDetailData;
      /** The roster as the server has it now. */
      roster: CompPilot[];
      /** The comp's id as it goes in URLs (share key and all, for a hidden comp). */
      urlId: string;
      /** The pages above this one: the competition, then its roster. */
      crumbs: Crumb[];
      /** The signed-in user's id: whose draft this page may read. */
      userId: string;
      /** Take in a change this page made to the comp (its classes, say). */
      updateComp: (change: Partial<CompDetailData>) => void;
      /** Back to the list: see the note at the top. */
      leave: () => void;
    };

export function useRosterAdminPage({
  current,
  fullTitle,
  canonicalPath,
}: {
  /** The page's title, for the bar of the states shown before it is ready. */
  current: string;
  /** The title in full, where `current` is a short form of it. */
  fullTitle?: string;
  /** The page's own URL, once the comp's name is known. */
  canonicalPath: (urlId: string, compName: string) => string;
}): RosterAdminPage {
  const { compId: compParam } = useParams<{ compId: string }>();
  const compId = idFromSegment(compParam ?? "");
  const { loading, user } = useUser();
  const leave = useLeave();

  const { data: comp, notFound, current: fresh, setData: setComp } = useSeededResource<CompDetailData>({
    ids: [compId],
    seed: null,
    load: ([comp_id]) => api.api.comp[":comp_id"].$get({ param: { comp_id } }),
    title: (c) => `GlideComp - ${c.name} pilots`,
  });

  const [roster, setRoster] = useState<CompPilot[] | null>(null);
  const [rosterError, setRosterError] = useState(false);
  useEffect(() => {
    if (!compId) return;
    let cancelled = false;
    void (async () => {
      try {
        // A dropped request is not an empty roster (#481).
        const res = await fetchWithRetry(() =>
          api.api.comp[":comp_id"].pilot.$get({ param: { comp_id: compId } })
        );
        if (cancelled) return;
        if (!res.ok) {
          setRosterError(true);
          return;
        }
        setRoster(((await res.json()) as unknown as { pilots: CompPilot[] }).pilots);
      } catch {
        if (!cancelled) setRosterError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [compId]);

  const urlId = comp ? compUrlId(comp, compId) : compId;
  useCanonicalPath(comp && fresh ? canonicalPath(urlId, comp.name) : null);
  const isAdmin = useAdminView(!!comp?.is_admin);

  if (notFound || !compId) {
    return { ready: false, element: <NotFound title="Competition not found" /> };
  }
  const crumbs = underCompPilots(urlId, comp?.name);
  const toList = () => {
    leave(compPilotsPath(urlId, comp?.name));
  };
  const waiting = (body: ReactElement) => (
    <Page bar={<PageBar title={current} fullTitle={fullTitle} trail={crumbs} cancel={toList} />}>
      {body}
    </Page>
  );
  if (!comp || loading || (roster === null && !rosterError)) {
    return { ready: false, element: waiting(<Loading>Loading pilots…</Loading>) };
  }
  // Visitors find every pilot in the score tables.
  if (!isAdmin || !user) {
    return { ready: false, element: <OrganisersOnly to={compScoresPath(urlId, comp.name)} /> };
  }
  if (rosterError || !roster) {
    return {
      ready: false,
      element: waiting(<p className="text-muted-foreground">Could not load pilots</p>),
    };
  }

  return {
    ready: true,
    comp,
    roster,
    urlId,
    crumbs,
    userId: user.id,
    updateComp: (change) => setComp((c) => (c ? { ...c, ...change } : c)),
    leave: toList,
  };
}
