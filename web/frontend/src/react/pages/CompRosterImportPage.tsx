/**
 * Importing a roster CSV (/comp/:compId/pilots/import) — ADMIN-ONLY and NOT
 * SSR'd (functions/comp/[[path]].ts serves it a noindex shell, like the
 * roster it belongs to). Reached from the pilots list's ⋯ menu, left with
 * Back. It was a dialog and a full-screen sheet over the list until #810.
 *
 * One page, two steps, one URL: what a CSV must look like and the button
 * that picks one; then, once a file is chosen, the review of what importing
 * it would do (comp/RosterActions.tsx). The file is a DRAFT
 * (`rosterImportDraft`, lib/draft-store.ts, docs/drafts.md), kept in this
 * tab's storage for this user and this comp, so:
 *
 *   - a reload comes back to the review of the same file;
 *   - Back leaves the draft where it is, so Forward comes back to it too;
 *   - Apply and Cancel forget it, and so does the menu's "Import CSV…",
 *     which always starts at choosing a file;
 *   - with no draft to read — a link opened in another tab or browser, a
 *     draft discarded, from an older shape or an expired one — the page is
 *     simply at its first step and asks for the file. No error: there is
 *     nothing wrong, only nothing chosen yet.
 *
 * The review is planned here, from the draft and the roster this page
 * fetched, never handed over: it is of the roster as it is now.
 */
import { useMemo } from "react";
import { useDraft } from "../lib/use-draft";
import { compPilotsImportPath } from "../lib/slug";
import { ImportCsvPicker, ImportReview, rosterImportDraft } from "../comp/RosterActions";
import { planImport } from "../comp/roster-import";
import { useRosterAdminPage } from "../comp/use-roster-admin-page";

export function CompRosterImportPage() {
  const page = useRosterAdminPage({
    current: "Import CSV",
    canonicalPath: compPilotsImportPath,
  });
  // The comp's bare id (never its share key) and whose draft it is.
  const draftKey = page.ready ? [page.comp.comp_id] : null;
  const { draft, setDraft } = useDraft(
    rosterImportDraft,
    draftKey,
    page.ready ? page.userId : null
  );
  const roster = page.ready ? page.roster : null;
  const classes = page.ready ? page.comp.pilot_classes : null;
  const plan = useMemo(
    () => (roster && classes && draft ? planImport(draft.text, draft.fileName, roster, classes) : null),
    [roster, classes, draft]
  );

  if (!page.ready) return page.element;

  if (!plan) {
    return (
      <ImportCsvPicker
        compId={page.urlId}
        compName={page.comp.name}
        onChosen={(file) => void setDraft(file)}
      />
    );
  }

  // Applied or cancelled, the file is forgotten — in storage only, so the
  // review stays on screen until the page has gone, rather than flashing
  // the first step on the way out.
  const finish = () => {
    rosterImportDraft.clear([page.comp.comp_id]);
    page.leave();
  };
  return (
    <ImportReview
      compId={page.urlId}
      compName={page.comp.name}
      plan={plan}
      onCancel={finish}
      onApplied={finish}
    />
  );
}
