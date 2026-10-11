/**
 * A row that chooses one of a few values: on iOS, SwiftUI's menu picker in
 * the Form row — the title on the left, the choice on the right — exactly
 * as Settings draws it.
 */
import { Picker, Text } from '@expo/ui/swift-ui';
import { pickerStyle, tag } from '@expo/ui/swift-ui/modifiers';

import type { ChoiceRowProps } from './choice-row.types';

export function ChoiceRow<T extends string>({ title, value, choices, onChange, testID }: ChoiceRowProps<T>) {
  return (
    <Picker
      label={title}
      selection={value}
      onSelectionChange={(v) => onChange(v as T)}
      modifiers={[pickerStyle('menu')]}
      testID={testID}>
      {choices.map((c) => (
        <Text key={c.value} modifiers={[tag(c.value)]}>
          {c.label}
        </Text>
      ))}
    </Picker>
  );
}
