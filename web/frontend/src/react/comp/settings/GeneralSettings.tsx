/**
 * General settings sub-page: Name, Wing, Timezone. Fields and their copy
 * carried over verbatim from the old settings dialog; only this group's
 * fields go in the PATCH (the server diffs per field).
 *
 * Close Date lives on the Access page: what it controls is when track
 * submissions stop being accepted, which is the same question as who may
 * submit at all.
 */
import { useState } from "react";
import { SettingsPage } from "@/react/components/SettingsPage";
import { SettingsForm } from "@/react/components/SettingsForm";
import { api } from "@/comp/api";
import { toast } from "@/react/lib/toast";
import { underCompSettings } from "@/react/lib/crumbs";
import { SearchableChoiceList } from "@/react/rac/choice-list";
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

export function GeneralSettings({ compId, comp, onSaved }: SettingsGroupProps) {
  const savedCategory = comp.category === "hg" ? "hg" : "pg";

  const [name, setName] = useState(comp.name);
  const [category, setCategory] = useState<"hg" | "pg">(savedCategory);
  // "auto" = no explicit zone: the server derives one from the task
  // location (and re-derives when saved as auto).
  const [timezone, setTimezone] = useState(comp.timezone ?? "auto");
  const [saving, setSaving] = useState(false);

  const dirty =
    name !== comp.name ||
    category !== savedCategory ||
    timezone !== (comp.timezone ?? "auto");

  async function save() {
    setSaving(true);
    try {
      const res = await api.api.comp[":comp_id"].$patch({
        param: { comp_id: compId },
        json: {
          name: name.trim(),
          category,
          timezone: timezone === "auto" ? null : timezone,
        },
      });
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        toast.error(err.error || "Failed to update competition");
        return;
      }
      onSaved();
    } catch {
      toast.error("Network error. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsPage crumbs={underCompSettings(compId, comp.name)} title="General">
      <SettingsForm onSave={save} saving={saving} dirty={dirty}>
        <NameField value={name} onChange={setName} />

        <CategoryField value={category} onChange={setCategory} />

        <SearchableChoiceList
          label="Timezone"
          value={timezone}
          onChange={setTimezone}
          options={timezoneOptions(comp.timezone)}
          searchLabel="Search timezones"
          searchPlaceholder="Type to search, e.g. Melbourne"
          description="Comp-local zone for displaying times (start gates, replay clock, score narratives). Auto derives it from the task location. Scoring runs on UTC and is unaffected."
        />
      </SettingsForm>
    </SettingsPage>
  );
}
