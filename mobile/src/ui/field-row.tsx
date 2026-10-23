/**
 * A text field as a row of the list on iOS: SwiftUI's TextField in a Form
 * row, through @expo/ui's universal TextInput. Uncontrolled: it starts from
 * `defaultValue` and reports every change. The label is the placeholder,
 * which is also what VoiceOver reads. (Android: field-row.android.tsx.)
 */
import { TextInput } from '@expo/ui';

import type { FieldRowProps } from './field-row.types';
import { testIdModifiers } from './test-id';

export function FieldRow({
  label,
  defaultValue,
  onChangeText,
  email = false,
  testID,
}: FieldRowProps) {
  return (
    <TextInput
      placeholder={label}
      defaultValue={defaultValue}
      onChangeText={onChangeText}
      autoCapitalize="none"
      autoCorrect={false}
      keyboardType={email ? 'email-address' : 'default'}
      autoComplete={email ? 'email' : 'off'}
      testID={testID}
      modifiers={testIdModifiers(testID)}
    />
  );
}

// Not a ListItem (for the Android section's insets; harmless on iOS).
FieldRow.needsInset = true;
