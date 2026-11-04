/**
 * Adding a waypoint to the comp's waypoint file
 * (/comp/:compId/waypoints/new) — ADMIN-ONLY and NOT SSR'd (a noindex shell
 * in functions/comp/[[path]].ts).
 *
 * Reached from the list's "Add waypoint", or by a tap on either map with Add
 * from map armed — in which case the tap and what the map said about it ride
 * in the URL (`?at=…&pick=…`, comp/AddWaypointForm.tsx), so a reload comes
 * back to the same point. It was a dialog with three text fields over the
 * list until #811; the overlays rule in CLAUDE.md makes anything with fields
 * a page.
 *
 * A kit form (rac/form.tsx): coordinates that do not parse are refused under
 * their field. Add puts the waypoint into the waypoints DRAFT
 * (comp/waypoints-draft.ts) and goes back the way the reader came — to the
 * list, or to the full-size map with Add from map still armed. Nothing is
 * saved until Save on the list. Back is Cancel, and so is the Cancel button.
 */
import { useSearchParams } from "react-router-dom";
import { underCompWaypoints } from "../lib/crumbs";
import { compWaypointsNewPath, compWaypointsPath } from "../lib/slug";
import { useCanonicalPath } from "../lib/use-canonical-path";
import { NewWaypointPage, readNewWaypointSeed } from "../comp/AddWaypointForm";
import { useWaypointsEditor } from "../comp/use-waypoints-editor";
import { waypointsEditorGate } from "../comp/WaypointsEditorGate";
import { addRecord } from "../comp/waypoints-draft";

export function CompWaypointNewPage() {
  const editor = useWaypointsEditor();
  const [searchParams] = useSearchParams();
  const { urlId, compName } = editor;

  useCanonicalPath(compName ? compWaypointsNewPath(urlId, compName) : null);

  const gate = waypointsEditorGate(editor);
  if (gate) return gate;
  // Mounted once the draft is known, so the code it suggests is unique among
  // the codes the draft holds.
  return (
    <NewWaypointPage
      crumbs={underCompWaypoints(urlId, compName)}
      seed={readNewWaypointSeed(searchParams)}
      codes={() => editor.draft.rows.map((r) => r.code)}
      onAdd={(record) => {
        // Nothing to send: a new waypoint joins the draft, saved with the set.
        editor.update((d) => addRecord(d, record).draft);
        return `Added ${record.code}. Save to keep it.`;
      }}
      onLeave={() => editor.leave(compWaypointsPath(urlId, compName))}
    />
  );
}
