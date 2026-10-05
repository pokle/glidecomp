import { Stack } from 'expo-router';

import { Screen } from '@/components/Screen';
import { StageNote } from '@/components/StageNote';

export default function MyFlights() {
  return (
    <Screen>
      <Stack.Screen options={{ title: 'My flights' }} />
      <StageNote stage={6}>Your flights arrive in stage 6.</StageNote>
    </Screen>
  );
}
