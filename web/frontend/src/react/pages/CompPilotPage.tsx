/**
 * One pilot's editor (/comp/:compId/pilots/:pilotId, and /pilots/new for a
 * blank one) — ADMIN-ONLY and NOT SSR'd (functions/comp/[[path]].ts serves it
 * a noindex shell, like the roster it belongs to).
 *
 * The form is comp/PilotForm.tsx. This page fetches what the list used to hand
 * the sheet: the comp (its classes and name) and the roster (the pilot, and
 * the teams the Team field offers). A new pilot's name rides in `?name=`, set
 * by the list's + when a search found nobody.
 *
 * Leaving goes back the way the reader came. Opened from the list (the row or
 * the + marks it with `state.fromList`), that is a real Back, so the list
 * returns with its search, its sort and its scroll exactly as they were.
 * Opened any other way (a bookmark, a reload), it replaces this entry with
 * the list instead, so Back from there does not land on a saved form.
 */
import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { NotFound } from "@/react/components/NotFound";
import { Breadcrumbs } from "@/react/rac/breadcrumbs";
import { Loading } from "@/react/rac/progress";
import { api } from "../../comp/api";
import { useAdminView, useUser } from "../lib/user";
import { underCompPilots } from "../lib/crumbs";
import { compPilotPath, compPilotsPath, compUrlId, idFromSegment } from "../lib/slug";
import { useCanonicalPath } from "../lib/use-canonical-path";
import { backPastClosedOverlays } from "../lib/use-back-dismiss";
import { useSeededResource } from "../lib/use-seeded-resource";
import { fetchWithRetry, type CompDetailData } from "../comp/types";
import type { CompPilot } from "../comp/csv";
import { rosterTeams } from "../comp/team-names";
import { PilotForm } from "../comp/PilotForm";

export function CompPilotPage() {
  const { compId: compParam, pilotId: pilotParam } = useParams<{
    compId: string;
    pilotId?: string;
  }>();
  const compId = idFromSegment(compParam ?? "");
  // No :pilotId is the /new route.
  const pilotId = pilotParam ? idFromSegment(pilotParam) : null;
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { loading } = useUser();

  const { data: comp, notFound, current } = useSeededResource<CompDetailData>({
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
        // A dropped request is not "no such pilot" (#481).
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

  const pilot = useMemo(
    () => (pilotId && roster ? (roster.find((p) => p.comp_pilot_id === pilotId) ?? null) : null),
    [pilotId, roster]
  );
  const teams = useMemo(() => rosterTeams(roster ?? []), [roster]);
  const urlId = comp ? compUrlId(comp, compId) : compId;

  useCanonicalPath(
    comp && current && (pilot || !pilotId)
      ? compPilotPath(urlId, comp.name, pilot ? pilot.comp_pilot_id : "new", pilot?.name)
      : null
  );

  const isAdmin = useAdminView(!!comp?.is_admin);

  if (notFound || !compId) return <NotFound title="Competition not found" />;
  if (!comp || loading || (roster === null && !rosterError)) {
    return <Loading>Loading pilot…</Loading>;
  }

  const crumbs = underCompPilots(urlId, comp.name);
  if (!isAdmin) {
    return (
      <div>
        <Breadcrumbs items={crumbs} current="Pilot" />
        <p className="mt-2 text-muted-foreground">
          Pilot management is for the competition’s organisers.
        </p>
      </div>
    );
  }
  if (rosterError) {
    return (
      <div>
        <Breadcrumbs items={crumbs} current="Pilot" />
        <p className="mt-2 text-muted-foreground">Could not load pilots</p>
      </div>
    );
  }
  // A pilot removed since the link was made (or never on this roster).
  if (pilotId && !pilot) return <NotFound title="Pilot not found" />;

  const backToList = () => {
    // Behind the Remove confirmation's own history entry, if it just closed.
    if ((location.state as { fromList?: boolean } | null)?.fromList) backPastClosedOverlays();
    else navigate(compPilotsPath(urlId, comp.name), { replace: true });
  };

  return (
    <PilotForm
      // A fresh form per pilot: going from one pilot's URL to another's must
      // not carry the first draft across.
      key={pilotId ?? "new"}
      compId={urlId}
      compName={comp.name}
      compClasses={comp.pilot_classes}
      pilot={pilot}
      initialName={pilotId ? undefined : (searchParams.get("name") ?? undefined)}
      teams={teams}
      onDone={backToList}
    />
  );
}
