/**
 * The task page's "Weather notes" section — the organizer's account of what
 * the day actually did.
 *
 * Public to READ (anyone who can see the task sees the notes), admin-only to
 * WRITE. That asymmetry is the point of the feature: the modelled weather on
 * the field-analysis page is a grid cell kilometres wide, and the people who
 * ran the day know things it cannot — that the cycle went through at one,
 * that the valley wind switched, that half the field got flushed off launch.
 * Pilots reading the analysis need that context; only organizers can supply
 * it.
 *
 * Rendered for admins even when empty, so there is somewhere to click to add
 * the first note; hidden entirely from everyone else when there is nothing to
 * read, rather than showing a permanently empty section.
 *
 * Not a scoring input. Saving goes through the task PATCH like every other
 * task field, which audit-logs the change (with an excerpt, since this is
 * prose) and deliberately does NOT mark scores stale.
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

/** Mirrors MAX_WEATHER_NOTES in the worker's validators — the server is the
 * authority; this stops a paste that would only be rejected on save. */
const MAX_NOTES = 4000;

export function WeatherNotesSection({
  compId,
  taskId,
  notes,
  isAdmin,
  onSaved,
}: {
  compId: string;
  taskId: string;
  notes: string;
  isAdmin: boolean;
  onSaved: (notes: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const hasNotes = notes.trim().length > 0;

  if (!hasNotes && !isAdmin) return null;

  return (
    <section>
      <SectionHeader
        title="Weather notes"
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
      ) : (
        <p className="mt-2 text-muted-foreground">
          No weather notes yet. Record what the day did — the conditions pilots
          flew in are context the scores can&rsquo;t show.
        </p>
      )}
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
    </section>
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
