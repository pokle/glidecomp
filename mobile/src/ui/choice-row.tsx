/**
 * A row that chooses one of a few values: on Android, the list item's title
 * with Material's exposed dropdown at its trailing edge (the iOS version is
 * choice-row.ios.tsx).
 */
import { ListItem, Picker } from '@expo/ui';

import type { ChoiceRowProps } from './choice-row.types';
import { testIdModifiers } from './test-id';

export function ChoiceRow<T extends string>({ title, value, choices, onChange, testID }: ChoiceRowProps<T>) {
  return (
    <ListItem
      modifiers={testIdModifiers(testID)}
      trailing={
        <Picker selectedValue={value} onValueChange={(v) => onChange(v as T)}>
          {choices.map((c) => (
            <Picker.Item key={c.value} label={c.label} value={c.value} />
          ))}
        </Picker>
      }>
      {title}
    </ListItem>
  );
}
