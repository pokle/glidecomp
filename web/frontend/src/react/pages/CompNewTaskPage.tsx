/**
 * Creating a task (/comp/:compId/task/new) — ADMIN-ONLY and NOT SSR'd
 * (functions/comp/[[path]].ts serves it a noindex shell, ahead of the public
 * task route whose URL shape it shares; `new` is never a task's id, because a
 * sqid is at least four letters).
 *
 * **A page, not a dialog over the comp** (issue #819). The overlays rule in
 * CLAUDE.md: a dialog with a text field brings up the keyboard over a layer
 * fixed to a scrolled page, which is how the pilot sheet came to stop
 * answering taps on an iPhone. A page gets the keyboard, Back and focus from
 * the browser.
 *
 * Reached by the comp page's "New task" links, so Back is the browser's own
 * and returns to the comp. Create REPLACES this entry with the task it made:
 * Back from the new task goes to the comp, not to a filled-in form whose
 * second Create would make the task twice.
 *
 * The form is a kit `Form` (rac/form.tsx): its own checks and the server's
 * refusals land under the field they are about. The server's names for the
 * fields (`name`, `task_date`, `pilot_classes` — validated() and the create
 * route's own refusals both say which) are the fields' `name`s here, so there
 * is nothing to map.
 */
import { useId, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { NotFound } from "@/react/components/NotFound";
import { OrganisersOnly } from "@/react/components/OrganisersOnly";
import { SettingsPage } from "@/react/components/SettingsPage";
import { CheckList } from "@/react/rac/choice-list";
import { DatePicker } from "@/react/rac/date-picker";
import { Label, TextField } from "@/react/rac/field";
import { Form, FormErrorBanner, SubmitButton } from "@/react/rac/form";
import { Loading } from "@/react/rac/progress";
import { api } from "../../comp/api";
import type { CompDetailData } from "../comp/types";
import { underComp } from "../lib/crumbs";
import { todayInZone } from "../lib/format";
import { compNewTaskPath, compPath, compUrlId, idFromSegment, taskPath } from "../lib/slug";
import { useCanonicalPath } from "../lib/use-canonical-path";
import { useSeededResource } from "../lib/use-seeded-resource";
import { useAdminView, useUser } from "../lib/user";

const TITLE = "Create task";

export function CompNewTaskPage() {
  const { compId: compParam } = useParams<{ compId: string }>();
  const compId = idFromSegment(compParam ?? "");
  const { loading } = useUser();

  const { data: comp, notFound, current } = useSeededResource<CompDetailData>({
    ids: [compId],
    seed: null,
    load: ([comp_id]) => api.api.comp[":comp_id"].$get({ param: { comp_id } }),
    title: (c) => `GlideComp - ${c.name} new task`,
  });
  // The share key rides in every link a hidden comp's page builds.
  const urlId = comp ? compUrlId(comp, compId) : compId;

  // Not from a comp still held over from the URL the page was on before.
  useCanonicalPath(comp && current ? compNewTaskPath(urlId, comp.name) : null);

  const isAdmin = useAdminView(!!comp?.is_admin);

  if (notFound || !compId) return <NotFound title="Competition not found" />;
  if (!comp || loading) return <Loading>Loading competition…</Loading>;

  if (!isAdmin) return <OrganisersOnly to={compPath(urlId, comp.name)} />;

  return <NewTaskForm compId={urlId} comp={comp} />;
}

function NewTaskForm({ compId, comp }: { compId: string; comp: CompDetailData }) {
  const navigate = useNavigate();
  const dateId = useId();
  const [name, setName] = useState("");
  // Today where the competition is flown, not where the organiser's laptop is.
  const [taskDate, setTaskDate] = useState(() => todayInZone(comp.timezone));
  // Every class ticked to begin with: most tasks are flown by the whole comp.
  const [selectedClasses, setSelectedClasses] = useState<string[]>(comp.pilot_classes);

  return (
    <SettingsPage crumbs={underComp(compId, comp.name)} title={TITLE}>
      <Form
        validate={() => ({
          name: name.trim() ? null : "Enter a task name",
          task_date: taskDate ? null : "Enter a date",
          pilot_classes:
            selectedClasses.length > 0 ? null : "Select at least one pilot class",
        })}
        onSubmit={() =>
          api.api.comp[":comp_id"].task.$post({
            param: { comp_id: compId },
            json: { name: name.trim(), task_date: taskDate, pilot_classes: selectedClasses },
          })
        }
        onSuccess={async (res) => {
          const task = (await res!.json()) as { task_id: string; name: string };
          // Replace, not push: see the note at the top.
          navigate(taskPath(compId, comp.name, task.task_id, task.name), { replace: true });
        }}
        className="flex flex-col gap-6"
      >
        <TextField
          label="Name"
          name="name"
          maxLength={128}
          placeholder="e.g. Day 1 - Ridge Run"
          value={name}
          onChange={setName}
          autoComplete="off"
        />
        {/* The same two controls the task's settings page uses (#638), so a
            task looks the same the moment after it is created as it does
            when it is next edited. */}
        <div className="flex flex-col gap-2">
          <Label id={dateId}>Date</Label>
          <DatePicker
            inline
            name="task_date"
            aria-labelledby={dateId}
            value={taskDate}
            onChange={setTaskDate}
          />
        </div>
        <CheckList
          label="Pilot classes"
          name="pilot_classes"
          value={selectedClasses}
          onChange={setSelectedClasses}
          options={comp.pilot_classes.map((cls) => ({ value: cls, label: cls }))}
        />
        {/* The error that belongs to no field sits beside Create, the
            button the reader just pressed. */}
        <FormErrorBanner />
        <div>
          <SubmitButton pendingLabel="Creating">Create</SubmitButton>
        </div>
      </Form>
    </SettingsPage>
  );
}
