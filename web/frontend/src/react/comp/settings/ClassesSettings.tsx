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
import { underCompSettings } from "@/react/lib/crumbs";
import { ChoiceList } from "@/react/rac/choice-list";
import { PilotClassesField } from "../fields";
import type { SettingsGroupProps } from "./CompSettingsIndex";

export function ClassesSettings({ compId, comp, onSaved }: SettingsGroupProps) {
  const savedText = comp.pilot_classes.join(", ");
  const [pilotClassesText, setPilotClassesText] = useState(savedText);
  const [defaultClass, setDefaultClass] = useState(comp.default_pilot_class);

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

  return (
    <SettingsPage
      crumbs={underCompSettings(compId, comp.name)}
      title="Pilot classes"
    >
      <SettingsForm
        dirty={dirty}
        validate={() => ({
          pilot_classes: classes.length === 0 && "At least one pilot class is required",
        })}
        onSubmit={() =>
          api.api.comp[":comp_id"].$patch({
            param: { comp_id: compId },
            json: {
              pilot_classes: classes,
              default_pilot_class: effectiveDefault,
            },
          })
        }
        onSuccess={onSaved}
      >
        {/* Named as the API names them, so a refusal lands under its field. */}
        <PilotClassesField
          value={pilotClassesText}
          onChange={setPilotClassesText}
          wing={comp.category === "pg" ? "pg" : "hg"}
        />

        <ChoiceList
          label="Default pilot class"
          name="default_pilot_class"
          value={effectiveDefault}
          onChange={setDefaultClass}
          options={classes.map((cls) => ({ value: cls, label: cls }))}
          description="Assigned to auto-registered pilots"
        />
      </SettingsForm>
    </SettingsPage>
  );
}
