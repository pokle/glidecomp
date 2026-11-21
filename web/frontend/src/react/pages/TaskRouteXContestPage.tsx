/**
 * Load from XContest (/comp/:c/task/:t/route/xcontest) — a whole route from an
 * XContest / XCTrack task code. ADMIN-ONLY and NOT SSR'd (a noindex shell in
 * functions/comp/[[path]].ts).
 *
 * It was a small dialog with one text field over the route editor until #812;
 * the overlays rule in docs/interaction-guide.md makes anything with a text field a page. A
 * kit form (rac/form.tsx): a code XContest does not know, or a task it cannot
 * read, is refused under the Task code field, with what is typed kept.
 *
 * Load puts the task into the route's DRAFT (comp/route-draft.ts) — asking
 * first when that would replace turnpoints already there — and goes back to
 * the route. Nothing is saved until Save on the route. Cancel is the bar's
 * left control and Load its commit button (#863); Back is Cancel too.
 */
import { useRef, useState } from "react";
import type { XCTask } from "@glidecomp/engine";
import { TextField } from "@/react/rac/field";
import { Form, FormErrorBanner, SubmitButton, refusal } from "@/react/rac/form";
import { Page, PageBar, commitClass } from "@/react/rac/page-bar";
import { fetchTaskByCodeWithRaw } from "../../analysis/xctsk-fetch";
import { underTaskRoute } from "../lib/crumbs";
import { taskRouteXContestPath } from "../lib/slug";
import { useCanonicalPath } from "../lib/use-canonical-path";
import { useLoadRoute, useRouteEditor, type RouteEditorState } from "../comp/use-route-editor";
import { routeEditorGate } from "../comp/RouteEditorGate";

/** The task code field's name, as the kit form knows it. */
const CODE = "code";

export function TaskRouteXContestPage() {
  const editor = useRouteEditor();
  const { urlId, compName, taskId, taskName } = editor;
  useCanonicalPath(
    editor.comp && editor.task && editor.current
      ? taskRouteXContestPath(urlId, compName, taskId, taskName)
      : null
  );
  const gate = routeEditorGate(editor, {
    title: "Load from XContest",
    trail: underTaskRoute(urlId, compName, taskId, taskName),
  });
  if (gate) return gate;
  return <XContestForm editor={editor} />;
}

function XContestForm({ editor }: { editor: RouteEditorState }) {
  const { urlId, compName, taskId, taskName } = editor;
  const loadRoute = useLoadRoute(editor);
  const [code, setCode] = useState("");
  // The task XContest sent, between the submit and what is done with it.
  const fetched = useRef<{ task: XCTask; code: string } | null>(null);

  return (
      <Form
        className="contents"
        onSubmit={async () => {
          const wanted = code.trim();
          try {
            const { task } = await fetchTaskByCodeWithRaw(wanted);
            fetched.current = { task, code: wanted.toUpperCase() };
            return undefined;
          } catch (err) {
            // A request that never got an answer is the kit form's to say.
            if (err instanceof TypeError) throw err;
            return refusal(err instanceof Error ? err.message : "Failed to load XContest task", {
              field: CODE,
            });
          }
        }}
        onSuccess={async () => {
          const got = fetched.current;
          if (!got) return;
          // The load may have asked first ("Replace the route…?").
          if (await loadRoute(got.task, `XContest task ${got.code}`)) {
            editor.leave();
          }
        }}
      >
        <Page
          className="flex flex-col gap-4"
          bar={
            <PageBar
              title="Load from XContest"
              trail={underTaskRoute(urlId, compName, taskId, taskName)}
              // Nothing typed here is worth asking about: a code is pasted.
              cancel={() => editor.leave()}
              commit={
                <SubmitButton
                  className={commitClass}
                  pendingLabel="Loading"
                  isDisabled={code.trim() === ""}
                >
                  Load
                </SubmitButton>
              }
            />
          }
        >
        <FormErrorBanner />
          <p className="text-sm text-muted-foreground">
            Paste an XContest/XCTrack task code. It replaces the route; nothing
            is saved until you press Save.
          </p>
          <TextField
            label="Task code"
            name={CODE}
            autoFocus
            placeholder="e.g. 3sVv6dV"
            spellCheck="false"
            value={code}
            onChange={setCode}
          />
        </Page>
      </Form>
  );
}
