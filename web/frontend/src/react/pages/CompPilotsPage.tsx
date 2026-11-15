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
import { Page, PageBar } from "@/react/rac/page-bar";
import { Loading } from "@/react/rac/progress";
import { api } from "../../comp/api";
import { useAdminView, useUser } from "../lib/user";
import { underComp } from "../lib/crumbs";
import { compUrlId, idFromSegment, compPath, compScoresPath } from "../lib/slug";
import { useCanonicalPath } from "../lib/use-canonical-path";
import { useSeededResource } from "../lib/use-seeded-resource";
import { PilotsSection } from "../comp/PilotsSection";
import type { CompDetailData } from "../comp/types";

export function CompPilotsPage() {
  const { compId: compParam } = useParams<{ compId: string }>();
  const compId = idFromSegment(compParam ?? "");
  const { loading } = useUser();
  const { data: comp, notFound, current } = useSeededResource<CompDetailData>({
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

  // The bar before the data, so the page does not jump when it arrives.
  if (!comp || loading) {
    return (
      <Page bar={<PageBar title="Pilots" trail={underComp(compId, comp?.name)} />}>
        <Loading>Loading pilots…</Loading>
      </Page>
    );
  }

  // The roster editor is a management tool; visitors find every pilot in
  // the score tables instead.
  if (!isAdmin) return <OrganisersOnly to={compScoresPath(compUrlId(comp, compId), comp.name)} />;

  return <PilotsSection compId={compId} comp={comp} />;
}
