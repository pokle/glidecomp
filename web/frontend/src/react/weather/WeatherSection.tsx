/**
 * The task page's "Weather" section: the organizer's notes on what the day
 * actually did, followed by the modelled conditions (TaskWeatherPanel) —
 * the same charts the field-analysis report leads with. The conditions are
 * context for reading everything below them on the page, which is why this
 * sits under the route and above the results.
 *
 * Notes are public to READ (anyone who can see the task sees them),
 * admin-only to WRITE. That asymmetry is the point of the feature: the
 * modelled weather is a grid cell kilometres wide, and the people who ran
 * the day know things it cannot — that the cycle went through at one, that
 * the valley wind switched, that half the field got flushed off launch.
 *
 * Rendered for admins even when there is nothing yet, so there is somewhere
 * to click to add the first note; hidden from everyone else only when there
 * is nothing to read at all — no notes, no charts, and no answer on its way.
 *
 * Notes are not a scoring input. Saving goes through the task PATCH like
 * every other task field, which audit-logs the change (with an excerpt,
 * since this is prose) and deliberately does NOT mark scores stale.
 */
import { useState } from "react";
import { Form } from "react-aria-components";
import { Button } from "@/react/rac/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Modal,
} from "@/react/rac/dialog";
import { Description, Label, TextArea } from "@/react/rac/field";
import { TextField as AriaTextField } from "react-aria-components";
import { SectionHeader } from "@/react/components/SectionHeader";
import { api } from "../../comp/api";
import { toast } from "../lib/toast";
import { WeatherNotesBlock } from "./WeatherNotesBlock";
import { TaskWeatherPanel } from "./TaskWeatherPanel";
import type { TaskWeatherState } from "./use-task-weather";
import { Card } from "@/react/rac/card";

/** Mirrors MAX_WEATHER_NOTES in the worker's validators — the server is the
 * authority; this stops a paste that would only be rejected on save. */
const MAX_NOTES = 4000;

export function WeatherSection({
  compId,
  taskId,
  weather,
  notes,
  isAdmin,
  compTimezone,
  onSaved,
}: {
  compId: string;
  taskId: string;
  /**
   * Fetched by the page and handed down, not fetched here. The task page's
   * route views want the same answer for their wind, and the endpoint can
   * schedule a background provider fetch — so it is asked once.
   */
  weather: TaskWeatherState;
  notes: string;
  isAdmin: boolean;
  /** Competition IANA zone; the charts' axis ticks in it. */
  compTimezone: string | null;
  onSaved: (notes: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const hasNotes = notes.trim().length > 0;

  const weatherPending = weather.loading || weather.data?.pending === true;
  const hasWeather = weatherPending || weather.data?.weather != null;
  // A task set beyond the forecast horizon explains itself in the panel, but
  // it doesn't open the section on its own: for a reader with nothing else to
  // see here, "no weather yet" is noise. The admin who scheduled the comp
  // that far ahead always has the section open, and gets the explanation.
  const tooFarAhead = weather.data?.too_far_ahead === true;

  if (!hasNotes && !hasWeather && !isAdmin) return null;

  return (
    <Card>
      <SectionHeader
        title="Weather"
        action={
          isAdmin ? (
            <Button variant="outline" size="sm" onPress={() => setEditing(true)}>
              {hasNotes ? "Edit notes…" : "Add notes…"}
            </Button>
          ) : null
        }
      />
      {hasNotes ? (
        <WeatherNotesBlock notes={notes} className="mt-2 text-sm whitespace-pre-line" />
      ) : isAdmin ? (
        <p className="mt-2 text-muted-foreground">
          No weather notes yet. Record what the day did — the conditions pilots
          flew in are context the scores can&rsquo;t show.
        </p>
      ) : null}
      {hasWeather || tooFarAhead ? (
        <div className="mt-3">
          <TaskWeatherPanel
            weather={weather.data?.weather ?? null}
            compTimezone={compTimezone}
            pending={weatherPending}
            tooFarAhead={tooFarAhead}
          />
        </div>
      ) : null}
      {editing ? (
        <EditWeatherNotesDialog
          compId={compId}
          taskId={taskId}
          notes={notes}
          onClose={() => setEditing(false)}
          onSaved={(saved) => {
            setEditing(false);
            onSaved(saved);
          }}
        />
      ) : null}
    </Card>
  );
}

function EditWeatherNotesDialog({
  compId,
  taskId,
  notes,
  onClose,
  onSaved,
}: {
  compId: string;
  taskId: string;
  notes: string;
  onClose: () => void;
  onSaved: (notes: string) => void;
}) {
  const [draft, setDraft] = useState(notes);
  const [saving, setSaving] = useState(false);

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
      onSaved(draft.trim());
    } catch {
      toast.error("Network error. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      className="sm:max-w-xl"
    >
      <Dialog>
        <DialogHeader>
          <DialogTitle>Weather notes</DialogTitle>
        </DialogHeader>
        <Form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
          className="flex flex-col gap-4"
        >
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
          <DialogFooter>
            <Button variant="outline" onPress={onClose} isDisabled={saving}>
              Cancel
            </Button>
            <Button type="submit" isDisabled={saving}>
              {saving ? "Saving…" : "Save notes"}
            </Button>
          </DialogFooter>
        </Form>
      </Dialog>
    </Modal>
  );
}
