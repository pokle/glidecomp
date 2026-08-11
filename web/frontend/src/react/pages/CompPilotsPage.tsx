/**
 * Pilot roster editor page (/comp/:id/pilots) — ADMIN-ONLY and NOT SSR'd
 * (functions/comp/[[path]].ts serves it a noindex shell). The roster used to
 * be a section of the comp page; it moved here
 * because for visitors it duplicated the score tables, while for admins it
 * is a management surface (paste-in roster setup, CSV import, the Tabulator
 * edit grid) that deserves room of its own.
 *
 * The #edit-pilots deep link (used by the comp setup guide) opens the edit
 * dialog on load — PilotsSection handles that hash itself.
 */
import { Link, useParams } from "react-router-dom";
import { NotFound } from "@/react/components/NotFound";
import { Breadcrumbs } from "@/react/rac/breadcrumbs";
import { Loading } from "@/react/rac/progress";
import { api } from "../../comp/api";
import { useAdminView, useUser } from "../lib/user";
import { underComp } from "../lib/crumbs";
import { idFromSegment, compPath } from "../lib/slug";
import { useCanonicalPath } from "../lib/use-canonical-path";
import { useSeededResource } from "../lib/use-seeded-resource";
import { PilotsSection } from "../comp/PilotsSection";
import type { CompDetailData } from "../comp/types";

export function CompPilotsPage() {
  const { compId: compParam } = useParams<{ compId: string }>();
  const compId = idFromSegment(compParam ?? "");
  const { user, loading } = useUser();
  const { data: comp, notFound } = useSeededResource<CompDetailData>({
    ids: [compId],
    seed: null,
    load: ([comp_id]) => api.api.comp[":comp_id"].$get({ param: { comp_id } }),
    title: (c) => `GlideComp - ${c.name} pilots`,
  });
  // Settle the address bar on the canonical `${slug}-${id}/pilots` once loaded.
  useCanonicalPath(comp ? `${compPath(compId, comp.name)}/pilots` : null);

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
