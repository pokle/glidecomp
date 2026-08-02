/**
 * Pilot roster editor page (/comp/:id/pilots) — ADMIN-ONLY and NOT SSR'd
 * (functions/comp/[[path]].ts serves it a noindex shell, like field
 * analysis). The roster used to be a section of the comp page; it moved here
 * because for visitors it duplicated the score tables, while for admins it
 * is a management surface (paste-in roster setup, CSV import, the Tabulator
 * edit grid) that deserves room of its own.
 *
 * The #edit-pilots deep link (used by the comp setup guide) opens the edit
 * dialog on load — PilotsSection handles that hash itself.
 */
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { NotFound } from "@/react/components/NotFound";
import { Breadcrumbs } from "@/react/rac/breadcrumbs";
import { Loading } from "@/react/rac/progress";
import { api } from "../../comp/api";
import { useAdminView, useUser } from "../lib/user";
import { underComp } from "../lib/crumbs";
import { idFromSegment, compPath } from "../lib/slug";
import { useCanonicalPath } from "../lib/use-canonical-path";
import { PilotsSection } from "../comp/PilotsSection";
import { fetchWithRetry, type CompDetailData } from "../comp/types";

export function CompPilotsPage() {
  const { compId: compParam } = useParams<{ compId: string }>();
  const compId = idFromSegment(compParam ?? "");
  const { user, loading } = useUser();
  const [comp, setComp] = useState<CompDetailData | null>(null);
  const [notFound, setNotFound] = useState(false);
  // Settle the address bar on the canonical `${slug}-${id}/pilots` once loaded.
  useCanonicalPath(comp ? `${compPath(compId, comp.name)}/pilots` : null);

  useEffect(() => {
    // Clear any previous verdict first. react-router keeps this component
    // mounted when only the id in the path changes, so a "not found" left over
    // from the old id would mask whatever the new one loads. That is not
    // hypothetical: the 404 page's own "did you mean" links point back at this
    // very route, so clicking one changed the URL and nothing else.
    setNotFound(false);
    if (!compId) {
      setNotFound(true);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithRetry(() =>
          api.api.comp[":comp_id"].$get({ param: { comp_id: compId } })
        );
        if (cancelled) return;
        if (!res.ok) {
          setNotFound(true);
          return;
        }
        const data = (await res.json()) as unknown as CompDetailData;
        if (cancelled) return;
        setComp(data);
        document.title = `GlideComp - ${data.name} pilots`;
      } catch {
        if (!cancelled) setNotFound(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [compId]);

  const isAdmin = useAdminView(
    user != null && comp != null && comp.admins.some((a) => a.email === user.email)
  );

  if (notFound || !compId) {
    return <NotFound title="Competition not found" />;
  }

  if (!comp || loading) {
    return (
      <Loading>Loading pilots…</Loading>
    );
  }

  if (!isAdmin) {
    // The roster editor is a management tool; visitors find every pilot in
    // the score tables instead.
    return (
      <div>
        <Breadcrumbs items={underComp(compId, comp.name)} current="Pilots" />
        <h1 className="mt-2 text-2xl font-bold">Pilots</h1>
        <p className="mt-2 text-muted-foreground">
          Pilot management is for competition admins. Looking for the pilots?
          They're all in the{" "}
          <Link
            className="underline underline-offset-4"
            to={`/comp/${compId}/scores`}
          >
            scores
          </Link>
          .
        </p>
      </div>
    );
  }

  return (
    <div>
      <Breadcrumbs items={underComp(compId, comp.name)} current="Pilots" />
      <PilotsSection
        compId={compId}
        compName={comp.name}
        compClasses={comp.pilot_classes}
        isAdmin={isAdmin}
        openRegistration={comp.open_registration}
        headingAs="h1"
      />
    </div>
  );
}
