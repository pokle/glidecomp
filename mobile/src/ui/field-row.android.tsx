/**
 * A text field as a row of the list on Android: Material's outlined text
 * field, whose label floats above what is typed, so the row reads as a field
 * and TalkBack names it. (The universal TextInput is Compose's undecorated
 * BasicTextField on Android — no outline, no label — so an empty one read as
 * a line of text, and nothing said it could be typed into.) Uncontrolled: it
 * starts from `defaultValue` and reports every change. iOS:
 * field-row.tsx.
 */
import { OutlinedTextField, Text, useNativeState } from '@expo/ui/jetpack-compose';
import { fillMaxWidth } from '@expo/ui/jetpack-compose/modifiers';
import { useRef } from 'react';

import type { FieldRowProps } from './field-row.types';
import { testIdModifiers } from './test-id';

export function FieldRow({ label, defaultValue, onChangeText, email = false, testID }: FieldRowProps) {
  // The field owns its text; the initial value is read once, as an
  // uncontrolled input's should be.
  const initial = useRef(defaultValue ?? '');
  const text = useNativeState<string>(initial.current);
  return (
    <OutlinedTextField
      value={text}
      onValueChange={onChangeText}
      singleLine
      keyboardOptions={{
        keyboardType: email ? 'email' : 'text',
        capitalization: 'none',
        autoCorrectEnabled: false,
      }}
      modifiers={[fillMaxWidth(), ...(testIdModifiers(testID) ?? [])]}>
      <OutlinedTextField.Label>
        <Text>{label}</Text>
      </OutlinedTextField.Label>
    </OutlinedTextField>
  );
}

// Not a ListItem: the Android section gives it a ListItem's insets (list-shell.android.tsx).
FieldRow.needsInset = true;
