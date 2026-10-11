/** Appearance: light, dark, or the phone's own setting — this phone only. */
import { Stack } from 'expo-router';

import { APPEARANCE_CHOICES } from '@/lib/me-labels';
import { setAppearance, useAppearance } from '@/settings/appearance';
import { GroupedList, Group, Note, Row } from '@/ui/grouped-list';

export default function Appearance() {
  const current = useAppearance();
  return (
    <>
      <Stack.Screen options={{ title: 'Appearance' }} />
      <GroupedList testID="appearance">
        <Group>
          {APPEARANCE_CHOICES.map((choice) => (
            <Row
              key={choice.value}
              testID={`appearance-${choice.value}`}
              title={choice.label}
              detail={choice.detail}
              selected={current === choice.value}
              onPress={() => setAppearance(choice.value)}
            />
          ))}
        </Group>
        <Group>
          <Note>How GlideComp looks on this phone.</Note>
        </Group>
      </GroupedList>
    </>
  );
}
