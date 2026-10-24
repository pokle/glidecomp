/**
 * Settings → Pilot classes: the separately-scored divisions, and the default
 * a self-registered pilot gets. Classes are a scoring input.
 */
import { PILOT_CLASS_EXAMPLES, parsePilotClasses } from '@glidecomp/client/comp-fields';
import type { CompDetailData } from '@glidecomp/client/types';
import { useState } from 'react';

import { updateComp } from '@/api/organiser';
import { CompSettingsScreen } from '@/components/CompSettingsScreen';
import { SettingsForm } from '@/components/SettingsForm';
import { Choices, Field, FormCard, FormHint } from '@/ui/form';
import { useFormSave } from '@/ui/use-form-save';

export default function ClassesSettings() {
  return <CompSettingsScreen title="Pilot classes">{(comp) => <Form comp={comp} />}</CompSettingsScreen>;
}

function Form({ comp }: { comp: CompDetailData }) {
  const wing = comp.category === 'pg' ? 'pg' : 'hg';
  const [base, setBase] = useState({ text: comp.pilot_classes.join(', '), def: comp.default_pilot_class });
  const [text, setText] = useState(base.text);
  const [def, setDef] = useState(base.def);
  const { saving, note, run } = useFormSave();
  const classes = parsePilotClasses(text);
  const effectiveDefault = classes.includes(def) ? def : classes[0];
  const dirty = classes.join(', ') !== parsePilotClasses(base.text).join(', ') || effectiveDefault !== base.def;

  async function save() {
    const ok = await run(() => updateComp(comp.comp_id, { pilot_classes: classes, default_pilot_class: effectiveDefault }), 'Saved.');
    if (ok !== undefined) setBase({ text: classes.join(', '), def: effectiveDefault });
  }

  return (
    <SettingsForm dirty={dirty} saving={saving} note={note} onSave={() => void save()} testID="settings-classes-form">
      <FormCard>
        <Field label="Pilot classes" value={text} onChangeText={setText} autoCapitalize="none" testID="settings-classes" />
        <Choices
          label="Or pick an example"
          value={PILOT_CLASS_EXAMPLES[wing].includes(text) ? text : ''}
          choices={PILOT_CLASS_EXAMPLES[wing].map((e) => ({ value: e, label: e }))}
          onChange={setText}
        />
        <FormHint>Separately-scored divisions of the field, comma-separated.</FormHint>
        <Choices label="Default pilot class" value={effectiveDefault} choices={classes.map((c) => ({ value: c, label: c }))} onChange={setDef} testID="settings-default-class" />
        <FormHint>Assigned to auto-registered pilots.</FormHint>
      </FormCard>
    </SettingsForm>
  );
}
