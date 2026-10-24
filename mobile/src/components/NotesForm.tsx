/**
 * A block of the organiser's prose — the competition's notes, a task's
 * weather notes — as one multi-line field and Save. Trimmed on the way in so
 * "cleared" is unambiguous, as the website does; 4000 characters, the
 * server's cap.
 */
import { useState } from 'react';

import { Field, FormCard, FormHint, FormMessage, FormScreen, PrimaryButton } from '@/ui/form';
import { useFormSave, useUnsavedGuard } from '@/ui/use-form-save';

const MAX_NOTES = 4000;

export function NotesForm({
  label,
  placeholder,
  hint,
  saved,
  save,
  onSaved,
  testID,
}: {
  label: string;
  placeholder: string;
  hint: string;
  saved: string;
  save: (text: string) => Promise<unknown>;
  onSaved: () => void;
  testID?: string;
}) {
  const [draft, setDraft] = useState(saved);
  const { saving, note, run } = useFormSave();
  const [done, setDone] = useState(false);
  const dirty = draft.trim() !== saved.trim() && !done;
  useUnsavedGuard(dirty, saving, 'these notes');

  async function submit() {
    const ok = await run(async () => {
      await save(draft.trim());
      return true;
    });
    if (ok) {
      setDone(true);
      // Let the guard see the saved state before leaving.
      setTimeout(onSaved, 0);
    }
  }

  return (
    <FormScreen testID={testID}>
      <FormCard>
        <Field
          label={label}
          value={draft}
          onChangeText={setDraft}
          multiline
          maxLength={MAX_NOTES}
          placeholder={placeholder}
          style={{ minHeight: 180, paddingTop: 10, textAlignVertical: 'top' }}
          testID={testID ? `${testID}-field` : undefined}
        />
        <FormHint>{`${hint} ${draft.length}/${MAX_NOTES} characters.`}</FormHint>
      </FormCard>
      {note ? <FormMessage kind={note.kind}>{note.text}</FormMessage> : null}
      <PrimaryButton
        title="Save"
        pendingLabel="Saving"
        pending={saving}
        disabled={!dirty}
        onPress={() => void submit()}
        testID={testID ? `${testID}-save` : undefined}
      />
    </FormScreen>
  );
}
