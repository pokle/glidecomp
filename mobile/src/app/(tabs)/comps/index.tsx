import { Stack } from 'expo-router';

import { EngineCheck } from '@/components/EngineCheck';
import { Screen } from '@/components/Screen';
import { StageNote } from '@/components/StageNote';

export default function Comps() {
  return (
    <Screen>
      <Stack.Screen options={{ title: 'Comps' }} />
      <StageNote stage={2}>Competitions arrive in stage 2.</StageNote>
      <EngineCheck />
    </Screen>
  );
}
