/**
 * Units: how the app prints altitudes, distances, speeds and climb rates.
 * Cylinder radii stay in metres whatever is chosen here — they are the task's
 * own numbers (root CLAUDE.md, the altitude rule).
 */
import type { UnitPreferences } from '@glidecomp/engine';
import { Stack } from 'expo-router';

import { setUnit, useUnits } from '@/settings/units';
import { GroupedList, Group, Note, Row } from '@/ui/grouped-list';

const OPTIONS: { key: keyof UnitPreferences; title: string; choices: { value: string; label: string }[] }[] = [
  {
    key: 'altitude',
    title: 'Altitude',
    choices: [
      { value: 'm', label: 'Metres' },
      { value: 'ft', label: 'Feet' },
    ],
  },
  {
    key: 'distance',
    title: 'Distance',
    choices: [
      { value: 'km', label: 'Kilometres' },
      { value: 'mi', label: 'Miles' },
      { value: 'nmi', label: 'Nautical miles' },
    ],
  },
  {
    key: 'speed',
    title: 'Speed',
    choices: [
      { value: 'km/h', label: 'Kilometres an hour' },
      { value: 'mph', label: 'Miles an hour' },
      { value: 'knots', label: 'Knots' },
    ],
  },
  {
    key: 'climbRate',
    title: 'Climb rate',
    choices: [
      { value: 'm/s', label: 'Metres a second' },
      { value: 'ft/min', label: 'Feet a minute' },
      { value: 'knots', label: 'Knots' },
    ],
  },
];

export default function Units() {
  const units = useUnits();
  return (
    <>
      <Stack.Screen options={{ title: 'Units' }} />
      <GroupedList testID="units">
        {OPTIONS.map((group) => (
          <Group key={group.key} title={group.title}>
            {group.choices.map((choice) => (
              <Row
                key={choice.value}
                testID={`unit-${group.key}-${choice.value}`}
                title={choice.label}
                selected={units[group.key] === choice.value}
                onPress={() => setUnit(group.key, choice.value as never)}
              />
            ))}
          </Group>
        ))}
        <Group>
          <Note>Cylinder radii are always in metres: that is how the task states them.</Note>
        </Group>
      </GroupedList>
    </>
  );
}
