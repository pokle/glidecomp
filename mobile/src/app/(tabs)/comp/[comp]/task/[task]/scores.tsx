import { Stack } from 'expo-router';

import { Screen } from '@/components/Screen';
import { StageNote } from '@/components/StageNote';

// A stub until stage 3 of docs/2026-10-05-mobile-app-plan.md builds it.
export default function TaskScores() {
  return (
    <Screen>
      <Stack.Screen options={{ title: 'Task scores' }} />
      <StageNote stage={3}>Task scores arrive in stage 3.</StageNote>
    </Screen>
  );
}
