import { Stack } from 'expo-router';

import { Screen } from '@/components/Screen';
import { StageNote } from '@/components/StageNote';

// A stub until stage 6 of docs/2026-10-05-mobile-app-plan.md builds it.
export default function CompActivity() {
  return (
    <Screen>
      <Stack.Screen options={{ title: 'Activity' }} />
      <StageNote stage={6}>The activity log arrives in stage 6.</StageNote>
    </Screen>
  );
}
