/**
 * The frame every comp settings group shares: the comp loaded, the title,
 * and the form below once there is a comp to edit.
 */
import { idFromSegment } from '@glidecomp/client/slug';
import type { CompDetailData } from '@glidecomp/client/types';
import { Stack, useLocalSearchParams } from 'expo-router';
import type { ReactNode } from 'react';
import { View } from 'react-native';

import { useComp } from '@/api/queries';
import { QueryGate, StaleBanner } from '@/ui/QueryStates';

export function CompSettingsScreen({ title, children }: { title: string; children: (comp: CompDetailData) => ReactNode }) {
  const { comp: segment } = useLocalSearchParams<{ comp: string }>();
  const comp = useComp(idFromSegment(segment));
  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ title, headerLargeTitle: false }} />
      <StaleBanner query={comp} />
      <QueryGate query={comp} loading="Loading the competition…" notFound="This competition doesn’t exist, or isn’t public.">
        {children}
      </QueryGate>
    </View>
  );
}
