/**
 * Adding a competition waypoint from the route editor's map
 * (/comp/:c/task/:t/route/add-waypoint) — ADMIN-ONLY and NOT SSR'd (a noindex
 * shell in functions/comp/[[path]].ts).
 *
 * Reached by a tap on the route's map with Add from map armed. The tap and
 * what the map said about it ride in the URL (`?at=…&pick=…`,
 * comp/AddWaypointForm.tsx), so a reload comes back to the same point. It was
 * a dialog over the route editor until #812 (the overlays rule in CLAUDE.md
 * makes anything with fields a page); its fields are the ones the waypoints
 * editor's Add waypoint shows (pages/CompWaypointNewPage.tsx), from the same
 * component, so the two cannot fork.
 *
 * A kit form: coordinates that do not parse are refused under their field.
 * Add puts the waypoint into the route's DRAFT (comp/route-draft.ts) as the
 * next turnpoint, and holds it there for the competition: it is written to the
 * competition's waypoints only when the route is saved, so throwing the route
 * away throws it away too. Back is Cancel, and so is the Cancel button.
 */
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { SectionHeader } from "../components/SectionHeader";
import { Breadcrumbs } from "@/react/rac/breadcrumbs";
import { Button } from "@/react/rac/button";
import { Form, FormErrorBanner, SubmitButton } from "@/react/rac/form";
import { underTaskRoute } from "../lib/crumbs";
import { taskRouteAddWaypointPath } from "../lib/slug";
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
import { addNewWaypoint } from "../comp/route-draft";
import { useRouteEditor, type RouteEditorState } from "../comp/use-route-editor";
import { routeEditorGate } from "../comp/RouteEditorGate";

export function TaskRouteAddWaypointPage() {
  const editor = useRouteEditor();
  const [searchParams] = useSearchParams();
  const { urlId, compName, taskId, taskName } = editor;
  useCanonicalPath(
    editor.comp && editor.task && editor.current
      ? taskRouteAddWaypointPath(urlId, compName, taskId, taskName)
      : null
  );
  const gate = routeEditorGate(editor);
  if (gate) return gate;
  // Wait for the waypoints, so the code it suggests is unique among them.
  if (editor.wpLoading) return null;
  return <NewWaypointForm editor={editor} seed={readNewWaypointSeed(searchParams)} />;
}

function NewWaypointForm({
  editor,
  seed: seedNow,
}: {
  editor: RouteEditorState;
  seed: NewWaypointSeed;
}) {
  const { urlId, compName, taskId, taskName, openDistance } = editor;
  // Where it started, read once: the fields are the reader's from here on.
  const [seed] = useState(seedNow);
  const [taken] = useState(() => editor.waypoints.map((w) => w.code));
  const waypoint = useNewWaypoint(seed, taken);

  return (
    <div className="max-w-2xl">
      <Breadcrumbs
        items={underTaskRoute(urlId, compName, taskId, taskName)}
        current="Add waypoint"
      />
      <Form
        validate={() => newWaypointProblems(waypoint.state)}
        // Nothing to send: the waypoint joins the route's draft, and the
        // competition's waypoints when the route is saved.
        onSubmit={async () => undefined}
        onSuccess={() => {
          const built = buildNewWaypoint(
            waypoint.state,
            editor.waypoints.map((w) => w.code)
          );
          if (!built) return;
          if (built.adjusted) toast.warning(built.adjusted);
          editor.update((d) => addNewWaypoint(d, built.record, { openDistance }));
          toast.success(`Added ${built.record.code} to the route. Save to keep it.`);
          editor.leave();
        }}
      >
        <SectionHeader
          as="h1"
          className="mt-2"
          title="Add waypoint"
          action={
            <div className="flex items-center gap-2">
              <Button variant="outline" onPress={() => editor.leave()}>
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
