import { Stack } from 'expo-router';

import { Screen } from '@/components/Screen';
import { StageNote } from '@/components/StageNote';

export default function Me() {
  return (
    <Screen>
      <Stack.Screen options={{ title: 'Me' }} />
      <StageNote stage={4}>Sign-in and your account arrive in stage 4.</StageNote>
    </Screen>
  );
}
