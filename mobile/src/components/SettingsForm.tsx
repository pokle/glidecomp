/**
 * A settings group's form: its fields, the save's outcome, and Save — off
 * until something changed, and the unsaved-changes guard on the way out.
 */
import type { ReactNode } from 'react';

import { FormMessage, FormScreen, PrimaryButton } from '@/ui/form';
import type { FormNote } from '@/ui/use-form-save';
import { useUnsavedGuard } from '@/ui/use-form-save';

export function SettingsForm({
  dirty,
  saving,
  note,
  onSave,
  children,
  testID,
  footer,
}: {
  dirty: boolean;
  saving: boolean;
  note: FormNote;
  onSave: () => void;
  children: ReactNode;
  testID?: string;
  footer?: ReactNode;
}) {
  useUnsavedGuard(dirty, saving, 'these settings');
  return (
    <FormScreen testID={testID}>
      {children}
      {note ? <FormMessage kind={note.kind}>{note.text}</FormMessage> : null}
      <PrimaryButton title="Save" pendingLabel="Saving" pending={saving} disabled={!dirty} onPress={onSave} testID={testID ? `${testID}-save` : undefined} />
      {footer}
    </FormScreen>
  );
}
