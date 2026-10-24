/**
 * What every organiser form shares: leaving with unsaved changes asks first
 * (the website's guard), and a save says it is happening, then what came
 * of it in the server's own words.
 */
import { useNavigation, usePreventRemove } from 'expo-router';
import { useState } from 'react';
import { Alert } from 'react-native';

import { writeErrorText } from '@/api/organiser';

export type FormNote = { kind: 'status' | 'error'; text: string } | null;

export function useUnsavedGuard(dirty: boolean, busy: boolean, what = 'these changes') {
  const navigation = useNavigation();
  usePreventRemove(dirty && !busy, ({ data }) => {
    Alert.alert('Discard changes?', `You haven’t saved ${what}. Leaving will discard them.`, [
      { text: 'Keep editing', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: () => navigation.dispatch(data.action) },
    ]);
  });
}

/** Run a write: `saving` while it is in flight, then a status or the refusal. */
export function useFormSave() {
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<FormNote>(null);
  async function run<T>(write: () => Promise<T>, done?: string): Promise<T | undefined> {
    setNote(null);
    setSaving(true);
    try {
      const out = await write();
      if (done) setNote({ kind: 'status', text: done });
      return out;
    } catch (err) {
      setNote({ kind: 'error', text: writeErrorText(err) });
      return undefined;
    } finally {
      setSaving(false);
    }
  }
  return { saving, note, setNote, run };
}

/** Ask before a destructive write; resolves true when the reader confirms. */
export function confirmDestructive(title: string, message: string, action: string): Promise<boolean> {
  return new Promise((resolve) =>
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: action, style: 'destructive', onPress: () => resolve(true) },
    ]),
  );
}
