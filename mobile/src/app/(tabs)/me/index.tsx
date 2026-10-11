/**
 * Me (IA §2). Signed out until stage 4, so for now: the reader's units, and
 * what this build is.
 */
import { router, Stack } from 'expo-router';

import { API_ORIGIN, WRITES_ALLOWED } from '@/api/config';
import { useUnits } from '@/settings/units';
import { GroupedList, Group, Note, Row } from '@/ui/grouped-list';

export default function Me() {
  const units = useUnits();
  return (
    <>
      <Stack.Screen options={{ title: 'Me' }} />
      <GroupedList testID="me">
        <Group>
          <Note>Sign-in and your account arrive in stage 4.</Note>
        </Group>
        <Group title="Settings">
          <Row
            testID="units-row"
            title="Units"
            value={`${units.altitude}, ${units.distance}, ${units.speed}`}
            onPress={() => router.push('/me/units')}
          />
        </Group>
        <Group title="This build">
          <Row
            title="Data from"
            value={API_ORIGIN.replace(/^https?:\/\//, '')}
            detail={WRITES_ALLOWED ? undefined : 'Read-only: a development build never writes to it'}
          />
          <Row title="Engine check" onPress={() => router.push('/me/engine-check')} />
        </Group>
      </GroupedList>
    </>
  );
}
