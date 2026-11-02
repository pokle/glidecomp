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
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { SectionHeader } from "../components/SectionHeader";
import { Breadcrumbs } from "@/react/rac/breadcrumbs";
import { Button } from "@/react/rac/button";
import { Form, FormErrorBanner, SubmitButton } from "@/react/rac/form";
import { underCompWaypoints } from "../lib/crumbs";
import { compWaypointsNewPath, compWaypointsPath } from "../lib/slug";
import { toast } from "../lib/toast";
import { useCanonicalPath } from "../lib/use-canonical-path";
import {
  AddWaypointFields,
  buildNewWaypoint,
  newWaypointProblems,
  readNewWaypointSeed,
  useNewWaypoint,
  type NewWaypointSeed,
} from "../comp/AddWaypointForm";
import {
  FROM_WAYPOINTS,
  FROM_WAYPOINTS_MAP,
  useWaypointsEditor,
  type WaypointsEditor,
} from "../comp/use-waypoints-editor";
import { waypointsEditorGate } from "../comp/WaypointsEditorGate";
import { addRecord } from "../comp/waypoints-draft";

export function CompWaypointNewPage() {
  const editor = useWaypointsEditor();
  const [searchParams] = useSearchParams();
  const { urlId, compName } = editor;

  useCanonicalPath(
    compName ? compWaypointsNewPath(urlId, compName) : null
  );

  const gate = waypointsEditorGate(editor);
  if (gate) return gate;
  // Mounted once the draft is known, so the code it suggests is unique among
  // the codes the draft holds.
  return <NewWaypointForm editor={editor} seed={readNewWaypointSeed(searchParams)} />;
}

function NewWaypointForm({ editor, seed: seedNow }: { editor: WaypointsEditor; seed: NewWaypointSeed }) {
  const { urlId, compName } = editor;
  // Where it started, read once: the fields are the reader's from here on.
  const [seed] = useState(seedNow);
  const [taken] = useState(() => editor.draft.rows.map((r) => r.code));
  const waypoint = useNewWaypoint(seed, taken);
  const leave = () =>
    editor.leave(compWaypointsPath(urlId, compName), FROM_WAYPOINTS, FROM_WAYPOINTS_MAP);

  return (
    <div className="max-w-2xl">
      <Breadcrumbs items={underCompWaypoints(urlId, compName)} current="Add waypoint" />
      <Form
        validate={() => newWaypointProblems(waypoint.state)}
        // Nothing to send: a new waypoint joins the draft, saved with the set.
        onSubmit={async () => undefined}
        onSuccess={() => {
          const built = buildNewWaypoint(waypoint.state, editor.draft.rows.map((r) => r.code));
          if (!built) return;
          if (built.adjusted) toast.warning(built.adjusted);
          editor.update((d) => addRecord(d, built.record).draft);
          leave();
        }}
      >
        <SectionHeader
          as="h1"
          className="mt-2"
          title="Add waypoint"
          action={
            <div className="flex items-center gap-2">
              <Button variant="outline" onPress={leave}>
                Cancel
              </Button>
              <SubmitButton pendingLabel="Adding">Add</SubmitButton>
            </div>
          }
        />
        <FormErrorBanner className="mt-3" />
        <div className="mt-4 flex flex-col gap-4">
          <AddWaypointFields seed={seed} waypoint={waypoint} />
        </div>
      </Form>
    </div>
  );
}
