/**
 * Waypoints → Send: the competition's whole waypoint set in every waypoint
 * format, or as a QR when it fits in one.
 */
import { idFromSegment } from '@glidecomp/client/slug';
import { Stack, useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';

import { useComp, useCompWaypoints } from '@/api/queries';
import { SendToInstrument } from '@/components/SendToInstrument';
import { QueryGate, StaleBanner } from '@/ui/QueryStates';

export default function SendWaypointsScreen() {
  const { comp: segment } = useLocalSearchParams<{ comp: string }>();
  const compId = idFromSegment(segment);
  const comp = useComp(compId);
  const waypoints = useCompWaypoints(compId);
  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ title: 'Send waypoints' }} />
      <StaleBanner query={waypoints} />
      <QueryGate
        query={waypoints}
        loading="Loading the waypoints…"
        notFound="This competition doesn’t exist, or isn’t public.">
        {(data) => (
          <SendToInstrument
            source={{ kind: 'waypoints', name: comp.data?.name ?? 'competition', records: data }}
            qrParams={{ comp: compId }}
            noun="waypoint"
          />
        )}
      </QueryGate>
    </View>
  );
}
