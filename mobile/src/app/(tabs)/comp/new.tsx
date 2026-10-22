/**
 * New competition (IA Q10, stage 7): the website's Start a new competition,
 * on the phone. Creating it makes the reader its organiser, and drops them
 * into it — the next thing is a task, and the comp view's Organiser group is
 * where that starts.
 */
import { PILOT_CLASS_EXAMPLES, parsePilotClasses, WING_CHOICES } from '@glidecomp/client/comp-fields';
import { compPath } from '@glidecomp/client/slug';
import { router, Stack } from 'expo-router';
import { useState } from 'react';

import { createComp } from '@/api/organiser';
import { Choices, Field, FormCard, FormHint, FormMessage, FormScreen, PrimaryButton, Toggle } from '@/ui/form';
import { useFormSave, useUnsavedGuard } from '@/ui/use-form-save';

export default function NewCompScreen() {
  const [name, setName] = useState('');
  const [category, setCategory] = useState<'hg' | 'pg'>('hg');
  const [classes, setClasses] = useState('open');
  const [test, setTest] = useState(false);
  const { saving, note, run } = useFormSave();
  const [made, setMade] = useState(false);
  useUnsavedGuard(name.trim() !== '' && !made, saving, 'this competition');

  async function create() {
    const comp = await run(() =>
      createComp({ name: name.trim(), category, test, pilot_classes: parsePilotClasses(classes) }),
    );
    if (comp) {
      setMade(true);
      router.replace(compPath(comp.comp_id, comp.name) as never);
    }
  }

  return (
    <FormScreen testID="new-comp">
      <Stack.Screen options={{ title: 'New competition', headerLargeTitle: false }} />
      <FormCard>
        <Field label="Name" value={name} onChangeText={setName} placeholder="e.g. Corryong Cup 2026" testID="new-comp-name" />
        <Choices label="Wing" value={category} choices={WING_CHOICES} onChange={setCategory} testID="new-comp-wing" />
        <FormHint>Sets the official CIVL GAP scoring defaults for your wing. You can fine-tune them later in Settings.</FormHint>
        <Field
          label="Pilot classes"
          value={classes}
          onChangeText={setClasses}
          autoCapitalize="none"
          placeholder={PILOT_CLASS_EXAMPLES[category][1]}
          testID="new-comp-classes"
        />
        <Choices
          label="Or pick an example"
          value={PILOT_CLASS_EXAMPLES[category].includes(classes) ? classes : ''}
          choices={PILOT_CLASS_EXAMPLES[category].map((e) => ({ value: e, label: e }))}
          onChange={setClasses}
        />
        <FormHint>Separately-scored divisions of the field, comma-separated.</FormHint>
        <Toggle
          label="Hidden"
          hint="Hidden from the public and pilots — only organisers can see it."
          value={test}
          onChange={setTest}
          testID="new-comp-hidden"
        />
      </FormCard>
      {note ? <FormMessage kind={note.kind}>{note.text}</FormMessage> : null}
      <PrimaryButton
        title="Create"
        pendingLabel="Creating the competition"
        pending={saving}
        disabled={name.trim() === ''}
        onPress={() => void create()}
        testID="new-comp-create"
      />
    </FormScreen>
  );
}
