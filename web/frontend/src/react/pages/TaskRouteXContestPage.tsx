/**
 * Load from XContest (/comp/:c/task/:t/route/xcontest) — a whole route from an
 * XContest / XCTrack task code. ADMIN-ONLY and NOT SSR'd (a noindex shell in
 * functions/comp/[[path]].ts).
 *
 * It was a small dialog with one text field over the route editor until #812;
 * the overlays rule in CLAUDE.md makes anything with a text field a page. A
 * kit form (rac/form.tsx): a code XContest does not know, or a task it cannot
 * read, is refused under the Task code field, with what is typed kept.
 *
 * Load puts the task into the route's DRAFT (comp/route-draft.ts) — asking
 * first when that would replace turnpoints already there — and goes back to
 * the route. Nothing is saved until Save on the route. Back is Cancel, and so
 * is the Cancel button.
 */
import { useRef, useState } from "react";
import type { XCTask } from "@glidecomp/engine";
import { SectionHeader } from "../components/SectionHeader";
import { Breadcrumbs } from "@/react/rac/breadcrumbs";
import { Button } from "@/react/rac/button";
import { TextField } from "@/react/rac/field";
import { Form, FormErrorBanner, SubmitButton, type SubmitResponse } from "@/react/rac/form";
import { fetchTaskByCodeWithRaw } from "../../analysis/xctsk-fetch";
import { underTaskRoute } from "../lib/crumbs";
import { taskRouteXContestPath } from "../lib/slug";
import { useCanonicalPath } from "../lib/use-canonical-path";
import { useLoadRoute, useRouteEditor, type RouteEditorState } from "../comp/use-route-editor";
import { routeEditorGate } from "../comp/RouteEditorGate";

/** The task code field's name, as the kit form knows it. */
const CODE = "code";

/** XContest's refusal, in the shape the kit form reads, under the code field. */
function refusal(message: string): SubmitResponse {
  return new Response(JSON.stringify({ error: message, field: CODE }), {
    status: 422,
    headers: { "Content-Type": "application/json" },
  });
}

export function TaskRouteXContestPage() {
  const editor = useRouteEditor();
  const { urlId, compName, taskId, taskName } = editor;
  useCanonicalPath(
    editor.comp && editor.task && editor.current
      ? taskRouteXContestPath(urlId, compName, taskId, taskName)
      : null
  );
  const gate = routeEditorGate(editor);
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
    <div className="max-w-2xl">
      <Breadcrumbs
        items={underTaskRoute(urlId, compName, taskId, taskName)}
        current="Load from XContest"
      />
      <Form
        onSubmit={async () => {
          const wanted = code.trim();
          try {
            const { task } = await fetchTaskByCodeWithRaw(wanted);
            fetched.current = { task, code: wanted.toUpperCase() };
            return undefined;
          } catch (err) {
            // A request that never got an answer is the kit form's to say.
            if (err instanceof TypeError) throw err;
            return refusal(err instanceof Error ? err.message : "Failed to load XContest task");
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
        <SectionHeader
          as="h1"
          className="mt-2"
          title="Load from XContest"
          action={
            <div className="flex items-center gap-2">
              <Button variant="outline" onPress={() => editor.leave()}>
                Cancel
              </Button>
              <SubmitButton pendingLabel="Loading" isDisabled={code.trim() === ""}>
                Load
              </SubmitButton>
            </div>
          }
        />
        <FormErrorBanner className="mt-3" />
        <div className="mt-4 flex flex-col gap-4">
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
        </div>
      </Form>
    </div>
  );
}
