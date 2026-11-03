/**
 * Pilot roster editor page (/comp/:id/pilots) — ADMIN-ONLY and NOT SSR'd
 * (functions/comp/[[path]].ts serves it a noindex shell). The roster used to
 * be a section of the comp page; it moved here
 * because for visitors it duplicated the score tables, while for admins it
 * is a management surface (a list of pilots that open pages, CSV import and
 * export, the CIVL fill) that deserves room of its own. See PilotsSection.
 */
import { useParams } from "react-router-dom";
import { NotFound } from "@/react/components/NotFound";
import { OrganisersOnly } from "@/react/components/OrganisersOnly";
import { Breadcrumbs } from "@/react/rac/breadcrumbs";
import { Loading } from "@/react/rac/progress";
import { api } from "../../comp/api";
import { useAdminView, useUser } from "../lib/user";
import { underComp } from "../lib/crumbs";
import { compUrlId, idFromSegment, compPath, compScoresPath } from "../lib/slug";
import { useCanonicalPath } from "../lib/use-canonical-path";
import { useSeededResource } from "../lib/use-seeded-resource";
import { PilotsSection } from "../comp/PilotsSection";
import {
  CompSectionNav,
  compSectionNavProps,
} from "../comp/CompSectionNav";
import type { CompDetailData } from "../comp/types";

export function CompPilotsPage() {
  const { compId: compParam } = useParams<{ compId: string }>();
  const compId = idFromSegment(compParam ?? "");
  const { loading } = useUser();
  const { data: comp, notFound, current, setData } = useSeededResource<CompDetailData>({
    ids: [compId],
    seed: null,
    load: ([comp_id]) => api.api.comp[":comp_id"].$get({ param: { comp_id } }),
    title: (c) => `GlideComp - ${c.name} pilots`,
  });
  // Settle the address bar on the canonical `${slug}-${id}/pilots` once loaded
  // (for THIS id, not the one the page was on before).
  useCanonicalPath(
    comp && current ? `${compPath(compUrlId(comp, compId), comp.name)}/pilots` : null
  );

  const isAdmin = useAdminView(!!comp?.is_admin);

  if (notFound || !compId) {
    return <NotFound title="Competition not found" />;
  }

  if (!comp || loading) {
    return (
      <Loading>Loading pilots…</Loading>
    );
  }

  // The roster editor is a management tool; visitors find every pilot in
  // the score tables instead.
  if (!isAdmin) return <OrganisersOnly to={compScoresPath(compUrlId(comp, compId), comp.name)} />;

  return (
    <div>
      <Breadcrumbs items={underComp(compId, comp.name)} current="Pilots" />
      <CompSectionNav {...compSectionNavProps(compId, comp, isAdmin)} />
      <PilotsSection
        compId={compId}
        compName={comp.name}
        compClasses={comp.pilot_classes}
        openRegistration={comp.open_registration}
        // Keeps the section nav's "Pilots (n)" in step with the list below it.
        onCountChange={(n) =>
          setData((c) => (c && c.pilot_count !== n ? { ...c, pilot_count: n } : c))
        }
        headingAs="h1"
      />
    </div>
  );
}
