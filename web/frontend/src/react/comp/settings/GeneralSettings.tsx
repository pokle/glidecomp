/**
 * General settings sub-page: Name, Wing, Timezone and the organiser's notes
 * (migration 0037). Only this group's fields go in the PATCH (the server
 * diffs per field).
 *
 * Close Date lives on the Access page: what it controls is when track
 * submissions stop being accepted, which is the same question as who may
 * submit at all.
 */
import { useState } from "react";
import { TextField as AriaTextField } from "react-aria-components";
import { SettingsPage } from "@/react/components/SettingsPage";
import { SettingsForm } from "@/react/components/SettingsForm";
import { api } from "@/comp/api";
import { underCompSettings } from "@/react/lib/crumbs";
import { SearchableChoiceList } from "@/react/rac/choice-list";
import { Description, FieldError, Label, TextArea } from "@/react/rac/field";
import { CategoryField, NameField } from "../fields";
import type { SettingsGroupProps } from "./CompSettingsIndex";

/**
 * Timezone dropdown options: "auto" plus every zone the runtime knows.
 * A stored zone the runtime doesn't list (e.g. saved by a newer browser)
 * is kept selectable rather than silently remapped.
 */
function timezoneOptions(current: string | null) {
  const zones: string[] =
    typeof Intl.supportedValuesOf === "function"
      ? [...Intl.supportedValuesOf("timeZone")]
      : [];
  if (current && !zones.includes(current)) zones.unshift(current);
  return [
    { value: "auto", label: "Auto — derive from the task location" },
    ...zones.map((z) => ({ value: z, label: z })),
  ];
}

/** Mirrors MAX_ORGANISER_NOTES in the competition worker's validators. */
const MAX_ORGANISER_NOTES = 4000;

export function GeneralSettings({ compId, comp, onSaved }: SettingsGroupProps) {
  const savedCategory = comp.category === "hg" ? "hg" : "pg";

  const [name, setName] = useState(comp.name);
  const [category, setCategory] = useState<"hg" | "pg">(savedCategory);
  // "auto" = no explicit zone: the server derives one from the task
  // location (and re-derives when saved as auto).
  const [timezone, setTimezone] = useState(comp.timezone ?? "auto");
  const savedNotes = comp.organiser_notes ?? "";
  const [notes, setNotes] = useState(savedNotes);

  const dirty =
    name !== comp.name ||
    category !== savedCategory ||
    timezone !== (comp.timezone ?? "auto") ||
    notes.trim() !== savedNotes.trim();

  return (
    <SettingsPage crumbs={underCompSettings(compId, comp.name)} title="General">
      <SettingsForm
        dirty={dirty}
        validate={() => ({ name: !name.trim() && "Enter a competition name" })}
        onSubmit={() =>
          api.api.comp[":comp_id"].$patch({
            param: { comp_id: compId },
            json: {
              name: name.trim(),
              category,
              timezone: timezone === "auto" ? null : timezone,
              organiser_notes: notes.trim(),
            },
          })
        }
        onSuccess={onSaved}
      >
        {/* Named as the API names them, so a refusal lands under its field.
            The timezone row has no input to carry a name: a refusal about it
            is shown beside Save. */}
        <NameField value={name} onChange={setName} />

        <CategoryField value={category} onChange={setCategory} />

        <SearchableChoiceList
          label="Timezone"
          value={timezone}
          onChange={setTimezone}
          options={timezoneOptions(comp.timezone)}
          searchLabel="Search timezones"
          searchPlaceholder="Type to search, e.g. Melbourne"
          description="The zone times are shown in. Auto uses the task location. Doesn't affect scoring."
        />

        <AriaTextField
          name="organiser_notes"
          value={notes}
          onChange={setNotes}
          maxLength={MAX_ORGANISER_NOTES}
          className="flex flex-col gap-2"
        >
          <Label>Notes for every pilot</Label>
          <TextArea
            rows={6}
            placeholder={
              "e.g. Briefing 9:30 at the launch shelter.\n" +
              "Retrieve leaves from the pub at 6."
            }
          />
          <Description>
            Shown under the organisers on the competition's page. Plain text.
            Up to 4,000 characters.
          </Description>
          <FieldError />
        </AriaTextField>
      </SettingsForm>
    </SettingsPage>
  );
}
