import { Stack } from 'expo-router';

import { Screen } from '@/components/Screen';
import { StageNote } from '@/components/StageNote';

// A stub until stage 8 of docs/2026-10-05-mobile-app-plan.md builds it.
export default function CompAnalysis() {
  return (
    <Screen>
      <Stack.Screen options={{ title: 'Analysis' }} />
      <StageNote stage={8}>Competition analysis arrives in stage 8.</StageNote>
    </Screen>
  );
}
