/**
 * Pilot classes sub-page: the class list and the default class. These two
 * stay together because the server validates them jointly (the default must
 * be one of the classes). Copy carried over verbatim from the old settings
 * dialog.
 */
import { useState } from "react";
import { SettingsPage } from "@/react/components/SettingsPage";
import { SettingsForm } from "@/react/components/SettingsForm";
import { api } from "@/comp/api";
import { toast } from "@/react/lib/toast";
import { underCompSettings } from "@/react/lib/crumbs";
import { ChoiceList } from "@/react/rac/choice-list";
import { PilotClassesField } from "../fields";
import type { SettingsGroupProps } from "./CompSettingsIndex";

export function ClassesSettings({ compId, comp, onSaved }: SettingsGroupProps) {
  const savedText = comp.pilot_classes.join(", ");
  const [pilotClassesText, setPilotClassesText] = useState(savedText);
  const [defaultClass, setDefaultClass] = useState(comp.default_pilot_class);
  const [saving, setSaving] = useState(false);

  // Live class list for the default-class dropdown.
  const classes = pilotClassesText
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  // When the chosen default disappears from the class list, fall back to the
  // first option.
  const effectiveDefault = classes.includes(defaultClass)
    ? defaultClass
    : (classes[0] ?? "");

  const dirty =
    pilotClassesText !== savedText ||
    effectiveDefault !== comp.default_pilot_class;

  async function save() {
    if (classes.length === 0) {
      toast.warning("At least one pilot class is required");
      return;
    }
    setSaving(true);
    try {
      const res = await api.api.comp[":comp_id"].$patch({
        param: { comp_id: compId },
        json: {
          pilot_classes: classes,
          default_pilot_class: effectiveDefault,
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
    <SettingsPage
      crumbs={underCompSettings(compId, comp.name)}
      title="Pilot classes"
    >
      <SettingsForm onSave={save} saving={saving} dirty={dirty}>
        <PilotClassesField
          value={pilotClassesText}
          onChange={setPilotClassesText}
          wing={comp.category === "pg" ? "pg" : "hg"}
        />

        <ChoiceList
          label="Default Pilot Class"
          value={effectiveDefault}
          onChange={setDefaultClass}
          options={classes.map((cls) => ({ value: cls, label: cls }))}
          description="Assigned to auto-registered pilots"
        />
      </SettingsForm>
    </SettingsPage>
  );
}
