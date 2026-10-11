import { Stack } from 'expo-router';

import { Screen } from '@/components/Screen';
import { StageNote } from '@/components/StageNote';

// Organisers only: the row that opens it is shown only when `is_admin`. A stub
// until stage 7 of docs/2026-10-05-mobile-app-plan.md builds it.
export default function OrganiserStub() {
  return (
    <Screen>
      <Stack.Screen options={{ title: 'Task settings' }} />
      <StageNote stage={7}>Task settings arrive in stage 7. Until then, use the website.</StageNote>
    </Screen>
  );
}
