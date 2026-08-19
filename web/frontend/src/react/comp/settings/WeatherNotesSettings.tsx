/**
 * Weather notes — the routed replacement for the dialog that used to open over
 * the task page's Weather section (issue #637). An eight-row textarea in a
 * centred modal is exactly the shape the conversion exists to remove: on a
 * phone the keyboard takes half the screen and the panel takes the rest.
 *
 * A sub-page of the task's settings rather than of the Weather section itself,
 * because it is admin-only writing over a public-read field, and settings is
 * where the task's other admin-only writing lives. The Weather section still
 * links straight here, so the affordance stays beside the notes it edits.
 *
 * Notes are NOT a scoring input. The save goes through the same task PATCH as
 * every other task field, which audit-logs the change with an excerpt (prose,
 * so the sentence quotes rather than diffs) and deliberately does not mark
 * scores stale — see docs/weather.md.
 */
import { useState } from "react";
import { TextField as AriaTextField } from "react-aria-components";
import { SettingsPage } from "@/react/components/SettingsPage";
import { SettingsForm } from "@/react/components/SettingsForm";
import { Description, Label, TextArea } from "@/react/rac/field";
import { api } from "@/comp/api";
import { toast } from "@/react/lib/toast";
import { underTaskSettings } from "@/react/lib/crumbs";
import type { TaskSettingsProps } from "./TaskSettings";

/** Mirrors MAX_WEATHER_NOTES in the worker's validators — the server is the
 * authority; this stops a paste that would only be rejected on save. */
const MAX_NOTES = 4000;

export function WeatherNotesSettings({
  compId,
  taskId,
  comp,
  task,
  onSaved,
}: TaskSettingsProps) {
  const [draft, setDraft] = useState(task.weather_notes);
  const [saving, setSaving] = useState(false);

  const dirty = draft.trim() !== task.weather_notes.trim();

  async function save() {
    setSaving(true);
    try {
      const res = await api.api.comp[":comp_id"].task[":task_id"].$patch({
        param: { comp_id: compId, task_id: taskId },
        // Trimmed on the way in so "cleared" is unambiguous — a field of
        // whitespace would otherwise read as notes that render as nothing.
        json: { weather_notes: draft.trim() },
      });
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        toast.error(err.error || "Failed to save weather notes");
        return;
      }
      toast.success("Weather notes saved");
      onSaved();
    } catch {
      toast.error("Network error. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsPage
      crumbs={underTaskSettings(compId, comp.name, taskId, task.name)}
      title="Weather notes"
    >
      <SettingsForm onSave={save} saving={saving} dirty={dirty}>
        <AriaTextField
          value={draft}
          onChange={setDraft}
          maxLength={MAX_NOTES}
          className="flex flex-col gap-2"
        >
          <Label>What did the day do?</Label>
          <TextArea
            rows={8}
            placeholder={
              "e.g. Slow start, inversion broke about 12:30.\n" +
              "Overdeveloped by 2pm over the back range.\n" +
              "Glass off at 3, most of the field landed short."
            }
          />
          <Description>
            Shown to everyone on this task and alongside the field analysis
            charts. Plain text; line breaks are kept. {draft.length}/{MAX_NOTES}
            characters.
          </Description>
        </AriaTextField>
      </SettingsForm>
    </SettingsPage>
  );
}
