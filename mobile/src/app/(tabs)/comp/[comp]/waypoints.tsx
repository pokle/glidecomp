import { Stack } from 'expo-router';

import { Screen } from '@/components/Screen';
import { StageNote } from '@/components/StageNote';

// A stub until stage 6 of docs/2026-10-05-mobile-app-plan.md builds it.
export default function CompWaypoints() {
  return (
    <Screen>
      <Stack.Screen options={{ title: 'Waypoints' }} />
      <StageNote stage={6}>Waypoints arrive in stage 6.</StageNote>
    </Screen>
  );
}
