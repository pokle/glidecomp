/**
 * Task settings — the routed replacement for the "Task Settings" dialog that
 * used to open over the task page (issue #637). Every field came across, and
 * the copy with it — bar the submissions switch, since reworded and flipped to
 * read positively (#649).
 *
 * FLAT, where the competition's settings are an index of grouped sub-pages
 * (comp/settings/CompSettingsIndex.tsx): a task has five settings, which is a
 * form and not a hierarchy — an index of two rows would be a tap that buys
 * nothing. The `NavList` at the foot is therefore not a group index; it holds
 * the two things that ARE their own pages (the route editor, the weather
 * notes) plus the destructive action, which stays out of the form for the
 * reason the comp index gives: it is an action, not a setting, and it has no
 * business next to a Save button.
 *
 * The controls are the settings-page family rather than the dialog one:
 * `DatePicker inline` (a calendar in flow, nothing for a phone keyboard to
 * cover), `CheckList` for the classes and `SwitchList` for the boolean.
 */
import { useId, useState } from "react";
import { useNavigate } from "react-router-dom";
import { SettingsPage } from "@/react/components/SettingsPage";
import { SettingsForm } from "@/react/components/SettingsForm";
import { NavActionRow, NavList } from "@/react/rac/nav-list";
import { CheckList } from "@/react/rac/choice-list";
import { SwitchField, SwitchList } from "@/react/rac/switch";
import { TextField, Description, Label } from "@/react/rac/field";
import { DatePicker, TimePicker } from "@/react/rac/date-picker";
import { api } from "@/comp/api";
import { toast } from "@/react/lib/toast";
import { useConfirm } from "@/react/lib/confirm";
import { underTask } from "@/react/lib/crumbs";
import { compPath } from "@/react/lib/slug";
import {
  utcISOToZonedDateTimeLocal,
  zonedDateTimeLocalToUtcISO,
  zoneLabel,
} from "@/react/lib/time";
import type { CompDetailData, TaskDetailData } from "../types";

interface TaskSettingsProps {
  compId: string;
  taskId: string;
  comp: CompDetailData;
  task: TaskDetailData;
  /** Called after a successful save; the caller refreshes and goes up. */
  onSaved: () => void;
}

export function TaskSettings({
  compId,
  taskId,
  comp,
  task,
  onSaved,
}: TaskSettingsProps) {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const dateId = useId();
  const stopId = useId();
  const timezone = comp.timezone ?? null;
  const compPilotClasses = comp.pilot_classes;

  const savedClasses = compPilotClasses.filter((cls) =>
    task.pilot_classes.includes(cls)
  );
  // The stop is edited as a comp-local wall-clock time of day ("" = task not
  // stopped) — the stop is always on the task date, so only the time is
  // editable. Recombined with taskDate on save and stored/scored as a UTC
  // instant.
  const savedStopTime = task.stop_announcement_time
    ? (utcISOToZonedDateTimeLocal(task.stop_announcement_time, timezone)?.slice(
        11,
        16
      ) ?? "")
    : "";

  const [name, setName] = useState(task.name);
  const [taskDate, setTaskDate] = useState(task.task_date);
  const [selectedClasses, setSelectedClasses] = useState<string[]>(savedClasses);
  const [stopTime, setStopTime] = useState(savedStopTime);
  // Held POSITIVELY, against a column that is stored negatively
  // (`submissions_closed`, migration 0028). A switch reads as "turn this on to
  // get it" and a negative one inverts that: off-means-open had organisers
  // reading the row as the opposite of what it did (#649). The column keeps
  // its name — its default of 0 is what makes a new task open — and the
  // inversion happens here, at the two edges of this component.
  const [submissionsOpen, setSubmissionsOpen] = useState(
    !task.submissions_closed
  );
  const [saving, setSaving] = useState(false);

  const dirty =
    name !== task.name ||
    taskDate !== task.task_date ||
    stopTime !== savedStopTime ||
    submissionsOpen !== !task.submissions_closed ||
    selectedClasses.length !== savedClasses.length ||
    selectedClasses.some((cls) => !savedClasses.includes(cls));

  async function save() {
    if (selectedClasses.length === 0) {
      toast.warning("Select at least one pilot class");
      return;
    }

    // The stop is on the task date; combine it with the comp-local stop time.
    const stopIso =
      stopTime && taskDate
        ? zonedDateTimeLocalToUtcISO(`${taskDate}T${stopTime}`, timezone)
        : null;
    if (stopTime && !stopIso) {
      toast.warning("Enter a valid stop time");
      return;
    }

    setSaving(true);
    try {
      const res = await api.api.comp[":comp_id"].task[":task_id"].$patch({
        param: { comp_id: compId, task_id: taskId },
        json: {
          name: name.trim(),
          task_date: taskDate,
          pilot_classes: selectedClasses,
          stop_announcement_time: stopIso,
          submissions_closed: !submissionsOpen,
        },
      });

      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        toast.error(err.error || "Failed to update task");
        return;
      }

      onSaved();
    } catch {
      toast.error("Network error. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function deleteTask() {
    const confirmed = await confirm({
      title: "Delete this task?",
      message: "This cannot be undone.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!confirmed) return;

    try {
      const res = await api.api.comp[":comp_id"].task[":task_id"].$delete({
        param: { comp_id: compId, task_id: taskId },
      });

      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        toast.error(err.error || "Failed to delete task");
        return;
      }

      navigate(compPath(compId, comp.name));
    } catch {
      toast.error("Network error. Please try again.");
    }
  }

  return (
    <SettingsPage
      crumbs={underTask(compId, comp.name, taskId, task.name)}
      title="Settings"
    >
      <SettingsForm onSave={save} saving={saving} dirty={dirty}>
        <TextField
          label="Name"
          isRequired
          maxLength={128}
          value={name}
          onChange={setName}
          errorMessage="Enter a task name"
        />

        <div className="flex flex-col gap-2">
          <Label id={dateId}>Date</Label>
          <DatePicker
            inline
            required
            aria-labelledby={dateId}
            value={taskDate}
            onChange={setTaskDate}
          />
        </div>

        <CheckList
          label="Pilot Classes"
          value={selectedClasses}
          onChange={setSelectedClasses}
          options={compPilotClasses.map((cls) => ({ value: cls, label: cls }))}
        />

        <div className="flex flex-col gap-2">
          <Label id={stopId}>
            Task stop (
            {zoneLabel(new Date(`${taskDate}T12:00:00Z`), timezone ?? "UTC")})
          </Label>
          {/* A segmented time field, not a popover — nothing to convert here,
              and nothing that opens over the description below it. */}
          <TimePicker
            clearable
            aria-labelledby={stopId}
            value={stopTime}
            onChange={setStopTime}
          />
          <Description>
            Set only when the task was stopped mid-flight (weather calldown).
            Scores are recomputed under the stopped-task rules (FAI S7F §13.4):
            a scored-back stop time, a clipped scoring window, and an altitude
            bonus for pilots still flying. Leave empty for a task that ran to
            completion.
          </Description>
        </div>

        <SwitchList>
          <SwitchField
            checked={submissionsOpen}
            onChange={setSubmissionsOpen}
            label="Open for track submissions"
            hint="Turn this off and pilots can no longer send tracks or manual flights for this task. Organisers still can, so a late recovery does not need it turned back on."
          />
        </SwitchList>
      </SettingsForm>

      {/* No nav rows for the route or the weather notes, though both are
          routed editors of this task. Each is reached from its own section on
          the task page, beside the content it edits — which is where a
          section-scoped manage action belongs (see the IA doc's design
          language). Listing them here as well would duplicate those entry
          points and, worse, frame content as settings. */}
      <NavList label="Danger zone">
        <NavActionRow
          destructive
          label="Delete task"
          onPress={() => void deleteTask()}
        />
      </NavList>
    </SettingsPage>
  );
}
