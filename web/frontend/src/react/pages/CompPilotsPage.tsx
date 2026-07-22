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
import { Breadcrumbs } from "@/react/rac/breadcrumbs";
import { api } from "../../comp/api";
import { useAdminView, useUser } from "../lib/user";
import { underComp } from "../lib/crumbs";
import { PilotsSection } from "../comp/PilotsSection";
import { fetchWithRetry, type CompDetailData } from "../comp/types";

export function CompPilotsPage() {
  const { compId } = useParams<{ compId: string }>();
  const { user, loading } = useUser();
  const [comp, setComp] = useState<CompDetailData | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
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
    return (
      <div>
        <p>Competition not found</p>
        <Link className="underline underline-offset-4" to="/comp">
          Back to Competitions
        </Link>
      </div>
    );
  }

  if (!comp || loading) {
    return (
      <p role="status" aria-label="Loading pilots" className="text-muted-foreground">
        Loading pilots…
      </p>
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
        headingAs="h1"
      />
    </div>
  );
}
