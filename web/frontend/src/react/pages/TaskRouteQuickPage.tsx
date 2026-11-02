/**
 * Quick entry (/comp/:c/task/:t/route/quick) — the whole route as one line of
 * text. ADMIN-ONLY and NOT SSR'd (a noindex shell in
 * functions/comp/[[path]].ts).
 *
 * The expert's way in. Where the turnpoint list adds and edits one turnpoint
 * at a time, this takes a route the way a task setter says it out loud and
 * builds the lot in one go: "ell 400m ell 5k mitta cudg ncor 1k".
 *
 * It is a page reached from a button, rather than a field sitting in the
 * editor mirroring the route (#661), and since #812 a page rather than a
 * full-screen sheet (the overlays rule in CLAUDE.md). The line is a LOSSY
 * view — it names waypoints, radii, types and the start, and can say nothing
 * about a turnpoint's coordinates, altitude or long name — so a live mirror
 * rebuilt the route from the text on every pause in your typing, quietly
 * discarding exactly the details the line could not carry. Here, applying is
 * a press you meant to make, and it RECONCILES rather than rebuilds
 * (route-reconcile.ts): turnpoints the line still names keep their id, their
 * position on the ground and their elevation.
 *
 * The page opens showing the route in the draft, so it edits a route as well
 * as enters one. "Use this route" writes the result into the route's draft
 * (comp/route-draft.ts) and goes back; leaving any other way — Cancel, Back —
 * leaves the route exactly as it was. The line itself is not kept: it is a
 * view of the route, made again from the draft each time the page opens.
 */
import { useMemo, useState } from "react";
import { SectionHeader } from "../components/SectionHeader";
import { Breadcrumbs } from "@/react/rac/breadcrumbs";
import { Button } from "@/react/rac/button";
import { Explain } from "@/react/rac/explain";
import { Form, FormErrorBanner, SubmitButton } from "@/react/rac/form";
import { useConfirm } from "../lib/confirm";
import { underTaskRoute } from "../lib/crumbs";
import { taskRouteQuickPath } from "../lib/slug";
import { useCanonicalPath } from "../lib/use-canonical-path";
import { parseTimeToken, quickTaskApply, quickTaskText } from "../comp/quick-task";
import { QuickTaskField } from "../comp/QuickTaskField";
import { applyQuickEntry, isBlankRow } from "../comp/route-draft";
import { NEW_ROW_RADIUS } from "../comp/turnpoint-draft";
import { useRouteEditor, type RouteEditorState } from "../comp/use-route-editor";
import { routeEditorGate } from "../comp/RouteEditorGate";

export function TaskRouteQuickPage() {
  const editor = useRouteEditor();
  const { urlId, compName, taskId, taskName } = editor;
  useCanonicalPath(
    editor.comp && editor.task && editor.current
      ? taskRouteQuickPath(urlId, compName, taskId, taskName)
      : null
  );
  const gate = routeEditorGate(editor);
  if (gate) return gate;
  // Mounted once the draft is known, so the line it opens with is the route
  // the draft holds.
  return <QuickEntryForm editor={editor} />;
}

function QuickEntryForm({ editor }: { editor: RouteEditorState }) {
  const confirm = useConfirm();
  const { draft, openDistance, urlId, compName, taskId, taskName } = editor;

  // The route as a quick-task line, so the page opens showing the task in the
  // editor and edits it rather than starting from a blank box. The start
  // config is part of it (#436) — otherwise the line would say "sss" while
  // the panel quietly held an enter start. Only gates that read as times are
  // offered: a gate mid-edit in the picker isn't something the line can say.
  // Read once: the line is the reader's from here on.
  const [initialText] = useState(() => {
    const rows = draft.rows.filter((r) => !isBlankRow(r));
    return quickTaskText(
      rows.map((r) => ({
        name: String(r.name),
        radius: Number(r.radius) || NEW_ROW_RADIUS,
        type: r.type === "GOAL" ? "" : r.type,
      })),
      openDistance
        ? {}
        : {
            start: {
              direction: draft.direction,
              type: draft.sssType,
              gates: draft.gates.filter((g) => parseTimeToken(g) !== null),
            },
          }
    );
  });
  const [text, setText] = useState(initialText);

  // Names of the turnpoints the route already holds — what the line may keep
  // without matching them to a waypoint. Stable identity: the field memoises
  // its parse on this, and a fresh array every render would re-parse the
  // line on every keystroke of it.
  const [known] = useState(() => draft.rows.map((r) => String(r.name)));

  const parsed = useMemo(
    () =>
      quickTaskApply(text, editor.waypoints, {
        defaultRadius: NEW_ROW_RADIUS,
        knownNames: known,
      }),
    [text, editor.waypoints, known]
  );

  /**
   * Leaving without pressing throws away the typing — so say so, but only
   * when there is typing to throw away.
   */
  async function cancel() {
    if (text === initialText) return editor.leave();
    const ok = await confirm({
      title: "Discard this text?",
      message: "The route in the editor hasn't changed. Anything typed here will be lost.",
      confirmLabel: "Discard",
      cancelLabel: "Keep editing",
      destructive: true,
    });
    if (ok) editor.leave({ afterConfirm: true });
  }

  return (
    <div className="max-w-2xl">
      <Breadcrumbs
        items={underTaskRoute(urlId, compName, taskId, taskName)}
        current="Quick entry"
      />
      <Form
        // Nothing to send: the route joins the draft, saved with the route.
        onSubmit={async () => undefined}
        onSuccess={() => {
          editor.update((d) => applyQuickEntry(d, parsed, { openDistance }));
          // A "Discard this text?" that was answered "Keep editing" may still
          // be giving back its history entry.
          editor.leave({ afterConfirm: true });
        }}
      >
        <SectionHeader
          as="h1"
          className="mt-2"
          title="Quick entry"
          action={
            <div className="flex items-center gap-2">
              <Button variant="outline" onPress={() => void cancel()}>
                Cancel
              </Button>
              <SubmitButton isDisabled={parsed.picks.length === 0}>Use this route</SubmitButton>
            </div>
          }
        />
        <FormErrorBanner className="mt-3" />
        <div className="mt-4 flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            Type waypoints in order, each with a radius — e.g.{" "}
            <span className="font-medium">ell 400m mitta 5k</span>.{" "}
            <Explain label="Syntax" className="align-middle">
              <p>
                Add a type (<span className="font-medium">to</span>,{" "}
                <span className="font-medium">sss</span>,{" "}
                <span className="font-medium">ess</span>,{" "}
                <span className="font-medium">tp</span>,{" "}
                <span className="font-medium">goal</span>) where position
                doesn&apos;t already imply it.
              </p>
              {!openDistance ? (
                <p>
                  The start takes its settings the same way —{" "}
                  <span className="font-medium">enter</span> or{" "}
                  <span className="font-medium">exit</span>,{" "}
                  <span className="font-medium">race</span> or{" "}
                  <span className="font-medium">elapsed</span>, and any start
                  gates as times:{" "}
                  <span className="font-medium">sss enter 13:15 13:30</span>.
                </p>
              ) : null}
            </Explain>
          </p>

          <QuickTaskField
            waypoints={editor.waypoints}
            defaultRadius={NEW_ROW_RADIUS}
            value={text}
            onChange={setText}
            knownNames={known}
            placeholder={openDistance ? "ell 5k" : "ell 400m ell 5k mitta cudg ncor 1k"}
            exampleSize={openDistance ? 1 : undefined}
            timeZoneLabel={openDistance ? undefined : editor.timeZoneLabel}
          />

          {/* What the line cannot say, said once — so nobody has to discover
              by losing an altitude that the grammar has no word for one. */}
          <p className="text-sm text-muted-foreground">
            Only sets the order, radii, types and the start — coordinates,
            altitudes and names are unchanged.
          </p>
        </div>
      </Form>
    </div>
  );
}
