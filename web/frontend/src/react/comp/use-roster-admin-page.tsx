/**
 * What the roster's bulk-action pages (/pilots/import, /pilots/civl-fill)
 * fetch for themselves — the comp and its roster — and the states they share
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
 */
import { useEffect, useState, type ReactElement } from "react";
import { useParams } from "react-router-dom";
import { useLeave } from "../lib/leave";
import { NotFound } from "@/react/components/NotFound";
import { OrganisersOnly } from "@/react/components/OrganisersOnly";
import { Breadcrumbs } from "@/react/rac/breadcrumbs";
import { Loading } from "@/react/rac/progress";
import { api } from "../../comp/api";
import { underCompPilots } from "../lib/crumbs";
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
      /** The signed-in user's id: whose draft this page may read. */
      userId: string;
      /** Take in a change this page made to the comp (its classes, say). */
      updateComp: (change: Partial<CompDetailData>) => void;
      /** Back to the list: see the note at the top. */
      leave: () => void;
    };

export function useRosterAdminPage({
  current,
  canonicalPath,
}: {
  /** The page's crumb, for the states shown before it is ready. */
  current: string;
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
  if (!comp || loading || (roster === null && !rosterError)) {
    return { ready: false, element: <Loading>Loading pilots…</Loading> };
  }
  const crumbs = underCompPilots(urlId, comp.name);
  // Visitors find every pilot in the score tables.
  if (!isAdmin || !user) {
    return { ready: false, element: <OrganisersOnly to={compScoresPath(urlId, comp.name)} /> };
  }
  if (rosterError || !roster) {
    return {
      ready: false,
      element: (
        <div>
          <Breadcrumbs items={crumbs} current={current} />
          <p className="mt-2 text-muted-foreground">Could not load pilots</p>
        </div>
      ),
    };
  }

  return {
    ready: true,
    comp,
    roster,
    urlId,
    userId: user.id,
    updateComp: (change) => setComp((c) => (c ? { ...c, ...change } : c)),
    leave: () => {
      leave(compPilotsPath(urlId, comp.name));
    },
  };
}
