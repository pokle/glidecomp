/**
 * Filling the roster from the CIVL world rankings
 * (/comp/:compId/pilots/civl-fill) — ADMIN-ONLY and NOT SSR'd
 * (functions/comp/[[path]].ts serves it a noindex shell, like the roster it
 * belongs to). Reached from the pilots list's ⋯ menu, left with Back. It was
 * a full-screen sheet over the list until #810.
 *
 * It holds no draft: everything it shows is asked for when it opens — the
 * roster from the server, then the rankings about that roster — so a reload
 * simply asks again. The form is comp/RosterActions.tsx's `CivlFill`.
 */
import { compPilotsCivlFillPath } from "../lib/slug";
import { CIVL_FILL_FULL_TITLE, CIVL_FILL_TITLE, CivlFill } from "../comp/RosterActions";
import { useRosterAdminPage } from "../comp/use-roster-admin-page";

export function CompCivlFillPage() {
  const page = useRosterAdminPage({
    current: CIVL_FILL_TITLE,
    fullTitle: CIVL_FILL_FULL_TITLE,
    canonicalPath: compPilotsCivlFillPath,
  });
  if (!page.ready) return page.element;
  return (
    <CivlFill
      compId={page.urlId}
      crumbs={page.crumbs}
      roster={page.roster}
      onDone={page.leave}
    />
  );
}
