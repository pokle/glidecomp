import { Stack } from 'expo-router';

import { EngineCheck } from '@/components/EngineCheck';
import { Screen } from '@/components/Screen';

/** Stage 1's proof that the scoring engine runs on this phone, kept as a diagnostic. */
export default function EngineCheckScreen() {
  return (
    <Screen>
      <Stack.Screen options={{ title: 'Engine check' }} />
      <EngineCheck />
    </Screen>
  );
}
